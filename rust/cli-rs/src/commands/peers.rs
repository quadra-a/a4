use crate::config::load_config;
use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct PeersOptions {
    pub human: bool,
}

pub async fn run(opts: PeersOptions) -> Result<()> {
    let config = load_config()?;
    let _identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    // Try to get peer information from daemon
    let daemon = DaemonClient::new(&daemon_socket_path());
    if daemon.is_running().await {
        let params = serde_json::json!({});

        match daemon.send_command("peers", params).await {
            Ok(response) => {
                if let Some(peers) = response.get("peers").and_then(|p| p.as_array()) {
                    if opts.human {
                        println!("Connected peers ({}):", peers.len());
                        println!();

                        for (i, peer) in peers.iter().enumerate() {
                            let did = peer
                                .get("did")
                                .and_then(|d| d.as_str())
                                .unwrap_or("unknown");
                            let name = peer
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("(unnamed)");
                            let relay = peer
                                .get("relay")
                                .and_then(|r| r.as_str())
                                .unwrap_or("unknown");
                            let connected_at = peer
                                .get("connectedAt")
                                .and_then(|c| c.as_u64())
                                .unwrap_or(0);

                            println!("{}. {} ({})", i + 1, name, &did[..20]);
                            println!("   Relay: {}", relay);

                            if connected_at > 0 {
                                let datetime =
                                    chrono::DateTime::from_timestamp(connected_at as i64 / 1000, 0)
                                        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                                        .unwrap_or_else(|| "unknown".to_string());
                                println!("   Connected: {}", datetime);
                            }
                            println!();
                        }
                    } else {
                        LlmFormatter::section("Connected Peers");
                        LlmFormatter::key_value("Count", &peers.len().to_string());

                        if !peers.is_empty() {
                            let headers = vec!["DID", "Name", "Relay", "Connected At"];
                            let mut rows = Vec::new();

                            for peer in peers {
                                let did = peer
                                    .get("did")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("unknown");
                                let name = peer
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("(unnamed)");
                                let relay = peer
                                    .get("relay")
                                    .and_then(|r| r.as_str())
                                    .unwrap_or("unknown");
                                let connected_at = peer
                                    .get("connectedAt")
                                    .and_then(|c| c.as_u64())
                                    .unwrap_or(0);

                                let datetime = if connected_at > 0 {
                                    chrono::DateTime::from_timestamp(connected_at as i64 / 1000, 0)
                                        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                                        .unwrap_or_else(|| "unknown".to_string())
                                } else {
                                    "unknown".to_string()
                                };

                                rows.push(vec![
                                    did.to_string(),
                                    name.to_string(),
                                    relay.to_string(),
                                    datetime,
                                ]);
                            }

                            LlmFormatter::table(&headers, &rows);
                        }
                        println!();
                    }
                } else if opts.human {
                    println!("No peers connected");
                } else {
                    LlmFormatter::section("Connected Peers");
                    LlmFormatter::key_value("Count", "0");
                    println!();
                }
            }
            Err(e) => {
                anyhow::bail!("Failed to get peer information from daemon: {}", e);
            }
        }
    } else if opts.human {
        println!("Daemon is not running. Start it with: agent listen");
    } else {
        LlmFormatter::section("Connected Peers");
        LlmFormatter::key_value("Status", "daemon_not_running");
        LlmFormatter::key_value("Count", "0");
        LlmFormatter::key_value("Note", "Start daemon with 'agent listen'");
        println!();
    }

    Ok(())
}
