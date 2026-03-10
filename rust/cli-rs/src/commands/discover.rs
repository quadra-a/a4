use anyhow::Result;
use colored::Colorize;

use crate::config::load_config;
use crate::identity::KeyPair;
use crate::protocol::{AgentCard, AgentCardUnsigned, Capability};
use crate::relay::connect_first_available;
use crate::ui::LlmFormatter;

pub struct DiscoverOptions {
    pub query: String,
    pub limit: Option<u32>,
    pub relay: Option<String>,
    pub human: bool,
}

pub async fn run(opts: DiscoverOptions) -> Result<()> {
    let config = load_config()?;
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let card = build_card(&config, identity)?;
    if opts.human {
        eprintln!("Connecting to configured relays...");
    }

    let (mut session, relay_url) =
        connect_first_available(opts.relay.as_deref(), Some(&config), &identity.did, &card, &keypair).await?;

    if opts.human {
        eprintln!(
            "Connected to {} (relay: {}, peers: {})",
            relay_url, session.relay_id, session.peers
        );
    }

    let agents = session
        .discover(Some(&opts.query), None, None, opts.limit)
        .await?;
    session.goodbye().await?;

    if agents.is_empty() {
        if opts.human {
            println!("No agents found matching {:?}", opts.query);
        } else {
            LlmFormatter::section("Discovery Results");
            LlmFormatter::key_value("Query", &opts.query);
            LlmFormatter::key_value("Results", "0");
            println!();
        }
        return Ok(());
    }

    if opts.human {
        println!("{} agent(s) found:\n", agents.len());
        for agent in &agents {
            let did = agent
                .get("did")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let online = agent
                .get("online")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let card = agent.get("card");
            let name = card
                .and_then(|c| c.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("(unnamed)");
            let desc = card
                .and_then(|c| c.get("description"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let status = if online {
                "online".green()
            } else {
                "offline".dimmed()
            };
            println!("  {} [{}]", name.bold(), status);
            println!("  DID: {}", did);
            if !desc.is_empty() {
                println!("  {}", desc);
            }
            println!();
        }
    } else {
        // LLM-friendly format
        LlmFormatter::section("Discovery Results");
        LlmFormatter::key_value("Query", &opts.query);
        LlmFormatter::key_value(
            "Limit",
            &opts
                .limit
                .map(|l| l.to_string())
                .unwrap_or_else(|| "none".to_string()),
        );
        LlmFormatter::key_value("Results", &agents.len().to_string());
        println!();

        let headers = vec!["DID", "Name", "Status", "Description"];
        let rows: Vec<Vec<String>> = agents
            .iter()
            .map(|agent| {
                let did = agent
                    .get("did")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let online = agent
                    .get("online")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let card = agent.get("card");
                let name = card
                    .and_then(|c| c.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unnamed)")
                    .to_string();
                let desc = card
                    .and_then(|c| c.get("description"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let status = if online { "online" } else { "offline" }.to_string();

                vec![did, name, status, desc]
            })
            .collect();

        LlmFormatter::table(&headers, &rows);
        println!();
    }

    Ok(())
}

pub fn build_card(
    config: &crate::config::Config,
    identity: &crate::config::IdentityConfig,
) -> Result<AgentCard> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let keypair = KeyPair::from_hex(&identity.private_key)?;

    let (name, description, capabilities) = if let Some(ac) = &config.agent_card {
        (
            ac.name.clone(),
            ac.description.clone(),
            ac.capabilities
                .iter()
                .map(|c| Capability {
                    id: c.clone(),
                    name: c.replace('-', " "),
                    description: c.clone(),
                    parameters: None,
                    metadata: None,
                })
                .collect::<Vec<_>>(),
        )
    } else {
        ("Unknown Agent".to_string(), "".to_string(), vec![])
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let card_unsigned = AgentCardUnsigned {
        did: identity.did.clone(),
        name,
        description,
        version: "1.0.0".to_string(),
        capabilities,
        endpoints: vec![],
        peer_id: None,
        trust: None,
        metadata: None,
        timestamp,
    };

    let signature = AgentCard::sign(&card_unsigned, &keypair);

    Ok(AgentCard {
        did: card_unsigned.did,
        name: card_unsigned.name,
        description: card_unsigned.description,
        version: card_unsigned.version,
        capabilities: card_unsigned.capabilities,
        endpoints: card_unsigned.endpoints,
        peer_id: card_unsigned.peer_id,
        trust: card_unsigned.trust,
        metadata: card_unsigned.metadata,
        timestamp: card_unsigned.timestamp,
        signature,
    })
}
