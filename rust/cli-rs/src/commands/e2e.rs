use anyhow::{Context, Result};
use serde_json::json;
use std::collections::BTreeSet;

use crate::config::load_config;
use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::e2e_state::with_locked_config_transaction;

pub struct E2eStatusOptions {
    pub json: bool,
}

pub struct E2eResetOptions {
    pub peer_did: Option<String>,
}

fn session_peer_did(session_key: &str) -> Option<&str> {
    session_key
        .rsplit_once(':')
        .map(|(peer_did, _)| peer_did)
        .filter(|peer_did| !peer_did.is_empty())
}

fn collect_reset_peers<'a, I>(session_keys: I, only_peer: Option<&str>) -> Vec<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut peers = BTreeSet::new();
    let exact_prefix = only_peer.map(|peer| format!("{}:", peer));

    for session_key in session_keys {
        let Some(peer_did) = session_peer_did(session_key) else {
            continue;
        };
        if let Some(prefix) = &exact_prefix {
            if !session_key.starts_with(prefix) {
                continue;
            }
        }
        peers.insert(peer_did.to_string());
    }

    peers.into_iter().collect()
}

pub async fn e2e_status(opts: E2eStatusOptions) -> Result<()> {
    let config = load_config()?;

    let e2e = config
        .e2e
        .as_ref()
        .context("No E2E configuration found. Run 'a4 listen' to initialize.")?;
    if !e2e.is_valid() {
        anyhow::bail!("Invalid E2E configuration. Run 'a4 listen' to reinitialize.");
    }

    let device_id = &e2e.current_device_id;
    let device = e2e
        .devices
        .get(device_id)
        .context("Current device not found in E2E config")?;

    let session_count = device.sessions.len();
    let sessions: Vec<_> = device
        .sessions
        .keys()
        .map(|k| {
            let parts: Vec<&str> = k.split(':').collect();
            json!({
                "key": k,
                "peer": parts.get(0).unwrap_or(&"unknown"),
            })
        })
        .collect();

    if opts.json {
        let output = json!({
            "deviceId": device_id,
            "sessionCount": session_count,
            "sessions": sessions,
        });
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        println!("E2E Status:");
        println!("  Device ID: {}", device_id);
        println!("  Sessions: {}", session_count);
        if !sessions.is_empty() {
            println!("\nActive sessions:");
            for session in sessions {
                println!(
                    "  - {} (key: {})",
                    session["peer"].as_str().unwrap_or("unknown"),
                    session["key"].as_str().unwrap_or("unknown")
                );
            }
        }
    }

    Ok(())
}

pub async fn e2e_reset(opts: E2eResetOptions) -> Result<()> {
    let config = load_config()?;

    // Resolve alias to DID if needed
    let peer_did = opts.peer_did.map(|input| {
        crate::commands::alias::resolve_did(&input, &config).unwrap_or(input)
    });
    let peer_did_for_reset = peer_did.clone();
    let (reset_result, _) = with_locked_config_transaction(|mut config| async move {
        let e2e = config
            .e2e
            .as_mut()
            .context("No E2E configuration found. Run 'a4 listen' to initialize.")?;
        if !e2e.is_valid() {
            anyhow::bail!("Invalid E2E configuration. Run 'a4 listen' to reinitialize.");
        }

        let device_id = &e2e.current_device_id.clone();
        let device = e2e
            .devices
            .get_mut(device_id)
            .context("Current device not found in E2E config")?;

        let before = device.sessions.len();
        let peers_to_notify = collect_reset_peers(
            device.sessions.keys().map(String::as_str),
            peer_did_for_reset.as_deref(),
        );

        let removed = if let Some(peer_did) = &peer_did_for_reset {
            let session_prefix = format!("{}:", peer_did);
            let before_peer = device.sessions.len();
            device.sessions.retain(|key, _| !key.starts_with(&session_prefix));
            before_peer - device.sessions.len()
        } else {
            let removed = device.sessions.len();
            device.sessions.clear();
            removed
        };

        Ok(((before, removed, peers_to_notify), config))
    }).await?;
    let (before, removed, peers_to_notify) = reset_result;

    if let Some(peer_did) = &peer_did {
        println!("Cleared {} session(s) for peer {}", removed, peer_did);
    } else {
        println!("Cleared all {} session(s)", before);
    }

    // Notify daemon to reload E2E config if running
    let socket_path = daemon_socket_path();
    let client = DaemonClient::new(&socket_path);
    if client.is_running().await {
        match client.send_command("reload-e2e", serde_json::json!({})).await {
            Ok(_) => {
                println!("\nDaemon E2E config reloaded.");
            }
            Err(_) => {
                println!("\nNote: Daemon not responding. Changes will apply on next daemon start.");
            }
        }

        if !peers_to_notify.is_empty() {
            match client
                .send_command("e2e-reset-notify", json!({ "peers": peers_to_notify }))
                .await
            {
                Ok(result) => {
                    let notified = result
                        .get("notified")
                        .and_then(|value| value.as_array())
                        .map(|value| value.len())
                        .unwrap_or(0);
                    let failed = result
                        .get("failed")
                        .and_then(|value| value.as_array())
                        .map(|value| value.len())
                        .unwrap_or(0);
                    println!(
                        "Sent session reset notification to {} peer(s){}.",
                        notified,
                        if failed > 0 {
                            format!(" ({} failed)", failed)
                        } else {
                            String::new()
                        }
                    );
                }
                Err(_) => {
                    println!(
                        "Note: Could not notify peer(s) about the reset. Remote sessions will recover on next decrypt failure."
                    );
                }
            }
        }
    } else if !peers_to_notify.is_empty() {
        println!(
            "\nNote: Daemon is not running, so peers were not notified about the reset. Remote sessions will recover on next decrypt failure."
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::collect_reset_peers;

    #[test]
    fn collect_reset_peers_uses_exact_peer_prefixes() {
        let session_keys = vec![
            "did:agent:zAlice:device-1",
            "did:agent:zAliceExtra:device-2",
            "did:agent:zBob:device-3",
        ];

        assert_eq!(
            collect_reset_peers(session_keys.iter().copied(), Some("did:agent:zAlice")),
            vec!["did:agent:zAlice".to_string()]
        );
    }

    #[test]
    fn collect_reset_peers_dedupes_all_matching_peers() {
        let session_keys = vec![
            "did:agent:zAlice:device-1",
            "did:agent:zAlice:device-2",
            "did:agent:zBob:device-3",
        ];

        assert_eq!(
            collect_reset_peers(session_keys.iter().copied(), None),
            vec![
                "did:agent:zAlice".to_string(),
                "did:agent:zBob".to_string(),
            ]
        );
    }
}
