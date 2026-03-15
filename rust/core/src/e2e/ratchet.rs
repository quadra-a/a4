use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::e2e::bootstrap::LocalSessionBootstrapState;
use crate::e2e::crypto::{
    bytes_to_hex, diffie_hellman_x25519, generate_x25519_key_pair, hkdf_sha256, random_bytes,
    X25519KeyPair,
};
use crate::e2e::messages::{decrypt_session_message, encrypt_session_message};
use crate::e2e::types::{E2EMessageType, LocalDeviceKeyPair, SessionMessage, E2E_PROTOCOL_VERSION};

pub const DOUBLE_RATCHET_ROOT_INFO: &str = "quadra-a/e2e/double-ratchet/root/v1";
pub const DOUBLE_RATCHET_CHAIN_INFO: &str = "quadra-a/e2e/double-ratchet/chain/v1";
pub const DOUBLE_RATCHET_CHAIN_SALT: &str = "quadra-a/e2e/double-ratchet/chain-salt/v1";
pub const MAX_SKIPPED_MESSAGE_KEYS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkippedMessageKeyState {
    #[serde(rename = "ratchetPublicKey")]
    pub ratchet_public_key: String,
    #[serde(rename = "messageNumber")]
    pub message_number: u32,
    #[serde(rename = "messageKey")]
    pub message_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalSessionState {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "peerDid")]
    pub peer_did: String,
    #[serde(rename = "peerDeviceId")]
    pub peer_device_id: String,
    #[serde(rename = "selfDeviceId")]
    pub self_device_id: String,
    pub role: String,
    #[serde(rename = "establishedBy")]
    pub established_by: String,
    pub phase: String,
    #[serde(rename = "rootKey")]
    pub root_key: String,
    #[serde(rename = "currentRatchetKey")]
    pub current_ratchet_key: LocalDeviceKeyPair,
    #[serde(rename = "remoteRatchetPublicKey")]
    pub remote_ratchet_public_key: String,
    #[serde(
        default,
        rename = "sendingChainKey",
        skip_serializing_if = "Option::is_none"
    )]
    pub sending_chain_key: Option<String>,
    #[serde(
        default,
        rename = "receivingChainKey",
        skip_serializing_if = "Option::is_none"
    )]
    pub receiving_chain_key: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(rename = "nextSendMessageNumber")]
    pub next_send_message_number: u32,
    #[serde(rename = "nextReceiveMessageNumber")]
    pub next_receive_message_number: u32,
    #[serde(rename = "previousSendChainLength")]
    pub previous_send_chain_length: u32,
    #[serde(rename = "skippedMessageKeys")]
    pub skipped_message_keys: Vec<SkippedMessageKeyState>,
    pub bootstrap: LocalSessionBootstrapState,
}

pub struct CreateRatchetSessionInput {
    pub session_id: String,
    pub peer_did: String,
    pub peer_device_id: String,
    pub self_device_id: String,
    pub role: String,
    pub root_key: Vec<u8>,
    pub current_ratchet_key: X25519KeyPair,
    pub remote_ratchet_public_key: Vec<u8>,
    pub bootstrap: LocalSessionBootstrapState,
    pub created_at: u64,
}

pub struct RatchetEncryptInput<'a> {
    pub session: &'a LocalSessionState,
    pub plaintext: &'a [u8],
    pub sender_did: &'a str,
    pub receiver_did: &'a str,
    pub message_id: Option<String>,
    pub nonce: Option<Vec<u8>>,
    pub ratchet_keypair: Option<X25519KeyPair>,
    pub now: Option<u64>,
}

pub struct RatchetEncryptResult {
    pub message: SessionMessage,
    pub session: LocalSessionState,
    pub message_key: Vec<u8>,
}

pub struct RatchetDecryptInput<'a> {
    pub session: &'a LocalSessionState,
    pub message: &'a SessionMessage,
    pub now: Option<u64>,
}

pub struct RatchetDecryptResult {
    pub plaintext: Vec<u8>,
    pub session: LocalSessionState,
    pub message_key: Vec<u8>,
    pub used_skipped_message_key: bool,
}

fn derive_root_and_chain_keys(root_key: &[u8], dh_output: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let material = hkdf_sha256(dh_output, root_key, DOUBLE_RATCHET_ROOT_INFO.as_bytes(), 64)?;
    Ok((material[0..32].to_vec(), material[32..64].to_vec()))
}

fn derive_chain_step(chain_key: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let material = hkdf_sha256(
        chain_key,
        DOUBLE_RATCHET_CHAIN_SALT.as_bytes(),
        DOUBLE_RATCHET_CHAIN_INFO.as_bytes(),
        64,
    )?;
    Ok((material[0..32].to_vec(), material[32..64].to_vec()))
}

fn decode_hex_key(value: &str, label: &str) -> Result<Vec<u8>> {
    hex::decode(value).map_err(|_| anyhow!("Failed to decode {} hex", label))
}

fn generate_message_id() -> String {
    format!("e2e-msg-{}", hex::encode(random_bytes(12)))
}

fn assert_nonce(nonce: &[u8]) -> Result<()> {
    if nonce.len() != 24 {
        anyhow::bail!("Double Ratchet nonce must be 24 bytes, got {}", nonce.len());
    }
    Ok(())
}

fn store_skipped_message_key(
    session: &mut LocalSessionState,
    ratchet_public_key: &str,
    message_number: u32,
    message_key: &[u8],
) {
    session.skipped_message_keys.push(SkippedMessageKeyState {
        ratchet_public_key: ratchet_public_key.to_string(),
        message_number,
        message_key: bytes_to_hex(message_key),
    });
    if session.skipped_message_keys.len() > MAX_SKIPPED_MESSAGE_KEYS {
        let overflow = session.skipped_message_keys.len() - MAX_SKIPPED_MESSAGE_KEYS;
        session.skipped_message_keys.drain(0..overflow);
    }
}

fn take_skipped_message_key(
    session: &mut LocalSessionState,
    ratchet_public_key: &str,
    message_number: u32,
) -> Result<Option<Vec<u8>>> {
    let Some(index) = session.skipped_message_keys.iter().position(|entry| {
        entry.ratchet_public_key == ratchet_public_key && entry.message_number == message_number
    }) else {
        return Ok(None);
    };

    let entry = session.skipped_message_keys.remove(index);
    Ok(Some(decode_hex_key(
        &entry.message_key,
        "skipped message key",
    )?))
}

fn skip_message_keys(session: &mut LocalSessionState, until_message_number: u32) -> Result<()> {
    if until_message_number < session.next_receive_message_number {
        return Ok(());
    }

    let Some(mut chain_key) = session
        .receiving_chain_key
        .as_ref()
        .map(|value| decode_hex_key(value, "receiving chain key"))
        .transpose()?
    else {
        if until_message_number == session.next_receive_message_number {
            return Ok(());
        }
        anyhow::bail!(
            "Missing receiving chain key while skipping messages: until={}, next={}",
            until_message_number,
            session.next_receive_message_number
        );
    };

    let gap = until_message_number - session.next_receive_message_number;
    if gap as usize > MAX_SKIPPED_MESSAGE_KEYS {
        anyhow::bail!(
            "Skipped-message window exceeded: gap={}, max={}",
            gap,
            MAX_SKIPPED_MESSAGE_KEYS
        );
    }

    while session.next_receive_message_number < until_message_number {
        let (next_chain_key, message_key) = derive_chain_step(&chain_key)?;
        let remote_ratchet_public_key = session.remote_ratchet_public_key.clone();
        let skipped_message_number = session.next_receive_message_number;
        store_skipped_message_key(
            session,
            &remote_ratchet_public_key,
            skipped_message_number,
            &message_key,
        );
        session.next_receive_message_number += 1;
        chain_key = next_chain_key;
    }

    session.receiving_chain_key = Some(bytes_to_hex(&chain_key));
    Ok(())
}

fn ensure_sending_chain(
    session: &mut LocalSessionState,
    next_ratchet_keypair: Option<X25519KeyPair>,
) -> Result<()> {
    if session.sending_chain_key.is_some() {
        return Ok(());
    }

    let ratchet_keypair = next_ratchet_keypair.unwrap_or_else(generate_x25519_key_pair);
    let dh_output = diffie_hellman_x25519(
        &ratchet_keypair.private_key,
        &decode_hex_key(
            &session.remote_ratchet_public_key,
            "remote ratchet public key",
        )?,
    )?;
    let (root_key, chain_key) =
        derive_root_and_chain_keys(&decode_hex_key(&session.root_key, "root key")?, &dh_output)?;
    session.root_key = bytes_to_hex(&root_key);
    session.current_ratchet_key = LocalDeviceKeyPair {
        public_key: bytes_to_hex(&ratchet_keypair.public_key),
        private_key: bytes_to_hex(&ratchet_keypair.private_key),
    };
    session.sending_chain_key = Some(bytes_to_hex(&chain_key));
    session.previous_send_chain_length = session.next_send_message_number;
    session.next_send_message_number = 0;
    Ok(())
}

fn advance_receiving_ratchet(
    session: &mut LocalSessionState,
    remote_ratchet_public_key: &[u8],
) -> Result<()> {
    let dh_output = diffie_hellman_x25519(
        &decode_hex_key(
            &session.current_ratchet_key.private_key,
            "current ratchet private key",
        )?,
        remote_ratchet_public_key,
    )?;
    let (root_key, chain_key) =
        derive_root_and_chain_keys(&decode_hex_key(&session.root_key, "root key")?, &dh_output)?;
    session.root_key = bytes_to_hex(&root_key);
    session.remote_ratchet_public_key = bytes_to_hex(remote_ratchet_public_key);
    session.receiving_chain_key = Some(bytes_to_hex(&chain_key));
    session.next_receive_message_number = 0;
    session.sending_chain_key = None;
    Ok(())
}

pub fn create_initiator_ratchet_session(
    input: CreateRatchetSessionInput,
) -> Result<LocalSessionState> {
    let dh_output = diffie_hellman_x25519(
        &input.current_ratchet_key.private_key,
        &input.remote_ratchet_public_key,
    )?;
    let (root_key, chain_key) = derive_root_and_chain_keys(&input.root_key, &dh_output)?;
    Ok(LocalSessionState {
        session_id: input.session_id,
        peer_did: input.peer_did,
        peer_device_id: input.peer_device_id,
        self_device_id: input.self_device_id,
        role: input.role,
        established_by: "prekey".to_string(),
        phase: "ratchet-active".to_string(),
        root_key: bytes_to_hex(&root_key),
        current_ratchet_key: LocalDeviceKeyPair {
            public_key: bytes_to_hex(&input.current_ratchet_key.public_key),
            private_key: bytes_to_hex(&input.current_ratchet_key.private_key),
        },
        remote_ratchet_public_key: bytes_to_hex(&input.remote_ratchet_public_key),
        sending_chain_key: Some(bytes_to_hex(&chain_key)),
        receiving_chain_key: None,
        created_at: input.created_at,
        updated_at: input.created_at,
        next_send_message_number: 0,
        next_receive_message_number: 0,
        previous_send_chain_length: 0,
        skipped_message_keys: Vec::new(),
        bootstrap: input.bootstrap,
    })
}

pub fn create_responder_ratchet_session(
    input: CreateRatchetSessionInput,
) -> Result<LocalSessionState> {
    let dh_output = diffie_hellman_x25519(
        &input.current_ratchet_key.private_key,
        &input.remote_ratchet_public_key,
    )?;
    let (root_key, chain_key) = derive_root_and_chain_keys(&input.root_key, &dh_output)?;
    Ok(LocalSessionState {
        session_id: input.session_id,
        peer_did: input.peer_did,
        peer_device_id: input.peer_device_id,
        self_device_id: input.self_device_id,
        role: input.role,
        established_by: "prekey".to_string(),
        phase: "ratchet-active".to_string(),
        root_key: bytes_to_hex(&root_key),
        current_ratchet_key: LocalDeviceKeyPair {
            public_key: bytes_to_hex(&input.current_ratchet_key.public_key),
            private_key: bytes_to_hex(&input.current_ratchet_key.private_key),
        },
        remote_ratchet_public_key: bytes_to_hex(&input.remote_ratchet_public_key),
        sending_chain_key: None,
        receiving_chain_key: Some(bytes_to_hex(&chain_key)),
        created_at: input.created_at,
        updated_at: input.created_at,
        next_send_message_number: 0,
        next_receive_message_number: 0,
        previous_send_chain_length: 0,
        skipped_message_keys: Vec::new(),
        bootstrap: input.bootstrap,
    })
}

pub fn encrypt_ratchet_message(input: RatchetEncryptInput<'_>) -> Result<RatchetEncryptResult> {
    let mut session = input.session.clone();
    ensure_sending_chain(&mut session, input.ratchet_keypair)?;

    let sending_chain_key = session
        .sending_chain_key
        .as_ref()
        .ok_or_else(|| anyhow!("Missing sending chain key after ratchet initialization"))?;
    let (next_chain_key, message_key) =
        derive_chain_step(&decode_hex_key(sending_chain_key, "sending chain key")?)?;
    let nonce = input.nonce.unwrap_or_else(|| random_bytes(24));
    assert_nonce(&nonce)?;
    let message = encrypt_session_message(
        &SessionMessage {
            version: E2E_PROTOCOL_VERSION,
            message_type: E2EMessageType::SessionMessage,
            sender_did: input.sender_did.to_string(),
            receiver_did: input.receiver_did.to_string(),
            sender_device_id: session.self_device_id.clone(),
            receiver_device_id: session.peer_device_id.clone(),
            session_id: session.session_id.clone(),
            message_id: input.message_id.unwrap_or_else(generate_message_id),
            ratchet_public_key: decode_hex_key(
                &session.current_ratchet_key.public_key,
                "current ratchet public key",
            )?,
            previous_chain_length: session.previous_send_chain_length,
            message_number: session.next_send_message_number,
            nonce,
            ciphertext: Vec::new(),
        },
        &message_key,
        input.plaintext,
    )?;

    session.sending_chain_key = Some(bytes_to_hex(&next_chain_key));
    session.next_send_message_number += 1;
    session.updated_at = input.now.unwrap_or(session.updated_at);

    Ok(RatchetEncryptResult {
        message,
        session,
        message_key,
    })
}

pub fn decrypt_ratchet_message(input: RatchetDecryptInput<'_>) -> Result<RatchetDecryptResult> {
    let mut session = input.session.clone();
    let ratchet_public_key = bytes_to_hex(&input.message.ratchet_public_key);

    if let Some(message_key) = take_skipped_message_key(
        &mut session,
        &ratchet_public_key,
        input.message.message_number,
    )? {
        let plaintext = decrypt_session_message(input.message, &message_key)?;
        session.updated_at = input.now.unwrap_or(session.updated_at);
        return Ok(RatchetDecryptResult {
            plaintext,
            session,
            message_key,
            used_skipped_message_key: true,
        });
    }

    if ratchet_public_key != session.remote_ratchet_public_key {
        skip_message_keys(&mut session, input.message.previous_chain_length)?;
        advance_receiving_ratchet(&mut session, &input.message.ratchet_public_key)?;
    }

    skip_message_keys(&mut session, input.message.message_number)?;
    let receiving_chain_key = session
        .receiving_chain_key
        .as_ref()
        .ok_or_else(|| anyhow!("Missing receiving chain key for session message decryption"))?;
    let (next_chain_key, message_key) =
        derive_chain_step(&decode_hex_key(receiving_chain_key, "receiving chain key")?)?;
    let plaintext = decrypt_session_message(input.message, &message_key)?;
    session.receiving_chain_key = Some(bytes_to_hex(&next_chain_key));
    session.next_receive_message_number = input.message.message_number + 1;
    session.updated_at = input.now.unwrap_or(session.updated_at);

    Ok(RatchetDecryptResult {
        plaintext,
        session,
        message_key,
        used_skipped_message_key: false,
    })
}
