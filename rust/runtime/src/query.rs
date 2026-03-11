use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

use quadra_a_core::config::EndorsementV2;
use quadra_a_core::protocol::AgentCard;

use crate::card::build_ephemeral_query_identity;
use crate::relay::{
    extract_discovered_relay_endpoints, parse_discovered_agent_card, RelaySession, DEFAULT_RELAY,
};

#[derive(Debug, Clone)]
pub struct DiscoveredAgent {
    pub card: AgentCard,
    pub online: bool,
}

#[derive(Debug, Deserialize)]
struct DiscoveredAgentEnvelopeWithOnline {
    did: Option<String>,
    online: Option<bool>,
    #[serde(default)]
    trust: Option<Value>,
    card: AgentCard,
}

fn parse_discovered_agent(value: Value) -> Option<DiscoveredAgent> {
    if let Some(card) = parse_discovered_agent_card(value.clone()) {
        return Some(DiscoveredAgent { card, online: true });
    }

    if let Ok(mut envelope) = serde_json::from_value::<DiscoveredAgentEnvelopeWithOnline>(value) {
        if let Some(did) = envelope.did.take() {
            envelope.card.did = did;
        }
        if envelope.card.trust.is_none() {
            envelope.card.trust = envelope.trust.take();
        }
        return Some(DiscoveredAgent {
            card: envelope.card,
            online: envelope.online.unwrap_or(true),
        });
    }

    None
}

pub async fn connect_query_session(
    relay_url: &str,
    invite_token: Option<&str>,
) -> Result<RelaySession> {
    let (did, keypair, card) = build_ephemeral_query_identity();
    RelaySession::connect_with_invite_token(relay_url, &did, &card, &keypair, invite_token).await
}

pub async fn query_discovered_agents(
    relay_urls: &[String],
    invite_token: Option<&str>,
    query: Option<&str>,
    capability: Option<&str>,
    min_trust: Option<f64>,
    limit: u32,
) -> Result<Vec<DiscoveredAgent>> {
    let candidates = if relay_urls.is_empty() {
        vec![DEFAULT_RELAY.to_string()]
    } else {
        relay_urls.to_vec()
    };

    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    let mut errors = Vec::new();
    let mut had_success = false;

    for relay_url in candidates {
        match query_discovered_agents_from_relay(
            &relay_url,
            invite_token,
            query,
            capability,
            min_trust,
            limit,
        )
        .await
        {
            Ok(results) => {
                had_success = true;
                for result in results {
                    if seen.insert(result.card.did.clone()) {
                        merged.push(result);
                        if merged.len() >= limit as usize {
                            return Ok(merged);
                        }
                    }
                }
            }
            Err(error) => errors.push(format!("{}: {}", relay_url, error)),
        }
    }

    if had_success {
        return Ok(merged);
    }

    anyhow::bail!(
        "Failed to query discovery across known relays: {}",
        if errors.is_empty() {
            "no relay candidates".to_string()
        } else {
            errors.join(" | ")
        }
    )
}

pub async fn query_discovered_agents_from_relay(
    relay_url: &str,
    invite_token: Option<&str>,
    query: Option<&str>,
    capability: Option<&str>,
    min_trust: Option<f64>,
    limit: u32,
) -> Result<Vec<DiscoveredAgent>> {
    let mut session = connect_query_session(relay_url, invite_token).await?;
    let result = session
        .discover(query, capability, min_trust, Some(limit))
        .await?;
    let _ = session.goodbye().await;
    Ok(result
        .into_iter()
        .filter_map(parse_discovered_agent)
        .collect())
}

pub async fn discover_relay_providers(
    relay_url: &str,
    invite_token: Option<&str>,
    capability: &str,
    limit: u32,
) -> Result<Vec<String>> {
    let mut session = connect_query_session(relay_url, invite_token).await?;
    let result = session
        .discover(None, Some(capability), None, Some(limit))
        .await?;
    let _ = session.goodbye().await;
    Ok(extract_discovered_relay_endpoints(&result))
}

pub async fn query_network_endorsements(
    relay_urls: &[String],
    invite_token: Option<&str>,
    target_did: &str,
    domain: Option<&str>,
    limit: u32,
) -> Result<Vec<EndorsementV2>> {
    let candidates = if relay_urls.is_empty() {
        vec![DEFAULT_RELAY.to_string()]
    } else {
        relay_urls.to_vec()
    };

    let mut endorsements = Vec::new();
    let mut errors = Vec::new();
    let mut had_success = false;

    for relay_url in candidates {
        match query_network_endorsements_from_relay(
            &relay_url,
            invite_token,
            target_did,
            domain,
            limit,
        )
        .await
        {
            Ok(result) => {
                had_success = true;
                merge_endorsements(&mut endorsements, result);
                if endorsements.len() >= limit as usize {
                    endorsements.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
                    endorsements.truncate(limit as usize);
                    return Ok(endorsements);
                }
            }
            Err(error) => errors.push(format!("{}: {}", relay_url, error)),
        }
    }

    if had_success {
        endorsements.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        endorsements.truncate(limit as usize);
        return Ok(endorsements);
    }

    anyhow::bail!(
        "Failed to query endorsements across known relays: {}",
        if errors.is_empty() {
            "no relay candidates".to_string()
        } else {
            errors.join(" | ")
        }
    )
}

pub async fn query_network_endorsements_from_relay(
    relay_url: &str,
    invite_token: Option<&str>,
    target_did: &str,
    domain: Option<&str>,
    limit: u32,
) -> Result<Vec<EndorsementV2>> {
    let mut session = connect_query_session(relay_url, invite_token).await?;
    let result = session
        .query_endorsements(target_did, domain, Some(limit), None)
        .await?;
    let _ = session.goodbye().await;
    Ok(result.endorsements)
}

fn merge_endorsements(existing: &mut Vec<EndorsementV2>, incoming: Vec<EndorsementV2>) {
    for endorsement in incoming {
        if let Some(index) = existing.iter().position(|current| {
            current.endorser == endorsement.endorser
                && current.endorsee == endorsement.endorsee
                && current.domain == endorsement.domain
        }) {
            if endorsement.timestamp > existing[index].timestamp {
                existing[index] = endorsement;
            }
        } else {
            existing.push(endorsement);
        }
    }
}
