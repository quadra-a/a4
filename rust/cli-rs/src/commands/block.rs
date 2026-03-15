use crate::config::{load_config, save_config, TrustConfig};
use crate::daemon::DaemonClient;
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct BlockOptions {
    pub target: String,
    pub reason: Option<String>,
    pub json: bool,
    pub human: bool,
}

pub async fn run(opts: BlockOptions) -> Result<()> {
    let mut config = load_config()?;
    let _identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    // CVP-0014: Resolve DID from alias
    let target_did =
        crate::commands::alias::resolve_did(&opts.target, &config).ok_or_else(|| {
            anyhow::anyhow!(
                "Could not resolve '{}' to a DID. Not found as alias or DID.",
                opts.target
            )
        })?;

    // Initialize trust config if it doesn't exist
    if config.trust_config.is_none() {
        config.trust_config = Some(TrustConfig::new());
    }

    // Block the agent
    if let Some(ref mut trust_config) = config.trust_config {
        trust_config.block_agent_with_reason(target_did.clone(), opts.reason.clone());
    }

    // Save the updated config
    save_config(&config)?;

    // Inform daemon if it's running (optional, don't fail if daemon unavailable)
    let _ = inform_daemon_of_block(&target_did).await;

    if opts.json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "target": target_did,
            "reason": opts.reason,
            "status": "blocked_and_stored",
        }))?);
        return Ok(());
    }

    if opts.human {
        println!("Blocking agent: {}", target_did);
        if let Some(reason) = &opts.reason {
            println!("Reason: {}", reason);
        }
        println!();
        println!("Agent blocked successfully and stored locally.");
        println!("This agent will no longer be able to send you messages.");
    } else {
        LlmFormatter::section("Block Agent");
        LlmFormatter::key_value("Target DID", &target_did);
        if let Some(reason) = &opts.reason {
            LlmFormatter::key_value("Reason", reason);
        }
        LlmFormatter::key_value("Status", "blocked_and_stored");
        LlmFormatter::key_value("Effect", "Messages from this agent will be rejected");
        println!();
    }

    Ok(())
}

async fn inform_daemon_of_block(target_did: &str) -> Result<()> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        anyhow::bail!("Daemon not running");
    }

    let request = serde_json::json!({
        "targetDid": target_did,
        "action": "block",
    });

    client.send_command("block_agent", request).await?;

    Ok(())
}
