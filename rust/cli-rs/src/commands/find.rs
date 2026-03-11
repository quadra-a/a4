use crate::config::load_config;
use crate::identity::KeyPair;
use crate::protocol::AgentCard;
use crate::relay::{connect_first_available, parse_discovered_agent_card, RelaySession};
use crate::ui::LlmFormatter;
use anyhow::Result;

fn matches_capability(agent: &AgentCard, capability: &str) -> bool {
    let normalized = capability.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    agent.capabilities.iter().any(|entry| {
        let candidate = entry.id.to_lowercase();
        candidate == normalized || candidate.starts_with(&format!("{}/", normalized))
    })
}

pub struct FindOptions {
    pub capability: Option<String>,
    pub query: Option<String>,
    pub did: Option<String>,
    pub limit: u32,
    pub min_trust: Option<f64>,
    pub alias: Option<String>,
    pub relay: Option<String>,
    pub human: bool,
}

pub async fn run(opts: FindOptions) -> Result<()> {
    let config = load_config()?;
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let card = crate::commands::discover::build_card(&config, identity)?;
    if opts.human {
        println!("Finding agents across configured relays...");
    }

    let (mut session, relay_url) = connect_first_available(
        opts.relay.as_deref(),
        Some(&config),
        &identity.did,
        &card,
        &keypair,
    )
    .await?;

    if opts.human {
        println!("Using relay {}", relay_url);
    }

    // Handle specific DID query
    if let Some(target_did) = &opts.did {
        let agent_card = query_agent_card(&mut session, target_did).await?;
        session.goodbye().await?;

        if let Some(card) = agent_card {
            render_agent_card(&card, opts.human);

            // Auto-alias if requested
            if let Some(alias_name) = &opts.alias {
                crate::commands::alias::set(crate::commands::alias::AliasSetOptions {
                    name: alias_name.clone(),
                    did: target_did.clone(),
                })?;
                if opts.human {
                    println!("Aliased as '{}'", alias_name);
                } else {
                    LlmFormatter::key_value("Aliased As", alias_name);
                }
            }
        } else if opts.human {
            println!("Agent not found: {}", target_did);
        } else {
            LlmFormatter::section("Find Result");
            LlmFormatter::key_value("Status", "not_found");
            LlmFormatter::key_value("DID", target_did);
            println!();
        }
        return Ok(());
    }

    let relay_query = opts.query.as_deref();
    let relay_capability = if opts.query.is_some() {
        None
    } else {
        opts.capability.as_deref()
    };

    let effective_min_trust = opts.min_trust.filter(|score| *score > 0.0);
    let agents = discover_agents(
        &mut session,
        relay_query,
        relay_capability,
        effective_min_trust,
        opts.limit,
    )
    .await?;
    session.goodbye().await?;

    let filtered_agents: Vec<AgentCard> = agents
        .into_iter()
        .filter(|agent| {
            opts.capability
                .as_deref()
                .map(|capability| matches_capability(agent, capability))
                .unwrap_or(true)
        })
        .filter(|agent| {
            effective_min_trust
                .map(|min_trust| {
                    trust_score(agent)
                        .map(|score| score >= min_trust)
                        .unwrap_or(false)
                })
                .unwrap_or(true)
        })
        .collect();

    // Render results
    render_agent_results(&filtered_agents, opts.human);

    // Auto-alias top result if requested
    if let Some(alias_name) = &opts.alias {
        if let Some(top_agent) = filtered_agents.first() {
            crate::commands::alias::set(crate::commands::alias::AliasSetOptions {
                name: alias_name.clone(),
                did: top_agent.did.clone(),
            })?;
            if opts.human {
                println!("Aliased top result as '{}'", alias_name);
            } else {
                LlmFormatter::key_value("Aliased Top Result", alias_name);
                println!();
            }
        } else if opts.human {
            println!("No results to alias");
        }
    }

    Ok(())
}

async fn query_agent_card(session: &mut RelaySession, did: &str) -> Result<Option<AgentCard>> {
    session.fetch_card(did).await
}

pub(crate) async fn discover_agents(
    session: &mut RelaySession,
    query: Option<&str>,
    capability: Option<&str>,
    min_trust: Option<f64>,
    limit: u32,
) -> Result<Vec<AgentCard>> {
    let discovered = session
        .discover(query, capability, min_trust, Some(limit))
        .await?;
    Ok(discovered
        .into_iter()
        .filter_map(parse_discovered_agent_card)
        .collect())
}

fn trust_score(agent: &AgentCard) -> Option<f64> {
    agent
        .trust
        .as_ref()
        .and_then(|trust| {
            trust
                .get("interactionScore")
                .or_else(|| trust.get("averageScore"))
        })
        .and_then(|score| score.as_f64())
}

fn render_agent_card(agent: &AgentCard, human: bool) {
    if human {
        println!();
        println!("DID:          {}", agent.did);
        println!("Name:         {}", agent.name);
        println!("Description:  {}", agent.description);
        println!("Version:      {}", agent.version);

        if !agent.capabilities.is_empty() {
            println!("Capabilities:");
            for cap in &agent.capabilities {
                println!("  - {} ({})", cap.name, cap.id);
                if !cap.description.is_empty() {
                    println!("    {}", cap.description);
                }
            }
        }

        if let Some(score) = trust_score(agent) {
            println!("Trust Score:  {:.1}%", score * 100.0);
        }

        println!(
            "Timestamp:    {}",
            chrono::DateTime::from_timestamp(agent.timestamp as i64 / 1000, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| agent.timestamp.to_string())
        );
    } else {
        LlmFormatter::section("Agent Details");
        LlmFormatter::key_value("DID", &agent.did);
        LlmFormatter::key_value("Name", &agent.name);
        LlmFormatter::key_value("Description", &agent.description);
        LlmFormatter::key_value("Version", &agent.version);

        if !agent.capabilities.is_empty() {
            let cap_names: Vec<String> = agent
                .capabilities
                .iter()
                .map(|cap| format!("{} ({})", cap.name, cap.id))
                .collect();
            LlmFormatter::key_value("Capabilities", &cap_names.join(", "));
        }

        if let Some(score) = trust_score(agent) {
            LlmFormatter::key_value("Trust Score", &format!("{:.1}%", score * 100.0));
        }

        LlmFormatter::key_value(
            "Timestamp",
            &chrono::DateTime::from_timestamp(agent.timestamp as i64 / 1000, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| agent.timestamp.to_string()),
        );
        println!();
    }
}

fn render_agent_results(agents: &[AgentCard], human: bool) {
    if agents.is_empty() {
        if human {
            println!("No agents found.");
        } else {
            LlmFormatter::section("Find Results");
            LlmFormatter::key_value("Count", "0");
            println!();
        }
        return;
    }

    if human {
        println!();
        println!("Found {} agent(s):", agents.len());
        println!();

        for (i, agent) in agents.iter().enumerate() {
            println!("{}. {} ({})", i + 1, agent.name, &agent.did[..20]);
            println!("   {}", agent.description);

            if !agent.capabilities.is_empty() {
                let cap_names: Vec<&str> =
                    agent.capabilities.iter().map(|c| c.name.as_str()).collect();
                println!("   Capabilities: {}", cap_names.join(", "));
            }

            if let Some(score) = trust_score(agent) {
                println!("   Trust: {:.1}%", score * 100.0);
            }
            println!();
        }
    } else {
        LlmFormatter::section("Find Results");
        LlmFormatter::key_value("Count", &agents.len().to_string());

        let headers = vec!["DID", "Name", "Capabilities", "Trust"];
        let mut rows = Vec::new();

        for agent in agents {
            let cap_names: Vec<&str> = agent.capabilities.iter().map(|c| c.name.as_str()).collect();
            let capabilities = if cap_names.is_empty() {
                "(none)".to_string()
            } else {
                cap_names.join(", ")
            };

            let trust = trust_score(agent)
                .map(|score| format!("{:.1}%", score * 100.0))
                .unwrap_or_else(|| "N/A".to_string());

            rows.push(vec![
                agent.did.clone(),
                agent.name.clone(),
                capabilities,
                trust,
            ]);
        }

        LlmFormatter::table(&headers, &rows);
        println!();
    }
}

#[cfg(test)]
mod tests {
    use crate::relay::parse_discovered_agent_card;
    use serde_json::json;

    #[test]
    fn parses_wrapped_discovery_results() {
        let value = json!({
            "did": "did:agent:test",
            "online": true,
            "trust": {
                "averageScore": 0.88
            },
            "card": {
                "did": "did:agent:test",
                "name": "Relay Agent",
                "description": "Test relay",
                "version": "1.0.0",
                "capabilities": [{
                    "id": "relay",
                    "name": "relay",
                    "description": "relay"
                }],
                "endpoints": [],
                "timestamp": 1,
                "signature": "deadbeef"
            }
        });

        let parsed =
            parse_discovered_agent_card(value).expect("wrapped discovery result should parse");
        assert_eq!(parsed.did, "did:agent:test");
        assert_eq!(parsed.name, "Relay Agent");
        assert_eq!(parsed.capabilities.len(), 1);
        assert_eq!(
            parsed
                .trust
                .as_ref()
                .and_then(|trust_value| trust_value.get("averageScore"))
                .and_then(|score_value| score_value.as_f64()),
            Some(0.88)
        );
    }

    #[test]
    fn parses_direct_agent_cards() {
        let value = json!({
            "did": "did:agent:direct",
            "name": "Direct Agent",
            "description": "already flattened",
            "version": "1.0.0",
            "capabilities": [],
            "endpoints": [],
            "timestamp": 1,
            "signature": "beadfeed"
        });

        let parsed = parse_discovered_agent_card(value).expect("direct card should parse");
        assert_eq!(parsed.did, "did:agent:direct");
        assert_eq!(parsed.name, "Direct Agent");
    }
}
