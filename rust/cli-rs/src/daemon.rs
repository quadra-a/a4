/// Unix socket daemon for agent communication.
/// Protocol: NDJSON — one JSON object per line.
/// Request:  {"id":"req_...","command":"send","params":{...}}\n
/// Response: {"id":"req_...","success":true,"data":{...}}\n
use anyhow::{Context, Result};
use dirs::home_dir;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time::{sleep, timeout, Duration};
use uuid::Uuid;

use crate::config::{
    load_config, resolve_reachability_policy, resolve_relay_invite_token, save_config,
    AgentCardConfig, Config, EndorsementV2, TrustConfig,
};
use crate::e2e_state::{with_local_e2e_state_transaction, with_locked_config_transaction};
use crate::identity::KeyPair;
use crate::protocol::{
    cbor_x_encode_json, relay_unsigned_endorsement_value, AgentCard, Envelope,
    EnvelopeUnsigned,
};
use crate::relay::connect_first_available;
use crate::trust::{ActivityLevel, NetworkPosition, TrustEngine};
use quadra_a_core::e2e::{
    assert_published_sender_device_matches_prekey_message,
    decode_encrypted_application_envelope_payload, DecodedEncryptedApplicationMessage,
    ensure_local_e2e_config, EncryptedApplicationEnvelopePayload,
    E2E_APPLICATION_ENVELOPE_PROTOCOL,
};
use quadra_a_runtime::card::{
    build_agent_card_from_config, build_published_prekey_bundles_from_config,
};
use quadra_a_runtime::e2e_receive::prepare_encrypted_receive;
use quadra_a_runtime::e2e_send::{
    prepare_encrypted_sends_with_session, PreparedEncryptedSendBatch,
};
use quadra_a_runtime::inbox::{
    effective_thread_id, parse_envelope_value, E2EDeliveryMetadata, E2EDeliveryState,
    E2ERetryMetadata, MessageDirection, MessageStore, StoredMessage, StoredMessageE2EMetadata,
};
use quadra_a_runtime::query::{
    connect_query_session, query_discovered_agents as runtime_query_discovered_agents,
    query_network_endorsements as runtime_query_network_endorsements,
};
use quadra_a_runtime::relay_worker::{
    run_relay_worker as runtime_run_relay_worker, RelaySendOutcome, RelayWorkerCommand,
    RelayWorkerEvent, RelayWorkerOptions,
};
use quadra_a_runtime::session_manager::ManagedRelayState;

pub const DEFAULT_RS_DAEMON_SOCKET: &str = "/tmp/quadra-a-rs.sock";
pub const DEFAULT_JS_DAEMON_SOCKET: &str = "/tmp/quadra-a.sock";

fn quadra_a_home() -> PathBuf {
    std::env::var("QUADRA_A_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".quadra-a")
        })
}

fn derived_home_hash() -> String {
    let mut hasher = Sha256::new();
    hasher.update(quadra_a_home().to_string_lossy().as_bytes());
    hex::encode(hasher.finalize())[..8].to_string()
}

fn derived_daemon_socket_path(runtime: &str) -> String {
    let suffix = if runtime == "rs" { "-rs" } else { "" };
    format!("/tmp/quadra-a-{}{}.sock", derived_home_hash(), suffix)
}

pub fn peer_daemon_socket_path() -> String {
    derived_daemon_socket_path("js")
}

pub fn daemon_server_socket_path() -> String {
    std::env::var("QUADRA_A_RS_SOCKET_PATH")
        .or_else(|_| std::env::var("QUADRA_A_SOCKET_PATH"))
        .unwrap_or_else(|_| derived_daemon_socket_path("rs"))
}

/// Client path: tries the Rust daemon for the current QUADRA_A_HOME first,
/// then the JS daemon for the same QUADRA_A_HOME, then legacy global sockets.
pub fn daemon_socket_path() -> String {
    if let Ok(explicit) =
        std::env::var("QUADRA_A_RS_SOCKET_PATH").or_else(|_| std::env::var("QUADRA_A_SOCKET_PATH"))
    {
        return explicit;
    }

    let candidates = [
        derived_daemon_socket_path("rs"),
        derived_daemon_socket_path("js"),
        DEFAULT_RS_DAEMON_SOCKET.to_string(),
        DEFAULT_JS_DAEMON_SOCKET.to_string(),
    ];

    for candidate in candidates {
        if std::path::Path::new(&candidate).exists() {
            return candidate;
        }
    }

    derived_daemon_socket_path("rs")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn json_string_filter(value: Option<&Value>) -> Option<HashSet<String>> {
    let value = value?;
    let values = match value {
        Value::String(text) => vec![text.trim().to_string()],
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::trim).map(ToOwned::to_owned))
            .collect::<Vec<_>>(),
        _ => return None,
    };

    let values = values
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn matches_string_filter(value: Option<&str>, allowed: Option<&HashSet<String>>) -> bool {
    match allowed {
        None => true,
        Some(allowed) => value.is_some_and(|value| allowed.contains(value)),
    }
}

fn stored_message_status(message: &StoredMessage) -> &'static str {
    if let Some(e2e) = message.e2e.as_ref() {
        if e2e
            .deliveries
            .iter()
            .any(|delivery| delivery.state == E2EDeliveryState::Failed)
        {
            return "failed";
        }
    }

    match message.direction {
        MessageDirection::Inbound => {
            if message.read {
                "delivered"
            } else {
                "pending"
            }
        }
        MessageDirection::Outbound => {
            if let Some(e2e) = message.e2e.as_ref() {
                if e2e.deliveries.iter().any(|delivery| {
                    matches!(
                        delivery.state,
                        E2EDeliveryState::Accepted
                            | E2EDeliveryState::Delivered
                            | E2EDeliveryState::Received
                    )
                }) {
                    return "delivered";
                }
            }
            "pending"
        }
    }
}

fn inbox_message_matches(
    message: &StoredMessage,
    unread_only: bool,
    thread_id: Option<&str>,
    directions: Option<&HashSet<String>>,
    from_dids: Option<&HashSet<String>>,
    to_dids: Option<&HashSet<String>>,
    protocols: Option<&HashSet<String>>,
    envelope_types: Option<&HashSet<String>>,
    reply_tos: Option<&HashSet<String>>,
    statuses: Option<&HashSet<String>>,
) -> bool {
    if unread_only && message.read {
        return false;
    }

    if let Some(thread_id) = thread_id {
        let effective = effective_thread_id(message);
        if message.thread_id.as_deref() != Some(thread_id) && effective != thread_id {
            return false;
        }
    }

    if !matches_string_filter(Some(message.direction.as_str()), directions) {
        return false;
    }

    if !matches_string_filter(Some(message.from.as_str()), from_dids) {
        return false;
    }

    if !matches_string_filter(Some(message.to.as_str()), to_dids) {
        return false;
    }

    if !matches_string_filter(
        message.envelope.get("protocol").and_then(|value| value.as_str()),
        protocols,
    ) {
        return false;
    }

    if !matches_string_filter(
        message.envelope.get("type").and_then(|value| value.as_str()),
        envelope_types,
    ) {
        return false;
    }

    if !matches_string_filter(
        message.envelope.get("replyTo").and_then(|value| value.as_str()),
        reply_tos,
    ) {
        return false;
    }

    matches_string_filter(Some(stored_message_status(message)), statuses)
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

const PEER_RECOVERY_DEBOUNCE_MS: u64 = 500;
const MAX_SESSION_REPLAY_ATTEMPTS: u32 = 3;

#[derive(Clone, Debug)]
struct PendingReplayRequest {
    lookup_message_id: String,
    reason: String,
    requested_at: u64,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
struct PendingDecryptFailure {
    transport_message_id: String,
    reason: String,
    requested_at: u64,
    thread_id: Option<String>,
}

#[derive(Clone, Debug)]
struct PeerRecoveryState {
    epoch: u64,
    #[allow(dead_code)]
    started_at: u64,
    reason: String,
    awaiting_ack: bool,
}

struct PendingPeerBatch<T> {
    items: HashMap<String, T>,
    timer_generation: u64,
    timer_active: bool,
    running: bool,
}

impl<T> Default for PendingPeerBatch<T> {
    fn default() -> Self {
        Self {
            items: HashMap::new(),
            timer_generation: 0,
            timer_active: false,
            running: false,
        }
    }
}

#[derive(Default)]
struct RecoveryCoordinator {
    pending_replays: HashMap<String, PendingPeerBatch<PendingReplayRequest>>,
    pending_retry_notifications: HashMap<String, PendingPeerBatch<PendingDecryptFailure>>,
    peer_recoveries: HashMap<String, PeerRecoveryState>,
    recovery_epoch_floors: HashMap<String, u64>,
}

pub struct DaemonState {
    pub config: Config,
    pub relay_runtime: ManagedRelayState,
    relay_sender: Option<mpsc::Sender<RelayWorkerCommand>>,
    outbound_send_lock: Arc<Mutex<()>>,
    peer_session_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    recovery_coordinator: Arc<Mutex<RecoveryCoordinator>>,
    messages_path: PathBuf,
    pub messages: MessageStore,
    pub running: bool,
}

fn daemon_messages_path() -> PathBuf {
    quadra_a_home().join("daemon-messages.json")
}

/// Merge CLI-managed fields from disk before saving daemon state.
/// The daemon holds config in memory, but the CLI may modify fields like
/// `aliases` directly on disk. Without this merge, `save_config` would
/// overwrite those changes with stale in-memory data.
fn merge_cli_fields_before_save(config: &mut Config) {
    if let Ok(fresh) = load_config() {
        config.aliases = fresh.aliases;
    }
}

fn load_persisted_message_store(path: &PathBuf) -> MessageStore {
    match MessageStore::load_from_path(path) {
        Ok(store) => store,
        Err(error) => {
            eprintln!(
                "Failed to load persisted daemon messages from {}: {}",
                path.display(),
                error
            );
            MessageStore::default()
        }
    }
}

fn persist_messages(state: &DaemonState) {
    if let Err(error) = state.messages.save_to_path(&state.messages_path) {
        eprintln!(
            "Failed to persist daemon messages to {}: {}",
            state.messages_path.display(),
            error
        );
    }
}

fn store_message(state: &mut DaemonState, message: StoredMessage) {
    state.messages.store(message);
    persist_messages(state);
}

fn mark_message_read(state: &mut DaemonState, message_id: &str) -> bool {
    let marked = state.messages.mark_read(message_id);
    if marked {
        persist_messages(state);
    }
    marked
}

fn upsert_message_retry(
    state: &mut DaemonState,
    message_id: &str,
    direction: MessageDirection,
    retry: E2ERetryMetadata,
) -> bool {
    let updated = state.messages.upsert_e2e_retry(message_id, direction, retry);
    if updated {
        persist_messages(state);
    }
    updated
}

fn upsert_message_delivery(
    state: &mut DaemonState,
    message_id: &str,
    direction: MessageDirection,
    delivery: E2EDeliveryMetadata,
) -> bool {
    let updated = state
        .messages
        .upsert_e2e_delivery(message_id, direction, delivery);
    if updated {
        persist_messages(state);
    }
    updated
}

fn update_message_delivery_by_transport_id(
    state: &mut DaemonState,
    transport_message_id: &str,
    delivery_state: E2EDeliveryState,
    recorded_at: u64,
    error: Option<String>,
) -> bool {
    let updated = state.messages.update_e2e_delivery_by_transport_message_id(
        transport_message_id,
        delivery_state,
        recorded_at,
        error,
    );
    if updated {
        persist_messages(state);
    }
    updated
}

fn inbound_rejection_reason(config: &Config, sender_did: &str) -> Option<String> {
    let trust_config = config.trust_config.as_ref()?;
    if trust_config.is_blocked(sender_did) {
        return Some(
            trust_config
                .blocked_reason(sender_did)
                .map(|reason| format!("blocked ({})", reason))
                .unwrap_or_else(|| "blocked".to_string()),
        );
    }
    if !trust_config.allowed_agents.is_empty() && !trust_config.is_allowed(sender_did) {
        return Some("not allowlisted".to_string());
    }
    None
}

fn compute_local_interaction_score(
    messages: &[StoredMessage],
    observer_did: &str,
    target_did: &str,
) -> (u32, f64) {
    let relevant = messages
        .iter()
        .filter(|message| match message.direction {
            MessageDirection::Outbound => message.from == observer_did && message.to == target_did,
            MessageDirection::Inbound => message.from == target_did,
        })
        .collect::<Vec<_>>();
    let interaction_count = relevant.len() as u32;
    if interaction_count == 0 {
        return (0, 0.0);
    }

    let outbound_requests = relevant
        .iter()
        .copied()
        .filter(|message| {
            message.direction == MessageDirection::Outbound
                && message
                    .envelope
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("message")
                    == "message"
        })
        .collect::<Vec<_>>();
    if outbound_requests.is_empty() {
        return (interaction_count, 0.5);
    }

    let replied_to = relevant
        .iter()
        .copied()
        .filter(|message| message.direction == MessageDirection::Inbound)
        .filter_map(|message| message.envelope.get("replyTo").and_then(|value| value.as_str()))
        .collect::<HashSet<_>>();
    let completed = outbound_requests
        .iter()
        .filter(|message| replied_to.contains(message.id.as_str()))
        .count();
    let success_rate = completed as f64 / outbound_requests.len() as f64;
    (interaction_count, (0.2 + success_rate * 0.8).clamp(0.0, 1.0))
}

fn clear_peer_sessions(config: &mut Config, peer_did: &str) -> usize {
    let Some(e2e) = config.e2e.as_mut() else {
        return 0;
    };
    if !e2e.is_valid() {
        return 0;
    }

    let Some(device) = e2e.devices.get_mut(&e2e.current_device_id) else {
        return 0;
    };

    let before = device.sessions.len();
    let session_prefix = format!("{}:", peer_did);
    device
        .sessions
        .retain(|key, _| !key.starts_with(&session_prefix));
    before.saturating_sub(device.sessions.len())
}

fn build_signed_control_envelope(
    keypair: &KeyPair,
    from: &str,
    to: &str,
    protocol: &str,
    payload: Value,
    thread_id: Option<String>,
    timestamp: u64,
) -> Envelope {
    let unsigned = EnvelopeUnsigned {
        id: format!(
            "msg_{}_{}",
            timestamp,
            &Uuid::new_v4().to_string().replace('-', "")[..13]
        ),
        from: from.to_string(),
        to: to.to_string(),
        msg_type: "message".to_string(),
        protocol: protocol.to_string(),
        payload,
        timestamp,
        reply_to: None,
        thread_id,
        group_id: None,
    };
    unsigned.sign(keypair)
}

fn build_session_reset_envelope(
    keypair: &KeyPair,
    from: &str,
    to: &str,
    reason: &str,
    epoch: u64,
    timestamp: u64,
) -> Envelope {
    build_signed_control_envelope(
        keypair,
        from,
        to,
        "e2e/session-reset",
        json!({
            "from": from,
            "to": to,
            "reason": reason,
            "epoch": epoch,
            "timestamp": timestamp,
        }),
        None,
        timestamp,
    )
}

fn build_session_reset_ack_envelope(
    keypair: &KeyPair,
    from: &str,
    to: &str,
    reason: &str,
    epoch: u64,
    timestamp: u64,
) -> Envelope {
    build_signed_control_envelope(
        keypair,
        from,
        to,
        "e2e/session-reset-ack",
        json!({
            "from": from,
            "to": to,
            "reason": reason,
            "epoch": epoch,
            "timestamp": timestamp,
        }),
        None,
        timestamp,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_session_retry_envelope(
    keypair: &KeyPair,
    from: &str,
    to: &str,
    message_id: &str,
    reason: &str,
    failed_transport: &str,
    timestamp: u64,
    thread_id: Option<String>,
) -> Envelope {
    build_signed_control_envelope(
        keypair,
        from,
        to,
        "e2e/session-retry",
        json!({
            "from": from,
            "to": to,
            "messageId": message_id,
            "reason": reason,
            "failedTransport": failed_transport,
            "timestamp": timestamp,
            "threadId": thread_id.clone(),
        }),
        thread_id,
        timestamp,
    )
}

fn encode_envelope_bytes(envelope: &Envelope) -> Result<Vec<u8>> {
    let envelope_json = serde_json::to_value(envelope)?;
    Ok(cbor_x_encode_json(&envelope_json))
}

fn clear_pending_peer_batch<T>(
    batches: &mut HashMap<String, PendingPeerBatch<T>>,
    peer_did: &str,
) -> usize {
    batches.remove(peer_did).map(|batch| batch.items.len()).unwrap_or(0)
}

fn note_peer_recovery_epoch(
    recovery_coordinator: &mut RecoveryCoordinator,
    peer_did: &str,
    epoch: u64,
) {
    let current_floor = recovery_coordinator
        .recovery_epoch_floors
        .get(peer_did)
        .copied()
        .unwrap_or(0);
    if epoch > current_floor {
        recovery_coordinator
            .recovery_epoch_floors
            .insert(peer_did.to_string(), epoch);
    }
}

fn next_peer_recovery_epoch(
    recovery_coordinator: &mut RecoveryCoordinator,
    peer_did: &str,
) -> u64 {
    let floor = recovery_coordinator
        .recovery_epoch_floors
        .get(peer_did)
        .copied()
        .unwrap_or(0);
    let epoch = now_ms().max(floor.saturating_add(1));
    recovery_coordinator
        .recovery_epoch_floors
        .insert(peer_did.to_string(), epoch);
    epoch
}

async fn clear_pending_peer_recovery(
    state: &Arc<RwLock<DaemonState>>,
    peer_did: &str,
) -> (usize, usize) {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };
    let mut guard = coordinator.lock().await;
    let replay_requests = clear_pending_peer_batch(&mut guard.pending_replays, peer_did);
    let retry_notifications =
        clear_pending_peer_batch(&mut guard.pending_retry_notifications, peer_did);
    (replay_requests, retry_notifications)
}

async fn clear_all_pending_recovery(state: &Arc<RwLock<DaemonState>>) -> (usize, usize) {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };
    let mut guard = coordinator.lock().await;
    let replay_peers = guard.pending_replays.len();
    let retry_peers = guard.pending_retry_notifications.len();
    guard.pending_replays.clear();
    guard.pending_retry_notifications.clear();
    (replay_peers, retry_peers)
}

async fn get_peer_recovery_state(
    state: &Arc<RwLock<DaemonState>>,
    peer_did: &str,
) -> Option<PeerRecoveryState> {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };
    let guard = coordinator.lock().await;
    guard.peer_recoveries.get(peer_did).cloned()
}

async fn get_peer_session_lock(
    state: &Arc<RwLock<DaemonState>>,
    peer_did: &str,
) -> Arc<Mutex<()>> {
    let lock_registry = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.peer_session_locks)
    };
    let mut guard = lock_registry.lock().await;
    Arc::clone(
        guard
            .entry(peer_did.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

async fn clear_peer_recovery_state(
    state: &Arc<RwLock<DaemonState>>,
    peer_did: &str,
    epoch: Option<u64>,
) -> bool {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };
    let mut guard = coordinator.lock().await;
    let Some(current) = guard.peer_recoveries.get(peer_did).cloned() else {
        return false;
    };
    if let Some(expected_epoch) = epoch {
        if current.epoch != expected_epoch {
            return false;
        }
    }
    note_peer_recovery_epoch(&mut guard, peer_did, current.epoch);
    guard.peer_recoveries.remove(peer_did);
    true
}

async fn clear_all_peer_recoveries(state: &Arc<RwLock<DaemonState>>) -> usize {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };
    let mut guard = coordinator.lock().await;
    let count = guard.peer_recoveries.len();
    let retained = guard
        .peer_recoveries
        .iter()
        .map(|(peer_did, recovery)| (peer_did.clone(), recovery.epoch))
        .collect::<Vec<_>>();
    for (peer_did, epoch) in retained {
        note_peer_recovery_epoch(&mut guard, &peer_did, epoch);
    }
    guard.peer_recoveries.clear();
    count
}

async fn clear_persisted_peer_sessions(
    state: &Arc<RwLock<DaemonState>>,
    peer_did: &str,
) -> usize {
    match with_locked_config_transaction({
        let peer_did = peer_did.to_string();
        move |mut config| async move {
            let cleared = clear_peer_sessions(&mut config, &peer_did);
            Ok((cleared, config))
        }
    })
    .await
    {
        Ok((cleared, next_config)) => {
            let mut state_guard = state.write().await;
            state_guard.config.e2e = next_config.e2e;
            cleared
        }
        Err(err) => {
            eprintln!(
                "Failed to clear persisted E2E sessions for {} while updating recovery state: {}",
                peer_did, err
            );
            0
        }
    }
}

async fn begin_local_peer_recovery(
    state: &Arc<RwLock<DaemonState>>,
    peer_did: &str,
    reason: &str,
    requested_at: u64,
) -> (PeerRecoveryState, bool, (usize, usize), usize) {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };

    let (recovery, started, cancelled) = {
        let mut guard = coordinator.lock().await;
        if let Some(existing) = guard.peer_recoveries.get(peer_did).cloned() {
            (existing, false, (0, 0))
        } else {
            let recovery = PeerRecoveryState {
                epoch: next_peer_recovery_epoch(&mut guard, peer_did),
                started_at: requested_at,
                reason: reason.to_string(),
                awaiting_ack: true,
            };
            let replay_requests = clear_pending_peer_batch(&mut guard.pending_replays, peer_did);
            let retry_notifications =
                clear_pending_peer_batch(&mut guard.pending_retry_notifications, peer_did);
            guard
                .peer_recoveries
                .insert(peer_did.to_string(), recovery.clone());
            (recovery, true, (replay_requests, retry_notifications))
        }
    };

    let cleared = if started {
        clear_persisted_peer_sessions(state, peer_did).await
    } else {
        0
    };

    (recovery, started, cancelled, cleared)
}

enum RemoteRecoveryAction {
    Ack,
    ResendReset,
}

struct RemoteRecoveryDecision {
    action: RemoteRecoveryAction,
    state: PeerRecoveryState,
    clear_after_send: bool,
    cancelled: (usize, usize),
    cleared_count: usize,
}

async fn handle_remote_peer_recovery(
    state: &Arc<RwLock<DaemonState>>,
    peer_did: &str,
    epoch: u64,
    reason: &str,
    requested_at: u64,
) -> RemoteRecoveryDecision {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };

    let decision = {
        let mut guard = coordinator.lock().await;
        note_peer_recovery_epoch(&mut guard, peer_did, epoch);

        if let Some(current) = guard.peer_recoveries.get(peer_did).cloned() {
            if current.epoch > epoch {
                let clear_after_send = !current.awaiting_ack;
                return RemoteRecoveryDecision {
                    action: if current.awaiting_ack {
                        RemoteRecoveryAction::ResendReset
                    } else {
                        RemoteRecoveryAction::Ack
                    },
                    state: current,
                    clear_after_send,
                    cancelled: (0, 0),
                    cleared_count: 0,
                };
            }

            if current.epoch == epoch {
                return RemoteRecoveryDecision {
                    action: RemoteRecoveryAction::Ack,
                    state: current,
                    clear_after_send: true,
                    cancelled: (0, 0),
                    cleared_count: 0,
                };
            }
        }

        let recovery = PeerRecoveryState {
            epoch,
            started_at: requested_at,
            reason: reason.to_string(),
            awaiting_ack: false,
        };
        let replay_requests = clear_pending_peer_batch(&mut guard.pending_replays, peer_did);
        let retry_notifications =
            clear_pending_peer_batch(&mut guard.pending_retry_notifications, peer_did);
        guard
            .peer_recoveries
            .insert(peer_did.to_string(), recovery.clone());
        (
            recovery,
            (replay_requests, retry_notifications),
        )
    };

    let cleared_count = clear_persisted_peer_sessions(state, peer_did).await;

    RemoteRecoveryDecision {
        action: RemoteRecoveryAction::Ack,
        state: decision.0,
        clear_after_send: true,
        cancelled: decision.1,
        cleared_count,
    }
}

fn peer_recovery_error(peer_did: &str, recovery: &PeerRecoveryState) -> anyhow::Error {
    anyhow::anyhow!(
        "Peer {} is recovering E2E session (epoch {}, reason {}); retry after session-reset-ack",
        peer_did,
        recovery.epoch,
        recovery.reason,
    )
}

async fn schedule_peer_replay(
    state: Arc<RwLock<DaemonState>>,
    peer_did: String,
    request: PendingReplayRequest,
) {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };

    let generation = {
        let mut guard = coordinator.lock().await;
        let batch = guard.pending_replays.entry(peer_did.clone()).or_default();
        batch
            .items
            .insert(request.lookup_message_id.clone(), request);
        batch.timer_generation += 1;
        batch.timer_active = true;
        batch.timer_generation
    };

    tokio::spawn(async move {
        sleep(Duration::from_millis(PEER_RECOVERY_DEBOUNCE_MS)).await;
        flush_peer_replay(state, peer_did, generation).await;
    });
}

#[allow(dead_code)]
async fn schedule_peer_retry_notification(
    state: Arc<RwLock<DaemonState>>,
    peer_did: String,
    failure: PendingDecryptFailure,
) {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };

    let generation = {
        let mut guard = coordinator.lock().await;
        let batch = guard
            .pending_retry_notifications
            .entry(peer_did.clone())
            .or_default();
        batch
            .items
            .insert(failure.transport_message_id.clone(), failure);
        batch.timer_generation += 1;
        batch.timer_active = true;
        batch.timer_generation
    };

    tokio::spawn(async move {
        sleep(Duration::from_millis(PEER_RECOVERY_DEBOUNCE_MS)).await;
        flush_peer_retry_notification(state, peer_did, generation).await;
    });
}

async fn flush_peer_replay(
    state: Arc<RwLock<DaemonState>>,
    peer_did: String,
    generation: u64,
) {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };

    let requests = {
        let mut guard = coordinator.lock().await;
        let Some(batch) = guard.pending_replays.get_mut(&peer_did) else {
            return;
        };
        if batch.timer_generation != generation {
            return;
        }
        batch.timer_active = false;
        if batch.running {
            return;
        }
        batch.running = true;
        let mut requests = batch.items.values().cloned().collect::<Vec<_>>();
        batch.items.clear();
        requests.sort_by_key(|request| request.requested_at);
        requests
    };

    if let Err(error) = replay_outbound_messages(Arc::clone(&state), &peer_did, &requests).await {
        eprintln!(
            "Failed to replay outbound batch for {} after session retry: {}",
            peer_did, error
        );
    }

    {
        let mut guard = coordinator.lock().await;
        if let Some(batch) = guard.pending_replays.get_mut(&peer_did) {
            batch.running = false;
            if batch.items.is_empty() && !batch.timer_active {
                guard.pending_replays.remove(&peer_did);
            }
        }
    }
}

#[allow(dead_code)]
async fn flush_peer_retry_notification(
    state: Arc<RwLock<DaemonState>>,
    peer_did: String,
    generation: u64,
) {
    let coordinator = {
        let state_guard = state.read().await;
        Arc::clone(&state_guard.recovery_coordinator)
    };

    let failures = {
        let mut guard = coordinator.lock().await;
        let Some(batch) = guard.pending_retry_notifications.get_mut(&peer_did) else {
            return;
        };
        if batch.timer_generation != generation {
            return;
        }
        batch.timer_active = false;
        if batch.running {
            return;
        }
        batch.running = true;
        let mut failures = batch.items.values().cloned().collect::<Vec<_>>();
        batch.items.clear();
        failures.sort_by_key(|failure| failure.requested_at);
        failures
    };

    if let Err(error) =
        send_peer_retry_notifications(Arc::clone(&state), &peer_did, &failures).await
    {
        eprintln!(
            "Failed to send batched E2E session retry notifications for {}: {}",
            peer_did, error
        );
    }

    {
        let mut guard = coordinator.lock().await;
        if let Some(batch) = guard.pending_retry_notifications.get_mut(&peer_did) {
            batch.running = false;
            if batch.items.is_empty() && !batch.timer_active {
                guard.pending_retry_notifications.remove(&peer_did);
            }
        }
    }
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

struct PendingSendBatch {
    envelope_bytes: Vec<u8>,
    delivery: Option<E2EDeliveryMetadata>,
    accepted_config: Option<Config>,
}

fn delivery_state_from_report_status(status: &str) -> E2EDeliveryState {
    match status {
        "delivered" => E2EDeliveryState::Delivered,
        _ => E2EDeliveryState::Accepted,
    }
}

fn delivery_state_from_event_status(status: &str) -> Option<E2EDeliveryState> {
    match status {
        "accepted" => Some(E2EDeliveryState::Accepted),
        "delivered" => Some(E2EDeliveryState::Delivered),
        "expired" | "queue_full" | "unknown_recipient" => Some(E2EDeliveryState::Failed),
        _ => None,
    }
}

fn delivery_error_from_event_status(status: &str) -> Option<String> {
    match status {
        "expired" => Some("Relay delivery expired".to_string()),
        "queue_full" => Some("Relay queue full for recipient".to_string()),
        "unknown_recipient" => Some("Recipient not found on relay".to_string()),
        _ => None,
    }
}

async fn send_envelope_via_worker(
    relay_sender: &mpsc::Sender<RelayWorkerCommand>,
    to: &str,
    envelope_bytes: Vec<u8>,
) -> Result<RelaySendOutcome> {
    let (response_tx, response_rx) = oneshot::channel();
    relay_sender
        .send(RelayWorkerCommand::SendEnvelope {
            to: to.to_string(),
            envelope_bytes,
            response: response_tx,
        })
        .await
        .context("Failed to reach relay worker")?;

    response_rx
        .await
        .context("Relay worker dropped send response")?
}

async fn send_recovery_control_via_worker(
    state: &Arc<RwLock<DaemonState>>,
    to: &str,
    envelope: &Envelope,
) -> Result<RelaySendOutcome> {
    let envelope_bytes = encode_envelope_bytes(envelope)?;
    let (relay_sender, outbound_send_lock) = {
        let state_guard = state.read().await;
        (
            state_guard
                .relay_sender
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Not connected to relay"))?,
            Arc::clone(&state_guard.outbound_send_lock),
        )
    };
    let _send_guard = outbound_send_lock.lock().await;
    send_envelope_via_worker(&relay_sender, to, envelope_bytes).await
}

async fn commit_e2e_state_after_accept(
    state: &Arc<RwLock<DaemonState>>,
    accepted_config: &Config,
) -> Result<()> {
    let accepted_e2e = accepted_config.e2e.clone();
    let (_, next_config) = with_locked_config_transaction(|mut current| async move {
        current.e2e = accepted_e2e;
        Ok(((), current))
    })
    .await?;

    let mut state_guard = state.write().await;
    state_guard.config.e2e = next_config.e2e;
    Ok(())
}

async fn replay_outbound_messages(
    state: Arc<RwLock<DaemonState>>,
    peer_did: &str,
    requests: &[PendingReplayRequest],
) -> Result<()> {
    if requests.is_empty() {
        return Ok(());
    }

    let (relay_sender, outbound_send_lock) = {
        let state_guard = state.read().await;
        (
            state_guard.relay_sender.clone(),
            Arc::clone(&state_guard.outbound_send_lock),
        )
    };

    let Some(relay_sender) = relay_sender else {
        eprintln!(
            "Ignoring {} queued session retry request(s) for {}: relay sender unavailable",
            requests.len(),
            peer_did,
        );
        return Ok(());
    };

    let peer_session_lock = get_peer_session_lock(&state, peer_did).await;
    let _peer_session_guard = peer_session_lock.lock().await;
    let _send_guard = outbound_send_lock.lock().await;

    for request in requests {
        let (original_message, relay_url) = {
            let state_guard = state.read().await;
            (
                state_guard
                    .messages
                    .get_message(&request.lookup_message_id, MessageDirection::Outbound)
                    .or_else(|| {
                        state_guard.messages.get_message_by_transport_message_id(
                            &request.lookup_message_id,
                            MessageDirection::Outbound,
                        )
                    }),
                state_guard.relay_runtime.relay_url.clone(),
            )
        };

        let Some(original_message) = original_message else {
            eprintln!(
                "Ignoring session retry for {}: outbound message {} not found",
                peer_did, request.lookup_message_id,
            );
            continue;
        };

        if original_message.to != peer_did {
            eprintln!(
                "Ignoring session retry for {}: outbound message {} targets {}",
                peer_did, original_message.id, original_message.to,
            );
            continue;
        }

        let original_message_id = original_message.id.clone();
        let replay_count = original_message
            .e2e
            .as_ref()
            .and_then(|metadata| metadata.retry.as_ref())
            .map(|retry| retry.replay_count)
            .unwrap_or(0);
        {
            let mut state_guard = state.write().await;
            upsert_message_retry(
                &mut state_guard,
                &original_message_id,
                MessageDirection::Outbound,
                E2ERetryMetadata {
                    replay_count,
                    last_requested_at: Some(request.requested_at),
                    last_replayed_at: None,
                    last_reason: Some(request.reason.clone()),
                },
            );
        }
        if replay_count >= MAX_SESSION_REPLAY_ATTEMPTS {
            eprintln!(
                "Ignoring session retry for {} on message {} after {} accepted replay(s)",
                peer_did, original_message_id, replay_count,
            );
            continue;
        }

        let application_envelope: Envelope =
            match serde_json::from_value(original_message.envelope.clone()) {
                Ok(envelope) => envelope,
                Err(err) => {
                    eprintln!(
                        "Ignoring session retry for {}: failed to parse outbound message {}: {}",
                        peer_did, original_message_id, err,
                    );
                    continue;
                }
            };

        let send_batches = match prepare_replayed_send_batches_without_commit(
            &relay_url,
            peer_did,
            application_envelope,
        )
        .await
        {
            Ok(send_batches) => send_batches,
            Err(err) => {
                eprintln!(
                    "Failed to replay outbound message {} after session retry from {}: {}",
                    original_message_id, peer_did, err,
                );
                continue;
            }
        };

        let mut accepted_any = false;
        let mut last_replayed_at = None;

        for batch in send_batches {
            let PendingSendBatch {
                envelope_bytes,
                mut delivery,
                accepted_config,
            } = batch;

            match send_envelope_via_worker(&relay_sender, peer_did, envelope_bytes).await {
                Ok(outcome) => {
                    if let Some(accepted_config) = accepted_config.as_ref() {
                        if let Err(error) =
                            commit_e2e_state_after_accept(&state, accepted_config).await
                        {
                            if let Some(delivery) = delivery.as_mut() {
                                delivery.transport_message_id =
                                    Some(outcome.relay_message_id.clone());
                                delivery.state = E2EDeliveryState::Failed;
                                delivery.recorded_at = now_ms();
                                delivery.error = Some(format!(
                                    "Failed to persist accepted E2E state: {}",
                                    error
                                ));
                                let mut state_guard = state.write().await;
                                upsert_message_delivery(
                                    &mut state_guard,
                                    &original_message_id,
                                    MessageDirection::Outbound,
                                    delivery.clone(),
                                );
                            }
                            eprintln!(
                                "Failed to persist accepted E2E state for replayed outbound message {}: {}",
                                original_message_id, error,
                            );
                            break;
                        }
                    }

                    accepted_any = true;
                    last_replayed_at = Some(outcome.reported_at);
                    if let Some(delivery) = delivery.as_mut() {
                        delivery.transport_message_id = Some(outcome.relay_message_id);
                        delivery.state = delivery_state_from_report_status(&outcome.status);
                        delivery.recorded_at = outcome.reported_at;
                        delivery.error = None;
                        let mut state_guard = state.write().await;
                        upsert_message_delivery(
                            &mut state_guard,
                            &original_message_id,
                            MessageDirection::Outbound,
                            delivery.clone(),
                        );
                    }
                }
                Err(error) => {
                    if let Some(delivery) = delivery.as_mut() {
                        delivery.state = E2EDeliveryState::Failed;
                        delivery.recorded_at = now_ms();
                        delivery.error = Some(error.to_string());
                        let mut state_guard = state.write().await;
                        upsert_message_delivery(
                            &mut state_guard,
                            &original_message_id,
                            MessageDirection::Outbound,
                            delivery.clone(),
                        );
                    }
                    eprintln!(
                        "Failed to replay outbound message {} after session retry from {}: {}",
                        original_message_id, peer_did, error,
                    );
                    break;
                }
            }
        }

        if accepted_any {
            let mut state_guard = state.write().await;
            upsert_message_retry(
                &mut state_guard,
                &original_message_id,
                MessageDirection::Outbound,
                E2ERetryMetadata {
                    replay_count: replay_count + 1,
                    last_requested_at: Some(request.requested_at),
                    last_replayed_at,
                    last_reason: Some(request.reason.clone()),
                },
            );
            eprintln!(
                "Replayed outbound message {} after batched session retry from {}",
                original_message_id, peer_did,
            );
        }
    }

    Ok(())
}

#[allow(dead_code)]
async fn send_peer_retry_notifications(
    state: Arc<RwLock<DaemonState>>,
    peer_did: &str,
    failures: &[PendingDecryptFailure],
) -> Result<()> {
    if failures.is_empty() {
        return Ok(());
    }

    let (my_did, private_key_hex, relay_sender, outbound_send_lock) = {
        let state_guard = state.read().await;
        (
            state_guard
                .config
                .identity
                .as_ref()
                .map(|identity| identity.did.clone())
                .unwrap_or_default(),
            state_guard
                .config
                .identity
                .as_ref()
                .map(|identity| identity.private_key.clone())
                .unwrap_or_default(),
            state_guard.relay_sender.clone(),
            Arc::clone(&state_guard.outbound_send_lock),
        )
    };

    let Some(relay_sender) = relay_sender else {
        eprintln!(
            "Skipping {} queued session retry notification(s) for {}: relay sender unavailable",
            failures.len(),
            peer_did,
        );
        return Ok(());
    };

    let keypair = KeyPair::from_hex(&private_key_hex)?;
    let peer_session_lock = get_peer_session_lock(&state, peer_did).await;
    let _peer_session_guard = peer_session_lock.lock().await;
    let cleared_count = match with_locked_config_transaction(|mut config| async move {
        let cleared = clear_peer_sessions(&mut config, peer_did);
        Ok((cleared, config))
    })
    .await
    {
        Ok((cleared, next_config)) => {
            let mut state_guard = state.write().await;
            state_guard.config.e2e = next_config.e2e;
            cleared
        }
        Err(err) => {
            eprintln!(
                "Failed to clear stale E2E session for {} before batched retry notification: {}",
                peer_did, err,
            );
            0
        }
    };

    let _send_guard = outbound_send_lock.lock().await;
    let mut sent_count = 0usize;
    for failure in failures {
        let retry_envelope = build_session_retry_envelope(
            &keypair,
            &my_did,
            peer_did,
            &failure.transport_message_id,
            &failure.reason,
            "session",
            failure.requested_at,
            failure.thread_id.clone(),
        );
        let envelope_bytes = match encode_envelope_bytes(&retry_envelope) {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!(
                    "Failed to encode E2E session retry for {} message {}: {}",
                    peer_did, failure.transport_message_id, err,
                );
                continue;
            }
        };

        match send_envelope_via_worker(&relay_sender, peer_did, envelope_bytes).await {
            Ok(_) => sent_count += 1,
            Err(err) => {
                eprintln!(
                    "Failed to send E2E session retry for {} message {}: {}",
                    peer_did, failure.transport_message_id, err,
                );
            }
        }
    }

    eprintln!(
        "Batched E2E session retry notifications for {}: cleared {} session(s), failureCount={}, sentCount={}",
        peer_did,
        cleared_count,
        failures.len(),
        sent_count,
    );
    Ok(())
}

fn build_pending_send_batches(
    prepared: &PreparedEncryptedSendBatch,
    recorded_at: u64,
) -> Vec<PendingSendBatch> {
    prepared
        .targets
        .iter()
        .map(|target| PendingSendBatch {
            envelope_bytes: target.outer_envelope_bytes.clone(),
            delivery: Some(E2EDeliveryMetadata {
                transport: target.transport.clone(),
                transport_message_id: None,
                sender_device_id: target.sender_device_id.clone(),
                receiver_device_id: target.recipient_device_id.clone(),
                session_id: target.session_id.clone(),
                state: E2EDeliveryState::Pending,
                recorded_at,
                used_skipped_message_key: None,
                error: None,
            }),
            accepted_config: Some(target.config_after_send.clone()),
        })
        .collect()
}

async fn prepare_encrypted_send_batches_without_commit(
    relay_url: &str,
    identity: &crate::config::IdentityConfig,
    envelope: Envelope,
) -> Result<(Value, Vec<PendingSendBatch>, StoredMessageE2EMetadata)> {
    let relay_url = relay_url.to_string();
    let identity_for_send = identity.clone();
    let envelope_for_send = envelope.clone();
    let (prepared, _) = with_local_e2e_state_transaction(|config| async move {
        let keypair = KeyPair::from_hex(&identity_for_send.private_key)?;
        let invite_token = resolve_relay_invite_token(None, Some(&config));
        let mut query_session = connect_query_session(&relay_url, invite_token.as_deref()).await?;
        let prepared =
            prepare_encrypted_sends_with_session(&mut query_session, &config, &keypair, envelope_for_send)
                .await?;
        let _ = query_session.goodbye().await;
        Ok((prepared, config))
    })
    .await?;

    let envelope_json = serde_json::to_value(&prepared.application_envelope)?;
    let recorded_at = now_ms();
    let send_batches = build_pending_send_batches(&prepared, recorded_at);
    let deliveries = send_batches
        .iter()
        .filter_map(|batch| batch.delivery.clone())
        .collect::<Vec<_>>();

    Ok((
        envelope_json,
        send_batches,
        StoredMessageE2EMetadata {
            deliveries,
            retry: None,
        },
    ))
}

async fn prepare_replayed_send_batches_without_commit(
    relay_url: &str,
    peer_did: &str,
    application_envelope: Envelope,
) -> Result<Vec<PendingSendBatch>> {
    let relay_url = relay_url.to_string();
    let peer_did = peer_did.to_string();
    let (prepared, _) = with_locked_config_transaction(|config| async move {
        let mut working_config = config.clone();
        ensure_local_e2e_config(&mut working_config)?;
        let identity = working_config
            .identity
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No identity found"))?
            .clone();
        let keypair = KeyPair::from_hex(&identity.private_key)?;
        let _ = clear_peer_sessions(&mut working_config, &peer_did);
        let invite_token = resolve_relay_invite_token(None, Some(&working_config));
        let mut query_session = connect_query_session(&relay_url, invite_token.as_deref()).await?;
        let prepared = prepare_encrypted_sends_with_session(
            &mut query_session,
            &working_config,
            &keypair,
            application_envelope,
        )
        .await?;
        let _ = query_session.goodbye().await;
        Ok((prepared, config))
    })
    .await?;

    Ok(build_pending_send_batches(&prepared, now_ms()))
}

impl DaemonServer {
    pub fn new(config: Config, _keypair: KeyPair, socket_path: &str) -> Self {
        let reachability_policy = resolve_reachability_policy(None, Some(&config));
        let messages_path = daemon_messages_path();
        let state = DaemonState {
            config,
            relay_runtime: ManagedRelayState::new(reachability_policy),
            relay_sender: None,
            outbound_send_lock: Arc::new(Mutex::new(())),
            peer_session_locks: Arc::new(Mutex::new(HashMap::new())),
            recovery_coordinator: Arc::new(Mutex::new(RecoveryCoordinator::default())),
            messages: load_persisted_message_store(&messages_path),
            messages_path,
            running: true,
        };

        DaemonServer {
            state: Arc::new(RwLock::new(state)),
            socket_path: socket_path.to_string(),
        }
    }

    pub async fn start(&self, explicit_relay: Option<&str>) -> Result<()> {
        // Check for other running daemons before starting
        self.check_no_other_daemon_running().await?;

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
            let prekey_bundles = build_published_prekey_bundles_from_config(&state.config);
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
                prekey_bundles,
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
                    let mut envelope = match parse_envelope_value(&envelope_bytes) {
                        Ok(envelope) => envelope,
                        Err(err) => {
                            eprintln!(
                                "Skipping relay message {} from {} on {}: {}",
                                message_id, from, relay_url, err,
                            );
                            continue;
                        }
                    };

                    let envelope_protocol =
                        envelope.get("protocol").and_then(|value| value.as_str());

                    if matches!(
                        envelope_protocol,
                        Some("e2e/session-reset" | "e2e/session-reset-ack" | "e2e/session-retry")
                    ) {
                        let control_envelope: Envelope =
                            match serde_json::from_value(envelope.clone()) {
                                Ok(envelope) => envelope,
                                Err(err) => {
                                    eprintln!(
                                        "Skipping malformed control envelope {} from {} on {}: {}",
                                        message_id, from, relay_url, err,
                                    );
                                    continue;
                                }
                            };

                        if control_envelope.from != from {
                            eprintln!(
                                "Skipping forged control envelope {} on {}: relay sender {} does not match envelope sender {}",
                                message_id, relay_url, from, control_envelope.from,
                            );
                            continue;
                        }

                        if !control_envelope.verify_signature().unwrap_or(false) {
                            eprintln!(
                                "Skipping unsigned control envelope {} from {} on {}",
                                message_id, from, relay_url,
                            );
                            continue;
                        }

                        let peer_session_lock = get_peer_session_lock(&state, &from).await;
                        let _peer_session_guard = peer_session_lock.lock().await;

                        if control_envelope.protocol == "e2e/session-reset" {
                            let payload = control_envelope.payload.as_object();
                            let reset_reason = payload
                                .and_then(|payload| payload.get("reason"))
                                .and_then(|value| value.as_str())
                                .unwrap_or("decrypt-failed")
                                .to_string();
                            let reset_requested_at =
                                json_u64(payload.and_then(|payload| payload.get("timestamp")))
                                    .unwrap_or(received_at);
                            let reset_epoch =
                                json_u64(payload.and_then(|payload| payload.get("epoch")))
                                    .unwrap_or(reset_requested_at);

                            let decision = handle_remote_peer_recovery(
                                &state,
                                &from,
                                reset_epoch,
                                &reset_reason,
                                reset_requested_at,
                            )
                            .await;

                            let (my_did, private_key_hex) = {
                                let state_guard = state.read().await;
                                (
                                    state_guard
                                        .config
                                        .identity
                                        .as_ref()
                                        .map(|identity| identity.did.clone())
                                        .unwrap_or_default(),
                                    state_guard
                                        .config
                                        .identity
                                        .as_ref()
                                        .map(|identity| identity.private_key.clone())
                                        .unwrap_or_default(),
                                )
                            };
                            let keypair = match KeyPair::from_hex(&private_key_hex) {
                                Ok(keypair) => keypair,
                                Err(err) => {
                                    eprintln!(
                                        "Failed to build keypair while responding to session reset from {} on {}: {}",
                                        from, relay_url, err,
                                    );
                                    continue;
                                }
                            };
                            let response_envelope = match decision.action {
                                RemoteRecoveryAction::Ack => build_session_reset_ack_envelope(
                                    &keypair,
                                    &my_did,
                                    &from,
                                    &decision.state.reason,
                                    decision.state.epoch,
                                    now_ms(),
                                ),
                                RemoteRecoveryAction::ResendReset => build_session_reset_envelope(
                                    &keypair,
                                    &my_did,
                                    &from,
                                    &decision.state.reason,
                                    decision.state.epoch,
                                    now_ms(),
                                ),
                            };

                            match send_recovery_control_via_worker(
                                &state,
                                &from,
                                &response_envelope,
                            )
                            .await
                            {
                                Ok(_) => {
                                    if decision.clear_after_send {
                                        let _ = clear_peer_recovery_state(
                                            &state,
                                            &from,
                                            Some(decision.state.epoch),
                                        )
                                        .await;
                                    }
                                    if decision.cleared_count > 0
                                        || decision.cancelled.0 > 0
                                        || decision.cancelled.1 > 0
                                    {
                                        eprintln!(
                                            "E2E session reset by peer {} (epoch={}, {} session(s) cleared, {} replay request(s) cancelled, {} retry notification(s) cancelled, action={})",
                                            from,
                                            decision.state.epoch,
                                            decision.cleared_count,
                                            decision.cancelled.0,
                                            decision.cancelled.1,
                                            match decision.action {
                                                RemoteRecoveryAction::Ack => "ack",
                                                RemoteRecoveryAction::ResendReset => "resend-reset",
                                            },
                                        );
                                    }
                                }
                                Err(err) => {
                                    eprintln!(
                                        "Failed to respond to session reset from {} on {} for epoch {}: {}",
                                        from, relay_url, decision.state.epoch, err,
                                    );
                                }
                            }
                            continue;
                        }

                        if control_envelope.protocol == "e2e/session-reset-ack" {
                            let payload = control_envelope.payload.as_object();
                            let ack_requested_at =
                                json_u64(payload.and_then(|payload| payload.get("timestamp")))
                                    .unwrap_or(received_at);
                            let ack_epoch =
                                json_u64(payload.and_then(|payload| payload.get("epoch")))
                                    .unwrap_or(ack_requested_at);
                            if clear_peer_recovery_state(&state, &from, Some(ack_epoch)).await {
                                eprintln!(
                                    "Peer {} acknowledged E2E session reset for epoch {}",
                                    from, ack_epoch,
                                );
                            } else {
                                eprintln!(
                                    "Ignoring stale E2E session reset acknowledgement from {} for epoch {}",
                                    from, ack_epoch,
                                );
                            }
                            continue;
                        }

                        let payload = control_envelope.payload.as_object();
                        let retry_message_lookup_id = payload
                            .and_then(|payload| payload.get("messageId"))
                            .and_then(|value| value.as_str())
                            .map(str::to_string);
                        let retry_reason = payload
                            .and_then(|payload| payload.get("reason"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("decrypt-failed")
                            .to_string();
                        let retry_transport = payload
                            .and_then(|payload| payload.get("failedTransport"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("session")
                            .to_string();
                        let retry_requested_at =
                            json_u64(payload.and_then(|payload| payload.get("timestamp")))
                                .unwrap_or(received_at);

                        let Some(retry_message_lookup_id) = retry_message_lookup_id else {
                            eprintln!(
                                "Ignoring malformed session retry {} from {} on {}: missing messageId",
                                message_id, from, relay_url,
                            );
                            continue;
                        };
                        if retry_transport != "session" {
                            eprintln!(
                                "Ignoring unsupported session retry {} from {} on {}: failedTransport={}",
                                message_id, from, relay_url, retry_transport,
                            );
                            continue;
                        }
                        if get_peer_recovery_state(&state, &from).await.is_some() {
                            eprintln!(
                                "Ignoring session retry {} from {} on {} while recovery barrier is active",
                                message_id, from, relay_url,
                            );
                            continue;
                        }

                        schedule_peer_replay(
                            Arc::clone(&state),
                            from.clone(),
                            PendingReplayRequest {
                                lookup_message_id: retry_message_lookup_id,
                                reason: retry_reason,
                                requested_at: retry_requested_at,
                            },
                        )
                        .await;
                        continue;
                    }

                    if envelope_protocol != Some(E2E_APPLICATION_ENVELOPE_PROTOCOL) {
                        eprintln!(
                            "Rejecting legacy plaintext relay message {} from {} on {} with protocol {}",
                            message_id,
                            from,
                            relay_url,
                            envelope
                                .get("protocol")
                                .and_then(|value| value.as_str())
                                .unwrap_or("<missing>"),
                        );
                        continue;
                    }

                    let peer_session_lock = get_peer_session_lock(&state, &from).await;
                    let _peer_session_guard = peer_session_lock.lock().await;

                    if let Some(recovery) = get_peer_recovery_state(&state, &from).await {
                        eprintln!(
                            "Dropping inbound E2E transport {} from {} on {} while recovery barrier is active (epoch={}, awaitingAck={})",
                            message_id,
                            from,
                            relay_url,
                            recovery.epoch,
                            recovery.awaiting_ack,
                        );
                        continue;
                    }

                    let transport_envelope: crate::protocol::Envelope =
                        match serde_json::from_value(envelope.clone()) {
                            Ok(envelope) => envelope,
                            Err(err) => {
                                eprintln!(
                                "Skipping malformed E2E transport envelope {} from {} on {}: {}",
                                message_id, from, relay_url, err,
                            );
                                continue;
                            }
                        };
                    let transport_message_id = transport_envelope.id.clone();
                    let transport_thread_id = transport_envelope.thread_id.clone();

                    let invite_token = {
                        let state_guard = state.read().await;
                        resolve_relay_invite_token(None, Some(&state_guard.config))
                    };

                    if let Ok(payload) =
                        serde_json::from_value::<EncryptedApplicationEnvelopePayload>(
                            transport_envelope.payload.clone(),
                        )
                    {
                        if let Ok(DecodedEncryptedApplicationMessage::PreKey(message)) =
                            decode_encrypted_application_envelope_payload(&payload)
                        {
                            match connect_query_session(&relay_url, invite_token.as_deref()).await {
                                Ok(mut query_session) => {
                                    let sender_card =
                                        query_session.fetch_card(&message.sender_did).await;
                                    let _ = query_session.goodbye().await;
                                    match sender_card {
                                        Ok(Some(card)) => {
                                            if let Err(err) =
                                                assert_published_sender_device_matches_prekey_message(
                                                    &card,
                                                    &message,
                                                )
                                            {
                                                eprintln!(
                                                    "Skipping undecryptable E2E relay message {} from {} on {}: {}",
                                                    message_id, from, relay_url, err,
                                                );
                                                continue;
                                            }
                                        }
                                        Ok(None) => {
                                            eprintln!(
                                                "Skipping undecryptable E2E relay message {} from {} on {}: Sender {}:{} is not published in current Agent Card",
                                                message_id,
                                                from,
                                                relay_url,
                                                message.sender_did,
                                                message.sender_device_id,
                                            );
                                            continue;
                                        }
                                        Err(err) => {
                                            eprintln!(
                                                "Skipping undecryptable E2E relay message {} from {} on {}: {}",
                                                message_id, from, relay_url, err,
                                            );
                                            continue;
                                        }
                                    }
                                }
                                Err(err) => {
                                    eprintln!(
                                        "Skipping undecryptable E2E relay message {} from {} on {}: {}",
                                        message_id, from, relay_url, err,
                                    );
                                    continue;
                                }
                            }
                        }
                    }

                    let decrypted = match with_local_e2e_state_transaction(|config| async move {
                        let decrypted = prepare_encrypted_receive(&config, &transport_envelope)?;
                        let next_config = decrypted.config.clone();
                        Ok((decrypted, next_config))
                    })
                    .await
                    {
                        Ok((decrypted, next_config)) => (decrypted, next_config),
                        Err(err) => {
                            eprintln!(
                                "E2E decrypt failed for {} from {}: {}",
                                message_id, from, err
                            );

                            let requested_at = received_at.max(now_ms());
                            let (recovery, started_recovery, cancelled, cleared_count) =
                                begin_local_peer_recovery(
                                    &state,
                                    &from,
                                    "decrypt-failed",
                                    requested_at,
                                )
                                .await;
                            let (my_did, fallback_receiver_device_id) = {
                                let state_guard = state.read().await;
                                (
                                    state_guard
                                        .config
                                        .identity
                                        .as_ref()
                                        .map(|identity| identity.did.clone())
                                        .unwrap_or_default(),
                                    state_guard
                                        .config
                                        .e2e
                                        .as_ref()
                                        .map(|e2e| e2e.current_device_id.clone())
                                        .unwrap_or_default(),
                                )
                            };
                            let receiver_device_id = fallback_receiver_device_id;

                            if started_recovery {
                                let private_key_hex = {
                                    let state_guard = state.read().await;
                                    state_guard
                                        .config
                                        .identity
                                        .as_ref()
                                        .map(|identity| identity.private_key.clone())
                                        .unwrap_or_default()
                                };
                                let keypair = match KeyPair::from_hex(&private_key_hex) {
                                    Ok(keypair) => keypair,
                                    Err(err) => {
                                        eprintln!(
                                            "Failed to build keypair while sending session reset to {} after decrypt failure: {}",
                                            from, err,
                                        );
                                        let failed_msg = StoredMessage {
                                            id: message_id.clone(),
                                            from: from.clone(),
                                            to: my_did.clone(),
                                            envelope: json!({
                                                "id": &message_id,
                                                "from": &from,
                                                "protocol": "e2e/decrypt-failed",
                                                "payload": {
                                                    "error": err.to_string(),
                                                    "epoch": recovery.epoch,
                                                    "hint": "Failed to build local keypair while entering explicit session recovery."
                                                },
                                                "timestamp": received_at,
                                            }),
                                            timestamp: received_at,
                                            thread_id: transport_thread_id.clone(),
                                            read: false,
                                            direction: MessageDirection::Inbound,
                                            e2e: Some(StoredMessageE2EMetadata {
                                                deliveries: vec![E2EDeliveryMetadata {
                                                    transport: "unknown".into(),
                                                    transport_message_id: Some(transport_message_id.clone()),
                                                    sender_device_id: "unknown".into(),
                                                    receiver_device_id: receiver_device_id.clone(),
                                                    session_id: "unknown".into(),
                                                    state: E2EDeliveryState::Failed,
                                                    recorded_at: received_at,
                                                    used_skipped_message_key: None,
                                                    error: Some(err.to_string()),
                                                }],
                                                retry: None,
                                            }),
                                        };
                                        let mut state_guard = state.write().await;
                                        if let Some(reason) =
                                            inbound_rejection_reason(&state_guard.config, &from)
                                        {
                                            eprintln!(
                                                "Dropping inbound recovery failure message {} from {}: {}",
                                                message_id, from, reason
                                            );
                                        } else {
                                            store_message(&mut state_guard, failed_msg);
                                        }
                                        continue;
                                    }
                                };
                                let reset_envelope = build_session_reset_envelope(
                                    &keypair,
                                    &my_did,
                                    &from,
                                    &recovery.reason,
                                    recovery.epoch,
                                    requested_at,
                                );
                                if let Err(reset_error) =
                                    send_recovery_control_via_worker(&state, &from, &reset_envelope)
                                        .await
                                {
                                    eprintln!(
                                        "Failed to send E2E session reset to {} after decrypt failure for epoch {}: {}",
                                        from, recovery.epoch, reset_error,
                                    );
                                }
                            }

                            let failed_msg = StoredMessage {
                                id: message_id.clone(),
                                from: from.clone(),
                                to: my_did,
                                envelope: json!({
                                    "id": &message_id,
                                    "from": &from,
                                    "protocol": "e2e/decrypt-failed",
                                    "payload": {
                                        "error": err.to_string(),
                                        "epoch": recovery.epoch,
                                        "hint": "Peer moved to explicit session recovery. Normal sends are blocked until reset-ack arrives."
                                    },
                                    "timestamp": received_at,
                                }),
                                timestamp: received_at,
                                thread_id: transport_thread_id,
                                read: false,
                                direction: MessageDirection::Inbound,
                                e2e: Some(StoredMessageE2EMetadata {
                                    deliveries: vec![E2EDeliveryMetadata {
                                        transport: "unknown".into(),
                                        transport_message_id: Some(transport_message_id),
                                        sender_device_id: "unknown".into(),
                                        receiver_device_id,
                                        session_id: "unknown".into(),
                                        state: E2EDeliveryState::Failed,
                                        recorded_at: received_at,
                                        used_skipped_message_key: None,
                                        error: Some(err.to_string()),
                                    }],
                                    retry: None,
                                }),
                            };
                            let mut state_guard = state.write().await;
                            if let Some(reason) =
                                inbound_rejection_reason(&state_guard.config, &from)
                            {
                                eprintln!(
                                    "Dropping inbound recovery failure message {} from {}: {}",
                                    message_id, from, reason
                                );
                            } else {
                                store_message(&mut state_guard, failed_msg);
                            }
                            eprintln!(
                                "E2E decrypt failure from {} entered explicit recovery barrier (epoch={}, startedRecovery={}, {} replay request(s) cancelled, {} retry notification(s) cancelled, {} session(s) cleared)",
                                from,
                                recovery.epoch,
                                started_recovery,
                                cancelled.0,
                                cancelled.1,
                                cleared_count,
                            );
                            continue;
                        }
                    };

                    let (decrypted, next_config) = decrypted;

                    envelope = match serde_json::to_value(&decrypted.application_envelope) {
                        Ok(envelope) => envelope,
                        Err(err) => {
                            eprintln!(
                                "Skipping decrypted envelope {} from {} on {} due to serialization failure: {}",
                                message_id, from, relay_url, err,
                            );
                            continue;
                        }
                    };

                    let e2e_metadata = Some(StoredMessageE2EMetadata {
                        deliveries: vec![E2EDeliveryMetadata {
                            transport: decrypted.transport.clone(),
                            transport_message_id: Some(transport_message_id),
                            sender_device_id: decrypted.sender_device_id,
                            receiver_device_id: decrypted.receiver_device_id,
                            session_id: decrypted.session_id,
                            state: E2EDeliveryState::Received,
                            recorded_at: received_at,
                            used_skipped_message_key: Some(decrypted.used_skipped_message_key),
                            error: None,
                        }],
                        retry: None,
                    });

                    eprintln!(
                        "Decrypted inbound E2E message {} on {} via {} transport",
                        message_id, relay_url, decrypted.transport,
                    );

                    let message = StoredMessage {
                        id: envelope
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&message_id)
                            .to_string(),
                        from: envelope
                            .get("from")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&from)
                            .to_string(),
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
                        e2e: e2e_metadata,
                    };

                    let mut state_guard = state.write().await;
                    state_guard.config.e2e = next_config.e2e;
                    if let Some(reason) =
                        inbound_rejection_reason(&state_guard.config, &message.from)
                    {
                        eprintln!(
                            "Dropping inbound message {} from {}: {}",
                            message.id, message.from, reason
                        );
                    } else {
                        store_message(&mut state_guard, message);
                    }
                }
                RelayWorkerEvent::DeliveryReported {
                    relay_url,
                    message_id,
                    status,
                    received_at,
                } => {
                    let Some(delivery_state) = delivery_state_from_event_status(&status) else {
                        eprintln!(
                            "Relay delivery report on {} for {}: {}",
                            relay_url, message_id, status,
                        );
                        continue;
                    };
                    let delivery_error = delivery_error_from_event_status(&status);
                    let updated = {
                        let mut state_guard = state.write().await;
                        update_message_delivery_by_transport_id(
                            &mut state_guard,
                            &message_id,
                            delivery_state,
                            received_at,
                            delivery_error.clone(),
                        )
                    };
                    if !updated {
                        eprintln!(
                            "Relay delivery report on {} for {}: {} (no matching outbound delivery)",
                            relay_url, message_id, status,
                        );
                    }
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
            "mark_read" => handle_mark_read(params, state).await,
            "send" => handle_send(params, state).await,
            "discover" => handle_discover(params, state).await,
            "peers" => handle_peers(params, state).await,
            "list_peers" => handle_list_peers(params, state).await,
            "sessions" => handle_sessions(params, state).await,
            "session_messages" => handle_session_messages(params, state).await,
            "trust_score" => handle_trust_score(params, state).await,
            "endorsements" | "query_endorsements" => handle_endorsements(params, state).await,
            "create_endorsement" => handle_create_endorsement(params, state).await,
            "block_agent" => handle_block_agent(params, state).await,
            "block" => handle_block_alias("block", params, state).await,
            "unblock" => handle_block_alias("unblock", params, state).await,
            "allowlist" => handle_allowlist(params, state).await,
            "get_card" => handle_get_card(state).await,
            "query-card" => handle_query_card(params, state).await,
            "query_agent_card" => handle_query_agent_card(params, state).await,
            "publish_card" => handle_publish_card(params, state).await,
            "reload-e2e" => handle_reload_e2e(state).await,
            "e2e-reset-notify" => handle_e2e_reset_notify(params, state).await,
            "stop" | "shutdown" => handle_stop(state).await,
            _ => Err(anyhow::anyhow!("Unknown command: {}", command)),
        }
    }

    async fn check_no_other_daemon_running(&self) -> Result<()> {
        let peer_candidates = [
            peer_daemon_socket_path(),
            DEFAULT_JS_DAEMON_SOCKET.to_string(),
        ];

        for other_socket in peer_candidates {
            if other_socket == self.socket_path || !std::path::Path::new(&other_socket).exists() {
                continue;
            }

            let client = DaemonClient::new(&other_socket);
            if client.is_running().await {
                anyhow::bail!(
                    "Another a4 daemon is already running at {}.\n\
                     This QUADRA_A_HOME is already bound to a different daemon socket.\n\
                     Stop it first or use a different QUADRA_A_HOME, then retry.",
                    other_socket
                );
            }
        }

        // Also check own socket for an already-running instance
        if std::path::Path::new(&self.socket_path).exists() {
            let client = DaemonClient::new(&self.socket_path);
            if client.is_running().await {
                anyhow::bail!("Daemon already running at {}", self.socket_path);
            }
        }

        Ok(())
    }
}

async fn handle_stop(state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let relay_sender = {
        let mut state_guard = state.write().await;
        state_guard.running = false;
        state_guard.relay_runtime.mark_disconnected();
        state_guard.relay_sender.clone()
    };
    if let Some(relay_sender) = relay_sender {
        let _ = relay_sender.send(RelayWorkerCommand::Stop).await;
    }
    Ok(json!({ "stopping": true }))
}

async fn handle_get_card(state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let state_guard = state.read().await;
    Ok(serde_json::to_value(&state_guard.config.agent_card).unwrap_or(Value::Null))
}

async fn handle_query_agent_card(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let result = handle_query_card(params, state).await?;
    Ok(result.get("card").cloned().unwrap_or(Value::Null))
}

async fn handle_list_peers(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let result = handle_peers(params, state).await?;
    Ok(result
        .get("peers")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new())))
}

async fn handle_block_alias(action: &str, mut params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let params_object = params
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Invalid block command parameters"))?;
    params_object.insert("action".to_string(), Value::String(action.to_string()));
    handle_block_agent(params, state).await
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
        "peerCount": state_guard.messages.peer_count(),
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
    let state_guard = state.read().await;
    let filter = params.get("filter");
    let limit = json_u64(
        params
            .get("limit")
            .or_else(|| params.get("pagination").and_then(|p| p.get("limit"))),
    )
    .unwrap_or(20) as usize;
    let unread = params
        .get("unread")
        .or_else(|| filter.and_then(|f| f.get("unread")))
        .or_else(|| filter.and_then(|f| f.get("unreadOnly")))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let thread_id = params
        .get("threadId")
        .or_else(|| filter.and_then(|f| f.get("threadId")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let directions =
        json_string_filter(params.get("direction").or_else(|| filter.and_then(|f| f.get("direction"))));
    let from_dids =
        json_string_filter(params.get("fromDid").or_else(|| filter.and_then(|f| f.get("fromDid"))));
    let to_dids =
        json_string_filter(params.get("toDid").or_else(|| filter.and_then(|f| f.get("toDid"))));
    let protocols = json_string_filter(
        params
            .get("protocol")
            .or_else(|| filter.and_then(|f| f.get("protocol"))),
    );
    let envelope_types =
        json_string_filter(params.get("type").or_else(|| filter.and_then(|f| f.get("type"))));
    let reply_tos = json_string_filter(
        params
            .get("replyTo")
            .or_else(|| filter.and_then(|f| f.get("replyTo"))),
    );
    let statuses =
        json_string_filter(params.get("status").or_else(|| filter.and_then(|f| f.get("status"))));

    let mut selected = state_guard
        .messages
        .all_messages()
        .iter()
        .filter(|message| {
            inbox_message_matches(
                message,
                unread,
                thread_id.as_deref(),
                directions.as_ref(),
                from_dids.as_ref(),
                to_dids.as_ref(),
                protocols.as_ref(),
                envelope_types.as_ref(),
                reply_tos.as_ref(),
                statuses.as_ref(),
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    selected.sort_by_key(|message| message.timestamp);
    let total = selected.len();
    let page = selected
        .into_iter()
        .rev()
        .take(limit)
        .collect::<Vec<_>>();
    let messages = page
        .into_iter()
        .map(|message| message_to_inbox_json(&message))
        .collect::<Vec<_>>();

    Ok(json!({
        "messages": messages,
        "total": total,
        "hasMore": total > limit,
    }))
}

async fn handle_mark_read(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let message_id = params
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Missing 'id' field"))?;

    let mut state_guard = state.write().await;
    let marked = mark_message_read(&mut state_guard, message_id);

    Ok(json!({ "marked": marked }))
}

async fn handle_send(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let to = params
        .get("to")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'to' field"))?
        .to_string();

    let peer_session_lock = get_peer_session_lock(&state, &to).await;
    let _peer_session_guard = peer_session_lock.lock().await;
    if let Some(recovery) = get_peer_recovery_state(&state, &to).await {
        return Err(peer_recovery_error(&to, &recovery));
    }

    // Phase 1: Read state snapshot (read lock only, released immediately).
    let (identity, relay_sender, relay_url, outbound_send_lock) = {
        let state_guard = state.read().await;
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
        let relay_url = state_guard.relay_runtime.relay_url.clone();
        (
            identity,
            relay_sender,
            relay_url,
            Arc::clone(&state_guard.outbound_send_lock),
        )
    };
    let _send_guard = outbound_send_lock.lock().await;
    if let Some(recovery) = get_peer_recovery_state(&state, &to).await {
        return Err(peer_recovery_error(&to, &recovery));
    }
    let keypair = KeyPair::from_hex(&identity.private_key)?;

    // Phase 2: Build envelope and E2E encrypt (no state lock held — allows
    // relay worker events to be processed concurrently).
    let (message_id, thread_id, envelope_json, send_batches, initial_e2e) =
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
            (
                message_id,
                thread_id,
                envelope_json,
                vec![PendingSendBatch {
                    envelope_bytes: bytes,
                    delivery: None,
                    accepted_config: None,
                }],
                None,
            )
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

            let envelope = crate::commands::tell::build_envelope(
                &identity.did,
                &to,
                msg_type,
                protocol,
                payload,
                crate::commands::tell::EnvelopeThreading::new(reply_to, thread_id.clone()),
                &keypair,
            )?;
            let (envelope_json, send_batches, initial_e2e) =
                prepare_encrypted_send_batches_without_commit(&relay_url, &identity, envelope)
                    .await?;
            (
                envelope_json
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                thread_id,
                envelope_json,
                send_batches,
                Some(initial_e2e),
            )
        };

    // Phase 3: Store outbound message (brief write lock).
    {
        let mut sg = state.write().await;
        store_message(&mut sg, StoredMessage {
            id: message_id.clone(),
            from: identity.did.clone(),
            to: to.clone(),
            timestamp: json_u64(envelope_json.get("timestamp")).unwrap_or_else(now_ms),
            thread_id: thread_id.clone(),
            envelope: envelope_json.clone(),
            read: true,
            direction: MessageDirection::Outbound,
            e2e: initial_e2e,
        });
    }

    // Phase 4: Send via relay (no state lock — relay worker can process
    // incoming events freely while we await the send response).
    for batch in send_batches {
        let PendingSendBatch {
            envelope_bytes,
            mut delivery,
            accepted_config,
        } = batch;

        match send_envelope_via_worker(&relay_sender, &to, envelope_bytes).await {
            Ok(outcome) => {
                if let Some(accepted_config) = accepted_config.as_ref() {
                    if let Err(error) = commit_e2e_state_after_accept(&state, accepted_config).await {
                        if let Some(delivery) = delivery.as_mut() {
                            delivery.transport_message_id = Some(outcome.relay_message_id.clone());
                            delivery.state = E2EDeliveryState::Failed;
                            delivery.recorded_at = now_ms();
                            delivery.error =
                                Some(format!("Failed to persist accepted E2E state: {}", error));
                            let mut sg = state.write().await;
                            upsert_message_delivery(
                                &mut sg,
                                &message_id,
                                MessageDirection::Outbound,
                                delivery.clone(),
                            );
                        }
                        return Err(error).context("Failed to persist accepted E2E state");
                    }
                }

                if let Some(delivery) = delivery.as_mut() {
                    delivery.transport_message_id = Some(outcome.relay_message_id);
                    delivery.state = delivery_state_from_report_status(&outcome.status);
                    delivery.recorded_at = outcome.reported_at;
                    delivery.error = None;
                    let mut sg = state.write().await;
                    upsert_message_delivery(
                        &mut sg,
                        &message_id,
                        MessageDirection::Outbound,
                        delivery.clone(),
                    );
                }
            }
            Err(error) => {
                if let Some(delivery) = delivery.as_mut() {
                    delivery.state = E2EDeliveryState::Failed;
                    delivery.recorded_at = now_ms();
                    delivery.error = Some(error.to_string());
                    let mut sg = state.write().await;
                    upsert_message_delivery(
                        &mut sg,
                        &message_id,
                        MessageDirection::Outbound,
                        delivery.clone(),
                    );
                }
                return Err(error).context("Relay send failed");
            }
        }
    }

    Ok(json!({
        "accepted": true,
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

    let (observer_did, relay_urls, invite_token, mut local_trust_config, messages_snapshot) = {
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
            state_guard.messages.all_messages().to_vec(),
        )
    };
    local_trust_config.trust_scores.remove(&target_did);

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
    let (interaction_count, local_trust) =
        compute_local_interaction_score(&messages_snapshot, &observer_did, &target_did);
    let alpha = (interaction_count as f64 / 20.0).min(0.8);
    let score = if interaction_count == 0 {
        trust_score.score
    } else {
        (alpha * local_trust + (1.0 - alpha) * trust_score.network_trust).clamp(0.0, 1.0)
    };
    engine.config.cache_trust_score(
        target_did.clone(),
        score,
        engine.config.trust_cache_ttl_seconds,
    );

    {
        let mut state_guard = state.write().await;
        state_guard.config.trust_config = Some(engine.config.clone());
        merge_cli_fields_before_save(&mut state_guard.config);
        let _ = save_config(&state_guard.config);
    }

    Ok(json!({
        "score": score,
        "localTrust": local_trust,
        "networkTrust": trust_score.network_trust,
        "alpha": alpha,
        "endorsementCount": trust_score.endorsement_count,
        "interactionCount": interaction_count,
        "breakdown": {
            "capabilityEndorsements": trust_score.breakdown.capability_endorsements,
            "reliabilityEndorsements": trust_score.breakdown.reliability_endorsements,
            "generalEndorsements": trust_score.breakdown.general_endorsements,
            "recentActivity": activity_level_name(&trust_score.breakdown.recent_activity),
            "networkPosition": network_position_name(&trust_score.breakdown.network_position),
        }
    }))
}

fn local_endorsement_to_js_value(endorsement: &EndorsementV2) -> Value {
    json!({
        "version": 2,
        "from": endorsement.endorser,
        "to": endorsement.endorsee,
        "score": endorsement.strength,
        "domain": endorsement.domain,
        "reason": endorsement
            .comment
            .clone()
            .unwrap_or_else(|| format!("{} endorsement", endorsement.endorsement_type)),
        "timestamp": endorsement.timestamp,
        "expires": endorsement.expires,
        "signature": endorsement.signature,
        "type": endorsement.endorsement_type,
        "comment": endorsement.comment,
    })
}

async fn handle_create_endorsement(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let target_did = params
        .get("targetDid")
        .or_else(|| params.get("did"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing target DID"))?
        .to_string();
    let score = params
        .get("score")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow::anyhow!("Missing endorsement score"))?;
    if !(0.0..=1.0).contains(&score) {
        anyhow::bail!("Endorsement score must be between 0.0 and 1.0");
    }

    let domain = non_empty_str(params.get("domain")).map(|value| value.to_string());
    let endorsement_type = non_empty_str(
        params
            .get("type")
            .or_else(|| params.get("endorsementType"))
            .or_else(|| params.get("endorsement_type")),
    )
    .unwrap_or("general")
    .to_string();
    let comment = non_empty_str(params.get("reason"))
        .or_else(|| non_empty_str(params.get("comment")))
        .map(|value| value.to_string());

    let (identity, mut next_config, timestamp) = {
        let state_guard = state.read().await;
        let identity = state_guard
            .config
            .identity
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No identity found"))?;
        (identity, state_guard.config.clone(), now_ms())
    };
    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let expires = Some(timestamp + 90 * 24 * 60 * 60 * 1000);

    let mut endorsement = EndorsementV2 {
        endorser: identity.did.clone(),
        endorsee: target_did,
        domain,
        endorsement_type,
        strength: score,
        comment,
        timestamp,
        expires,
        version: "2.0".to_string(),
        signature: String::new(),
    };

    let endorsement_json = serde_json::to_string(&relay_unsigned_endorsement_value(&endorsement))?;
    endorsement.signature = hex::encode(keypair.sign(endorsement_json.as_bytes()));

    if next_config.trust_config.is_none() {
        next_config.trust_config = Some(TrustConfig::new());
    }
    if let Some(trust_config) = &mut next_config.trust_config {
        trust_config.add_endorsement(endorsement.clone());
    }
    merge_cli_fields_before_save(&mut next_config);
    save_config(&next_config)?;

    {
        let mut state_guard = state.write().await;
        state_guard.config = next_config.clone();
    }

    if let Ok(card) = build_agent_card_from_config(&next_config, &identity) {
        if let Ok((mut session, _relay_url)) = connect_first_available(
            None,
            Some(&next_config),
            &identity.did,
            &card,
            &keypair,
        )
        .await
        {
            let _ = session.publish_endorsement(&endorsement).await;
            let _ = session.goodbye().await;
        }
    }

    Ok(local_endorsement_to_js_value(&endorsement))
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

    if action == "unblock" {
        if let Some(trust_config) = &mut state_guard.config.trust_config {
            trust_config.unblock_agent(&target_did);
        }
    } else {
        if let Some(trust_config) = &mut state_guard.config.trust_config {
            trust_config.block_agent(target_did.clone());
        }
        if state_guard.messages.remove_inbound_from(&target_did) > 0 {
            persist_messages(&state_guard);
        }
    }

    merge_cli_fields_before_save(&mut state_guard.config);
    save_config(&state_guard.config)?;

    Ok(json!({
        "blocked": action != "unblock",
        "targetDid": target_did,
    }))
}

async fn handle_allowlist(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let target_did = params
        .get("targetDid")
        .or_else(|| params.get("did"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing target DID"))?
        .to_string();

    let action = params
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("allow");

    let note = params
        .get("note")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut state_guard = state.write().await;
    if state_guard.config.trust_config.is_none() {
        state_guard.config.trust_config = Some(TrustConfig::new());
    }

    if let Some(trust_config) = &mut state_guard.config.trust_config {
        match action {
            "allow" | "add" => {
                trust_config.allow_agent(target_did.clone(), note);
            }
            "remove" => {
                trust_config.allowed_agents.remove(&target_did);
            }
            _ => return Err(anyhow::anyhow!("Unknown allowlist action: {}", action)),
        }
    }

    merge_cli_fields_before_save(&mut state_guard.config);
    save_config(&state_guard.config)?;

    Ok(json!({
        "action": action,
        "targetDid": target_did,
    }))
}

async fn handle_publish_card(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let (identity, mut next_config) = {
        let state_guard = state.read().await;
        let identity = state_guard
            .config
            .identity
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No identity found"))?;
        (identity, state_guard.config.clone())
    };

    let current_card = next_config.agent_card.clone();
    let next_card = AgentCardConfig {
        name: non_empty_str(params.get("name"))
            .map(|value| value.to_string())
            .or_else(|| current_card.as_ref().map(|card| card.name.clone()))
            .unwrap_or_else(|| "quadra-a Agent".to_string()),
        description: params
            .get("description")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .or_else(|| current_card.as_ref().map(|card| card.description.clone()))
            .unwrap_or_default(),
        capabilities: params
            .get("capabilities")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                current_card
                    .map(|card| card.capabilities)
                    .unwrap_or_default()
            }),
    };

    next_config.agent_card = Some(next_card.clone());
    merge_cli_fields_before_save(&mut next_config);
    save_config(&next_config)?;

    {
        let mut state_guard = state.write().await;
        state_guard.config = next_config.clone();
    }

    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let card = build_agent_card_from_config(&next_config, &identity)?;
    let (mut session, _relay_url) = connect_first_available(
        None,
        Some(&next_config),
        &identity.did,
        &card,
        &keypair,
    )
    .await?;
    session.publish_card().await?;
    let _ = session.goodbye().await;

    next_config.published = Some(true);
    merge_cli_fields_before_save(&mut next_config);
    save_config(&next_config)?;

    {
        let mut state_guard = state.write().await;
        state_guard.config = next_config;
    }

    Ok(json!({
        "did": identity.did,
        "card": {
            "name": next_card.name,
            "description": next_card.description,
            "capabilities": next_card.capabilities,
        }
    }))
}

async fn handle_query_card(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let did = params
        .get("did")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'did' parameter"))?
        .to_string();

    let (relay_url, invite_token) = {
        let state_guard = state.read().await;
        (
            state_guard.relay_runtime.relay_url.clone(),
            resolve_relay_invite_token(None, Some(&state_guard.config)),
        )
    };

    // Query the relay for the agent's card
    let card = match connect_query_session(&relay_url, invite_token.as_deref()).await {
        Ok(mut session) => {
            let result = session.fetch_card(&did).await;
            let _ = session.goodbye().await;
            result.ok().flatten()
        }
        Err(_) => None,
    };

    Ok(json!({ "card": card }))
}

async fn handle_reload_e2e(state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let (cancelled_replay_peers, cancelled_retry_peers) = clear_all_pending_recovery(&state).await;
    let cleared_recovering_peers = clear_all_peer_recoveries(&state).await;
    let fresh_config = load_config()?;
    let mut state_guard = state.write().await;
    state_guard.config.e2e = fresh_config.e2e;
    Ok(json!({
        "status": "reloaded",
        "cancelledReplayPeers": cancelled_replay_peers,
        "cancelledRetryPeers": cancelled_retry_peers,
        "clearedRecoveringPeers": cleared_recovering_peers,
    }))
}

async fn handle_e2e_reset_notify(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let peers = params
        .get("peers")
        .and_then(|value| value.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing 'peers' array"))?;

    let mut deduped_peers = BTreeSet::new();
    for peer in peers {
        let peer_did = peer
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Peer list must contain non-empty DID strings"))?;
        deduped_peers.insert(peer_did.to_string());
    }

    if deduped_peers.is_empty() {
        return Ok(json!({
            "notified": Vec::<String>::new(),
            "failed": Vec::<Value>::new(),
        }));
    }

    let (from_did, private_key_hex) = {
        let state_guard = state.read().await;
        if !state_guard.relay_runtime.connected {
            anyhow::bail!("Not connected to any relay");
        }
        (
            state_guard
                .config
                .identity
                .as_ref()
                .map(|identity| identity.did.clone())
                .ok_or_else(|| anyhow::anyhow!("No identity found"))?,
            state_guard
                .config
                .identity
                .as_ref()
                .map(|identity| identity.private_key.clone())
                .ok_or_else(|| anyhow::anyhow!("No identity found"))?,
        )
    };
    let keypair = KeyPair::from_hex(&private_key_hex)?;

    let mut notified = Vec::new();
    let mut failed = Vec::new();
    for peer_did in &deduped_peers {
        let peer_session_lock = get_peer_session_lock(&state, peer_did).await;
        let _peer_session_guard = peer_session_lock.lock().await;
        let requested_at = now_ms();
        let (recovery, _, _, _) =
            begin_local_peer_recovery(&state, peer_did, "manual-reset", requested_at).await;
        let envelope = build_session_reset_envelope(
            &keypair,
            &from_did,
            peer_did,
            "manual-reset",
            recovery.epoch,
            requested_at,
        );
        match send_recovery_control_via_worker(&state, peer_did, &envelope).await {
            Ok(_) => notified.push(peer_did.clone()),
            Err(error) => failed.push(json!({
                "peer": peer_did.clone(),
                "error": error.to_string(),
            })),
        }
    }

    Ok(json!({
        "from": from_did,
        "notified": notified,
        "failed": failed,
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
        "status": stored_message_status(message),
        "envelope": message.envelope,
        "timestamp": message.timestamp,
        "threadId": effective_thread_id(message),
        "read": message.read,
        "receivedAt": if message.direction == MessageDirection::Inbound { json!(message.timestamp) } else { Value::Null },
        "sentAt": if message.direction == MessageDirection::Outbound { json!(message.timestamp) } else { Value::Null },
        "e2e": message.e2e,
    })
}

fn message_to_session_json(message: &StoredMessage) -> Value {
    json!({
        "id": message.id,
        "direction": message.direction.as_str(),
        "envelope": message.envelope,
        "receivedAt": if message.direction == MessageDirection::Inbound { json!(message.timestamp) } else { Value::Null },
        "sentAt": if message.direction == MessageDirection::Outbound { json!(message.timestamp) } else { Value::Null },
        "e2e": message.e2e,
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

    pub async fn stop_listener(&self) -> Result<()> {
        match self.send_command("stop", json!({})).await {
            Ok(_) => Ok(()),
            Err(error) if error.to_string().contains("Unknown command") => {
                self.send_command("shutdown", json!({})).await.map(|_| ())
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_session_reset_ack_envelope, build_session_reset_envelope,
        build_session_retry_envelope, clear_pending_peer_recovery, encode_envelope_bytes,
        compute_local_interaction_score, get_peer_recovery_state, handle_e2e_reset_notify,
        handle_inbox, handle_send, inbound_rejection_reason, DaemonState, PeerRecoveryState,
        PendingDecryptFailure, PendingReplayRequest, RecoveryCoordinator,
        DEFAULT_JS_DAEMON_SOCKET, DEFAULT_RS_DAEMON_SOCKET,
    };
    use crate::config::{Config, IdentityConfig, TrustConfig};
    use crate::identity::KeyPair;
    use quadra_a_runtime::inbox::{parse_envelope_value, MessageDirection, StoredMessage};
    use quadra_a_runtime::relay_worker::{RelaySendOutcome, RelayWorkerCommand};
    use quadra_a_runtime::session_manager::ManagedRelayState;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Mutex, RwLock};

    #[test]
    fn default_constants_are_distinct() {
        assert_ne!(DEFAULT_RS_DAEMON_SOCKET, DEFAULT_JS_DAEMON_SOCKET);
        assert!(DEFAULT_RS_DAEMON_SOCKET.ends_with("-rs.sock"));
        assert!(!DEFAULT_JS_DAEMON_SOCKET.contains("-rs"));
    }

    #[test]
    fn session_reset_envelope_is_signed_and_encoded_as_standard_envelope() {
        let keypair = KeyPair::generate();
        let did = quadra_a_core::identity::derive_did(keypair.verifying_key.as_bytes());
        let envelope = build_session_reset_envelope(
            &keypair,
            &did,
            "did:agent:zPeer",
            "decrypt-failed",
            123,
            123,
        );

        assert_eq!(envelope.protocol, "e2e/session-reset");
        assert!(envelope.verify_signature().expect("signature verifies"));

        let encoded = encode_envelope_bytes(&envelope).expect("envelope encodes");
        let decoded = parse_envelope_value(&encoded).expect("encoded envelope decodes");
        assert_eq!(
            decoded.get("protocol").and_then(|value| value.as_str()),
            Some("e2e/session-reset")
        );
        assert_eq!(
            decoded
                .get("payload")
                .and_then(|value| value.get("reason"))
                .and_then(|value| value.as_str()),
            Some("decrypt-failed")
        );
    }

    #[test]
    fn session_reset_ack_envelope_is_signed_and_encoded_as_standard_envelope() {
        let keypair = KeyPair::generate();
        let did = quadra_a_core::identity::derive_did(keypair.verifying_key.as_bytes());
        let envelope = build_session_reset_ack_envelope(
            &keypair,
            &did,
            "did:agent:zPeer",
            "decrypt-failed",
            456,
            456,
        );

        assert_eq!(envelope.protocol, "e2e/session-reset-ack");
        assert!(envelope.verify_signature().expect("signature verifies"));

        let encoded = encode_envelope_bytes(&envelope).expect("envelope encodes");
        let decoded = parse_envelope_value(&encoded).expect("encoded envelope decodes");
        assert_eq!(
            decoded.get("protocol").and_then(|value| value.as_str()),
            Some("e2e/session-reset-ack")
        );
        assert_eq!(
            decoded
                .get("payload")
                .and_then(|value| value.get("epoch"))
                .and_then(|value| value.as_u64()),
            Some(456)
        );
    }

    #[test]
    fn session_retry_envelope_is_signed_and_encoded_as_standard_envelope() {
        let keypair = KeyPair::generate();
        let did = quadra_a_core::identity::derive_did(keypair.verifying_key.as_bytes());
        let envelope = build_session_retry_envelope(
            &keypair,
            &did,
            "did:agent:zPeer",
            "msg-original",
            "decrypt-failed",
            "session",
            456,
            Some("thread-1".to_string()),
        );

        assert_eq!(envelope.protocol, "e2e/session-retry");
        assert!(envelope.verify_signature().expect("signature verifies"));

        let encoded = encode_envelope_bytes(&envelope).expect("envelope encodes");
        let decoded = parse_envelope_value(&encoded).expect("encoded envelope decodes");
        assert_eq!(
            decoded.get("protocol").and_then(|value| value.as_str()),
            Some("e2e/session-retry")
        );
        assert_eq!(
            decoded
                .get("payload")
                .and_then(|value| value.get("messageId"))
                .and_then(|value| value.as_str()),
            Some("msg-original")
        );
        assert_eq!(
            decoded
                .get("payload")
                .and_then(|value| value.get("failedTransport"))
                .and_then(|value| value.as_str()),
            Some("session")
        );
    }

    #[tokio::test]
    async fn e2e_reset_notify_sends_signed_manual_reset_envelopes() {
        let keypair = KeyPair::generate();
        let did = quadra_a_core::identity::derive_did(keypair.verifying_key.as_bytes());
        let config = Config {
            identity: Some(IdentityConfig {
                did: did.clone(),
                public_key: keypair.public_key_hex(),
                private_key: keypair.private_key_hex(),
            }),
            ..Config::default()
        };

        let mut relay_runtime =
            ManagedRelayState::new(quadra_a_core::config::ReachabilityPolicy::default());
        relay_runtime.connected = true;

        let (relay_tx, mut relay_rx) = mpsc::channel(1);
        let state = Arc::new(RwLock::new(DaemonState {
            config,
            relay_runtime,
            relay_sender: Some(relay_tx),
            outbound_send_lock: Arc::new(Mutex::new(())),
            peer_session_locks: Arc::new(Mutex::new(HashMap::new())),
            recovery_coordinator: Arc::new(Mutex::new(RecoveryCoordinator::default())),
            messages_path: std::env::temp_dir()
                .join(format!("a4-daemon-messages-{}.json", uuid::Uuid::new_v4())),
            messages: quadra_a_runtime::inbox::MessageStore::default(),
            running: true,
        }));

        let notify_task = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                handle_e2e_reset_notify(
                    json!({
                        "peers": ["did:agent:zPeer", "did:agent:zPeer"]
                    }),
                    state,
                )
                .await
            }
        });

        let command = relay_rx.recv().await.expect("relay worker command emitted");
        match command {
            RelayWorkerCommand::SendEnvelope {
                to,
                envelope_bytes,
                response,
            } => {
                assert_eq!(to, "did:agent:zPeer");
                let decoded =
                    parse_envelope_value(&envelope_bytes).expect("encoded envelope decodes");
                assert_eq!(
                    decoded.get("protocol").and_then(|value| value.as_str()),
                    Some("e2e/session-reset")
                );
                assert_eq!(
                    decoded
                        .get("payload")
                        .and_then(|value| value.get("reason"))
                        .and_then(|value| value.as_str()),
                    Some("manual-reset")
                );
                let _ = response.send(Ok(RelaySendOutcome {
                    relay_message_id: "relay-reset-1".to_string(),
                    status: "accepted".to_string(),
                    reported_at: 123,
                }));
            }
            RelayWorkerCommand::Stop => panic!("unexpected stop command"),
        }

        let result = notify_task
            .await
            .expect("notify task joins")
            .expect("notify succeeds");
        assert_eq!(
            result
                .get("notified")
                .and_then(|value| value.as_array())
                .map(|value| value.len()),
            Some(1)
        );
        assert_eq!(
            result
                .get("failed")
                .and_then(|value| value.as_array())
                .map(|value| value.len()),
            Some(0)
        );

        let recovery = get_peer_recovery_state(&state, "did:agent:zPeer")
            .await
            .expect("peer recovery recorded");
        assert_eq!(recovery.reason, "manual-reset");
        assert!(recovery.awaiting_ack);
    }

    #[tokio::test]
    async fn clear_pending_peer_recovery_removes_batched_recovery_state() {
        let state = Arc::new(RwLock::new(DaemonState {
            config: Config::default(),
            relay_runtime: ManagedRelayState::new(
                quadra_a_core::config::ReachabilityPolicy::default(),
            ),
            relay_sender: None,
            outbound_send_lock: Arc::new(Mutex::new(())),
            peer_session_locks: Arc::new(Mutex::new(HashMap::new())),
            recovery_coordinator: Arc::new(Mutex::new(RecoveryCoordinator::default())),
            messages_path: std::env::temp_dir()
                .join(format!("a4-daemon-messages-{}.json", uuid::Uuid::new_v4())),
            messages: quadra_a_runtime::inbox::MessageStore::default(),
            running: true,
        }));

        let coordinator = {
            let state_guard = state.read().await;
            Arc::clone(&state_guard.recovery_coordinator)
        };
        {
            let mut guard = coordinator.lock().await;
            guard.pending_replays.insert(
                "did:agent:zPeer".to_string(),
                super::PendingPeerBatch {
                    items: std::collections::HashMap::from([(
                        "msg-1".to_string(),
                        PendingReplayRequest {
                            lookup_message_id: "msg-1".to_string(),
                            reason: "decrypt-failed".to_string(),
                            requested_at: 1,
                        },
                    )]),
                    ..Default::default()
                },
            );
            guard.pending_retry_notifications.insert(
                "did:agent:zPeer".to_string(),
                super::PendingPeerBatch {
                    items: std::collections::HashMap::from([(
                        "transport-1".to_string(),
                        PendingDecryptFailure {
                            transport_message_id: "transport-1".to_string(),
                            reason: "decrypt-failed".to_string(),
                            requested_at: 2,
                            thread_id: Some("thread-1".to_string()),
                        },
                    )]),
                    ..Default::default()
                },
            );
        }

        let cancelled = clear_pending_peer_recovery(&state, "did:agent:zPeer").await;
        assert_eq!(cancelled, (1, 1));

        let guard = coordinator.lock().await;
        assert!(!guard.pending_replays.contains_key("did:agent:zPeer"));
        assert!(!guard
            .pending_retry_notifications
            .contains_key("did:agent:zPeer"));
    }

    #[tokio::test]
    async fn handle_send_fails_fast_while_peer_recovery_barrier_is_active() {
        let peer_did = "did:agent:zPeer".to_string();
        let state = Arc::new(RwLock::new(DaemonState {
            config: Config::default(),
            relay_runtime: ManagedRelayState::new(
                quadra_a_core::config::ReachabilityPolicy::default(),
            ),
            relay_sender: None,
            outbound_send_lock: Arc::new(Mutex::new(())),
            peer_session_locks: Arc::new(Mutex::new(HashMap::new())),
            recovery_coordinator: Arc::new(Mutex::new(RecoveryCoordinator::default())),
            messages_path: std::env::temp_dir()
                .join(format!("a4-daemon-messages-{}.json", uuid::Uuid::new_v4())),
            messages: quadra_a_runtime::inbox::MessageStore::default(),
            running: true,
        }));

        let coordinator = {
            let state_guard = state.read().await;
            Arc::clone(&state_guard.recovery_coordinator)
        };
        {
            let mut guard = coordinator.lock().await;
            guard.peer_recoveries.insert(
                peer_did.clone(),
                PeerRecoveryState {
                    epoch: 777,
                    started_at: 777,
                    reason: "decrypt-failed".to_string(),
                    awaiting_ack: true,
                },
            );
        }

        let error = handle_send(
            json!({
                "to": peer_did,
                "protocol": "/agent/msg/1.0.0",
                "payload": { "text": "blocked" },
            }),
            Arc::clone(&state),
        )
        .await
        .expect_err("send should be rejected while recovery barrier is active");

        assert!(error.to_string().contains("recovering E2E session"));
    }

    #[test]
    fn inbound_rejection_reason_blocks_blocked_agents() {
        let mut trust = TrustConfig::new();
        trust.block_agent("did:agent:blocked".to_string());
        let config = Config {
            trust_config: Some(trust),
            ..Config::default()
        };

        assert_eq!(
            inbound_rejection_reason(&config, "did:agent:blocked").as_deref(),
            Some("blocked")
        );
    }

    #[test]
    fn compute_local_interaction_score_counts_correlated_replies() {
        let messages = vec![
            quadra_a_runtime::inbox::StoredMessage {
                id: "msg-1".to_string(),
                from: "did:agent:me".to_string(),
                to: "did:agent:peer".to_string(),
                envelope: json!({"id":"msg-1","type":"message","payload":{"text":"hello"}}),
                timestamp: 1,
                thread_id: None,
                read: true,
                direction: quadra_a_runtime::inbox::MessageDirection::Outbound,
                e2e: None,
            },
            quadra_a_runtime::inbox::StoredMessage {
                id: "msg-2".to_string(),
                from: "did:agent:peer".to_string(),
                to: "did:agent:me".to_string(),
                envelope: json!({"id":"msg-2","type":"reply","replyTo":"msg-1","payload":{"text":"ok"}}),
                timestamp: 2,
                thread_id: None,
                read: false,
                direction: quadra_a_runtime::inbox::MessageDirection::Inbound,
                e2e: None,
            },
        ];

        let (interaction_count, local_trust) =
            compute_local_interaction_score(&messages, "did:agent:me", "did:agent:peer");

        assert_eq!(interaction_count, 2);
        assert_eq!(local_trust, 1.0);
    }

    #[tokio::test]
    async fn handle_inbox_applies_direction_type_reply_to_and_status_filters() {
        let state = Arc::new(RwLock::new(DaemonState {
            config: Config::default(),
            relay_runtime: ManagedRelayState::new(
                quadra_a_core::config::ReachabilityPolicy::default(),
            ),
            relay_sender: None,
            outbound_send_lock: Arc::new(Mutex::new(())),
            peer_session_locks: Arc::new(Mutex::new(HashMap::new())),
            recovery_coordinator: Arc::new(Mutex::new(RecoveryCoordinator::default())),
            messages_path: std::env::temp_dir()
                .join(format!("a4-daemon-messages-{}.json", uuid::Uuid::new_v4())),
            messages: quadra_a_runtime::inbox::MessageStore::default(),
            running: true,
        }));

        {
            let mut guard = state.write().await;
            guard.messages.store(StoredMessage {
                id: "msg-request".to_string(),
                from: "did:agent:me".to_string(),
                to: "did:agent:gpu".to_string(),
                envelope: json!({
                    "id": "msg-request",
                    "type": "message",
                    "protocol": "/capability/gpu/compute",
                    "payload": { "size": 1024 }
                }),
                timestamp: 1,
                thread_id: None,
                read: true,
                direction: MessageDirection::Outbound,
                e2e: None,
            });
            guard.messages.store(StoredMessage {
                id: "msg-reply".to_string(),
                from: "did:agent:gpu".to_string(),
                to: "did:agent:me".to_string(),
                envelope: json!({
                    "id": "msg-reply",
                    "type": "reply",
                    "protocol": "/capability/gpu/compute",
                    "replyTo": "msg-request",
                    "payload": { "ok": true }
                }),
                timestamp: 2,
                thread_id: None,
                read: false,
                direction: MessageDirection::Inbound,
                e2e: None,
            });
        }

        let response = handle_inbox(
            json!({
                "pagination": { "limit": 20 },
                "filter": {
                    "direction": "inbound",
                    "type": "reply",
                    "replyTo": "msg-request",
                    "status": "pending"
                }
            }),
            Arc::clone(&state),
        )
        .await
        .expect("filtered inbox query succeeds");

        let messages = response["messages"]
            .as_array()
            .expect("messages array present");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["id"], "msg-reply");
        assert_eq!(messages[0]["direction"], "inbound");
        assert_eq!(messages[0]["status"], "pending");
    }
}
