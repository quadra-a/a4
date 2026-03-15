use anyhow::{anyhow, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::e2e::cbor_x::{encode, E2eCborValue};
use crate::e2e::types::{SignedPreKeyRecord, E2E_PROTOCOL_VERSION, SIGNED_PRE_KEY_TYPE};
use crate::identity::KeyPair;

pub fn build_signed_pre_key_payload(
    device_id: &str,
    signed_pre_key_id: u32,
    signed_pre_key_public: &[u8],
) -> Result<Vec<u8>> {
    Ok(encode(&E2eCborValue::Map(vec![
        ("type", E2eCborValue::Str(SIGNED_PRE_KEY_TYPE)),
        ("version", E2eCborValue::Int(E2E_PROTOCOL_VERSION as i64)),
        ("deviceId", E2eCborValue::Str(device_id)),
        (
            "signedPreKeyId",
            E2eCborValue::Int(signed_pre_key_id as i64),
        ),
        (
            "signedPreKeyPublic",
            E2eCborValue::TypedBytes(signed_pre_key_public),
        ),
    ])))
}

pub fn sign_signed_pre_key_record(
    device_id: &str,
    signed_pre_key_id: u32,
    signed_pre_key_public: &[u8],
    signing_keypair: &KeyPair,
) -> Result<SignedPreKeyRecord> {
    let payload =
        build_signed_pre_key_payload(device_id, signed_pre_key_id, signed_pre_key_public)?;
    let signature = signing_keypair.sign(&payload);

    Ok(SignedPreKeyRecord {
        device_id: device_id.to_string(),
        signed_pre_key_id,
        signed_pre_key_public: signed_pre_key_public.to_vec(),
        signature,
    })
}

pub fn verify_signed_pre_key_record(
    record: &SignedPreKeyRecord,
    signing_public_key: &[u8],
) -> Result<bool> {
    if record.signature.len() != 64 || signing_public_key.len() != 32 {
        return Ok(false);
    }

    let verifying_key = VerifyingKey::from_bytes(
        &signing_public_key
            .try_into()
            .map_err(|_| anyhow!("Invalid Ed25519 public key length"))?,
    )
    .map_err(|_| anyhow!("Invalid Ed25519 public key"))?;
    let signature = Signature::from_slice(&record.signature)
        .map_err(|_| anyhow!("Invalid Ed25519 signature"))?;
    let payload = build_signed_pre_key_payload(
        &record.device_id,
        record.signed_pre_key_id,
        &record.signed_pre_key_public,
    )?;

    Ok(verifying_key.verify(&payload, &signature).is_ok())
}
