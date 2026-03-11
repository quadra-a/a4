/// Unix socket daemon for agent communication.
/// Protocol: NDJSON — one JSON object per line.
/// Request:  {"id":"req_...","command":"send","params":{...}}\n
/// Response: {"id":"req_...","success":true,"data":{...}}\n
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::config::{
    resolve_reachability_policy, resolve_relay_invite_token, save_config, Config, EndorsementV2,
    TrustConfig,
};
use crate::identity::KeyPair;
use crate::protocol::{cbor_x_encode_json, AgentCard};
use crate::trust::{ActivityLevel, NetworkPosition, TrustEngine};
use quadra_a_runtime::card::build_agent_card_from_config;
use quadra_a_runtime::inbox::{
    effective_thread_id, parse_envelope_value, MessageDirection, MessageStore, StoredMessage,
};
use quadra_a_runtime::query::{
    query_discovered_agents as runtime_query_discovered_agents,
    query_network_endorsements as runtime_query_network_endorsements,
};
use quadra_a_runtime::relay_worker::{
    run_relay_worker as runtime_run_relay_worker, RelayWorkerCommand, RelayWorkerEvent,
    RelayWorkerOptions,
};
use quadra_a_runtime::session_manager::ManagedRelayState;

pub const DEFAULT_DAEMON_SOCKET: &str = "/tmp/quadra-a-rs.sock";

fn resolve_daemon_socket_path(
    rust_socket_path: Option<String>,
    shared_socket_path: Option<String>,
) -> String {
    rust_socket_path
        .or(shared_socket_path)
        .unwrap_or_else(|| DEFAULT_DAEMON_SOCKET.to_string())
}

pub fn daemon_socket_path() -> String {
    resolve_daemon_socket_path(
        std::env::var("QUADRA_A_RS_SOCKET_PATH").ok(),
        std::env::var("QUADRA_A_SOCKET_PATH").ok(),
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|v| {
        v.as_u64().or_else(|| {
            v.as_f64().and_then(|f| {
                if f.is_finite() && f >= 0.0 && f.fract() == 0.0 {
                    Some(f as u64)
                } else {
                    None
                }
            })
        })
    })
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(|v| v.as_f64())
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub struct DaemonState {
    pub config: Config,
    pub keypair: KeyPair,
    pub relay_runtime: ManagedRelayState,
    relay_sender: Option<mpsc::Sender<RelayWorkerCommand>>,
    pub messages: MessageStore,
    pub running: bool,
}

pub struct DaemonServer {
    state: Arc<RwLock<DaemonState>>,
    socket_path: String,
}

fn matches_capability(card: &AgentCard, capability: &str) -> bool {
    let normalized = capability.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    card.capabilities.iter().any(|entry| {
        let candidate = entry.id.to_lowercase();
        candidate == normalized || candidate.starts_with(&format!("{}/", normalized))
    })
}

impl DaemonServer {
    pub fn new(config: Config, keypair: KeyPair, socket_path: &str) -> Self {
        let reachability_policy = resolve_reachability_policy(None, Some(&config));
        let state = DaemonState {
            config,
            keypair,
            relay_runtime: ManagedRelayState::new(reachability_policy),
            relay_sender: None,
            messages: MessageStore::default(),
            running: true,
        };

        DaemonServer {
            state: Arc::new(RwLock::new(state)),
            socket_path: socket_path.to_string(),
        }
    }

    pub async fn start(&self, explicit_relay: Option<&str>) -> Result<()> {
        let _ = std::fs::remove_file(&self.socket_path);

        let listener = UnixListener::bind(&self.socket_path)
            .with_context(|| format!("Failed to bind to socket {}", self.socket_path))?;

        {
            let mut state = self.state.write().await;
            let identity = state
                .config
                .identity
                .clone()
                .ok_or_else(|| anyhow::anyhow!("No identity found"))?;
            let should_publish = state.config.published.unwrap_or(false);
            let reachability_policy =
                resolve_reachability_policy(explicit_relay, Some(&state.config));
            let card = build_agent_card_from_config(&state.config, &identity)?;
            let invite_token = resolve_relay_invite_token(None, Some(&state.config));
            let (relay_tx, relay_rx) = mpsc::channel(32);
            let (event_tx, event_rx) = mpsc::channel(128);

            state.relay_runtime.reset(reachability_policy.clone());
            let relay_runtime = state.relay_runtime.clone();
            state.relay_sender = Some(relay_tx);

            eprintln!(
                "Daemon managing relays: {}",
                state.relay_runtime.known_relays.join(", ")
            );

            let state_clone = Arc::clone(&self.state);
            tokio::spawn(async move {
                Self::process_relay_worker_events(state_clone, event_rx).await;
            });

            let worker_options = RelayWorkerOptions {
                should_publish,
                ..RelayWorkerOptions::new(identity, card, invite_token)
            };
            tokio::spawn(async move {
                runtime_run_relay_worker(relay_runtime, relay_rx, event_tx, worker_options).await;
            });
        }

        loop {
            match timeout(Duration::from_millis(250), listener.accept()).await {
                Ok(Ok((stream, _))) => {
                    let state_clone = Arc::clone(&self.state);
                    tokio::spawn(async move {
                        if let Err(e) = Self::handle_client(stream, state_clone).await {
                            eprintln!("Client handler error: {}", e);
                        }
                    });
                }
                Ok(Err(e)) => {
                    eprintln!("Failed to accept connection: {}", e);
                    break;
                }
                Err(_) => {}
            }

            if !self.state.read().await.running {
                break;
            }
        }

        let _ = std::fs::remove_file(&self.socket_path);
        Ok(())
    }

    async fn process_relay_worker_events(
        state: Arc<RwLock<DaemonState>>,
        mut event_rx: mpsc::Receiver<RelayWorkerEvent>,
    ) {
        while let Some(event) = event_rx.recv().await {
            match event {
                RelayWorkerEvent::EnvelopeReceived {
                    relay_url,
                    message_id,
                    from,
                    envelope_bytes,
                    received_at,
                } => {
                    let envelope = match parse_envelope_value(&envelope_bytes) {
                        Ok(envelope) => envelope,
                        Err(err) => {
                            eprintln!(
                                "Skipping relay message {} from {} on {}: {}",
                                message_id, from, relay_url, err,
                            );
                            continue;
                        }
                    };

                    let message = StoredMessage {
                        id: envelope
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&message_id)
                            .to_string(),
                        from,
                        to: envelope
                            .get("to")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        timestamp: json_u64(envelope.get("timestamp")).unwrap_or(received_at),
                        thread_id: envelope
                            .get("threadId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        envelope,
                        read: false,
                        direction: MessageDirection::Inbound,
                    };

                    let mut state_guard = state.write().await;
                    state_guard.messages.store(message);
                }
                RelayWorkerEvent::DeliveryReported {
                    relay_url,
                    message_id,
                    status,
                    ..
                } => {
                    eprintln!(
                        "Relay delivery report on {} for {}: {}",
                        relay_url, message_id, status,
                    );
                }
                other => {
                    let mut state_guard = state.write().await;
                    let known_relays_before = state_guard.relay_runtime.known_relays.len();
                    state_guard.relay_runtime.apply_worker_event(&other);

                    match &other {
                        RelayWorkerEvent::Connected { relay_url, .. } => {
                            let did = state_guard
                                .config
                                .identity
                                .as_ref()
                                .map(|identity| identity.did.as_str())
                                .unwrap_or("unknown");
                            eprintln!("Daemon connected to relay {} as {}", relay_url, did);
                        }
                        RelayWorkerEvent::RelayPoolUpdated { .. }
                            if state_guard.relay_runtime.known_relays.len()
                                > known_relays_before =>
                        {
                            eprintln!(
                                "Daemon supplemented relay pool: {}",
                                state_guard.relay_runtime.known_relays.join(", ")
                            );
                        }
                        _ => {}
                    }
                }
            }
        }

        let mut state_guard = state.write().await;
        state_guard.relay_runtime.mark_disconnected();
        state_guard.relay_sender = None;
    }

    async fn handle_client(stream: UnixStream, state: Arc<RwLock<DaemonState>>) -> Result<()> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut buf = String::new();

        loop {
            buf.clear();
            let n = reader.read_line(&mut buf).await?;
            if n == 0 {
                break;
            }

            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }

            let request: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    let error_response = json!({
                        "id": "unknown",
                        "success": false,
                        "error": format!("Invalid JSON: {}", e),
                    });
                    let mut line = serde_json::to_string(&error_response)?;
                    line.push('\n');
                    write_half.write_all(line.as_bytes()).await?;
                    continue;
                }
            };

            let request_id = request
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let command = request
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let params = request.get("params").cloned().unwrap_or(Value::Null);

            let response = Self::handle_command(command, params, Arc::clone(&state)).await;
            let response_json = json!({
                "id": request_id,
                "success": response.is_ok(),
                "data": response.as_ref().ok().cloned().unwrap_or(Value::Null),
                "error": response.as_ref().err().map(|e| e.to_string()).unwrap_or_default(),
            });

            let mut line = serde_json::to_string(&response_json)?;
            line.push('\n');
            write_half.write_all(line.as_bytes()).await?;
        }

        Ok(())
    }

    async fn handle_command(
        command: &str,
        params: Value,
        state: Arc<RwLock<DaemonState>>,
    ) -> Result<Value> {
        match command {
            "status" => handle_status(state).await,
            "inbox" => handle_inbox(params, state).await,
            "send" => handle_send(params, state).await,
            "discover" => handle_discover(params, state).await,
            "peers" => handle_peers(params, state).await,
            "sessions" => handle_sessions(params, state).await,
            "session_messages" => handle_session_messages(params, state).await,
            "trust_score" => handle_trust_score(params, state).await,
            "endorsements" | "query_endorsements" => handle_endorsements(params, state).await,
            "block_agent" => handle_block_agent(params, state).await,
            "stop" => {
                let relay_sender = {
                    let mut state_guard = state.write().await;
                    state_guard.running = false;
                    state_guard.relay_runtime.mark_disconnected();
                    state_guard.relay_sender.clone()
                };
                if let Some(relay_sender) = relay_sender {
                    let _ = relay_sender.send(RelayWorkerCommand::Stop).await;
                }
                Ok(json!({"stopping": true}))
            }
            _ => Err(anyhow::anyhow!("Unknown command: {}", command)),
        }
    }
}

async fn handle_status(state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let state_guard = state.read().await;
    let did = state_guard
        .config
        .identity
        .as_ref()
        .map(|identity| identity.did.clone());
    let connected_relays = if state_guard.relay_runtime.connected {
        vec![state_guard.relay_runtime.relay_url.clone()]
    } else {
        Vec::<String>::new()
    };
    let known_relays = state_guard.relay_runtime.known_relays.clone();
    let reachability_policy = state_guard.relay_runtime.reachability_policy.clone();
    let relay_failures = state_guard.relay_runtime.failure_snapshot();

    Ok(json!({
        "running": state_guard.running,
        "connected": state_guard.relay_runtime.connected,
        "messages": state_guard.messages.len(),
        "relay": state_guard.relay_runtime.relay_url.clone(),
        "connectedRelays": connected_relays.clone(),
        "knownRelays": known_relays.clone(),
        "reachabilityPolicy": reachability_policy.clone(),
        "reachabilityStatus": {
            "connectedProviders": connected_relays,
            "knownProviders": known_relays,
            "lastDiscoveryAt": state_guard.relay_runtime.last_discovery_at,
            "providerFailures": relay_failures,
            "targetProviderCount": reachability_policy.target_provider_count,
            "mode": reachability_policy.mode,
            "autoDiscoverProviders": reachability_policy.auto_discover_providers,
            "operatorLock": reachability_policy.operator_lock,
            "bootstrapProviders": reachability_policy.bootstrap_providers,
        },
        "connectedAt": state_guard.relay_runtime.connected_at,
        "did": did,
    }))
}

async fn handle_inbox(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let mut state_guard = state.write().await;
    let limit = json_u64(
        params
            .get("limit")
            .or_else(|| params.get("pagination").and_then(|p| p.get("limit"))),
    )
    .unwrap_or(20) as usize;
    let unread = params
        .get("unread")
        .or_else(|| params.get("filter").and_then(|f| f.get("unread")))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let thread_id = params
        .get("threadId")
        .or_else(|| params.get("filter").and_then(|f| f.get("threadId")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let (selected, total) = state_guard
        .messages
        .inbox_page(limit, unread, thread_id.as_deref());
    let messages = selected
        .into_iter()
        .map(|message| message_to_inbox_json(&message))
        .collect::<Vec<_>>();

    Ok(json!({
        "messages": messages,
        "total": total,
    }))
}

async fn handle_send(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let mut state_guard = state.write().await;
    let identity = state_guard
        .config
        .identity
        .clone()
        .ok_or_else(|| anyhow::anyhow!("No identity found"))?;
    if !state_guard.relay_runtime.connected {
        anyhow::bail!("Not connected to any relay");
    }
    let relay_sender = state_guard
        .relay_sender
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Not connected to relay"))?;
    let to = params
        .get("to")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'to' field"))?
        .to_string();

    let (message_id, thread_id, envelope_json, envelope_bytes) =
        if let Some(envelope_hex) = params.get("envelope").and_then(|v| v.as_str()) {
            let bytes = hex::decode(envelope_hex).context("Invalid hex envelope")?;
            let envelope_json = parse_envelope_value(&bytes)?;
            let message_id = envelope_json
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let thread_id = envelope_json
                .get("threadId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (message_id, thread_id, envelope_json, bytes)
        } else {
            let msg_type = params
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("message");
            let protocol = params
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("highway1/chat/1.0");
            let payload = params.get("payload").cloned().unwrap_or_else(|| json!({}));
            let reply_to = params
                .get("replyTo")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let thread_id = params
                .get("threadId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let envelope = crate::commands::send::build_envelope(
                &identity.did,
                &to,
                msg_type,
                protocol,
                payload,
                crate::commands::send::EnvelopeThreading::new(reply_to, thread_id.clone()),
                &state_guard.keypair,
            )?;
            let envelope_json = serde_json::to_value(&envelope)?;
            let envelope_bytes = cbor_x_encode_json(&envelope_json);
            (
                envelope.id.clone(),
                envelope.thread_id.clone(),
                envelope_json,
                envelope_bytes,
            )
        };

    let (response_tx, response_rx) = oneshot::channel();
    relay_sender
        .send(RelayWorkerCommand::SendEnvelope {
            to: to.clone(),
            envelope_bytes,
            response: response_tx,
        })
        .await
        .context("Failed to reach relay worker")?;
    response_rx
        .await
        .context("Relay worker dropped send response")??;

    let message = StoredMessage {
        id: message_id.clone(),
        from: identity.did,
        to,
        timestamp: json_u64(envelope_json.get("timestamp")).unwrap_or_else(now_ms),
        thread_id: thread_id.clone(),
        envelope: envelope_json,
        read: true,
        direction: MessageDirection::Outbound,
    };
    state_guard.messages.store(message);

    Ok(json!({
        "sent": true,
        "id": message_id,
        "messageId": message_id,
        "threadId": thread_id,
    }))
}

async fn handle_discover(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let (relay_urls, invite_token) = {
        let state_guard = state.read().await;
        (
            state_guard.relay_runtime.candidates(),
            resolve_relay_invite_token(None, Some(&state_guard.config)),
        )
    };
    let limit = json_u64(params.get("limit")).unwrap_or(20) as u32;
    let capability = non_empty_str(params.get("capability"));
    let min_trust = json_f64(
        params
            .get("minTrust")
            .or_else(|| params.get("filters").and_then(|f| f.get("minTrustScore"))),
    );
    let query = non_empty_str(params.get("query"));

    let mut discovered: Vec<(AgentCard, bool)> = if query.is_some() {
        runtime_query_discovered_agents(
            &relay_urls,
            invite_token.as_deref(),
            query,
            None,
            min_trust,
            limit,
        )
        .await?
        .into_iter()
        .map(|result| (result.card, result.online))
        .collect()
    } else {
        runtime_query_discovered_agents(
            &relay_urls,
            invite_token.as_deref(),
            None,
            capability,
            min_trust,
            limit,
        )
        .await?
        .into_iter()
        .map(|result| (result.card, result.online))
        .collect()
    };

    if let (Some(_query), Some(capability)) = (query, capability) {
        discovered.retain(|(card, _)| matches_capability(card, capability));
    }

    let cards = discovered
        .into_iter()
        .map(|(card, online)| {
            let mut value = serde_json::to_value(card).unwrap_or_else(|_| json!({}));
            if let Some(obj) = value.as_object_mut() {
                obj.insert("online".to_string(), Value::Bool(online));
            }
            value
        })
        .collect::<Vec<_>>();

    Ok(json!(cards))
}

async fn handle_peers(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let (relay_urls, relay_url, connected_at, invite_token) = {
        let state_guard = state.read().await;
        (
            state_guard.relay_runtime.candidates(),
            state_guard.relay_runtime.relay_url.clone(),
            state_guard.relay_runtime.connected_at,
            resolve_relay_invite_token(None, Some(&state_guard.config)),
        )
    };
    let limit = json_u64(params.get("limit")).unwrap_or(20) as u32;
    let capability = non_empty_str(params.get("capability"));
    let min_trust = json_f64(params.get("minTrust"));
    let query = non_empty_str(params.get("query"));

    let mut discovered: Vec<(AgentCard, bool)> = if query.is_some() {
        runtime_query_discovered_agents(
            &relay_urls,
            invite_token.as_deref(),
            query,
            None,
            min_trust,
            limit,
        )
        .await?
        .into_iter()
        .map(|result| (result.card, result.online))
        .collect()
    } else {
        runtime_query_discovered_agents(
            &relay_urls,
            invite_token.as_deref(),
            None,
            capability,
            min_trust,
            limit,
        )
        .await?
        .into_iter()
        .map(|result| (result.card, result.online))
        .collect()
    };

    if let (Some(_query), Some(capability)) = (query, capability) {
        discovered.retain(|(card, _)| matches_capability(card, capability));
    }

    let peers = discovered
        .into_iter()
        .map(|(card, online)| {
            json!({
                "did": card.did,
                "name": card.name,
                "description": card.description,
                "relay": relay_url,
                "connectedAt": if online { connected_at } else { 0 },
                "online": online,
                "capabilities": card.capabilities,
                "trust": card.trust,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({ "peers": peers }))
}

async fn handle_sessions(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let state_guard = state.read().await;
    let limit = json_u64(params.get("limit")).unwrap_or(50) as usize;
    let peer_filter = params.get("peerDid").and_then(|v| v.as_str());

    let all_sessions = state_guard.messages.session_summaries(peer_filter);
    let total = all_sessions.len();
    let sessions = all_sessions
        .into_iter()
        .take(limit)
        .map(|session| {
            json!({
                "threadId": session.thread_id,
                "peerDid": session.peer_did,
                "startedAt": session.started_at,
                "lastMessageAt": session.last_message_at,
                "messageCount": session.message_count,
                "title": session.title,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "sessions": sessions,
        "total": total,
    }))
}

async fn handle_session_messages(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let thread_id = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'threadId' field"))?;
    let limit = json_u64(params.get("limit")).unwrap_or(50) as usize;

    let state_guard = state.read().await;
    let (messages, total) = state_guard.messages.session_messages(thread_id, limit);
    let page = messages
        .into_iter()
        .map(|message| message_to_session_json(&message))
        .collect::<Vec<_>>();

    Ok(json!({
        "messages": page,
        "total": total,
    }))
}

async fn handle_trust_score(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let target_did = params
        .get("targetDid")
        .or_else(|| params.get("did"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing target DID"))?
        .to_string();

    let (observer_did, relay_urls, invite_token, local_trust_config) = {
        let state_guard = state.read().await;
        let observer_did = state_guard
            .config
            .identity
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No identity found"))?
            .did
            .clone();
        (
            observer_did,
            state_guard.relay_runtime.candidates(),
            resolve_relay_invite_token(None, Some(&state_guard.config)),
            state_guard.config.trust_config.clone().unwrap_or_default(),
        )
    };

    let mut endorsements: Vec<EndorsementV2> =
        local_trust_config.endorsements.values().cloned().collect();
    if let Ok(network_endorsements) = runtime_query_network_endorsements(
        &relay_urls,
        invite_token.as_deref(),
        &target_did,
        None,
        100,
    )
    .await
    {
        merge_endorsements(&mut endorsements, network_endorsements);
    }

    let mut engine = TrustEngine::new(local_trust_config);
    let trust_score = engine.compute_trust_score(&target_did, &observer_did, &endorsements)?;

    {
        let mut state_guard = state.write().await;
        state_guard.config.trust_config = Some(engine.config.clone());
        let _ = save_config(&state_guard.config);
    }

    Ok(json!({
        "score": trust_score.score,
        "localTrust": trust_score.local_trust,
        "networkTrust": trust_score.network_trust,
        "alpha": trust_score.alpha,
        "endorsementCount": trust_score.endorsement_count,
        "interactionCount": trust_score.interaction_count,
        "breakdown": {
            "capabilityEndorsements": trust_score.breakdown.capability_endorsements,
            "reliabilityEndorsements": trust_score.breakdown.reliability_endorsements,
            "generalEndorsements": trust_score.breakdown.general_endorsements,
            "recentActivity": activity_level_name(&trust_score.breakdown.recent_activity),
            "networkPosition": network_position_name(&trust_score.breakdown.network_position),
        }
    }))
}

async fn handle_endorsements(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let target_did = params
        .get("targetDid")
        .or_else(|| params.get("did"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let created_by = params
        .get("createdBy")
        .or_else(|| params.get("endorser"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let limit = json_u64(params.get("limit")).unwrap_or(20) as usize;
    let domain = non_empty_str(params.get("domain"));

    let (relay_urls, invite_token, mut endorsements) = {
        let state_guard = state.read().await;
        (
            state_guard.relay_runtime.candidates(),
            resolve_relay_invite_token(None, Some(&state_guard.config)),
            state_guard
                .config
                .trust_config
                .clone()
                .unwrap_or_else(TrustConfig::new)
                .endorsements
                .into_values()
                .collect::<Vec<_>>(),
        )
    };

    if let Some(target_did) = &target_did {
        if let Ok(network_endorsements) = runtime_query_network_endorsements(
            &relay_urls,
            invite_token.as_deref(),
            target_did,
            domain,
            limit as u32 + 20,
        )
        .await
        {
            merge_endorsements(&mut endorsements, network_endorsements);
        }
    }

    endorsements.retain(|endorsement| {
        let target_matches = target_did
            .as_ref()
            .map(|target| &endorsement.endorsee == target)
            .unwrap_or(true);
        let creator_matches = created_by
            .as_ref()
            .map(|creator| &endorsement.endorser == creator)
            .unwrap_or(true);
        let domain_matches = domain
            .map(|requested| {
                endorsement.domain.as_deref() == Some(requested)
                    || endorsement.domain.as_deref() == Some("*")
                    || endorsement.domain.is_none()
            })
            .unwrap_or(true);
        target_matches && creator_matches && domain_matches
    });
    endorsements.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let total = endorsements.len();
    let endorsements = endorsements
        .into_iter()
        .take(limit)
        .map(|endorsement| serde_json::to_value(endorsement).unwrap_or_else(|_| json!({})))
        .collect::<Vec<_>>();

    Ok(json!({
        "endorsements": endorsements,
        "totalCount": total,
    }))
}

async fn handle_block_agent(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let target_did = params
        .get("targetDid")
        .or_else(|| params.get("did"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing target DID"))?
        .to_string();

    let action = params
        .get("action")
        .and_then(|value| value.as_str())
        .unwrap_or("block");

    let mut state_guard = state.write().await;
    if state_guard.config.trust_config.is_none() {
        state_guard.config.trust_config = Some(TrustConfig::new());
    }

    if let Some(trust_config) = &mut state_guard.config.trust_config {
        if action == "unblock" {
            trust_config.unblock_agent(&target_did);
        } else {
            trust_config.block_agent(target_did.clone());
        }
    }

    save_config(&state_guard.config)?;

    Ok(json!({
        "blocked": action != "unblock",
        "targetDid": target_did,
    }))
}

fn activity_level_name(level: &ActivityLevel) -> &'static str {
    match level {
        ActivityLevel::Low => "Low",
        ActivityLevel::Medium => "Medium",
        ActivityLevel::High => "High",
    }
}

fn network_position_name(position: &NetworkPosition) -> &'static str {
    match position {
        NetworkPosition::Isolated => "Isolated",
        NetworkPosition::Connected => "Connected",
        NetworkPosition::WellConnected => "WellConnected",
        NetworkPosition::Central => "Central",
    }
}

fn merge_endorsements(existing: &mut Vec<EndorsementV2>, incoming: Vec<EndorsementV2>) {
    let mut dedup = HashMap::new();
    for endorsement in existing.drain(..) {
        let key = endorsement.signature.clone();
        dedup.insert(key, endorsement);
    }
    for endorsement in incoming {
        let key = endorsement.signature.clone();
        dedup.entry(key).or_insert(endorsement);
    }
    existing.extend(dedup.into_values());
}

fn message_to_inbox_json(message: &StoredMessage) -> Value {
    json!({
        "id": message.id,
        "from": message.from,
        "to": message.to,
        "direction": message.direction.as_str(),
        "envelope": message.envelope,
        "timestamp": message.timestamp,
        "threadId": effective_thread_id(message),
        "read": message.read,
        "receivedAt": if message.direction == MessageDirection::Inbound { json!(message.timestamp) } else { Value::Null },
        "sentAt": if message.direction == MessageDirection::Outbound { json!(message.timestamp) } else { Value::Null },
    })
}

fn message_to_session_json(message: &StoredMessage) -> Value {
    json!({
        "id": message.id,
        "direction": message.direction.as_str(),
        "envelope": message.envelope,
        "receivedAt": if message.direction == MessageDirection::Inbound { json!(message.timestamp) } else { Value::Null },
        "sentAt": if message.direction == MessageDirection::Outbound { json!(message.timestamp) } else { Value::Null },
    })
}

pub struct DaemonClient {
    socket_path: String,
}

impl DaemonClient {
    pub fn new(socket_path: &str) -> Self {
        DaemonClient {
            socket_path: socket_path.to_string(),
        }
    }

    pub async fn send_command(&self, command: &str, params: Value) -> Result<Value> {
        let request_id = format!("req_{}", Uuid::new_v4().to_string().replace('-', ""));

        let stream = UnixStream::connect(&self.socket_path)
            .await
            .with_context(|| format!("Failed to connect to daemon at {}", self.socket_path))?;

        let (read_half, mut write_half) = stream.into_split();

        let request = json!({
            "id": request_id,
            "command": command,
            "params": params,
        });
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        write_half.write_all(line.as_bytes()).await?;

        let req_id = request_id.clone();
        let result = timeout(Duration::from_secs(30), async move {
            let mut reader = BufReader::new(read_half);
            let mut buf = String::new();
            loop {
                buf.clear();
                let n = reader.read_line(&mut buf).await?;
                if n == 0 {
                    anyhow::bail!("Daemon closed connection without response");
                }
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let response: Value =
                    serde_json::from_str(trimmed).context("Failed to parse daemon response")?;
                if response.get("id").and_then(|v| v.as_str()) != Some(&req_id) {
                    continue;
                }
                if response
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    return Ok(response.get("data").cloned().unwrap_or(Value::Null));
                }
                let err = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown daemon error");
                anyhow::bail!("{}", err);
            }
        })
        .await
        .context("Daemon request timed out")??;

        Ok(result)
    }

    pub async fn is_running(&self) -> bool {
        self.send_command("status", json!({})).await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_daemon_socket_path, DEFAULT_DAEMON_SOCKET};

    #[test]
    fn prefers_rust_specific_socket_path() {
        let actual = resolve_daemon_socket_path(
            Some("/tmp/rust.sock".to_string()),
            Some("/tmp/shared.sock".to_string()),
        );
        assert_eq!(actual, "/tmp/rust.sock");
    }

    #[test]
    fn falls_back_to_shared_socket_path() {
        let actual = resolve_daemon_socket_path(None, Some("/tmp/shared.sock".to_string()));
        assert_eq!(actual, "/tmp/shared.sock");
    }

    #[test]
    fn uses_rust_default_when_no_env_is_set() {
        let actual = resolve_daemon_socket_path(None, None);
        assert_eq!(actual, DEFAULT_DAEMON_SOCKET);
    }
}
