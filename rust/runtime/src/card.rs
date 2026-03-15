use anyhow::Result;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

use quadra_a_core::config::{Config, IdentityConfig};
use quadra_a_core::e2e::{
    build_published_device_directory, build_published_pre_key_bundles,
    PublishedDeviceDirectoryEntry, PublishedPreKeyBundle,
};
use quadra_a_core::identity::{derive_did, KeyPair};
use quadra_a_core::protocol::{AgentCard, AgentCardUnsigned, Capability};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn build_capabilities(capabilities: &[String]) -> Vec<Capability> {
    capabilities
        .iter()
        .map(|capability| Capability {
            id: capability.clone(),
            name: capability.replace('-', " "),
            description: capability.clone(),
            parameters: None,
            metadata: None,
        })
        .collect()
}

pub fn build_published_prekey_bundles_from_config(config: &Config) -> Vec<PublishedPreKeyBundle> {
    config
        .e2e
        .as_ref()
        .map(build_published_pre_key_bundles)
        .unwrap_or_default()
}

pub fn build_signed_agent_card(
    keypair: &KeyPair,
    did: String,
    name: String,
    description: String,
    capabilities: Vec<Capability>,
    devices: Option<Vec<PublishedDeviceDirectoryEntry>>,
    metadata: Option<Value>,
) -> AgentCard {
    let timestamp = now_ms();
    let unsigned = AgentCardUnsigned {
        did,
        name,
        description,
        version: "1.0.0".to_string(),
        capabilities,
        endpoints: vec![],
        devices,
        peer_id: None,
        trust: None,
        metadata,
        timestamp,
    };

    let signature = AgentCard::sign(&unsigned, keypair);
    AgentCard {
        did: unsigned.did,
        name: unsigned.name,
        description: unsigned.description,
        version: unsigned.version,
        capabilities: unsigned.capabilities,
        endpoints: unsigned.endpoints,
        devices: unsigned.devices,
        peer_id: unsigned.peer_id,
        trust: unsigned.trust,
        metadata: unsigned.metadata,
        timestamp: unsigned.timestamp,
        signature,
    }
}

pub fn build_agent_card_from_config(
    config: &Config,
    identity: &IdentityConfig,
) -> Result<AgentCard> {
    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let (name, description, capabilities) = if let Some(agent_card) = &config.agent_card {
        (
            agent_card.name.clone(),
            agent_card.description.clone(),
            build_capabilities(&agent_card.capabilities),
        )
    } else {
        ("Unknown Agent".to_string(), "".to_string(), Vec::new())
    };
    let devices = config
        .e2e
        .as_ref()
        .map(build_published_device_directory)
        .filter(|entries| !entries.is_empty());

    Ok(build_signed_agent_card(
        &keypair,
        identity.did.clone(),
        name,
        description,
        capabilities,
        devices,
        None,
    ))
}

pub fn build_ephemeral_query_identity() -> (String, KeyPair, AgentCard) {
    let keypair = KeyPair::generate();
    let did = derive_did(keypair.verifying_key.as_bytes());
    let card = build_signed_agent_card(
        &keypair,
        did.clone(),
        "Rust Daemon Query".to_string(),
        "Internal query session".to_string(),
        Vec::new(),
        None,
        Some(serde_json::json!({"internal": true})),
    );
    (did, keypair, card)
}

#[cfg(test)]
mod tests {
    use super::{build_agent_card_from_config, build_published_prekey_bundles_from_config};
    use quadra_a_core::config::{AgentCardConfig, Config, IdentityConfig};
    use quadra_a_core::e2e::ensure_local_e2e_config;
    use quadra_a_core::identity::KeyPair;

    #[test]
    fn build_agent_card_from_config_publishes_device_directory() {
        let keypair = KeyPair::generate();
        let did = quadra_a_core::identity::derive_did(keypair.verifying_key.as_bytes());
        let mut config = Config {
            identity: Some(IdentityConfig {
                did: did.clone(),
                public_key: keypair.public_key_hex(),
                private_key: keypair.private_key_hex(),
            }),
            agent_card: Some(AgentCardConfig {
                name: "Device Agent".to_string(),
                description: "publishes devices".to_string(),
                capabilities: vec!["chat".to_string()],
            }),
            ..Config::default()
        };

        let created = ensure_local_e2e_config(&mut config).expect("e2e config created");
        assert!(created);

        let identity = config.identity.as_ref().expect("identity present");
        let card = build_agent_card_from_config(&config, identity).expect("card builds");
        let devices = card.devices.as_ref().expect("devices published");

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].one_time_pre_key_count, 16);
        assert!(card.verify_signature().expect("signature verifies"));
    }

    #[test]
    fn builds_prekey_bundles_from_config() {
        let keypair = KeyPair::generate();
        let did = quadra_a_core::identity::derive_did(keypair.verifying_key.as_bytes());
        let mut config = Config {
            identity: Some(IdentityConfig {
                did,
                public_key: keypair.public_key_hex(),
                private_key: keypair.private_key_hex(),
            }),
            ..Config::default()
        };

        ensure_local_e2e_config(&mut config).expect("e2e config created");
        let bundles = build_published_prekey_bundles_from_config(&config);
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].one_time_pre_keys.len(), 16);
    }
}
