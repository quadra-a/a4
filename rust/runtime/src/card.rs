use anyhow::Result;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

use quadra_a_core::config::{Config, IdentityConfig};
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

pub fn build_signed_agent_card(
    keypair: &KeyPair,
    did: String,
    name: String,
    description: String,
    capabilities: Vec<Capability>,
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

    Ok(build_signed_agent_card(
        &keypair,
        identity.did.clone(),
        name,
        description,
        capabilities,
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
        Some(serde_json::json!({"internal": true})),
    );
    (did, keypair, card)
}
