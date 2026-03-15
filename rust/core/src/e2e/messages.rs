use anyhow::{Context, Result};
use serde_json::Value;

use crate::e2e::cbor_x::{encode, E2eCborValue};
use crate::e2e::crypto::{decrypt_xchacha20poly1305, encrypt_xchacha20poly1305};
use crate::e2e::types::{E2EMessageType, PreKeyMessage, SessionMessage, E2E_PROTOCOL_VERSION};
use crate::protocol::cbor_decode_value;

fn get_str(value: &Value, field: &str) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Missing string field {}", field))
}

fn get_u64(value: &Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .with_context(|| format!("Missing integer field {}", field))
}

fn get_bytes(value: &Value, field: &str) -> Result<Vec<u8>> {
    value
        .get(field)
        .and_then(Value::as_array)
        .with_context(|| format!("Missing byte-array field {}", field))?
        .iter()
        .map(|item| {
            item.as_u64()
                .filter(|byte| *byte <= 255)
                .map(|byte| byte as u8)
                .with_context(|| format!("Field {} contains non-byte value", field))
        })
        .collect()
}

fn build_prekey_map(
    message: &PreKeyMessage,
    include_ciphertext: bool,
) -> Vec<(&str, E2eCborValue<'_>)> {
    let mut fields = vec![
        ("version", E2eCborValue::Int(message.version as i64)),
        ("type", E2eCborValue::Str("PREKEY_MESSAGE")),
        ("senderDid", E2eCborValue::Str(&message.sender_did)),
        ("receiverDid", E2eCborValue::Str(&message.receiver_did)),
        (
            "senderDeviceId",
            E2eCborValue::Str(&message.sender_device_id),
        ),
        (
            "receiverDeviceId",
            E2eCborValue::Str(&message.receiver_device_id),
        ),
        ("sessionId", E2eCborValue::Str(&message.session_id)),
        ("messageId", E2eCborValue::Str(&message.message_id)),
        (
            "initiatorIdentityKey",
            E2eCborValue::TypedBytes(&message.initiator_identity_key),
        ),
        (
            "initiatorEphemeralKey",
            E2eCborValue::TypedBytes(&message.initiator_ephemeral_key),
        ),
        (
            "recipientSignedPreKeyId",
            E2eCborValue::Int(message.recipient_signed_pre_key_id as i64),
        ),
    ];

    if let Some(one_time_pre_key_id) = message.recipient_one_time_pre_key_id {
        fields.push((
            "recipientOneTimePreKeyId",
            E2eCborValue::Int(one_time_pre_key_id as i64),
        ));
    }

    fields.push(("nonce", E2eCborValue::TypedBytes(&message.nonce)));

    if include_ciphertext {
        fields.push(("ciphertext", E2eCborValue::TypedBytes(&message.ciphertext)));
    }

    fields
}

fn build_session_map(
    message: &SessionMessage,
    include_ciphertext: bool,
) -> Vec<(&str, E2eCborValue<'_>)> {
    let mut fields = vec![
        ("version", E2eCborValue::Int(message.version as i64)),
        ("type", E2eCborValue::Str("SESSION_MESSAGE")),
        ("senderDid", E2eCborValue::Str(&message.sender_did)),
        ("receiverDid", E2eCborValue::Str(&message.receiver_did)),
        (
            "senderDeviceId",
            E2eCborValue::Str(&message.sender_device_id),
        ),
        (
            "receiverDeviceId",
            E2eCborValue::Str(&message.receiver_device_id),
        ),
        ("sessionId", E2eCborValue::Str(&message.session_id)),
        ("messageId", E2eCborValue::Str(&message.message_id)),
        (
            "ratchetPublicKey",
            E2eCborValue::TypedBytes(&message.ratchet_public_key),
        ),
        (
            "previousChainLength",
            E2eCborValue::Int(message.previous_chain_length as i64),
        ),
        (
            "messageNumber",
            E2eCborValue::Int(message.message_number as i64),
        ),
        ("nonce", E2eCborValue::TypedBytes(&message.nonce)),
    ];

    if include_ciphertext {
        fields.push(("ciphertext", E2eCborValue::TypedBytes(&message.ciphertext)));
    }

    fields
}

pub fn build_prekey_message_associated_data(message: &PreKeyMessage) -> Result<Vec<u8>> {
    Ok(encode(&E2eCborValue::Map(build_prekey_map(message, false))))
}

pub fn build_session_message_associated_data(message: &SessionMessage) -> Result<Vec<u8>> {
    Ok(encode(&E2eCborValue::Map(build_session_map(
        message, false,
    ))))
}

pub fn encrypt_prekey_message(
    message: &PreKeyMessage,
    key: &[u8],
    plaintext: &[u8],
) -> Result<PreKeyMessage> {
    let mut encrypted = message.clone();
    encrypted.ciphertext = encrypt_xchacha20poly1305(
        key,
        &encrypted.nonce,
        plaintext,
        &build_prekey_message_associated_data(message)?,
    )?;
    Ok(encrypted)
}

pub fn decrypt_prekey_message(message: &PreKeyMessage, key: &[u8]) -> Result<Vec<u8>> {
    decrypt_xchacha20poly1305(
        key,
        &message.nonce,
        &message.ciphertext,
        &build_prekey_message_associated_data(message)?,
    )
}

pub fn encrypt_session_message(
    message: &SessionMessage,
    key: &[u8],
    plaintext: &[u8],
) -> Result<SessionMessage> {
    let mut encrypted = message.clone();
    encrypted.ciphertext = encrypt_xchacha20poly1305(
        key,
        &encrypted.nonce,
        plaintext,
        &build_session_message_associated_data(message)?,
    )?;
    Ok(encrypted)
}

pub fn decrypt_session_message(message: &SessionMessage, key: &[u8]) -> Result<Vec<u8>> {
    decrypt_xchacha20poly1305(
        key,
        &message.nonce,
        &message.ciphertext,
        &build_session_message_associated_data(message)?,
    )
}

pub fn encode_prekey_message(message: &PreKeyMessage) -> Result<Vec<u8>> {
    if message.version != E2E_PROTOCOL_VERSION {
        anyhow::bail!("Unsupported PREKEY_MESSAGE version: {}", message.version);
    }
    Ok(encode(&E2eCborValue::Map(build_prekey_map(message, true))))
}

pub fn decode_prekey_message(bytes: &[u8]) -> Result<PreKeyMessage> {
    let value = cbor_decode_value(bytes).context("Failed to decode PREKEY_MESSAGE")?;
    if value.get("version").and_then(Value::as_u64) != Some(E2E_PROTOCOL_VERSION as u64)
        || value.get("type").and_then(Value::as_str) != Some("PREKEY_MESSAGE")
    {
        anyhow::bail!("Invalid PREKEY_MESSAGE payload");
    }

    Ok(PreKeyMessage {
        version: get_u64(&value, "version")? as u8,
        message_type: E2EMessageType::PreKeyMessage,
        sender_did: get_str(&value, "senderDid")?,
        receiver_did: get_str(&value, "receiverDid")?,
        sender_device_id: get_str(&value, "senderDeviceId")?,
        receiver_device_id: get_str(&value, "receiverDeviceId")?,
        session_id: get_str(&value, "sessionId")?,
        message_id: get_str(&value, "messageId")?,
        initiator_identity_key: get_bytes(&value, "initiatorIdentityKey")?,
        initiator_ephemeral_key: get_bytes(&value, "initiatorEphemeralKey")?,
        recipient_signed_pre_key_id: get_u64(&value, "recipientSignedPreKeyId")? as u32,
        recipient_one_time_pre_key_id: value
            .get("recipientOneTimePreKeyId")
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        nonce: get_bytes(&value, "nonce")?,
        ciphertext: get_bytes(&value, "ciphertext")?,
    })
}

pub fn encode_session_message(message: &SessionMessage) -> Result<Vec<u8>> {
    if message.version != E2E_PROTOCOL_VERSION {
        anyhow::bail!("Unsupported SESSION_MESSAGE version: {}", message.version);
    }
    Ok(encode(&E2eCborValue::Map(build_session_map(message, true))))
}

pub fn decode_session_message(bytes: &[u8]) -> Result<SessionMessage> {
    let value = cbor_decode_value(bytes).context("Failed to decode SESSION_MESSAGE")?;
    if value.get("version").and_then(Value::as_u64) != Some(E2E_PROTOCOL_VERSION as u64)
        || value.get("type").and_then(Value::as_str) != Some("SESSION_MESSAGE")
    {
        anyhow::bail!("Invalid SESSION_MESSAGE payload");
    }

    Ok(SessionMessage {
        version: get_u64(&value, "version")? as u8,
        message_type: E2EMessageType::SessionMessage,
        sender_did: get_str(&value, "senderDid")?,
        receiver_did: get_str(&value, "receiverDid")?,
        sender_device_id: get_str(&value, "senderDeviceId")?,
        receiver_device_id: get_str(&value, "receiverDeviceId")?,
        session_id: get_str(&value, "sessionId")?,
        message_id: get_str(&value, "messageId")?,
        ratchet_public_key: get_bytes(&value, "ratchetPublicKey")?,
        previous_chain_length: get_u64(&value, "previousChainLength")? as u32,
        message_number: get_u64(&value, "messageNumber")? as u32,
        nonce: get_bytes(&value, "nonce")?,
        ciphertext: get_bytes(&value, "ciphertext")?,
    })
}
