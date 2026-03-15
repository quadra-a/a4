/// Unix socket daemon for agent communication.
/// Protocol: NDJSON — one JSON object per line.
/// Request:  {"id":"req_...","command":"send","params":{...}}\n
/// Response: {"id":"req_...","success":true,"data":{...}}\n
use anyhow::{Context, Result};
use dirs::home_dir;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::config::{
    load_config, resolve_reachability_policy, resolve_relay_invite_token, save_config, Config,
    EndorsementV2, TrustConfig,
};
use crate::e2e_state::{with_local_e2e_state_transaction, with_locked_config_transaction};
use crate::identity::KeyPair;
use crate::protocol::{cbor_x_encode_json, AgentCard, Envelope, EnvelopeUnsigned};
use crate::trust::{ActivityLevel, NetworkPosition, TrustEngine};
use quadra_a_core::e2e::{
    assert_published_sender_device_matches_prekey_message,
    decode_encrypted_application_envelope_payload, DecodedEncryptedApplicationMessage,
    EncryptedApplicationEnvelopePayload, E2E_APPLICATION_ENVELOPE_PROTOCOL,
};
use quadra_a_runtime::card::{
    build_agent_card_from_config, build_published_prekey_bundles_from_config,
};
use quadra_a_runtime::e2e_receive::prepare_encrypted_receive;
use quadra_a_runtime::e2e_send::prepare_encrypted_sends_with_session;
use quadra_a_runtime::inbox::{
    effective_thread_id, parse_envelope_value, E2EDeliveryMetadata, E2EDeliveryState,
    E2ERetryMetadata, MessageDirection, MessageStore, StoredMessage, StoredMessageE2EMetadata,
};
use quadra_a_runtime::query::{
    connect_query_session, query_discovered_agents as runtime_query_discovered_agents,
    query_network_endorsements as runtime_query_network_endorsements,
};
use quadra_a_runtime::relay_worker::{
    run_relay_worker as runtime_run_relay_worker, RelayWorkerCommand, RelayWorkerEvent,
    RelayWorkerOptions,
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

/// Merge CLI-managed fields from disk before saving daemon state.
/// The daemon holds config in memory, but the CLI may modify fields like
/// `aliases` directly on disk. Without this merge, `save_config` would
/// overwrite those changes with stale in-memory data.
fn merge_cli_fields_before_save(config: &mut Config) {
    if let Ok(fresh) = load_config() {
        config.aliases = fresh.aliases;
    }
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

                    let mut state_guard = state.write().await;
                    let envelope_protocol =
                        envelope.get("protocol").and_then(|value| value.as_str());

                    // Handle signed control messages outside the E2E transport.
                    if matches!(
                        envelope_protocol,
                        Some("e2e/session-reset" | "e2e/session-retry")
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

                        if control_envelope.protocol == "e2e/session-reset" {
                            let from_for_reset = from.clone();
                            match with_locked_config_transaction(|mut config| async move {
                                let cleared = clear_peer_sessions(&mut config, &from_for_reset);
                                Ok((cleared, config))
                            })
                            .await
                            {
                                Ok((cleared, next_config)) => {
                                    state_guard.config = next_config;
                                    if cleared > 0 {
                                        eprintln!(
                                            "E2E session reset by peer {} ({} session(s) cleared)",
                                            from, cleared
                                        );
                                    }
                                }
                                Err(err) => {
                                    eprintln!(
                                        "Failed to persist session reset from {} on {}: {}",
                                        from, relay_url, err,
                                    );
                                }
                            }
                            continue;
                        }

                        let payload = control_envelope.payload.as_object();
                        let retry_message_id = payload
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

                        let Some(retry_message_id) = retry_message_id else {
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

                        let Some(original_message) = state_guard
                            .messages
                            .get_message(&retry_message_id, MessageDirection::Outbound)
                        else {
                            eprintln!(
                                "Ignoring session retry {} from {} on {}: outbound message {} not found",
                                message_id, from, relay_url, retry_message_id,
                            );
                            continue;
                        };

                        if original_message.to != from {
                            eprintln!(
                                "Ignoring session retry {} from {} on {}: outbound message {} targets {}",
                                message_id, from, relay_url, retry_message_id, original_message.to,
                            );
                            continue;
                        }

                        let replay_count = original_message
                            .e2e
                            .as_ref()
                            .and_then(|metadata| metadata.retry.as_ref())
                            .map(|retry| retry.replay_count)
                            .unwrap_or(0);
                        state_guard.messages.upsert_e2e_retry(
                            &retry_message_id,
                            MessageDirection::Outbound,
                            E2ERetryMetadata {
                                replay_count,
                                last_requested_at: Some(retry_requested_at),
                                last_replayed_at: None,
                                last_reason: Some(retry_reason.clone()),
                            },
                        );
                        if replay_count > 0 {
                            eprintln!(
                                "Ignoring repeated session retry {} from {} on {} for message {}",
                                message_id, from, relay_url, retry_message_id,
                            );
                            continue;
                        }

                        let application_envelope: Envelope = match serde_json::from_value(
                            original_message.envelope.clone(),
                        ) {
                            Ok(envelope) => envelope,
                            Err(err) => {
                                eprintln!(
                                    "Ignoring session retry {} from {} on {}: failed to parse outbound message {}: {}",
                                    message_id, from, relay_url, retry_message_id, err,
                                );
                                continue;
                            }
                        };
                        let Some(relay_sender) = state_guard.relay_sender.clone() else {
                            eprintln!(
                                "Ignoring session retry {} from {} on {}: relay sender unavailable",
                                message_id, from, relay_url,
                            );
                            continue;
                        };

                        let relay_url_for_retry = relay_url.clone();
                        let from_for_retry = from.clone();
                        let retry_message_id_for_send = retry_message_id.clone();
                        let application_envelope_for_send = application_envelope.clone();
                        let replay_result =
                            with_local_e2e_state_transaction(|mut config| async move {
                                let relay_identity = config
                                    .identity
                                    .as_ref()
                                    .ok_or_else(|| anyhow::anyhow!("No identity found"))?
                                    .clone();
                                let keypair = KeyPair::from_hex(&relay_identity.private_key)?;
                                let _ = clear_peer_sessions(&mut config, &from_for_retry);
                                let invite_token = resolve_relay_invite_token(None, Some(&config));
                                let mut query_session = connect_query_session(
                                    &relay_url_for_retry,
                                    invite_token.as_deref(),
                                )
                                .await?;
                                let prepared = prepare_encrypted_sends_with_session(
                                    &mut query_session,
                                    &config,
                                    &keypair,
                                    application_envelope_for_send.clone(),
                                )
                                .await?;
                                let _ = query_session.goodbye().await;
                                let next_config = prepared.config.clone();
                                Ok((prepared, next_config))
                            })
                            .await;

                        let (prepared, next_config) = match replay_result {
                            Ok(result) => result,
                            Err(err) => {
                                eprintln!(
                                    "Failed to replay outbound message {} after session retry from {} on {}: {}",
                                    retry_message_id, from, relay_url, err,
                                );
                                continue;
                            }
                        };
                        state_guard.config = next_config;

                        let recorded_at = now_ms();
                        state_guard.messages.upsert_e2e_retry(
                            &retry_message_id_for_send,
                            MessageDirection::Outbound,
                            E2ERetryMetadata {
                                replay_count: replay_count + 1,
                                last_requested_at: Some(retry_requested_at),
                                last_replayed_at: Some(recorded_at),
                                last_reason: Some(retry_reason.clone()),
                            },
                        );

                        let send_batches = prepared
                            .targets
                            .iter()
                            .map(|target| {
                                (
                                    target.outer_envelope_bytes.clone(),
                                    E2EDeliveryMetadata {
                                        transport: target.transport.clone(),
                                        sender_device_id: target.sender_device_id.clone(),
                                        receiver_device_id: target.recipient_device_id.clone(),
                                        session_id: target.session_id.clone(),
                                        state: E2EDeliveryState::Sent,
                                        recorded_at,
                                        used_skipped_message_key: None,
                                        error: None,
                                    },
                                )
                            })
                            .collect::<Vec<_>>();

                        drop(state_guard);
                        for (envelope_bytes, delivery) in send_batches {
                            let (response_tx, response_rx) = oneshot::channel();
                            if relay_sender
                                .send(RelayWorkerCommand::SendEnvelope {
                                    to: from.clone(),
                                    envelope_bytes,
                                    response: response_tx,
                                })
                                .await
                                .is_err()
                            {
                                let mut state_guard = state.write().await;
                                state_guard.messages.upsert_e2e_delivery(
                                    &retry_message_id_for_send,
                                    MessageDirection::Outbound,
                                    E2EDeliveryMetadata {
                                        error: Some("Failed to reach relay worker".to_string()),
                                        state: E2EDeliveryState::Failed,
                                        recorded_at: now_ms(),
                                        ..delivery.clone()
                                    },
                                );
                                eprintln!(
                                    "Failed to replay outbound message {} after session retry from {} on {}: relay worker unavailable",
                                    retry_message_id_for_send, from, relay_url,
                                );
                                continue;
                            }

                            let send_result = response_rx.await;
                            let mut state_guard = state.write().await;
                            match send_result {
                                Ok(Ok(())) => {
                                    state_guard.messages.upsert_e2e_delivery(
                                        &retry_message_id_for_send,
                                        MessageDirection::Outbound,
                                        delivery,
                                    );
                                }
                                Ok(Err(err)) => {
                                    state_guard.messages.upsert_e2e_delivery(
                                        &retry_message_id_for_send,
                                        MessageDirection::Outbound,
                                        E2EDeliveryMetadata {
                                            error: Some(err.to_string()),
                                            state: E2EDeliveryState::Failed,
                                            recorded_at: now_ms(),
                                            ..delivery
                                        },
                                    );
                                    eprintln!(
                                        "Failed to replay outbound message {} after session retry from {} on {}: {}",
                                        retry_message_id_for_send, from, relay_url, err,
                                    );
                                }
                                Err(err) => {
                                    state_guard.messages.upsert_e2e_delivery(
                                        &retry_message_id_for_send,
                                        MessageDirection::Outbound,
                                        E2EDeliveryMetadata {
                                            error: Some(err.to_string()),
                                            state: E2EDeliveryState::Failed,
                                            recorded_at: now_ms(),
                                            ..delivery
                                        },
                                    );
                                }
                            }
                        }
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

                    if let Ok(payload) = serde_json::from_value::<EncryptedApplicationEnvelopePayload>(
                        transport_envelope.payload.clone(),
                    ) {
                        if let Ok(DecodedEncryptedApplicationMessage::PreKey(message)) =
                            decode_encrypted_application_envelope_payload(&payload)
                        {
                            let invite_token =
                                resolve_relay_invite_token(None, Some(&state_guard.config));
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
                        Ok((decrypted, next_config)) => {
                            state_guard.config = next_config;
                            decrypted
                        }
                        Err(err) => {
                            eprintln!(
                                "E2E decrypt failed for {} from {}: {}",
                                message_id, from, err
                            );

                            let my_did = state_guard
                                .config
                                .identity
                                .as_ref()
                                .map(|i| i.did.clone())
                                .unwrap_or_default();
                            let from_for_failure = from.clone();
                            match with_locked_config_transaction(|mut config| async move {
                                let cleared = clear_peer_sessions(&mut config, &from_for_failure);
                                Ok((cleared, config))
                            })
                            .await
                            {
                                Ok((_, next_config)) => {
                                    state_guard.config = next_config;
                                }
                                Err(persist_err) => {
                                    eprintln!(
                                        "Failed to clear stale E2E session for {} after decrypt failure on {}: {}",
                                        from, relay_url, persist_err,
                                    );
                                }
                            }

                            if let Some(sender) = &state_guard.relay_sender {
                                let retry_envelope = build_session_retry_envelope(
                                    &state_guard.keypair,
                                    &my_did,
                                    &from,
                                    &transport_message_id,
                                    "decrypt-failed",
                                    "session",
                                    received_at,
                                    transport_thread_id,
                                );
                                if let Ok(envelope_bytes) = encode_envelope_bytes(&retry_envelope) {
                                    let (response_tx, _response_rx) = oneshot::channel();
                                    let _ = sender
                                        .send(RelayWorkerCommand::SendEnvelope {
                                            to: from.clone(),
                                            envelope_bytes,
                                            response: response_tx,
                                        })
                                        .await;
                                }
                            }

                            // 2) Store failed message in inbox so user knows what happened
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
                                        "hint": "Session cleared. Sender was asked to replay the message once."
                                    },
                                    "timestamp": received_at,
                                }),
                                timestamp: received_at,
                                thread_id: None,
                                read: false,
                                direction: MessageDirection::Inbound,
                                e2e: Some(StoredMessageE2EMetadata {
                                    deliveries: vec![E2EDeliveryMetadata {
                                        transport: "unknown".into(),
                                        sender_device_id: "unknown".into(),
                                        receiver_device_id: state_guard
                                            .config
                                            .e2e
                                            .as_ref()
                                            .map(|e| e.current_device_id.clone())
                                            .unwrap_or_default(),
                                        session_id: "unknown".into(),
                                        state: E2EDeliveryState::Failed,
                                        recorded_at: received_at,
                                        used_skipped_message_key: None,
                                        error: Some(err.to_string()),
                                    }],
                                    retry: None,
                                }),
                            };
                            state_guard.messages.store(failed_msg);
                            continue;
                        }
                    };

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
            "mark_read" => handle_mark_read(params, state).await,
            "send" => handle_send(params, state).await,
            "discover" => handle_discover(params, state).await,
            "peers" => handle_peers(params, state).await,
            "sessions" => handle_sessions(params, state).await,
            "session_messages" => handle_session_messages(params, state).await,
            "trust_score" => handle_trust_score(params, state).await,
            "endorsements" | "query_endorsements" => handle_endorsements(params, state).await,
            "block_agent" => handle_block_agent(params, state).await,
            "allowlist" => handle_allowlist(params, state).await,
            "query-card" => handle_query_card(params, state).await,
            "reload-e2e" => handle_reload_e2e(state).await,
            "e2e-reset-notify" => handle_e2e_reset_notify(params, state).await,
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
    let state_guard = state.write().await;
    let limit = json_u64(
        params
            .get("limit")
            .or_else(|| params.get("pagination").and_then(|p| p.get("limit"))),
    )
    .unwrap_or(20) as usize;
    let unread = params
        .get("unread")
        .or_else(|| params.get("filter").and_then(|f| f.get("unread")))
        .or_else(|| params.get("filter").and_then(|f| f.get("unreadOnly")))
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

async fn handle_mark_read(params: Value, state: Arc<RwLock<DaemonState>>) -> Result<Value> {
    let message_id = params
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Missing 'id' field"))?;

    let mut state_guard = state.write().await;
    let marked = state_guard.messages.mark_read(message_id);

    Ok(json!({ "marked": marked }))
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
                vec![(bytes, None)],
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
                &state_guard.keypair,
            )?;
            let relay_url = state_guard.relay_runtime.relay_url.clone();
            let identity_for_send = identity.clone();
            let envelope_for_send = envelope.clone();
            let (prepared, next_config) = with_local_e2e_state_transaction(|config| async move {
                let keypair = KeyPair::from_hex(&identity_for_send.private_key)?;
                let invite_token = resolve_relay_invite_token(None, Some(&config));
                let mut query_session =
                    connect_query_session(&relay_url, invite_token.as_deref()).await?;
                let prepared = prepare_encrypted_sends_with_session(
                    &mut query_session,
                    &config,
                    &keypair,
                    envelope_for_send.clone(),
                )
                .await?;
                let _ = query_session.goodbye().await;
                let next_config = prepared.config.clone();
                Ok((prepared, next_config))
            })
            .await?;
            state_guard.config = next_config;
            let envelope_json = serde_json::to_value(&prepared.application_envelope)?;
            let initial_deliveries = prepared
                .targets
                .iter()
                .map(|target| E2EDeliveryMetadata {
                    transport: target.transport.clone(),
                    sender_device_id: target.sender_device_id.clone(),
                    receiver_device_id: target.recipient_device_id.clone(),
                    session_id: target.session_id.clone(),
                    state: E2EDeliveryState::Pending,
                    recorded_at: now_ms(),
                    used_skipped_message_key: None,
                    error: None,
                })
                .collect::<Vec<_>>();
            let send_batches = prepared
                .targets
                .iter()
                .zip(initial_deliveries.iter())
                .map(|(target, delivery)| {
                    (target.outer_envelope_bytes.clone(), Some(delivery.clone()))
                })
                .collect::<Vec<_>>();

            (
                prepared.application_envelope.id.clone(),
                prepared.application_envelope.thread_id.clone(),
                envelope_json,
                send_batches,
                Some(StoredMessageE2EMetadata {
                    deliveries: initial_deliveries,
                    retry: None,
                }),
            )
        };

    state_guard.messages.store(StoredMessage {
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

    for (envelope_bytes, delivery) in send_batches {
        let (response_tx, response_rx) = oneshot::channel();
        relay_sender
            .send(RelayWorkerCommand::SendEnvelope {
                to: to.clone(),
                envelope_bytes,
                response: response_tx,
            })
            .await
            .context("Failed to reach relay worker")?;

        match response_rx
            .await
            .context("Relay worker dropped send response")?
        {
            Ok(()) => {
                if let Some(mut delivery) = delivery {
                    delivery.state = E2EDeliveryState::Sent;
                    delivery.recorded_at = now_ms();
                    state_guard.messages.upsert_e2e_delivery(
                        &message_id,
                        MessageDirection::Outbound,
                        delivery,
                    );
                }
            }
            Err(error) => {
                if let Some(mut delivery) = delivery {
                    delivery.state = E2EDeliveryState::Failed;
                    delivery.recorded_at = now_ms();
                    delivery.error = Some(error.to_string());
                    state_guard.messages.upsert_e2e_delivery(
                        &message_id,
                        MessageDirection::Outbound,
                        delivery,
                    );
                }
                return Err(error).context("Relay send failed");
            }
        }
    }

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
        merge_cli_fields_before_save(&mut state_guard.config);
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
    let fresh_config = load_config()?;
    let mut state_guard = state.write().await;
    state_guard.config.e2e = fresh_config.e2e;
    Ok(json!({ "status": "reloaded" }))
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

    let (relay_sender, from_did, encoded_resets) = {
        let state_guard = state.read().await;
        if !state_guard.relay_runtime.connected {
            anyhow::bail!("Not connected to any relay");
        }
        let relay_sender = state_guard
            .relay_sender
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Not connected to relay"))?;
        let from_did = state_guard
            .config
            .identity
            .as_ref()
            .map(|identity| identity.did.clone())
            .ok_or_else(|| anyhow::anyhow!("No identity found"))?;

        let mut encoded_resets = Vec::with_capacity(deduped_peers.len());
        for peer_did in &deduped_peers {
            let envelope = build_session_reset_envelope(
                &state_guard.keypair,
                &from_did,
                peer_did,
                "manual-reset",
                now_ms(),
            );
            encoded_resets.push((peer_did.clone(), encode_envelope_bytes(&envelope)?));
        }

        (relay_sender, from_did, encoded_resets)
    };

    let mut notified = Vec::new();
    let mut failed = Vec::new();

    for (peer_did, envelope_bytes) in encoded_resets {
        let (response_tx, response_rx) = oneshot::channel();
        match relay_sender
            .send(RelayWorkerCommand::SendEnvelope {
                to: peer_did.clone(),
                envelope_bytes,
                response: response_tx,
            })
            .await
        {
            Ok(()) => match response_rx.await {
                Ok(Ok(())) => notified.push(peer_did),
                Ok(Err(error)) => failed.push(json!({
                    "peer": peer_did,
                    "error": error.to_string(),
                })),
                Err(error) => failed.push(json!({
                    "peer": peer_did,
                    "error": error.to_string(),
                })),
            },
            Err(error) => failed.push(json!({
                "peer": peer_did,
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
        build_session_reset_envelope, build_session_retry_envelope, encode_envelope_bytes,
        handle_e2e_reset_notify, DaemonState, DEFAULT_JS_DAEMON_SOCKET, DEFAULT_RS_DAEMON_SOCKET,
    };
    use crate::config::{Config, IdentityConfig};
    use crate::identity::KeyPair;
    use quadra_a_runtime::inbox::parse_envelope_value;
    use quadra_a_runtime::relay_worker::RelayWorkerCommand;
    use quadra_a_runtime::session_manager::ManagedRelayState;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::{mpsc, RwLock};

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
        let envelope =
            build_session_reset_envelope(&keypair, &did, "did:agent:zPeer", "decrypt-failed", 123);

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
            keypair,
            relay_runtime,
            relay_sender: Some(relay_tx),
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
                let _ = response.send(Ok(()));
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
    }
}
