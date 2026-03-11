use anyhow::Result;
use colored::Colorize;

use crate::config::load_config;
use crate::identity::KeyPair;
use crate::protocol::AgentCard;
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

    let (mut session, relay_url) = connect_first_available(
        opts.relay.as_deref(),
        Some(&config),
        &identity.did,
        &card,
        &keypair,
    )
    .await?;

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
    quadra_a_runtime::card::build_agent_card_from_config(config, identity)
}
