use anyhow::{bail, Result};
use serde_json::json;

use crate::daemon::{daemon_socket_path, DaemonClient};

pub struct StatusOptions {
    pub json: bool,
    pub human: bool,
}

pub async fn run(opts: StatusOptions) -> Result<()> {
    let config = crate::config::load_config()?;
    let daemon = DaemonClient::new(&daemon_socket_path());
    let daemon_running = daemon.is_running().await;
    let daemon_status = if daemon_running {
        daemon.send_command("status", json!({})).await.ok()
    } else {
        None
    };

    let identity = match &config.identity {
        Some(id) => id,
        None => bail!("No identity found. Run `agent listen` to create one."),
    };
    let reachability_policy = crate::config::resolve_reachability_policy(None, Some(&config));

    // CVP-0021: Show discovery status
    let discovery_status = match config.published {
        Some(true) => "Discoverable",
        Some(false) => "Anonymous",
        None => "Unknown",
    };

    if opts.json {
        let mut json_config = serde_json::to_value(&config)?;
        if let Some(obj) = json_config.as_object_mut() {
            obj.insert(
                "discoveryStatus".to_string(),
                serde_json::Value::String(discovery_status.to_string()),
            );
            obj.insert(
                "daemon".to_string(),
                daemon_status.clone().unwrap_or(serde_json::Value::Null),
            );
        }
        println!("{}", serde_json::to_string_pretty(&json_config)?);
        return Ok(());
    }

    if opts.human {
        use colored::Colorize;
        println!();
        println!("{}", "Agent Status".bold().cyan());
        println!();
        println!("{}", "Identity".bold());
        println!("  {}: {}", "DID".dimmed(), identity.did);
        println!("  {}: {}", "Public Key".dimmed(), identity.public_key);
        println!(
            "  {}: {}",
            "Discovery Status".dimmed(),
            match discovery_status {
                "Discoverable" => discovery_status.green(),
                "Anonymous" => discovery_status.yellow(),
                _ => discovery_status.normal(),
            }
        );

        if let Some(card) = &config.agent_card {
            println!();
            println!("{}", "Agent Card".bold());
            println!("  {}: {}", "Name".dimmed(), card.name);
            println!("  {}: {}", "Description".dimmed(), card.description);
            if card.capabilities.is_empty() {
                println!("  {}: (none)", "Capabilities".dimmed());
            } else {
                println!(
                    "  {}: {}",
                    "Capabilities".dimmed(),
                    card.capabilities.join(", ")
                );
            }
        }

        println!();
        println!("{}", "Network".bold());
        println!(
            "  {}: {}",
            "Config".dimmed(),
            crate::config::config_path().display()
        );
        println!(
            "  {}: {}",
            "Daemon".dimmed(),
            if daemon_running { "Running" } else { "Stopped" }
        );
        println!(
            "  {}: {:?}",
            "Reachability Mode".dimmed(),
            reachability_policy.mode
        );
        println!(
            "  {}: {}",
            "Bootstrap Providers".dimmed(),
            reachability_policy.bootstrap_providers.join(", ")
        );
        println!(
            "  {}: {}",
            "Target Providers".dimmed(),
            reachability_policy.target_provider_count
        );
        if let Some(status) = &daemon_status {
            println!(
                "  {}: {}",
                "Relay".dimmed(),
                status
                    .get("relay")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown")
            );
            println!(
                "  {}: {}",
                "Connected".dimmed(),
                status
                    .get("connected")
                    .and_then(|value| value.as_bool())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "false".to_string())
            );
            println!(
                "  {}: {}",
                "Message Cache".dimmed(),
                status
                    .get("messages")
                    .and_then(|value| value.as_u64())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "0".to_string())
            );
        }
        println!();
    } else {
        // LLM-friendly format
        use crate::ui::LlmFormatter;

        LlmFormatter::section("Agent Status");
        LlmFormatter::key_value("Identity", "");
        LlmFormatter::key_value("  DID", &identity.did);
        LlmFormatter::key_value("  Public Key", &identity.public_key);
        LlmFormatter::key_value("  Discovery Status", discovery_status);

        if let Some(card) = &config.agent_card {
            println!();
            LlmFormatter::key_value("Agent Card", "");
            LlmFormatter::key_value("  Name", &card.name);
            LlmFormatter::key_value("  Description", &card.description);
            if card.capabilities.is_empty() {
                LlmFormatter::key_value("  Capabilities", "(none)");
            } else {
                LlmFormatter::key_value("  Capabilities", &card.capabilities.join(", "));
            }
        }

        println!();
        LlmFormatter::key_value("Network", "");
        LlmFormatter::key_value(
            "  Config",
            &crate::config::config_path().display().to_string(),
        );
        LlmFormatter::key_value(
            "  Daemon",
            if daemon_running { "running" } else { "stopped" },
        );
        LlmFormatter::key_value(
            "  Reachability Mode",
            match reachability_policy.mode {
                crate::config::ReachabilityMode::Adaptive => "adaptive",
                crate::config::ReachabilityMode::Fixed => "fixed",
            },
        );
        LlmFormatter::key_value(
            "  Bootstrap Providers",
            &reachability_policy.bootstrap_providers.join(", "),
        );
        LlmFormatter::key_value(
            "  Target Providers",
            &reachability_policy.target_provider_count.to_string(),
        );
        if let Some(status) = &daemon_status {
            if let Some(relay) = status.get("relay").and_then(|value| value.as_str()) {
                LlmFormatter::key_value("  Relay", relay);
            }
            if let Some(connected) = status.get("connected").and_then(|value| value.as_bool()) {
                LlmFormatter::key_value("  Connected", if connected { "true" } else { "false" });
            }
            if let Some(messages) = status.get("messages").and_then(|value| value.as_u64()) {
                LlmFormatter::key_value("  Message Cache", &messages.to_string());
            }
        }
        println!();
    }

    Ok(())
}
