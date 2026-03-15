use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::{Config, DeviceIdentityConfig};
use crate::e2e::crypto::{bytes_to_hex, generate_x25519_key_pair, random_bytes};
use crate::e2e::signed_pre_key::sign_signed_pre_key_record;
use crate::e2e::types::{
    ClaimedPreKeyBundle, LocalDeviceKeyPair, LocalDeviceState, LocalE2EConfig,
    LocalOneTimePreKeyState, LocalSignedPreKeyState, PublishedDeviceDirectoryEntry,
    PublishedOneTimePreKey, PublishedPreKeyBundle,
};
use crate::identity::KeyPair;

pub const DEFAULT_ONE_TIME_PRE_KEY_COUNT: usize = 16;
const DEVICE_ID_DERIVATION_DOMAIN: &[u8] = b"quadra-a/device-id/v1";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn generate_device_id() -> String {
    format!("device-{}", hex::encode(random_bytes(8)))
}

pub fn derive_device_id(seed_hex: &str) -> Result<String> {
    let seed = hex::decode(seed_hex).map_err(|error| anyhow!("Invalid device identity seed: {}", error))?;
    let mut hasher = Sha256::new();
    hasher.update(DEVICE_ID_DERIVATION_DOMAIN);
    hasher.update(seed);
    let digest = hasher.finalize();
    Ok(format!("device-{}", hex::encode(&digest[..8])))
}

fn create_device_identity(existing_device_id: Option<String>) -> Result<DeviceIdentityConfig> {
    let seed_hex = bytes_to_hex(&random_bytes(32));
    let device_id = match existing_device_id {
        Some(device_id) => device_id,
        None => derive_device_id(&seed_hex)?,
    };

    Ok(DeviceIdentityConfig {
        seed: seed_hex,
        device_id,
    })
}

pub fn ensure_device_identity(config: &mut Config) -> Result<bool> {
    let is_valid = config
        .device_identity
        .as_ref()
        .is_some_and(|device_identity| {
            !device_identity.seed.is_empty() && !device_identity.device_id.is_empty()
        });
    if is_valid {
        return Ok(false);
    }

    let existing_device_id = config
        .e2e
        .as_ref()
        .filter(|e2e| e2e.is_valid())
        .map(|e2e| e2e.current_device_id.clone());
    config.device_identity = Some(create_device_identity(existing_device_id)?);
    Ok(true)
}

fn build_one_time_pre_keys(count: usize, created_at: u64) -> Vec<LocalOneTimePreKeyState> {
    (0..count)
        .map(|index| {
            let key_pair = generate_x25519_key_pair();
            LocalOneTimePreKeyState {
                key_id: (index + 1) as u32,
                public_key: bytes_to_hex(&key_pair.public_key),
                private_key: bytes_to_hex(&key_pair.private_key),
                created_at,
                claimed_at: None,
            }
        })
        .collect()
}

fn build_published_one_time_pre_keys(device: &LocalDeviceState) -> Vec<PublishedOneTimePreKey> {
    let mut keys: Vec<PublishedOneTimePreKey> = device
        .one_time_pre_keys
        .iter()
        .filter(|key| key.claimed_at.is_none())
        .map(|key| PublishedOneTimePreKey {
            key_id: key.key_id,
            public_key: key.public_key.clone(),
        })
        .collect();
    keys.sort_by_key(|key| key.key_id);
    keys
}

pub fn create_local_device_state(
    signing_keypair: &KeyPair,
    device_id: Option<String>,
    signed_pre_key_id: Option<u32>,
    one_time_pre_key_count: usize,
    created_at: u64,
) -> Result<LocalDeviceState> {
    let device_id = device_id.unwrap_or_else(generate_device_id);
    let signed_pre_key_id = signed_pre_key_id.unwrap_or(1);
    let identity_key_pair = generate_x25519_key_pair();
    let signed_pre_key_pair = generate_x25519_key_pair();
    let signed_pre_key_record = sign_signed_pre_key_record(
        &device_id,
        signed_pre_key_id,
        &signed_pre_key_pair.public_key,
        signing_keypair,
    )?;

    Ok(LocalDeviceState {
        device_id: device_id.clone(),
        created_at,
        identity_key: LocalDeviceKeyPair {
            public_key: bytes_to_hex(&identity_key_pair.public_key),
            private_key: bytes_to_hex(&identity_key_pair.private_key),
        },
        signed_pre_key: LocalSignedPreKeyState {
            signed_pre_key_id,
            public_key: bytes_to_hex(&signed_pre_key_pair.public_key),
            private_key: bytes_to_hex(&signed_pre_key_pair.private_key),
            signature: bytes_to_hex(&signed_pre_key_record.signature),
            created_at,
        },
        one_time_pre_keys: build_one_time_pre_keys(one_time_pre_key_count, created_at),
        last_resupply_at: created_at,
        sessions: BTreeMap::new(),
    })
}

pub fn rotate_local_device_signed_pre_key(
    signing_keypair: &KeyPair,
    e2e: &LocalE2EConfig,
    device_id: &str,
    signed_pre_key_id: Option<u32>,
    one_time_pre_key_count: Option<usize>,
    created_at: Option<u64>,
) -> Result<LocalE2EConfig> {
    let existing_device = e2e
        .devices
        .get(device_id)
        .ok_or_else(|| anyhow!("Missing local E2E device {}", device_id))?;

    let mut next_config = e2e.clone();
    let next_signed_pre_key_id = signed_pre_key_id.unwrap_or_else(|| {
        e2e.devices
            .values()
            .map(|device| device.signed_pre_key.signed_pre_key_id)
            .max()
            .unwrap_or(0)
            + 1
    });
    let created_at = created_at.unwrap_or_else(now_ms);
    let available_otks = existing_device
        .one_time_pre_keys
        .iter()
        .filter(|key| key.claimed_at.is_none())
        .count();
    let next_one_time_pre_key_count = one_time_pre_key_count
        .unwrap_or_else(|| available_otks.max(DEFAULT_ONE_TIME_PRE_KEY_COUNT));
    let signed_pre_key_pair = generate_x25519_key_pair();
    let signed_pre_key_record = sign_signed_pre_key_record(
        device_id,
        next_signed_pre_key_id,
        &signed_pre_key_pair.public_key,
        signing_keypair,
    )?;

    let next_device = next_config
        .devices
        .get_mut(device_id)
        .ok_or_else(|| anyhow!("Missing local E2E device {}", device_id))?;
    next_device.signed_pre_key = LocalSignedPreKeyState {
        signed_pre_key_id: next_signed_pre_key_id,
        public_key: bytes_to_hex(&signed_pre_key_pair.public_key),
        private_key: bytes_to_hex(&signed_pre_key_pair.private_key),
        signature: bytes_to_hex(&signed_pre_key_record.signature),
        created_at,
    };
    next_device.one_time_pre_keys = build_one_time_pre_keys(next_one_time_pre_key_count, created_at);
    next_device.last_resupply_at = created_at;

    Ok(next_config)
}

pub fn create_initial_local_e2e_config(signing_keypair: &KeyPair) -> Result<LocalE2EConfig> {
    create_initial_local_e2e_config_with_device_id(signing_keypair, generate_device_id())
}

pub fn create_initial_local_e2e_config_with_device_id(
    signing_keypair: &KeyPair,
    device_id: String,
) -> Result<LocalE2EConfig> {
    let created_at = now_ms();
    let device = create_local_device_state(
        signing_keypair,
        Some(device_id),
        None,
        DEFAULT_ONE_TIME_PRE_KEY_COUNT,
        created_at,
    )?;
    let mut devices = BTreeMap::new();
    devices.insert(device.device_id.clone(), device.clone());

    Ok(LocalE2EConfig {
        current_device_id: device.device_id,
        devices,
    })
}

pub fn ensure_local_e2e_config(config: &mut Config) -> Result<bool> {
    ensure_device_identity(config)?;

    if let Some(existing) = &config.e2e {
        if existing.is_valid() {
            return Ok(false);
        }
    }

    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow!("Identity must exist before E2E state can be created"))?;
    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let device_id = config
        .device_identity
        .as_ref()
        .map(|device_identity| device_identity.device_id.clone())
        .ok_or_else(|| anyhow!("Device identity must exist before E2E state can be created"))?;
    config.e2e = Some(create_initial_local_e2e_config_with_device_id(&keypair, device_id)?);
    Ok(true)
}

pub fn build_published_device_directory_entry(
    device: &LocalDeviceState,
) -> PublishedDeviceDirectoryEntry {
    PublishedDeviceDirectoryEntry {
        device_id: device.device_id.clone(),
        identity_key_public: device.identity_key.public_key.clone(),
        signed_pre_key_public: device.signed_pre_key.public_key.clone(),
        signed_pre_key_id: device.signed_pre_key.signed_pre_key_id,
        signed_pre_key_signature: device.signed_pre_key.signature.clone(),
        one_time_pre_key_count: device
            .one_time_pre_keys
            .iter()
            .filter(|key| key.claimed_at.is_none())
            .count() as u32,
        last_resupply_at: device.last_resupply_at,
    }
}

pub fn build_published_device_directory(
    e2e: &LocalE2EConfig,
) -> Vec<PublishedDeviceDirectoryEntry> {
    e2e.devices
        .values()
        .map(build_published_device_directory_entry)
        .collect()
}

pub fn build_published_pre_key_bundle(device: &LocalDeviceState) -> PublishedPreKeyBundle {
    PublishedPreKeyBundle {
        device_id: device.device_id.clone(),
        identity_key_public: device.identity_key.public_key.clone(),
        signed_pre_key_public: device.signed_pre_key.public_key.clone(),
        signed_pre_key_id: device.signed_pre_key.signed_pre_key_id,
        signed_pre_key_signature: device.signed_pre_key.signature.clone(),
        one_time_pre_key_count: device
            .one_time_pre_keys
            .iter()
            .filter(|key| key.claimed_at.is_none())
            .count() as u32,
        last_resupply_at: device.last_resupply_at,
        one_time_pre_keys: build_published_one_time_pre_keys(device),
    }
}

pub fn build_published_pre_key_bundles(e2e: &LocalE2EConfig) -> Vec<PublishedPreKeyBundle> {
    e2e.devices
        .values()
        .map(build_published_pre_key_bundle)
        .collect()
}

pub fn build_claimed_pre_key_bundle(
    bundle: &PublishedPreKeyBundle,
    one_time_pre_key: Option<PublishedOneTimePreKey>,
) -> ClaimedPreKeyBundle {
    let remaining = if one_time_pre_key.is_some() {
        bundle.one_time_pre_keys.len().saturating_sub(1) as u32
    } else {
        bundle.one_time_pre_keys.len() as u32
    };

    ClaimedPreKeyBundle {
        device_id: bundle.device_id.clone(),
        identity_key_public: bundle.identity_key_public.clone(),
        signed_pre_key_public: bundle.signed_pre_key_public.clone(),
        signed_pre_key_id: bundle.signed_pre_key_id,
        signed_pre_key_signature: bundle.signed_pre_key_signature.clone(),
        one_time_pre_key_count: remaining,
        last_resupply_at: bundle.last_resupply_at,
        one_time_pre_key,
        remaining_one_time_pre_key_count: remaining,
    }
}

pub fn current_device_state<'a>(e2e: &'a LocalE2EConfig) -> Result<&'a LocalDeviceState> {
    e2e.devices
        .get(&e2e.current_device_id)
        .ok_or_else(|| anyhow!("Missing current E2E device {}", e2e.current_device_id))
}

#[cfg(test)]
mod tests {
    use super::{
        create_initial_local_e2e_config, create_initial_local_e2e_config_with_device_id,
        derive_device_id, rotate_local_device_signed_pre_key,
    };
    use crate::identity::KeyPair;

    #[test]
    fn rotates_one_device_signed_pre_key_without_disturbing_sessions() {
        let signing_keypair = KeyPair::generate();
        let mut e2e = create_initial_local_e2e_config(&signing_keypair).expect("create initial e2e");
        let device_id = e2e.current_device_id.clone();
        let original = e2e
            .devices
            .get_mut(&device_id)
            .expect("current device exists");
        original
            .sessions
            .insert("did:agent:zpeer:device-peer".to_string(), serde_json::json!({"sessionId": "session-existing"}));
        let original = original.clone();

        let rotated = rotate_local_device_signed_pre_key(
            &signing_keypair,
            &e2e,
            &device_id,
            None,
            None,
            Some(123456),
        )
        .expect("rotate signed pre-key");
        let rotated_device = rotated.devices.get(&device_id).expect("rotated device exists");

        assert_eq!(rotated_device.identity_key, original.identity_key);
        assert_eq!(rotated_device.sessions, original.sessions);
        assert!(rotated_device.signed_pre_key.signed_pre_key_id > original.signed_pre_key.signed_pre_key_id);
        assert_ne!(rotated_device.signed_pre_key.public_key, original.signed_pre_key.public_key);
        assert_eq!(rotated_device.last_resupply_at, 123456);
        assert_eq!(rotated_device.one_time_pre_keys.len(), 16);
    }

    #[test]
    fn create_initial_config_uses_explicit_device_id() {
        let signing_keypair = KeyPair::generate();
        let e2e = create_initial_local_e2e_config_with_device_id(
            &signing_keypair,
            "device-stable".to_string(),
        )
        .expect("create initial e2e");

        assert_eq!(e2e.current_device_id, "device-stable");
        assert!(e2e.devices.contains_key("device-stable"));
    }

    #[test]
    fn derive_device_id_is_stable_for_same_seed() {
        let device_id = derive_device_id(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        )
        .expect("derive device id");

        assert_eq!(device_id, "device-f2f59669be519c02");
    }
}
