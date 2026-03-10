use anyhow::Result;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use tokio::time::{sleep, Duration};

use crate::config::{load_config, save_config, AgentCardConfig, IdentityConfig};
use crate::daemon::{daemon_socket_path, DaemonClient, DaemonServer};
use crate::identity::{derive_did, generate_anonymous_identity, KeyPair};

fn parse_capabilities(capabilities: Option<&str>) -> Vec<String> {
    capabilities
        .map(|caps| {
            caps.split(',')
                .map(|capability| capability.trim())
                .filter(|capability| !capability.is_empty())
                .map(|capability| capability.to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_token(token: Option<&str>) -> Option<String> {
    token
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
}

async fn stop_existing_daemon(daemon: &DaemonClient) -> Result<()> {
    daemon.send_command("stop", json!({})).await?;

    for _ in 0..20 {
        if !daemon.is_running().await {
            return Ok(());
        }
        sleep(Duration::from_millis(250)).await;
    }

    anyhow::bail!("Timed out waiting for existing listener to stop")
}

async fn spawn_background_listener(opts: &ListenOptions, daemon: &DaemonClient) -> Result<Value> {
    let exe_path = std::env::current_exe()?;
    let mut command = Command::new(exe_path);
    command.arg("listen").arg("--json");

    if let Some(relay) = &opts.relay {
        command.arg("--relay").arg(relay);
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command.spawn()?;

    for _ in 0..40 {
        if let Ok(status) = daemon.send_command("status", json!({})).await {
            return Ok(status);
        }

        if let Some(exit_status) = child.try_wait()? {
            anyhow::bail!("Background listener exited early: {}", exit_status);
        }

        sleep(Duration::from_millis(250)).await;
    }

    anyhow::bail!("Timed out waiting for listener to start")
}

pub struct ListenOptions {
    pub relay: Option<String>,
    pub token: Option<String>,
    pub json: bool,
    pub background: bool,
    pub discoverable: bool,
    pub name: Option<String>,
    pub description: Option<String>,
    pub capabilities: Option<String>,
}

pub async fn run(opts: ListenOptions) -> Result<()> {
    let mut config = load_config()?;
    let mut config_changed = false;
    let mut created_identity = false;

    if config.identity.is_none() {
        if opts.discoverable {
            let name = opts
                .name
                .clone()
                .ok_or_else(|| anyhow::anyhow!("--name is required when using --discoverable"))?;
            let description = opts.description.clone().ok_or_else(|| {
                anyhow::anyhow!("--description is required when using --discoverable")
            })?;
            let capabilities = parse_capabilities(opts.capabilities.as_deref());

            let keypair = KeyPair::generate();
            let did = derive_did(keypair.verifying_key.as_bytes());

            config.identity = Some(IdentityConfig {
                did: did.clone(),
                public_key: keypair.public_key_hex(),
                private_key: keypair.private_key_hex(),
            });
            config.agent_card = Some(AgentCardConfig {
                name,
                description,
                capabilities,
            });
            config.published = Some(true);
            config_changed = true;
            created_identity = true;

            if !opts.json {
                println!("Created discoverable identity: {}", did);
            }
        } else {
            let anonymous = generate_anonymous_identity();
            config.identity = Some(anonymous.identity);
            config.agent_card = Some(anonymous.agent_card);
            config.published = Some(false);
            config_changed = true;
            created_identity = true;

            if !opts.json {
                println!(
                    "Created anonymous identity: {}",
                    config
                        .identity
                        .as_ref()
                        .map(|identity| identity.did.as_str())
                        .unwrap_or("unknown")
                );
                println!(
                    "Name: {}",
                    config
                        .agent_card
                        .as_ref()
                        .map(|card| card.name.as_str())
                        .unwrap_or("unknown")
                );
                println!("Status: anonymous (not discoverable)");
            }
        }
    }

    if opts.discoverable {
        let name = opts
            .name
            .clone()
            .ok_or_else(|| anyhow::anyhow!("--name is required when using --discoverable"))?;
        let description = opts.description.clone().ok_or_else(|| {
            anyhow::anyhow!("--description is required when using --discoverable")
        })?;
        let capabilities = parse_capabilities(opts.capabilities.as_deref());

        let next_card = AgentCardConfig {
            name,
            description,
            capabilities,
        };

        let needs_card_update = config
            .agent_card
            .as_ref()
            .map(|card| {
                card.name != next_card.name
                    || card.description != next_card.description
                    || card.capabilities != next_card.capabilities
            })
            .unwrap_or(true);

        if needs_card_update {
            config.agent_card = Some(next_card);
            config_changed = true;
        }

        if config.published != Some(true) {
            config.published = Some(true);
            config_changed = true;
        }

        if config_changed && !created_identity && !opts.json {
            let did = config
                .identity
                .as_ref()
                .map(|identity| identity.did.as_str())
                .unwrap_or("unknown");
            println!("Updated discoverable agent card: {}", did);
        }
    }

    let next_token = normalize_token(opts.token.as_deref());
    let current_token = normalize_token(config.relay_invite_token.as_deref());
    if next_token.is_some() && next_token != current_token {
        config.relay_invite_token = next_token;
        config_changed = true;
    }

    let socket_path = daemon_socket_path();
    let daemon = DaemonClient::new(&socket_path);
    let daemon_status = daemon.send_command("status", json!({})).await.ok();
    let daemon_running = daemon_status.is_some();
    let relay_changed = daemon_status
        .as_ref()
        .and_then(|status| status.get("relay").and_then(|value| value.as_str()))
        .map(|current| {
            opts.relay
                .as_deref()
                .map(|desired| desired != current)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let should_restart = daemon_running && (config_changed || relay_changed);

    if config_changed {
        save_config(&config)?;
    }

    if opts.background {
        if daemon_running && !should_restart {
            let status = daemon_status.unwrap_or_else(|| json!({}));
            if !opts.json {
                println!("Agent already listening");
                if let Some(did) = status.get("did").and_then(|value| value.as_str()) {
                    println!("DID: {}", did);
                }
                if opts.discoverable {
                    println!("Discovery mode: discoverable");
                }
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "status": "already_running",
                        "did": status.get("did").cloned().unwrap_or(Value::Null),
                        "createdIdentity": created_identity,
                        "discoverable": opts.discoverable,
                    }))?
                );
            }
            return Ok(());
        }

        if should_restart {
            if !opts.json {
                println!("Restarting existing listener...");
            }
            stop_existing_daemon(&daemon).await?;
            let status = spawn_background_listener(&opts, &daemon).await?;
            if !opts.json {
                println!("Agent listener restarted in background");
                if let Some(did) = status.get("did").and_then(|value| value.as_str()) {
                    println!("DID: {}", did);
                }
                if created_identity {
                    println!("Identity created automatically");
                }
                if opts.discoverable {
                    println!("Discovery mode: discoverable");
                }
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "status": "restarted",
                        "did": status.get("did").cloned().unwrap_or(Value::Null),
                        "createdIdentity": created_identity,
                        "discoverable": opts.discoverable,
                    }))?
                );
            }
            return Ok(());
        }

        let status = spawn_background_listener(&opts, &daemon).await?;
        if !opts.json {
            println!("Agent now listening in background");
            if let Some(did) = status.get("did").and_then(|value| value.as_str()) {
                println!("DID: {}", did);
            }
            if created_identity {
                println!("Identity created automatically");
            }
            if opts.discoverable {
                println!("Discovery mode: discoverable");
            }
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "status": "started",
                    "did": status.get("did").cloned().unwrap_or(Value::Null),
                    "createdIdentity": created_identity,
                    "discoverable": opts.discoverable,
                }))?
            );
        }
        return Ok(());
    }

    if daemon_running {
        if !should_restart {
            if !opts.json {
                println!("Agent already listening");
                let did = daemon_status
                    .as_ref()
                    .and_then(|status| status.get("did").and_then(|value| value.as_str()))
                    .or_else(|| {
                        config
                            .identity
                            .as_ref()
                            .map(|identity| identity.did.as_str())
                    })
                    .unwrap_or("unknown");
                println!("DID: {}", did);
            }
            return Ok(());
        }
        stop_existing_daemon(&daemon).await?;
    }

    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;
    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let daemon = DaemonServer::new(config, keypair, &socket_path);

    if !opts.json {
        if created_identity {
            println!("Identity created automatically");
        }
        println!("Starting daemon server...");
    }

    daemon.start(opts.relay.as_deref()).await?;

    Ok(())
}
