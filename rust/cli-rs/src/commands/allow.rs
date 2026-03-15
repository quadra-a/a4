use crate::config::{load_config, save_config, TrustConfig};
use crate::daemon::DaemonClient;
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct AllowOptions {
    pub target: String,
    pub note: Option<String>,
    pub json: bool,
    pub human: bool,
}

pub async fn run(opts: AllowOptions) -> Result<()> {
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
        trust_config.allow_agent(target_did.clone(), opts.note.clone());
    }

    save_config(&config)?;

    let _ = inform_daemon_of_allow(&target_did, opts.note.as_deref()).await;

    if opts.json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "target": target_did,
            "status": "allowed",
            "note": opts.note,
        }))?);
        return Ok(());
    }

    if opts.human {
        println!("Allowlisting agent: {}", target_did);
        if let Some(note) = &opts.note {
            println!("Note: {}", note);
        }
        println!();
        println!("Agent allowlisted successfully.");
        println!("This agent will bypass all defense checks.");
    } else {
        LlmFormatter::section("Allow Agent");
        LlmFormatter::key_value("Target DID", &target_did);
        if let Some(note) = &opts.note {
            LlmFormatter::key_value("Note", note);
        }
        LlmFormatter::key_value("Status", "allowed");
        LlmFormatter::key_value("Effect", "Bypasses blocklist, rate limits, and trust checks");
        println!();
    }

    Ok(())
}

async fn inform_daemon_of_allow(target_did: &str, note: Option<&str>) -> Result<()> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        anyhow::bail!("Daemon not running");
    }

    let request = serde_json::json!({
        "targetDid": target_did,
        "action": "allow",
        "note": note,
    });

    client.send_command("allowlist", request).await?;
    Ok(())
}
