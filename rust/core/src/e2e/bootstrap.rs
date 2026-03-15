use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::e2e::crypto::{bytes_to_hex, generate_x25519_key_pair, random_bytes, X25519KeyPair};
use crate::e2e::messages::{decrypt_prekey_message, encrypt_prekey_message};
use crate::e2e::ratchet::{
    create_initiator_ratchet_session, create_responder_ratchet_session, LocalSessionState,
};
use crate::e2e::types::{
    ClaimedPreKeyBundle, E2EMessageType, LocalE2EConfig, PreKeyMessage,
    PublishedDeviceDirectoryEntry, E2E_PROTOCOL_VERSION,
};
use crate::e2e::x3dh::{derive_x3dh_initiator_shared_secret, derive_x3dh_responder_shared_secret};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalSessionBootstrapState {
    #[serde(rename = "selfIdentityKey")]
    pub self_identity_key: String,
    #[serde(rename = "peerIdentityKey")]
    pub peer_identity_key: String,
    #[serde(rename = "initiatorEphemeralKey")]
    pub initiator_ephemeral_key: String,
    #[serde(rename = "recipientSignedPreKeyId")]
    pub recipient_signed_pre_key_id: u32,
    #[serde(rename = "recipientSignedPreKeyPublic")]
    pub recipient_signed_pre_key_public: String,
    #[serde(
        default,
        rename = "recipientOneTimePreKeyId",
        skip_serializing_if = "Option::is_none"
    )]
    pub recipient_one_time_pre_key_id: Option<u32>,
}

pub struct BuildInitiatorPreKeyMessageInput<'a> {
    pub e2e: &'a LocalE2EConfig,
    pub sender_did: &'a str,
    pub receiver_did: &'a str,
    pub recipient_device: &'a PublishedDeviceDirectoryEntry,
    pub claimed_bundle: &'a ClaimedPreKeyBundle,
    pub plaintext: &'a [u8],
    pub session_id: Option<String>,
    pub message_id: Option<String>,
    pub nonce: Option<Vec<u8>>,
    pub ephemeral_keypair: Option<X25519KeyPair>,
    pub now: Option<u64>,
}

pub struct BuildInitiatorPreKeyMessageResult {
    pub message: PreKeyMessage,
    pub session: LocalSessionState,
    pub e2e: LocalE2EConfig,
    pub shared_secret: Vec<u8>,
}

pub struct ConsumeResponderPreKeyMessageInput<'a> {
    pub e2e: &'a LocalE2EConfig,
    pub receiver_did: &'a str,
    pub message: &'a PreKeyMessage,
    pub now: Option<u64>,
}

pub struct ConsumeResponderPreKeyMessageResult {
    pub plaintext: Vec<u8>,
    pub session: LocalSessionState,
    pub e2e: LocalE2EConfig,
    pub shared_secret: Vec<u8>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn decode_hex_key(value: &str, label: &str) -> Result<Vec<u8>> {
    hex::decode(value).map_err(|_| anyhow!("Failed to decode {} hex", label))
}

fn generate_session_id() -> String {
    format!("e2e-session-{}", hex::encode(random_bytes(12)))
}

fn generate_message_id() -> String {
    format!("e2e-msg-{}", hex::encode(random_bytes(12)))
}

fn assert_bundle_matches_directory(
    recipient_device: &PublishedDeviceDirectoryEntry,
    claimed_bundle: &ClaimedPreKeyBundle,
) -> Result<()> {
    if recipient_device.device_id != claimed_bundle.device_id
        || recipient_device.identity_key_public != claimed_bundle.identity_key_public
        || recipient_device.signed_pre_key_public != claimed_bundle.signed_pre_key_public
        || recipient_device.signed_pre_key_id != claimed_bundle.signed_pre_key_id
        || recipient_device.signed_pre_key_signature != claimed_bundle.signed_pre_key_signature
        || recipient_device.last_resupply_at != claimed_bundle.last_resupply_at
    {
        anyhow::bail!("Claimed pre-key bundle does not match trusted device directory entry");
    }

    Ok(())
}

pub fn build_local_session_key(peer_did: &str, peer_device_id: &str) -> String {
    format!("{}:{}", peer_did, peer_device_id)
}

pub fn load_local_session(
    e2e: &LocalE2EConfig,
    device_id: &str,
    peer_did: &str,
    peer_device_id: &str,
) -> Result<Option<LocalSessionState>> {
    let Some(device) = e2e.devices.get(device_id) else {
        return Ok(None);
    };
    let Some(value) = device
        .sessions
        .get(&build_local_session_key(peer_did, peer_device_id))
    else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_value(value.clone())?))
}

pub fn store_local_session(
    e2e: &LocalE2EConfig,
    device_id: &str,
    session: &LocalSessionState,
) -> Result<LocalE2EConfig> {
    let mut next = e2e.clone();
    let device = next
        .devices
        .get_mut(device_id)
        .ok_or_else(|| anyhow!("Missing local E2E device {}", device_id))?;
    device.sessions.insert(
        build_local_session_key(&session.peer_did, &session.peer_device_id),
        serde_json::to_value(session)?,
    );
    Ok(next)
}

pub fn build_initiator_pre_key_message(
    input: BuildInitiatorPreKeyMessageInput<'_>,
) -> Result<BuildInitiatorPreKeyMessageResult> {
    assert_bundle_matches_directory(input.recipient_device, input.claimed_bundle)?;

    let now = input.now.unwrap_or_else(now_ms);
    let device = crate::e2e::current_device_state(input.e2e)?;
    let ephemeral_keypair = input
        .ephemeral_keypair
        .unwrap_or_else(generate_x25519_key_pair);
    let shared_secret = derive_x3dh_initiator_shared_secret(
        &decode_hex_key(
            &device.identity_key.private_key,
            "initiator identity private key",
        )?,
        &ephemeral_keypair.private_key,
        &decode_hex_key(
            &input.claimed_bundle.identity_key_public,
            "recipient identity public key",
        )?,
        &decode_hex_key(
            &input.claimed_bundle.signed_pre_key_public,
            "recipient signed pre-key public key",
        )?,
        input
            .claimed_bundle
            .one_time_pre_key
            .as_ref()
            .map(|key| decode_hex_key(&key.public_key, "recipient one-time pre-key public key"))
            .transpose()?
            .as_deref(),
    )?;

    let session_id = input.session_id.unwrap_or_else(generate_session_id);
    let message_id = input.message_id.unwrap_or_else(generate_message_id);
    let nonce = input.nonce.unwrap_or_else(|| random_bytes(24));
    let message = encrypt_prekey_message(
        &PreKeyMessage {
            version: E2E_PROTOCOL_VERSION,
            message_type: E2EMessageType::PreKeyMessage,
            sender_did: input.sender_did.to_string(),
            receiver_did: input.receiver_did.to_string(),
            sender_device_id: device.device_id.clone(),
            receiver_device_id: input.claimed_bundle.device_id.clone(),
            session_id: session_id.clone(),
            message_id,
            initiator_identity_key: decode_hex_key(
                &device.identity_key.public_key,
                "initiator identity public key",
            )?,
            initiator_ephemeral_key: ephemeral_keypair.public_key.to_vec(),
            recipient_signed_pre_key_id: input.claimed_bundle.signed_pre_key_id,
            recipient_one_time_pre_key_id: input
                .claimed_bundle
                .one_time_pre_key
                .as_ref()
                .map(|key| key.key_id),
            nonce,
            ciphertext: Vec::new(),
        },
        &shared_secret,
        input.plaintext,
    )?;

    let bootstrap = LocalSessionBootstrapState {
        self_identity_key: device.identity_key.public_key.clone(),
        peer_identity_key: input.claimed_bundle.identity_key_public.clone(),
        initiator_ephemeral_key: bytes_to_hex(&ephemeral_keypair.public_key),
        recipient_signed_pre_key_id: input.claimed_bundle.signed_pre_key_id,
        recipient_signed_pre_key_public: input.claimed_bundle.signed_pre_key_public.clone(),
        recipient_one_time_pre_key_id: input
            .claimed_bundle
            .one_time_pre_key
            .as_ref()
            .map(|key| key.key_id),
    };
    let session =
        create_initiator_ratchet_session(crate::e2e::ratchet::CreateRatchetSessionInput {
            session_id: session_id.clone(),
            peer_did: input.receiver_did.to_string(),
            peer_device_id: input.claimed_bundle.device_id.clone(),
            self_device_id: device.device_id.clone(),
            role: "initiator".to_string(),
            root_key: shared_secret.clone(),
            current_ratchet_key: ephemeral_keypair,
            remote_ratchet_public_key: decode_hex_key(
                &input.claimed_bundle.signed_pre_key_public,
                "recipient signed pre-key public key",
            )?,
            bootstrap,
            created_at: now,
        })?;

    Ok(BuildInitiatorPreKeyMessageResult {
        e2e: store_local_session(input.e2e, &device.device_id, &session)?,
        message,
        session,
        shared_secret,
    })
}

pub fn consume_responder_pre_key_message(
    input: ConsumeResponderPreKeyMessageInput<'_>,
) -> Result<ConsumeResponderPreKeyMessageResult> {
    if input.message.receiver_did != input.receiver_did {
        anyhow::bail!(
            "PREKEY_MESSAGE receiver DID mismatch: expected {}, got {}",
            input.receiver_did,
            input.message.receiver_did
        );
    }

    let now = input.now.unwrap_or_else(now_ms);
    let mut next = input.e2e.clone();
    let (
        device_id,
        self_identity_public,
        self_identity_private,
        signed_pre_key_public,
        signed_pre_key_private,
        one_time_pre_key,
    ) = {
        let device = next
            .devices
            .get_mut(&input.message.receiver_device_id)
            .ok_or_else(|| {
                anyhow!(
                    "Missing local E2E device {}",
                    input.message.receiver_device_id
                )
            })?;

        let one_time_pre_key = if let Some(key_id) = input.message.recipient_one_time_pre_key_id {
            let key = device
                .one_time_pre_keys
                .iter_mut()
                .find(|key| key.key_id == key_id)
                .ok_or_else(|| anyhow!("Missing claimed one-time pre-key {}", key_id))?;
            if let Some(claimed_at) = key.claimed_at {
                anyhow::bail!(
                    "Claimed one-time pre-key already consumed for PREKEY_MESSAGE: key_id={}, claimed_at={}",
                    key_id,
                    claimed_at
                );
            }
            key.claimed_at = Some(now);
            Some(key.clone())
        } else {
            None
        };

        if input.message.recipient_signed_pre_key_id != device.signed_pre_key.signed_pre_key_id {
            anyhow::bail!(
                "PREKEY_MESSAGE signed pre-key id does not match current receiver device state: expected {}, got {}",
                device.signed_pre_key.signed_pre_key_id,
                input.message.recipient_signed_pre_key_id
            );
        }

        (
            device.device_id.clone(),
            device.identity_key.public_key.clone(),
            device.identity_key.private_key.clone(),
            device.signed_pre_key.public_key.clone(),
            device.signed_pre_key.private_key.clone(),
            one_time_pre_key,
        )
    };

    let shared_secret = derive_x3dh_responder_shared_secret(
        &decode_hex_key(&self_identity_private, "recipient identity private key")?,
        &decode_hex_key(
            &signed_pre_key_private,
            "recipient signed pre-key private key",
        )?,
        &input.message.initiator_identity_key,
        &input.message.initiator_ephemeral_key,
        one_time_pre_key
            .as_ref()
            .map(|key| decode_hex_key(&key.private_key, "recipient one-time pre-key private key"))
            .transpose()?
            .as_deref(),
    )?;
    let plaintext = decrypt_prekey_message(input.message, &shared_secret)?;

    let bootstrap = LocalSessionBootstrapState {
        self_identity_key: self_identity_public,
        peer_identity_key: bytes_to_hex(&input.message.initiator_identity_key),
        initiator_ephemeral_key: bytes_to_hex(&input.message.initiator_ephemeral_key),
        recipient_signed_pre_key_id: input.message.recipient_signed_pre_key_id,
        recipient_signed_pre_key_public: signed_pre_key_public.clone(),
        recipient_one_time_pre_key_id: input.message.recipient_one_time_pre_key_id,
    };
    let session =
        create_responder_ratchet_session(crate::e2e::ratchet::CreateRatchetSessionInput {
            session_id: input.message.session_id.clone(),
            peer_did: input.message.sender_did.clone(),
            peer_device_id: input.message.sender_device_id.clone(),
            self_device_id: device_id.clone(),
            role: "responder".to_string(),
            root_key: shared_secret.clone(),
            current_ratchet_key: X25519KeyPair {
                public_key: decode_hex_key(&signed_pre_key_public, "signed pre-key public")?
                    .try_into()
                    .map_err(|_| anyhow!("signed pre-key public must be 32 bytes"))?,
                private_key: decode_hex_key(&signed_pre_key_private, "signed pre-key private")?
                    .try_into()
                    .map_err(|_| anyhow!("signed pre-key private must be 32 bytes"))?,
            },
            remote_ratchet_public_key: input.message.initiator_ephemeral_key.clone(),
            bootstrap,
            created_at: now,
        })?;

    Ok(ConsumeResponderPreKeyMessageResult {
        e2e: store_local_session(&next, &device_id, &session)?,
        plaintext,
        session,
        shared_secret,
    })
}
