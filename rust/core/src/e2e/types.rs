use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const E2E_PROTOCOL_VERSION: u8 = 1;
pub const X3DH_INFO: &str = "quadra-a/e2e/x3dh/v1";
pub const X3DH_SALT: &str = "quadra-a/e2e/x3dh/salt/v1";
pub const SIGNED_PRE_KEY_TYPE: &str = "SIGNED_PRE_KEY";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum E2EMessageType {
    #[serde(rename = "PREKEY_MESSAGE")]
    PreKeyMessage,
    #[serde(rename = "SESSION_MESSAGE")]
    SessionMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceDirectoryEntry {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "identityKeyPublic", with = "serde_bytes")]
    pub identity_key_public: Vec<u8>,
    #[serde(rename = "signedPreKeyPublic", with = "serde_bytes")]
    pub signed_pre_key_public: Vec<u8>,
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "signedPreKeySignature", with = "serde_bytes")]
    pub signed_pre_key_signature: Vec<u8>,
    #[serde(rename = "oneTimePreKeyCount")]
    pub one_time_pre_key_count: u32,
    #[serde(rename = "lastResupplyAt")]
    pub last_resupply_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishedDeviceDirectoryEntry {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "identityKeyPublic")]
    pub identity_key_public: String,
    #[serde(rename = "signedPreKeyPublic")]
    pub signed_pre_key_public: String,
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "signedPreKeySignature")]
    pub signed_pre_key_signature: String,
    #[serde(rename = "oneTimePreKeyCount")]
    pub one_time_pre_key_count: u32,
    #[serde(rename = "lastResupplyAt")]
    pub last_resupply_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishedOneTimePreKey {
    #[serde(rename = "keyId")]
    pub key_id: u32,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishedPreKeyBundle {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "identityKeyPublic")]
    pub identity_key_public: String,
    #[serde(rename = "signedPreKeyPublic")]
    pub signed_pre_key_public: String,
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "signedPreKeySignature")]
    pub signed_pre_key_signature: String,
    #[serde(rename = "oneTimePreKeyCount")]
    pub one_time_pre_key_count: u32,
    #[serde(rename = "lastResupplyAt")]
    pub last_resupply_at: u64,
    #[serde(rename = "oneTimePreKeys")]
    pub one_time_pre_keys: Vec<PublishedOneTimePreKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaimedPreKeyBundle {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "identityKeyPublic")]
    pub identity_key_public: String,
    #[serde(rename = "signedPreKeyPublic")]
    pub signed_pre_key_public: String,
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "signedPreKeySignature")]
    pub signed_pre_key_signature: String,
    #[serde(rename = "oneTimePreKeyCount")]
    pub one_time_pre_key_count: u32,
    #[serde(rename = "lastResupplyAt")]
    pub last_resupply_at: u64,
    #[serde(
        default,
        rename = "oneTimePreKey",
        skip_serializing_if = "Option::is_none"
    )]
    pub one_time_pre_key: Option<PublishedOneTimePreKey>,
    #[serde(rename = "remainingOneTimePreKeyCount")]
    pub remaining_one_time_pre_key_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalDeviceKeyPair {
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "privateKey")]
    pub private_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalSignedPreKeyState {
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "privateKey")]
    pub private_key: String,
    pub signature: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalOneTimePreKeyState {
    #[serde(rename = "keyId")]
    pub key_id: u32,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "privateKey")]
    pub private_key: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(default, rename = "claimedAt", skip_serializing_if = "Option::is_none")]
    pub claimed_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocalDeviceState {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "identityKey")]
    pub identity_key: LocalDeviceKeyPair,
    #[serde(rename = "signedPreKey")]
    pub signed_pre_key: LocalSignedPreKeyState,
    #[serde(rename = "oneTimePreKeys")]
    pub one_time_pre_keys: Vec<LocalOneTimePreKeyState>,
    #[serde(rename = "lastResupplyAt")]
    pub last_resupply_at: u64,
    #[serde(default)]
    pub sessions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LocalE2EConfig {
    #[serde(default, rename = "currentDeviceId")]
    pub current_device_id: String,
    #[serde(default)]
    pub devices: BTreeMap<String, LocalDeviceState>,
}

impl LocalE2EConfig {
    pub fn is_valid(&self) -> bool {
        !self.current_device_id.is_empty()
            && self.devices.contains_key(&self.current_device_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignedPreKeyRecord {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "signedPreKeyPublic", with = "serde_bytes")]
    pub signed_pre_key_public: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreKeyMessage {
    pub version: u8,
    #[serde(rename = "type")]
    pub message_type: E2EMessageType,
    #[serde(rename = "senderDid")]
    pub sender_did: String,
    #[serde(rename = "receiverDid")]
    pub receiver_did: String,
    #[serde(rename = "senderDeviceId")]
    pub sender_device_id: String,
    #[serde(rename = "receiverDeviceId")]
    pub receiver_device_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "initiatorIdentityKey", with = "serde_bytes")]
    pub initiator_identity_key: Vec<u8>,
    #[serde(rename = "initiatorEphemeralKey", with = "serde_bytes")]
    pub initiator_ephemeral_key: Vec<u8>,
    #[serde(rename = "recipientSignedPreKeyId")]
    pub recipient_signed_pre_key_id: u32,
    #[serde(
        rename = "recipientOneTimePreKeyId",
        skip_serializing_if = "Option::is_none"
    )]
    pub recipient_one_time_pre_key_id: Option<u32>,
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionMessage {
    pub version: u8,
    #[serde(rename = "type")]
    pub message_type: E2EMessageType,
    #[serde(rename = "senderDid")]
    pub sender_did: String,
    #[serde(rename = "receiverDid")]
    pub receiver_did: String,
    #[serde(rename = "senderDeviceId")]
    pub sender_device_id: String,
    #[serde(rename = "receiverDeviceId")]
    pub receiver_device_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "ratchetPublicKey", with = "serde_bytes")]
    pub ratchet_public_key: Vec<u8>,
    #[serde(rename = "previousChainLength")]
    pub previous_chain_length: u32,
    #[serde(rename = "messageNumber")]
    pub message_number: u32,
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}
