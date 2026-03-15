use crate::config::{load_config, save_config, TrustConfig};
use crate::daemon::DaemonClient;
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct UnblockOptions {
    pub target: String,
    pub keep_history: bool,
    pub json: bool,
    pub human: bool,
}

pub async fn run(opts: UnblockOptions) -> Result<()> {
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

    if config.trust_config.is_none() {
        config.trust_config = Some(TrustConfig::new());
    }

    if let Some(trust_config) = &mut config.trust_config {
        trust_config.unblock_agent(&target_did);
    }

    save_config(&config)?;

    let reset_trust = !opts.keep_history;
    let _ = inform_daemon_of_unblock(&target_did, reset_trust).await;

    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "target": target_did,
                "status": "unblocked",
                "resetTrust": reset_trust,
            }))?
        );
        return Ok(());
    }

    if opts.human {
        println!("Unblocking agent: {}", target_did);
        println!();
        println!("Agent unblocked successfully.");
        println!("This agent can now send you messages again.");
        if reset_trust {
            println!("Interaction history reset (use --keep-history to preserve).");
        }
    } else {
        LlmFormatter::section("Unblock Agent");
        LlmFormatter::key_value("Target DID", &target_did);
        LlmFormatter::key_value("Status", "unblocked");
        LlmFormatter::key_value("Effect", "Messages from this agent will be accepted");
        if reset_trust {
            LlmFormatter::key_value("Trust Reset", "yes");
        }
        println!();
    }

    Ok(())
}

async fn inform_daemon_of_unblock(target_did: &str, reset_trust: bool) -> Result<()> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        anyhow::bail!("Daemon not running");
    }

    let request = serde_json::json!({
        "targetDid": target_did,
        "action": "unblock",
        "resetTrust": reset_trust,
    });

    client.send_command("block_agent", request).await?;
    Ok(())
}
