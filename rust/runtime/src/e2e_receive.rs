use anyhow::{anyhow, Result};

use quadra_a_core::config::Config;
use quadra_a_core::e2e::{decrypt_application_envelope, DecryptApplicationEnvelopeInput};
use quadra_a_core::protocol::Envelope;

pub struct PreparedEncryptedReceive {
    pub application_envelope: Envelope,
    pub config: Config,
    pub transport: String,
    pub sender_device_id: String,
    pub receiver_device_id: String,
    pub session_id: String,
    pub used_skipped_message_key: bool,
}

pub fn prepare_encrypted_receive(
    config: &Config,
    transport_envelope: &Envelope,
) -> Result<PreparedEncryptedReceive> {
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow!("Missing identity config"))?;
    let e2e = config
        .e2e
        .as_ref()
        .ok_or_else(|| anyhow!("Missing local E2E config"))?;

    let decrypted = decrypt_application_envelope(DecryptApplicationEnvelopeInput {
        e2e,
        receiver_did: &identity.did,
        transport_envelope,
        now: None,
    })?;

    let mut next_config = config.clone();
    next_config.e2e = Some(decrypted.e2e);

    Ok(PreparedEncryptedReceive {
        application_envelope: decrypted.application_envelope,
        config: next_config,
        transport: decrypted.transport.to_string(),
        sender_device_id: decrypted.sender_device_id,
        receiver_device_id: decrypted.receiver_device_id,
        session_id: decrypted.session_id,
        used_skipped_message_key: decrypted.used_skipped_message_key,
    })
}
