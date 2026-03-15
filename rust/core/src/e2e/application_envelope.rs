use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::e2e::bootstrap::{
    build_initiator_pre_key_message, consume_responder_pre_key_message, load_local_session,
    store_local_session,
};
use crate::e2e::bytes_to_hex;
use crate::e2e::messages::{
    decode_prekey_message, decode_session_message, encode_prekey_message, encode_session_message,
};
use crate::e2e::ratchet::{decrypt_ratchet_message, encrypt_ratchet_message};
use crate::e2e::types::{
    ClaimedPreKeyBundle, E2EMessageType, LocalE2EConfig, PreKeyMessage,
    PublishedDeviceDirectoryEntry, SessionMessage,
};
use crate::protocol::{AgentCard, Envelope, EnvelopeUnsigned};

pub const E2E_APPLICATION_ENVELOPE_PROTOCOL: &str = "/agent/e2e/1.0.0";
pub const E2E_APPLICATION_ENVELOPE_KIND: &str = "quadra-a-e2e";
pub const E2E_APPLICATION_ENVELOPE_VERSION: u8 = 1;
pub const E2E_APPLICATION_ENVELOPE_ENCODING: &str = "hex";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedApplicationEnvelopePayload {
    pub kind: String,
    pub version: u8,
    pub encoding: String,
    #[serde(rename = "messageType")]
    pub message_type: E2EMessageType,
    #[serde(rename = "senderDeviceId")]
    pub sender_device_id: String,
    #[serde(rename = "receiverDeviceId")]
    pub receiver_device_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "wireMessage")]
    pub wire_message: String,
}

pub enum DecodedEncryptedApplicationMessage {
    PreKey(PreKeyMessage),
    Session(SessionMessage),
}

pub struct EncryptApplicationEnvelopeInput<'a> {
    pub e2e: &'a LocalE2EConfig,
    pub application_envelope: &'a Envelope,
    pub recipient_device: &'a PublishedDeviceDirectoryEntry,
    pub claimed_bundle: Option<&'a ClaimedPreKeyBundle>,
}

pub struct EncryptApplicationEnvelopeResult {
    pub payload: EncryptedApplicationEnvelopePayload,
    pub e2e: LocalE2EConfig,
    pub transport: &'static str,
}

pub struct DecryptApplicationEnvelopeInput<'a> {
    pub e2e: &'a LocalE2EConfig,
    pub receiver_did: &'a str,
    pub transport_envelope: &'a Envelope,
    pub now: Option<u64>,
}

pub struct DecryptApplicationEnvelopeResult {
    pub application_envelope: Envelope,
    pub e2e: LocalE2EConfig,
    pub transport: &'static str,
    pub sender_device_id: String,
    pub receiver_device_id: String,
    pub session_id: String,
    pub used_skipped_message_key: bool,
}

fn serialize_signed_application_envelope(envelope: &Envelope) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(envelope)?)
}

pub fn deserialize_signed_application_envelope(bytes: &[u8]) -> Result<Envelope> {
    Ok(serde_json::from_slice(bytes)?)
}

fn build_encrypted_application_envelope_payload(
    message_type: E2EMessageType,
    message: &PreKeyMessage,
    wire_message: &[u8],
) -> EncryptedApplicationEnvelopePayload {
    EncryptedApplicationEnvelopePayload {
        kind: E2E_APPLICATION_ENVELOPE_KIND.to_string(),
        version: E2E_APPLICATION_ENVELOPE_VERSION,
        encoding: E2E_APPLICATION_ENVELOPE_ENCODING.to_string(),
        message_type,
        sender_device_id: message.sender_device_id.clone(),
        receiver_device_id: message.receiver_device_id.clone(),
        session_id: message.session_id.clone(),
        wire_message: bytes_to_hex(wire_message),
    }
}

fn build_encrypted_application_envelope_payload_from_session(
    message: &SessionMessage,
    wire_message: &[u8],
) -> EncryptedApplicationEnvelopePayload {
    EncryptedApplicationEnvelopePayload {
        kind: E2E_APPLICATION_ENVELOPE_KIND.to_string(),
        version: E2E_APPLICATION_ENVELOPE_VERSION,
        encoding: E2E_APPLICATION_ENVELOPE_ENCODING.to_string(),
        message_type: E2EMessageType::SessionMessage,
        sender_device_id: message.sender_device_id.clone(),
        receiver_device_id: message.receiver_device_id.clone(),
        session_id: message.session_id.clone(),
        wire_message: bytes_to_hex(wire_message),
    }
}

fn assert_transport_envelope_signature(envelope: &Envelope, label: &str) -> Result<()> {
    if envelope.verify_signature()? {
        return Ok(());
    }

    anyhow::bail!(
        "{} signature verification failed for {} from {}",
        label,
        envelope.id,
        envelope.from
    )
}

fn assert_transport_envelope_matches_message(
    transport_envelope: &Envelope,
    payload: &EncryptedApplicationEnvelopePayload,
    message: &DecodedEncryptedApplicationMessage,
) -> Result<()> {
    if transport_envelope.protocol != E2E_APPLICATION_ENVELOPE_PROTOCOL {
        anyhow::bail!(
            "Transport envelope protocol mismatch: expected {}, got {}",
            E2E_APPLICATION_ENVELOPE_PROTOCOL,
            transport_envelope.protocol
        );
    }

    let (
        message_type,
        sender_did,
        receiver_did,
        sender_device_id,
        receiver_device_id,
        session_id,
        message_id,
    ) = match message {
        DecodedEncryptedApplicationMessage::PreKey(message) => (
            E2EMessageType::PreKeyMessage,
            &message.sender_did,
            &message.receiver_did,
            &message.sender_device_id,
            &message.receiver_device_id,
            &message.session_id,
            &message.message_id,
        ),
        DecodedEncryptedApplicationMessage::Session(message) => (
            E2EMessageType::SessionMessage,
            &message.sender_did,
            &message.receiver_did,
            &message.sender_device_id,
            &message.receiver_device_id,
            &message.session_id,
            &message.message_id,
        ),
    };

    if transport_envelope.from != *sender_did || transport_envelope.to != *receiver_did {
        anyhow::bail!(
            "Transport envelope DID routing does not match encrypted message for {}",
            message_id
        );
    }

    if transport_envelope.id != *message_id {
        anyhow::bail!(
            "Transport envelope id {} does not match encrypted message id {}",
            transport_envelope.id,
            message_id
        );
    }

    if payload.message_type != message_type
        || payload.sender_device_id != *sender_device_id
        || payload.receiver_device_id != *receiver_device_id
        || payload.session_id != *session_id
    {
        anyhow::bail!(
            "Transport envelope metadata does not match encrypted message payload for {}",
            message_id
        );
    }

    Ok(())
}

fn assert_application_envelope_matches_message(
    application_envelope: &Envelope,
    message: &DecodedEncryptedApplicationMessage,
) -> Result<()> {
    let (message_id, sender_did, receiver_did) = match message {
        DecodedEncryptedApplicationMessage::PreKey(message) => (
            &message.message_id,
            &message.sender_did,
            &message.receiver_did,
        ),
        DecodedEncryptedApplicationMessage::Session(message) => (
            &message.message_id,
            &message.sender_did,
            &message.receiver_did,
        ),
    };

    if application_envelope.id != *message_id
        || application_envelope.from != *sender_did
        || application_envelope.to != *receiver_did
    {
        anyhow::bail!(
            "Decrypted application envelope routing does not match encrypted message for {}",
            message_id
        );
    }

    Ok(())
}

pub fn assert_published_sender_device_matches_prekey_message(
    sender_card: &AgentCard,
    message: &PreKeyMessage,
) -> Result<()> {
    let devices = sender_card.devices.as_ref().cloned().unwrap_or_default();
    let matching_devices = devices
        .into_iter()
        .filter(|device| device.device_id == message.sender_device_id)
        .collect::<Vec<_>>();

    match matching_devices.len() {
        0 => anyhow::bail!(
            "Sender {}:{} is not published in current Agent Card",
            message.sender_did,
            message.sender_device_id
        ),
        1 => {}
        _ => anyhow::bail!(
            "Sender {} publishes duplicate E2E device {}",
            message.sender_did,
            message.sender_device_id
        ),
    }

    if matching_devices[0].identity_key_public != bytes_to_hex(&message.initiator_identity_key) {
        anyhow::bail!(
            "Sender {}:{} published identity key does not match PREKEY_MESSAGE",
            message.sender_did,
            message.sender_device_id
        );
    }

    Ok(())
}

pub fn decode_encrypted_application_envelope_payload(
    payload: &EncryptedApplicationEnvelopePayload,
) -> Result<DecodedEncryptedApplicationMessage> {
    if payload.kind != E2E_APPLICATION_ENVELOPE_KIND
        || payload.version != E2E_APPLICATION_ENVELOPE_VERSION
        || payload.encoding != E2E_APPLICATION_ENVELOPE_ENCODING
    {
        anyhow::bail!("Invalid encrypted application envelope payload");
    }

    let wire_message = hex::decode(&payload.wire_message)
        .map_err(|_| anyhow!("Invalid encrypted application wire message hex"))?;
    Ok(match payload.message_type {
        E2EMessageType::PreKeyMessage => {
            DecodedEncryptedApplicationMessage::PreKey(decode_prekey_message(&wire_message)?)
        }
        E2EMessageType::SessionMessage => {
            DecodedEncryptedApplicationMessage::Session(decode_session_message(&wire_message)?)
        }
    })
}

pub fn encrypt_application_envelope(
    input: EncryptApplicationEnvelopeInput<'_>,
) -> Result<EncryptApplicationEnvelopeResult> {
    let plaintext = serialize_signed_application_envelope(input.application_envelope)?;
    let current_device_id = input.e2e.current_device_id.clone();
    let existing_session = load_local_session(
        input.e2e,
        &current_device_id,
        &input.application_envelope.to,
        &input.recipient_device.device_id,
    )?;

    if let Some(session) = existing_session {
        let encrypted = encrypt_ratchet_message(crate::e2e::RatchetEncryptInput {
            session: &session,
            plaintext: &plaintext,
            sender_did: &input.application_envelope.from,
            receiver_did: &input.application_envelope.to,
            message_id: Some(input.application_envelope.id.clone()),
            nonce: None,
            ratchet_keypair: None,
            now: None,
        })?;
        let next_e2e = store_local_session(input.e2e, &current_device_id, &encrypted.session)?;
        return Ok(EncryptApplicationEnvelopeResult {
            payload: build_encrypted_application_envelope_payload_from_session(
                &encrypted.message,
                &encode_session_message(&encrypted.message)?,
            ),
            e2e: next_e2e,
            transport: "session",
        });
    }

    let claimed_bundle = input.claimed_bundle.ok_or_else(|| {
        anyhow!(
            "Missing claimed pre-key bundle for first encrypted send to {}:{}",
            input.application_envelope.to,
            input.recipient_device.device_id
        )
    })?;

    let bootstrap =
        build_initiator_pre_key_message(crate::e2e::BuildInitiatorPreKeyMessageInput {
            e2e: input.e2e,
            sender_did: &input.application_envelope.from,
            receiver_did: &input.application_envelope.to,
            recipient_device: input.recipient_device,
            claimed_bundle,
            plaintext: &plaintext,
            session_id: None,
            message_id: Some(input.application_envelope.id.clone()),
            nonce: None,
            ephemeral_keypair: None,
            now: None,
        })?;

    Ok(EncryptApplicationEnvelopeResult {
        payload: build_encrypted_application_envelope_payload(
            E2EMessageType::PreKeyMessage,
            &bootstrap.message,
            &encode_prekey_message(&bootstrap.message)?,
        ),
        e2e: bootstrap.e2e,
        transport: "prekey",
    })
}

pub fn decrypt_application_envelope(
    input: DecryptApplicationEnvelopeInput<'_>,
) -> Result<DecryptApplicationEnvelopeResult> {
    assert_transport_envelope_signature(input.transport_envelope, "Encrypted transport envelope")?;
    if input.transport_envelope.protocol != E2E_APPLICATION_ENVELOPE_PROTOCOL {
        anyhow::bail!(
            "Transport envelope protocol mismatch: expected {}, got {}",
            E2E_APPLICATION_ENVELOPE_PROTOCOL,
            input.transport_envelope.protocol,
        );
    }

    let payload: EncryptedApplicationEnvelopePayload =
        serde_json::from_value(input.transport_envelope.payload.clone())?;
    let decoded_message = decode_encrypted_application_envelope_payload(&payload)?;
    assert_transport_envelope_matches_message(
        input.transport_envelope,
        &payload,
        &decoded_message,
    )?;

    let (plaintext, next_e2e, transport, used_skipped_message_key) = match &decoded_message {
        DecodedEncryptedApplicationMessage::PreKey(message) => {
            let consumed = consume_responder_pre_key_message(
                crate::e2e::ConsumeResponderPreKeyMessageInput {
                    e2e: input.e2e,
                    receiver_did: input.receiver_did,
                    message,
                    now: input.now,
                },
            )?;
            (consumed.plaintext, consumed.e2e, "prekey", false)
        }
        DecodedEncryptedApplicationMessage::Session(message) => {
            let session = load_local_session(
                input.e2e,
                &message.receiver_device_id,
                &message.sender_did,
                &message.sender_device_id,
            )?
            .ok_or_else(|| {
                anyhow!(
                    "Missing local E2E session for SESSION_MESSAGE {}:{} -> {}:{} ({})",
                    message.sender_did,
                    message.sender_device_id,
                    message.receiver_did,
                    message.receiver_device_id,
                    message.session_id
                )
            })?;

            if session.session_id != message.session_id {
                anyhow::bail!(
                    "SESSION_MESSAGE session id mismatch: expected {}, got {}",
                    session.session_id,
                    message.session_id
                );
            }

            let decrypted = decrypt_ratchet_message(crate::e2e::RatchetDecryptInput {
                session: &session,
                message,
                now: input.now,
            })?;
            (
                decrypted.plaintext,
                store_local_session(input.e2e, &message.receiver_device_id, &decrypted.session)?,
                "session",
                decrypted.used_skipped_message_key,
            )
        }
    };

    let application_envelope = deserialize_signed_application_envelope(&plaintext)?;
    assert_application_envelope_matches_message(&application_envelope, &decoded_message)?;
    assert_transport_envelope_signature(&application_envelope, "Decrypted application envelope")?;

    let (sender_device_id, receiver_device_id, session_id) = match decoded_message {
        DecodedEncryptedApplicationMessage::PreKey(message) => (
            message.sender_device_id,
            message.receiver_device_id,
            message.session_id,
        ),
        DecodedEncryptedApplicationMessage::Session(message) => (
            message.sender_device_id,
            message.receiver_device_id,
            message.session_id,
        ),
    };

    Ok(DecryptApplicationEnvelopeResult {
        application_envelope,
        e2e: next_e2e,
        transport,
        sender_device_id,
        receiver_device_id,
        session_id,
        used_skipped_message_key,
    })
}

pub fn build_encrypted_transport_envelope(
    application_envelope: &Envelope,
    payload: EncryptedApplicationEnvelopePayload,
    keypair: &crate::identity::KeyPair,
) -> Envelope {
    EnvelopeUnsigned {
        id: application_envelope.id.clone(),
        from: application_envelope.from.clone(),
        to: application_envelope.to.clone(),
        msg_type: "message".to_string(),
        protocol: E2E_APPLICATION_ENVELOPE_PROTOCOL.to_string(),
        payload: serde_json::to_value(payload).expect("serialize encrypted application payload"),
        timestamp: application_envelope.timestamp,
        reply_to: None,
        thread_id: None,
        group_id: None,
    }
    .sign(keypair)
}
