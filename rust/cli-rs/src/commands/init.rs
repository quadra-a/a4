use anyhow::{bail, Result};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::{save_config, AgentCardConfig, IdentityConfig};
use crate::identity::KeyPair;
use crate::protocol::{AgentCard, AgentCardUnsigned};

pub struct InitOptions {
    pub name: String,
    pub description: String,
    pub force: bool,
}

pub fn run(opts: InitOptions) -> Result<()> {
    let mut config = crate::config::load_config()?;

    if let Some(identity) = config.identity.as_ref() {
        if !opts.force {
            bail!(
                "Identity already exists. Use --force to overwrite.\nDID: {}",
                identity.did
            );
        }
    }

    // Generate keypair
    let keypair = KeyPair::generate();
    let did = crate::identity::derive_did(keypair.verifying_key.as_bytes());

    // Build and sign agent card
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let card_unsigned = AgentCardUnsigned {
        did: did.clone(),
        name: opts.name.clone(),
        description: opts.description.clone(),
        version: "1.0.0".to_string(),
        capabilities: vec![],
        endpoints: vec![],
        devices: None,
        peer_id: None,
        trust: None,
        metadata: None,
        timestamp,
    };

    let signature = AgentCard::sign(&card_unsigned, &keypair);

    let _card = AgentCard {
        did: card_unsigned.did,
        name: card_unsigned.name,
        description: card_unsigned.description,
        version: card_unsigned.version,
        capabilities: card_unsigned.capabilities,
        endpoints: card_unsigned.endpoints,
        devices: card_unsigned.devices,
        peer_id: card_unsigned.peer_id,
        trust: card_unsigned.trust,
        metadata: card_unsigned.metadata,
        timestamp: card_unsigned.timestamp,
        signature,
    };

    config.identity = Some(IdentityConfig {
        did: did.clone(),
        public_key: keypair.public_key_hex(),
        private_key: keypair.private_key_hex(),
    });

    config.agent_card = Some(AgentCardConfig {
        name: opts.name,
        description: opts.description,
        capabilities: vec![],
    });

    save_config(&config)?;

    println!("Identity created successfully");
    println!("DID: {}", did);
    println!("Config: {}", crate::config::config_path().display());

    Ok(())
}
