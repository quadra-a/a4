use anyhow::{Context, Result};

use crate::e2e::crypto::{diffie_hellman_x25519, hkdf_sha256};
use crate::e2e::types::{X3DH_INFO, X3DH_SALT};

fn derive_shared_secret(parts: Vec<[u8; 32]>) -> Result<Vec<u8>> {
    let mut combined = Vec::with_capacity(parts.len() * 32);
    for part in parts {
        combined.extend_from_slice(&part);
    }

    hkdf_sha256(&combined, X3DH_SALT.as_bytes(), X3DH_INFO.as_bytes(), 32)
        .context("Failed to derive X3DH shared secret")
}

pub fn derive_x3dh_initiator_shared_secret(
    initiator_identity_private: &[u8],
    initiator_ephemeral_private: &[u8],
    recipient_identity_public: &[u8],
    recipient_signed_pre_key_public: &[u8],
    recipient_one_time_pre_key_public: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let mut parts = vec![
        diffie_hellman_x25519(initiator_identity_private, recipient_signed_pre_key_public)?,
        diffie_hellman_x25519(initiator_ephemeral_private, recipient_identity_public)?,
        diffie_hellman_x25519(initiator_ephemeral_private, recipient_signed_pre_key_public)?,
    ];

    if let Some(one_time_pre_key_public) = recipient_one_time_pre_key_public {
        parts.push(diffie_hellman_x25519(
            initiator_ephemeral_private,
            one_time_pre_key_public,
        )?);
    }

    derive_shared_secret(parts)
}

pub fn derive_x3dh_responder_shared_secret(
    recipient_identity_private: &[u8],
    recipient_signed_pre_key_private: &[u8],
    initiator_identity_public: &[u8],
    initiator_ephemeral_public: &[u8],
    recipient_one_time_pre_key_private: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let mut parts = vec![
        diffie_hellman_x25519(recipient_signed_pre_key_private, initiator_identity_public)?,
        diffie_hellman_x25519(recipient_identity_private, initiator_ephemeral_public)?,
        diffie_hellman_x25519(recipient_signed_pre_key_private, initiator_ephemeral_public)?,
    ];

    if let Some(one_time_pre_key_private) = recipient_one_time_pre_key_private {
        parts.push(diffie_hellman_x25519(
            one_time_pre_key_private,
            initiator_ephemeral_public,
        )?);
    }

    derive_shared_secret(parts)
}
