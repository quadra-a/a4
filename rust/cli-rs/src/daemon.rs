/// Unix socket daemon for agent communication.
/// Protocol: NDJSON — one JSON object per line.
/// Request:  {"id":"req_...","command":"send","params":{...}}\n
/// Response: {"id":"req_...","success":true,"data":{...}}\n
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::time::{sleep, timeout, Duration};
use uuid::Uuid;

use crate::config::{
    resolve_reachability_policy, save_config, Config, EndorsementV2, IdentityConfig,
    ReachabilityMode, ReachabilityPolicy, TrustConfig,
};
use crate::identity::{derive_did, KeyPair};
use crate::protocol::{cbor_x_encode_json, AgentCard, AgentCardUnsigned, Capability};
use crate::relay::{extract_discovered_relay_endpoints, RelaySession, DEFAULT_RELAY};
use crate::trust::{ActivityLevel, NetworkPosition, TrustEngine};

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

fn parse_envelope_value(envelope_bytes: &[u8]) -> Result<Value> {
    if let Ok(value) = crate::protocol::cbor_decode_value(envelope_bytes) {
        return Ok(value);
    }

    serde_json::from_slice::<Value>(envelope_bytes).context("Invalid envelope payload")
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MessageDirection {
    Inbound,
    Outbound,
}

impl MessageDirection {
    fn as_str(self) -> &'static str {
        match self {
            MessageDirection::Inbound => "inbound",
            MessageDirection::Outbound => "outbound",
        }
    }
}

#[derive(Clone)]
pub struct Message {
    pub id: String,
    pub from: String,
    pub to: String,
    pub envelope: Value,
    pub timestamp: u64,
    pub thread_id: Option<String>,
    pub read: bool,
    pub direction: MessageDirection,
}

pub struct DaemonState {
    pub config: Config,
    pub keypair: KeyPair,
    pub relay_url: String,
    relay_sender: Option<mpsc::Sender<RelayCommand>>,
    pub messages: Vec<Message>,
    pub running: bool,
    pub connected: bool,
    pub connected_at: u64,
    pub reachability_policy: ReachabilityPolicy,
    pub known_relays: Vec<String>,
    pub last_discovery_at: Option<u64>,
    pub relay_failures: HashMap<String, RelayFailureState>,
}

pub struct DaemonServer {
    state: Arc<RwLock<DaemonState>>,
    socket_path: String,
}

#[derive(Debug, Deserialize)]
struct DiscoveredAgentEnvelope {
    did: Option<String>,
    online: Option<bool>,
    #[serde(default)]
    trust: Option<Value>,
    card: AgentCard,
}

struct SessionSummary {
    thread_id: String,
    peer_did: String,
    started_at: u64,
    last_message_at: u64,
    message_count: usize,
    title: String,
}

#[derive(Clone, Serialize)]
pub struct RelayFailureState {
    pub provider: String,
    pub attempts: u32,
    #[serde(rename = "lastFailureAt")]
    pub last_failure_at: u64,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

enum RelayCommand {
    SendEnvelope {
        to: String,
        envelope_bytes: Vec<u8>,
        response: oneshot::Sender<Result<()>>,
    },
    Stop,
}

const RELAY_DISCOVERY_CAPABILITY: &str = "relay/message-routing";
const RELAY_MAINTENANCE_INTERVAL_SECS: u64 = 60;
const RELAY_RECONNECT_DELAY_SECS: u64 = 5;

fn relay_candidates(state: &DaemonState) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut relays = Vec::new();

    for relay_url in std::iter::once(state.relay_url.as_str())
        .chain(state.known_relays.iter().map(String::as_str))
        .chain(
            state
                .reachability_policy
                .bootstrap_providers
                .iter()
                .map(String::as_str),
        )
    {
        let normalized = relay_url.trim();
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized.to_string()) {
            relays.push(normalized.to_string());
        }
    }

    if relays.is_empty() {
        relays.push(DEFAULT_RELAY.to_string());
    }

    relays
}

fn insert_known_relays<I>(state: &mut DaemonState, relays: I) -> bool
where
    I: IntoIterator<Item = String>,
{
    let mut changed = false;
    for relay_url in relays {
        let normalized = relay_url.trim();
        if normalized.is_empty() {
            continue;
        }
        if state.known_relays.iter().any(|known| known == normalized) {
            continue;
        }
        state.known_relays.push(normalized.to_string());
        changed = true;
    }
    changed
}

fn relay_failure_snapshot(state: &DaemonState) -> Vec<RelayFailureState> {
    let mut failures = state
        .relay_failures
        .values()
        .cloned()
        .collect::<Vec<_>>();
    failures.sort_by(|left, right| left.provider.cmp(&right.provider));
    failures
}

async fn record_relay_failure(state: &Arc<RwLock<DaemonState>>, relay_url: &str, error: String) {
    let mut state_guard = state.write().await;
    let entry = state_guard
        .relay_failures
        .entry(relay_url.to_string())
        .or_insert(RelayFailureState {
            provider: relay_url.to_string(),
            attempts: 0,
            last_failure_at: 0,
            last_error: None,
        });
    entry.attempts = entry.attempts.saturating_add(1);
    entry.last_failure_at = now_ms();
    entry.last_error = Some(error);
}

async fn clear_relay_failure(state: &Arc<RwLock<DaemonState>>, relay_url: &str) {
    state.write().await.relay_failures.remove(relay_url);
}

impl DaemonServer {
    pub fn new(config: Config, keypair: KeyPair, socket_path: &str) -> Self {
        let reachability_policy = resolve_reachability_policy(None, Some(&config));
        let relay_url = reachability_policy
            .bootstrap_providers
            .first()
            .cloned()
            .unwrap_or_else(|| DEFAULT_RELAY.to_string());
        let state = DaemonState {
            config,
            keypair,
            relay_url,
            relay_sender: None,
            messages: Vec::new(),
            running: true,
            connected: false,
            connected_at: 0,
            reachability_policy: reachability_policy.clone(),
            known_relays: reachability_policy.bootstrap_providers.clone(),
            last_discovery_at: None,
            relay_failures: HashMap::new(),
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
            let reachability_policy = resolve_reachability_policy(explicit_relay, Some(&state.config));
            let card = crate::commands::discover::build_card(&state.config, &identity)?;
            let (relay_tx, relay_rx) = mpsc::channel(32);

            state.reachability_policy = reachability_policy.clone();
            state.known_relays = reachability_policy.bootstrap_providers.clone();
            if state.known_relays.is_empty() {
                state.known_relays.push(DEFAULT_RELAY.to_string());
            }
            state.relay_url = state
                .known_relays
                .first()
                .cloned()
                .unwrap_or_else(|| DEFAULT_RELAY.to_string());
            state.connected = false;
            state.connected_at = 0;
            state.last_discovery_at = None;
            state.relay_failures.clear();
            state.relay_sender = Some(relay_tx);

            eprintln!("Daemon managing relays: {}", state.known_relays.join(", "));

            let state_clone = Arc::clone(&self.state);
            tokio::spawn(async move {
                Self::run_relay_worker(state_clone, relay_rx, identity, card, should_publish).await;
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

    async fn connect_managed_session(
        state: &Arc<RwLock<DaemonState>>,
        identity: &IdentityConfig,
        card: &AgentCard,
        should_publish: bool,
    ) -> Result<(RelaySession, String)> {
        let keypair = KeyPair::from_hex(&identity.private_key)?;
        let relay_urls = {
            let state_guard = state.read().await;
            relay_candidates(&state_guard)
        };

        let mut errors = Vec::new();
        for relay_url in relay_urls {
            match RelaySession::connect(&relay_url, &identity.did, card, &keypair).await {
                Ok(mut session) => {
                    clear_relay_failure(state, &relay_url).await;
                    if should_publish {
                        if let Err(error) = session.publish_card().await {
                            record_relay_failure(
                                state,
                                &relay_url,
                                format!("publish failed: {}", error),
                            )
                            .await;
                            let _ = session.goodbye().await;
                            errors.push(format!("{}: publish failed: {}", relay_url, error));
                            continue;
                        }
                        eprintln!("Daemon published agent card for discovery");
                    }

                    {
                        let mut state_guard = state.write().await;
                        state_guard.relay_url = relay_url.clone();
                        state_guard.connected = true;
                        state_guard.connected_at = now_ms();
                        insert_known_relays(&mut state_guard, std::iter::once(relay_url.clone()));
                    }

                    eprintln!("Daemon connected to relay {} as {}", relay_url, identity.did);
                    return Ok((session, relay_url));
                }
                Err(error) => {
                    record_relay_failure(state, &relay_url, error.to_string()).await;
                    errors.push(format!("{}: {}", relay_url, error));
                }
            }
        }

        state.write().await.connected = false;
        anyhow::bail!(
            "Failed to connect to any relay: {}",
            if errors.is_empty() {
                "no configured relays".to_string()
            } else {
                errors.join(" | ")
            }
        )
    }

    async fn maintain_relay_set(state: &Arc<RwLock<DaemonState>>, relay_url: &str) -> Result<()> {
        let limit = {
            let state_guard = state.read().await;
            if !matches!(state_guard.reachability_policy.mode, ReachabilityMode::Adaptive)
                || !state_guard.reachability_policy.auto_discover_providers
            {
                return Ok(());
            }
            ((state_guard.reachability_policy.target_provider_count as usize).max(1) * 4)
                .max(10) as u32
        };

        let relay_endpoints = discover_relay_providers(relay_url, limit).await?;
        let mut state_guard = state.write().await;
        state_guard.last_discovery_at = Some(now_ms());
        if insert_known_relays(&mut state_guard, relay_endpoints) {
            eprintln!("Daemon supplemented relay pool: {}", state_guard.known_relays.join(", "));
        }
        Ok(())
    }

    async fn run_relay_worker(
        state: Arc<RwLock<DaemonState>>,
        mut relay_rx: mpsc::Receiver<RelayCommand>,
        identity: IdentityConfig,
        card: AgentCard,
        should_publish: bool,
    ) {
        let mut maintenance_interval = tokio::time::interval(Duration::from_secs(
            RELAY_MAINTENANCE_INTERVAL_SECS,
        ));
        maintenance_interval.tick().await;

        'worker: loop {
            if !state.read().await.running {
                break;
            }

            let (mut session, relay_url) = match Self::connect_managed_session(
                &state,
                &identity,
                &card,
                should_publish,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    eprintln!("Relay connect retry pending: {}", error);
                    tokio::select! {
                        maybe_command = relay_rx.recv() => {
                            match maybe_command {
                                Some(RelayCommand::Stop) | None => break 'worker,
                                Some(RelayCommand::SendEnvelope { response, .. }) => {
                                    let _ = response.send(Err(anyhow::anyhow!("Not connected to any relay")));
                                }
                            }
                        }
                        _ = sleep(Duration::from_secs(RELAY_RECONNECT_DELAY_SECS)) => {}
                    }
                    continue;
                }
            };

            let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
            ping_interval.tick().await;

            loop {
                if !state.read().await.running {
                    break 'worker;
                }

                tokio::select! {
                    maybe_command = relay_rx.recv() => {
                        match maybe_command {
                            Some(RelayCommand::SendEnvelope { to, envelope_bytes, response }) => {
                                let result = session.send_envelope(&to, envelope_bytes).await;
                                if let Err(error) = &result {
                                    record_relay_failure(&state, &relay_url, error.to_string()).await;
                                }
                                let failed = result.is_err();
                                let _ = response.send(result);
                                if failed {
                                    break;
                                }
                            }
                            Some(RelayCommand::Stop) | None => break 'worker,
                        }
                    }
                    result = session.next_deliver() => {
                        match result {
                            Ok((message_id, from, envelope_bytes)) => {
                                if !from.starts_with("__delivery_report:") {
                                    let envelope = match parse_envelope_value(&envelope_bytes) {
                                        Ok(envelope) => envelope,
                                        Err(err) => {
                                            eprintln!(
                                                "Skipping relay message {} from {}: {}",
                                                message_id,
                                                from,
                                                err,
                                            );
                                            continue;
                                        }
                                    };

                                    let message = Message {
                                        id: envelope.get("id").and_then(|v| v.as_str()).unwrap_or(&message_id).to_string(),
                                        from: from.clone(),
                                        to: envelope.get("to").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                        timestamp: json_u64(envelope.get("timestamp")).unwrap_or_else(now_ms),
                                        thread_id: envelope.get("threadId").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                        envelope,
                                        read: false,
                                        direction: MessageDirection::Inbound,
                                    };

                                    let mut state_guard = state.write().await;
                                    store_message(&mut state_guard, message);
                                }
                            }
                            Err(error) => {
                                eprintln!("Relay error on {}: {}", relay_url, error);
                                record_relay_failure(&state, &relay_url, error.to_string()).await;
                                break;
                            }
                        }
                    }
                    _ = ping_interval.tick() => {
                        if let Err(error) = session.ping().await {
                            eprintln!("Ping failed on {}: {}", relay_url, error);
                            record_relay_failure(&state, &relay_url, error.to_string()).await;
                            break;
                        }
                    }
                    _ = maintenance_interval.tick() => {
                        if let Err(error) = Self::maintain_relay_set(&state, &relay_url).await {
                            eprintln!("Relay maintenance skipped on {}: {}", relay_url, error);
                        }
                    }
                }
            }

            let _ = session.goodbye().await;
            state.write().await.connected = false;

            tokio::select! {
                maybe_command = relay_rx.recv() => {
                    match maybe_command {
                        Some(RelayCommand::Stop) | None => break 'worker,
                        Some(RelayCommand::SendEnvelope { response, .. }) => {
                            let _ = response.send(Err(anyhow::anyhow!("Not connected to any relay")));
                        }
                    }
                }
                _ = sleep(Duration::from_secs(RELAY_RECONNECT_DELAY_SECS)) => {}
            }
        }

        let mut state_guard = state.write().await;
        state_guard.connected = false;
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
                    state_guard.connected = false;
                    state_guard.relay_sender.clone()
                };
                if let Some(relay_sender) = relay_sender {
                    let _ = relay_sender.send(RelayCommand::Stop).await;
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
    let connected_relays = if state_guard.connected {
        vec![state_guard.relay_url.clone()]
    } else {
        Vec::<String>::new()
    };
    let known_relays = state_guard.known_relays.clone();
    let reachability_policy = state_guard.reachability_policy.clone();
    let relay_failures = relay_failure_snapshot(&state_guard);

    Ok(json!({
        "running": state_guard.running,
        "connected": state_guard.connected,
        "messages": state_guard.messages.len(),
        "relay": state_guard.relay_url.clone(),
        "connectedRelays": connected_relays.clone(),
        "knownRelays": known_relays.clone(),
        "reachabilityPolicy": reachability_policy.clone(),
        "reachabilityStatus": {
            "connectedProviders": connected_relays,
            "knownProviders": known_relays,
            "lastDiscoveryAt": state_guard.last_discovery_at,
            "providerFailures": relay_failures,
            "targetProviderCount": reachability_policy.target_provider_count,
            "mode": reachability_policy.mode,
            "autoDiscoverProviders": reachability_policy.auto_discover_providers,
            "operatorLock": reachability_policy.operator_lock,
            "bootstrapProviders": reachability_policy.bootstrap_providers,
        },
        "connectedAt": state_guard.connected_at,
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

    let mut matching: Vec<_> = state_guard
        .messages
        .iter_mut()
        .filter(|msg| {
            if unread && msg.read {
                return false;
            }

            if let Some(thread_id) = &thread_id {
                let effective = effective_thread_id(msg);
                if msg.thread_id.as_deref() != Some(thread_id.as_str()) && effective != *thread_id {
                    return false;
                }
            }

            true
        })
        .collect();

    matching.sort_by_key(|msg| msg.timestamp);
    let total = matching.len();

    let selected = matching.into_iter().rev().take(limit).collect::<Vec<_>>();
    let messages = selected
        .into_iter()
        .map(|msg| {
            msg.read = true;
            message_to_inbox_json(msg)
        })
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
    if !state_guard.connected {
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
                reply_to,
                thread_id.clone(),
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
        .send(RelayCommand::SendEnvelope {
            to: to.clone(),
            envelope_bytes,
            response: response_tx,
        })
        .await
        .context("Failed to reach relay worker")?;
    response_rx
        .await
        .context("Relay worker dropped send response")??;

    let message = Message {
        id: message_id.clone(),
        from: identity.did,
        to,
        timestamp: json_u64(envelope_json.get("timestamp")).unwrap_or_else(now_ms),
        thread_id: thread_id.clone(),
        envelope: envelope_json,
        read: true,
        direction: MessageDirection::Outbound,
    };
    store_message(&mut state_guard, message);

    Ok(json!({
        "sent": true,
        "id": message_id,
        "messageId": message_id,
        "threadId": thread_id,
    }))
}

async fn handle_discover(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let relay_urls = {
        let state_guard = state.read().await;
        relay_candidates(&state_guard)
    };
    let limit = json_u64(params.get("limit")).unwrap_or(20) as u32;
    let capability = non_empty_str(params.get("capability"));
    let min_trust = json_f64(
        params
            .get("minTrust")
            .or_else(|| params.get("filters").and_then(|f| f.get("minTrustScore"))),
    );
    let query = non_empty_str(params.get("query"));

    let mut discovered = if query.is_some() {
        query_discovered_agents(&relay_urls, query, None, min_trust, limit).await?
    } else {
        query_discovered_agents(&relay_urls, None, capability, min_trust, limit).await?
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
    let (relay_urls, relay_url, connected_at) = {
        let state_guard = state.read().await;
        (
            relay_candidates(&state_guard),
            state_guard.relay_url.clone(),
            state_guard.connected_at,
        )
    };
    let limit = json_u64(params.get("limit")).unwrap_or(20) as u32;
    let capability = non_empty_str(params.get("capability"));
    let min_trust = json_f64(params.get("minTrust"));
    let query = non_empty_str(params.get("query"));

    let mut discovered = if query.is_some() {
        query_discovered_agents(&relay_urls, query, None, min_trust, limit).await?
    } else {
        query_discovered_agents(&relay_urls, None, capability, min_trust, limit).await?
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

    let all_sessions = build_session_summaries(&state_guard.messages, peer_filter);
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
    let mut messages = state_guard
        .messages
        .iter()
        .filter(|msg| effective_thread_id(msg) == thread_id)
        .collect::<Vec<_>>();
    messages.sort_by_key(|msg| msg.timestamp);

    let total = messages.len();
    let start = total.saturating_sub(limit);
    let page = messages
        .into_iter()
        .skip(start)
        .map(message_to_session_json)
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

    let (observer_did, relay_urls, local_trust_config) = {
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
            relay_candidates(&state_guard),
            state_guard.config.trust_config.clone().unwrap_or_default(),
        )
    };

    let mut endorsements: Vec<EndorsementV2> =
        local_trust_config.endorsements.values().cloned().collect();
    if let Ok(network_endorsements) = query_network_endorsements(&relay_urls, &target_did, 100).await
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

    let (relay_urls, mut endorsements) = {
        let state_guard = state.read().await;
        (
            relay_candidates(&state_guard),
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
        if let Ok(network_endorsements) =
            query_network_endorsements(&relay_urls, target_did, limit as u32 + 20).await
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
        target_matches && creator_matches
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

    let mut state_guard = state.write().await;
    if state_guard.config.trust_config.is_none() {
        state_guard.config.trust_config = Some(TrustConfig::new());
    }

    if let Some(trust_config) = &mut state_guard.config.trust_config {
        trust_config.block_agent(target_did.clone());
    }

    save_config(&state_guard.config)?;

    Ok(json!({
        "blocked": true,
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

fn store_message(state: &mut DaemonState, message: Message) {
    state.messages.push(message);
    let msg_len = state.messages.len();
    if msg_len > 1000 {
        state.messages.drain(0..msg_len - 1000);
    }
}

fn effective_thread_id(message: &Message) -> String {
    message
        .thread_id
        .clone()
        .unwrap_or_else(|| format!("direct:{}", peer_did(message)))
}

fn peer_did(message: &Message) -> String {
    match message.direction {
        MessageDirection::Inbound => message.from.clone(),
        MessageDirection::Outbound => message.to.clone(),
    }
}

fn payload_text(payload: Option<&Value>) -> Option<String> {
    payload.and_then(|payload| {
        payload
            .get("text")
            .or_else(|| payload.get("message"))
            .and_then(|value| value.as_str())
            .map(|text| text.to_string())
    })
}

fn session_title(message: &Message) -> String {
    payload_text(message.envelope.get("payload"))
        .map(|text| {
            if text.chars().count() > 60 {
                text.chars().take(60).collect::<String>() + "..."
            } else {
                text
            }
        })
        .unwrap_or_else(|| format!("Conversation with {}", peer_did(message)))
}

fn build_session_summaries(messages: &[Message], peer_filter: Option<&str>) -> Vec<SessionSummary> {
    let mut sessions = HashMap::<String, SessionSummary>::new();

    for message in messages {
        let peer = peer_did(message);
        if let Some(peer_filter) = peer_filter {
            if peer != peer_filter {
                continue;
            }
        }

        let thread_id = effective_thread_id(message);
        let entry = sessions
            .entry(thread_id.clone())
            .or_insert_with(|| SessionSummary {
                thread_id: thread_id.clone(),
                peer_did: peer.clone(),
                started_at: message.timestamp,
                last_message_at: message.timestamp,
                message_count: 0,
                title: session_title(message),
            });

        entry.peer_did = peer;
        entry.started_at = entry.started_at.min(message.timestamp);
        entry.last_message_at = entry.last_message_at.max(message.timestamp);
        entry.message_count += 1;
        if entry.title.starts_with("Conversation with") {
            entry.title = session_title(message);
        }
    }

    let mut sessions = sessions.into_values().collect::<Vec<_>>();
    sessions.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));
    sessions
}

fn message_to_inbox_json(message: &Message) -> Value {
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

fn message_to_session_json(message: &Message) -> Value {
    json!({
        "id": message.id,
        "direction": message.direction.as_str(),
        "envelope": message.envelope,
        "receivedAt": if message.direction == MessageDirection::Inbound { json!(message.timestamp) } else { Value::Null },
        "sentAt": if message.direction == MessageDirection::Outbound { json!(message.timestamp) } else { Value::Null },
    })
}

fn parse_discovered_agent(value: Value) -> Option<(AgentCard, bool)> {
    if let Ok(card) = serde_json::from_value::<AgentCard>(value.clone()) {
        return Some((card, true));
    }

    if let Ok(mut envelope) = serde_json::from_value::<DiscoveredAgentEnvelope>(value) {
        if let Some(did) = envelope.did.take() {
            envelope.card.did = did;
        }
        if envelope.card.trust.is_none() {
            envelope.card.trust = envelope.trust.take();
        }
        return Some((envelope.card, envelope.online.unwrap_or(true)));
    }

    None
}

async fn query_discovered_agents(
    relay_urls: &[String],
    query: Option<&str>,
    capability: Option<&str>,
    min_trust: Option<f64>,
    limit: u32,
) -> Result<Vec<(AgentCard, bool)>> {
    let candidates = if relay_urls.is_empty() {
        vec![DEFAULT_RELAY.to_string()]
    } else {
        relay_urls.to_vec()
    };

    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    let mut errors = Vec::new();
    let mut had_success = false;

    for relay_url in candidates {
        match query_discovered_agents_from_relay(&relay_url, query, capability, min_trust, limit)
            .await
        {
            Ok(results) => {
                had_success = true;
                for (card, online) in results {
                    if seen.insert(card.did.clone()) {
                        merged.push((card, online));
                        if merged.len() >= limit as usize {
                            return Ok(merged);
                        }
                    }
                }
            }
            Err(error) => errors.push(format!("{}: {}", relay_url, error)),
        }
    }

    if had_success {
        return Ok(merged);
    }

    anyhow::bail!(
        "Failed to query discovery across known relays: {}",
        if errors.is_empty() {
            "no relay candidates".to_string()
        } else {
            errors.join(" | ")
        }
    )
}

async fn query_discovered_agents_from_relay(
    relay_url: &str,
    query: Option<&str>,
    capability: Option<&str>,
    min_trust: Option<f64>,
    limit: u32,
) -> Result<Vec<(AgentCard, bool)>> {
    let mut session = connect_query_session(relay_url).await?;
    let result = session
        .discover(query, capability, min_trust, Some(limit))
        .await?;
    let _ = session.goodbye().await;
    Ok(result
        .into_iter()
        .filter_map(parse_discovered_agent)
        .collect())
}

async fn discover_relay_providers(relay_url: &str, limit: u32) -> Result<Vec<String>> {
    let mut session = connect_query_session(relay_url).await?;
    let result = session
        .discover(None, Some(RELAY_DISCOVERY_CAPABILITY), None, Some(limit))
        .await?;
    let _ = session.goodbye().await;
    Ok(extract_discovered_relay_endpoints(&result))
}

async fn query_network_endorsements(
    relay_urls: &[String],
    target_did: &str,
    limit: u32,
) -> Result<Vec<EndorsementV2>> {
    let candidates = if relay_urls.is_empty() {
        vec![DEFAULT_RELAY.to_string()]
    } else {
        relay_urls.to_vec()
    };

    let mut endorsements = Vec::new();
    let mut errors = Vec::new();
    let mut had_success = false;

    for relay_url in candidates {
        match query_network_endorsements_from_relay(&relay_url, target_did, limit).await {
            Ok(result) => {
                had_success = true;
                merge_endorsements(&mut endorsements, result);
                if endorsements.len() >= limit as usize {
                    endorsements.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
                    endorsements.truncate(limit as usize);
                    return Ok(endorsements);
                }
            }
            Err(error) => errors.push(format!("{}: {}", relay_url, error)),
        }
    }

    if had_success {
        endorsements.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        endorsements.truncate(limit as usize);
        return Ok(endorsements);
    }

    anyhow::bail!(
        "Failed to query endorsements across known relays: {}",
        if errors.is_empty() {
            "no relay candidates".to_string()
        } else {
            errors.join(" | ")
        }
    )
}

async fn query_network_endorsements_from_relay(
    relay_url: &str,
    target_did: &str,
    limit: u32,
) -> Result<Vec<EndorsementV2>> {
    let mut session = connect_query_session(relay_url).await?;
    let result = session
        .query_endorsements(target_did, None, Some(limit), None)
        .await?;
    let _ = session.goodbye().await;
    Ok(result.endorsements)
}

async fn connect_query_session(relay_url: &str) -> Result<RelaySession> {
    let keypair = KeyPair::generate();
    let did = derive_did(keypair.verifying_key.as_bytes());
    let timestamp = now_ms();
    let unsigned = AgentCardUnsigned {
        did: did.clone(),
        name: "Rust Daemon Query".to_string(),
        description: "Internal query session".to_string(),
        version: "1.0.0".to_string(),
        capabilities: Vec::<Capability>::new(),
        endpoints: vec![],
        peer_id: None,
        trust: None,
        metadata: Some(json!({"internal": true})),
        timestamp,
    };
    let signature = AgentCard::sign(&unsigned, &keypair);
    let card = AgentCard {
        did: unsigned.did,
        name: unsigned.name,
        description: unsigned.description,
        version: unsigned.version,
        capabilities: unsigned.capabilities,
        endpoints: unsigned.endpoints,
        peer_id: unsigned.peer_id,
        trust: unsigned.trust,
        metadata: unsigned.metadata,
        timestamp: unsigned.timestamp,
        signature,
    };

    RelaySession::connect(relay_url, &did, &card, &keypair).await
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
    use super::{
        build_session_summaries, effective_thread_id, parse_envelope_value,
        resolve_daemon_socket_path, Message, MessageDirection, DEFAULT_DAEMON_SOCKET,
    };
    use serde_json::json;

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

    #[test]
    fn groups_direct_messages_into_synthetic_sessions() {
        let messages = vec![
            Message {
                id: "msg-1".to_string(),
                from: "did:agent:alice".to_string(),
                to: "did:agent:me".to_string(),
                envelope: json!({"payload": {"text": "hello"}}),
                timestamp: 10,
                thread_id: None,
                read: false,
                direction: MessageDirection::Inbound,
            },
            Message {
                id: "msg-2".to_string(),
                from: "did:agent:me".to_string(),
                to: "did:agent:alice".to_string(),
                envelope: json!({"payload": {"text": "hi back"}}),
                timestamp: 20,
                thread_id: None,
                read: true,
                direction: MessageDirection::Outbound,
            },
        ];

        assert_eq!(effective_thread_id(&messages[0]), "direct:did:agent:alice");
        let sessions = build_session_summaries(&messages, None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].thread_id, "direct:did:agent:alice");
        assert_eq!(sessions[0].message_count, 2);
        assert_eq!(sessions[0].peer_did, "did:agent:alice");
    }

    #[test]
    fn parses_json_envelope_payloads() {
        let envelope = parse_envelope_value(br#"{"id":"msg-1","protocol":"highway1/chat/1.0"}"#)
            .expect("json envelope should parse");

        assert_eq!(envelope.get("id").and_then(|v| v.as_str()), Some("msg-1"));
        assert_eq!(
            envelope.get("protocol").and_then(|v| v.as_str()),
            Some("highway1/chat/1.0")
        );
    }

    #[test]
    fn rejects_invalid_envelope_payloads() {
        let err = parse_envelope_value(&[0xff, 0x00]).expect_err("invalid payload should fail");
        assert!(err.to_string().contains("Invalid envelope payload"));
    }
}
