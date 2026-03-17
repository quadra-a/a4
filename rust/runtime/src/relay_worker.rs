use anyhow::Result;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep, Duration};

use quadra_a_core::config::{IdentityConfig, ReachabilityMode};
use quadra_a_core::e2e::PublishedPreKeyBundle;
use quadra_a_core::identity::KeyPair;
use quadra_a_core::protocol::AgentCard;

use crate::query::discover_relay_providers;
use crate::relay::RelaySession;
use crate::session_manager::ManagedRelayState;

pub const DEFAULT_RELAY_DISCOVERY_CAPABILITY: &str = "relay/message-routing";
pub const DEFAULT_RELAY_MAINTENANCE_INTERVAL_SECS: u64 = 60;
pub const DEFAULT_RELAY_RECONNECT_DELAY_SECS: u64 = 5;
pub const DEFAULT_RELAY_PING_INTERVAL_SECS: u64 = 30;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub enum RelayWorkerCommand {
    SendEnvelope {
        to: String,
        envelope_bytes: Vec<u8>,
        response: oneshot::Sender<Result<RelaySendOutcome>>,
    },
    Stop,
}

#[derive(Clone, Debug)]
pub struct RelaySendOutcome {
    pub relay_message_id: String,
    pub status: String,
    pub reported_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RelayWorkerEvent {
    Connected {
        relay_url: String,
        connected_at: u64,
    },
    Disconnected {
        relay_url: String,
        disconnected_at: u64,
    },
    FailureRecorded {
        relay_url: String,
        error: String,
        failed_at: u64,
    },
    FailureCleared {
        relay_url: String,
    },
    RelayPoolUpdated {
        relay_url: String,
        discovered_relays: Vec<String>,
        discovered_at: u64,
    },
    EnvelopeReceived {
        relay_url: String,
        message_id: String,
        from: String,
        envelope_bytes: Vec<u8>,
        received_at: u64,
    },
    DeliveryReported {
        relay_url: String,
        message_id: String,
        status: String,
        received_at: u64,
    },
}

pub struct RelayWorkerOptions {
    pub identity: IdentityConfig,
    pub card: AgentCard,
    pub invite_token: Option<String>,
    pub prekey_bundles: Vec<PublishedPreKeyBundle>,
    pub should_publish: bool,
    pub relay_discovery_capability: String,
    pub maintenance_interval: Duration,
    pub reconnect_delay: Duration,
    pub ping_interval: Duration,
}

impl RelayWorkerOptions {
    pub fn new(identity: IdentityConfig, card: AgentCard, invite_token: Option<String>) -> Self {
        Self {
            identity,
            card,
            invite_token,
            prekey_bundles: Vec::new(),
            should_publish: false,
            relay_discovery_capability: DEFAULT_RELAY_DISCOVERY_CAPABILITY.to_string(),
            maintenance_interval: Duration::from_secs(DEFAULT_RELAY_MAINTENANCE_INTERVAL_SECS),
            reconnect_delay: Duration::from_secs(DEFAULT_RELAY_RECONNECT_DELAY_SECS),
            ping_interval: Duration::from_secs(DEFAULT_RELAY_PING_INTERVAL_SECS),
        }
    }
}

async fn emit_event(event_tx: &mpsc::Sender<RelayWorkerEvent>, event: RelayWorkerEvent) {
    let _ = event_tx.send(event).await;
}

async fn record_failure(
    relay_state: &mut ManagedRelayState,
    event_tx: &mpsc::Sender<RelayWorkerEvent>,
    relay_url: &str,
    error: String,
) {
    let failed_at = now_ms();
    relay_state.record_failure(relay_url, error.clone(), failed_at);
    emit_event(
        event_tx,
        RelayWorkerEvent::FailureRecorded {
            relay_url: relay_url.to_string(),
            error,
            failed_at,
        },
    )
    .await;
}

async fn clear_failure(
    relay_state: &mut ManagedRelayState,
    event_tx: &mpsc::Sender<RelayWorkerEvent>,
    relay_url: &str,
) {
    relay_state.clear_failure(relay_url);
    emit_event(
        event_tx,
        RelayWorkerEvent::FailureCleared {
            relay_url: relay_url.to_string(),
        },
    )
    .await;
}

async fn connect_managed_session(
    relay_state: &mut ManagedRelayState,
    options: &RelayWorkerOptions,
    event_tx: &mpsc::Sender<RelayWorkerEvent>,
) -> Result<(RelaySession, String)> {
    let keypair = KeyPair::from_hex(&options.identity.private_key)?;
    let relay_urls = relay_state.candidates();

    let mut errors = Vec::new();
    for relay_url in relay_urls {
        match RelaySession::connect_with_invite_token(
            &relay_url,
            &options.identity.did,
            &options.card,
            &keypair,
            options.invite_token.as_deref(),
        )
        .await
        {
            Ok(mut session) => {
                clear_failure(relay_state, event_tx, &relay_url).await;
                if !options.prekey_bundles.is_empty() {
                    if let Err(error) = session
                        .publish_prekey_bundles(&options.prekey_bundles)
                        .await
                    {
                        record_failure(
                            relay_state,
                            event_tx,
                            &relay_url,
                            format!("pre-key publish failed: {}", error),
                        )
                        .await;
                        let _ = session.goodbye().await;
                        errors.push(format!("{}: pre-key publish failed: {}", relay_url, error));
                        continue;
                    }
                }

                if options.should_publish {
                    if let Err(error) = session.publish_card().await {
                        record_failure(
                            relay_state,
                            event_tx,
                            &relay_url,
                            format!("publish failed: {}", error),
                        )
                        .await;
                        let _ = session.goodbye().await;
                        errors.push(format!("{}: publish failed: {}", relay_url, error));
                        continue;
                    }
                }

                let connected_at = now_ms();
                relay_state.mark_connected(&relay_url, connected_at);
                emit_event(
                    event_tx,
                    RelayWorkerEvent::Connected {
                        relay_url: relay_url.clone(),
                        connected_at,
                    },
                )
                .await;
                return Ok((session, relay_url));
            }
            Err(error) => {
                record_failure(relay_state, event_tx, &relay_url, error.to_string()).await;
                errors.push(format!("{}: {}", relay_url, error));
            }
        }
    }

    relay_state.mark_disconnected();
    anyhow::bail!(
        "Failed to connect to any relay: {}",
        if errors.is_empty() {
            "no configured relays".to_string()
        } else {
            errors.join(" | ")
        }
    )
}

async fn maintain_relay_set(
    relay_state: &mut ManagedRelayState,
    relay_url: &str,
    options: &RelayWorkerOptions,
    event_tx: &mpsc::Sender<RelayWorkerEvent>,
) -> Result<()> {
    if !matches!(
        relay_state.reachability_policy.mode,
        ReachabilityMode::Adaptive
    ) || !relay_state.reachability_policy.auto_discover_providers
    {
        return Ok(());
    }

    let limit = ((relay_state.reachability_policy.target_provider_count as usize).max(1) * 4)
        .max(10) as u32;
    let discovered_relays = discover_relay_providers(
        relay_url,
        options.invite_token.as_deref(),
        &options.relay_discovery_capability,
        limit,
    )
    .await?;
    let discovered_at = now_ms();
    relay_state.note_discovery(discovered_relays.clone(), discovered_at);
    emit_event(
        event_tx,
        RelayWorkerEvent::RelayPoolUpdated {
            relay_url: relay_url.to_string(),
            discovered_relays,
            discovered_at,
        },
    )
    .await;
    Ok(())
}

enum RelaySendError {
    Recoverable(anyhow::Error),
    Fatal(anyhow::Error),
}

impl RelaySendError {
    fn into_anyhow(self) -> anyhow::Error {
        match self {
            Self::Recoverable(error) | Self::Fatal(error) => error,
        }
    }

    fn is_fatal(&self) -> bool {
        matches!(self, Self::Fatal(_))
    }
}

async fn wait_for_send_acceptance(
    session: &mut RelaySession,
    relay_url: &str,
    event_tx: &mpsc::Sender<RelayWorkerEvent>,
) -> std::result::Result<RelaySendOutcome, RelaySendError> {
    loop {
        let (message_id, status) = session
            .wait_delivery_report_with_id()
            .await
            .map_err(RelaySendError::Fatal)?;
        let reported_at = now_ms();
        match status.as_str() {
            "accepted" => {
                return Ok(RelaySendOutcome {
                    relay_message_id: message_id,
                    status,
                    reported_at,
                });
            }
            "queue_full" => {
                return Err(RelaySendError::Recoverable(anyhow::anyhow!(
                    "Relay queue full for recipient"
                )));
            }
            "unknown_recipient" => {
                return Err(RelaySendError::Recoverable(anyhow::anyhow!(
                    "Recipient not found on relay"
                )));
            }
            "expired" => {
                return Err(RelaySendError::Recoverable(anyhow::anyhow!(
                    "Relay delivery expired before acceptance"
                )));
            }
            "delivered" => {
                emit_event(
                    event_tx,
                    RelayWorkerEvent::DeliveryReported {
                        relay_url: relay_url.to_string(),
                        message_id,
                        status,
                        received_at: reported_at,
                    },
                )
                .await;
            }
            other => {
                return Err(RelaySendError::Fatal(anyhow::anyhow!(
                    "Unexpected relay delivery report while waiting for acceptance: {}",
                    other
                )));
            }
        }
    }
}

pub async fn run_relay_worker(
    mut relay_state: ManagedRelayState,
    mut relay_rx: mpsc::Receiver<RelayWorkerCommand>,
    event_tx: mpsc::Sender<RelayWorkerEvent>,
    options: RelayWorkerOptions,
) {
    let mut maintenance_interval = tokio::time::interval(options.maintenance_interval);
    maintenance_interval.tick().await;

    'worker: loop {
        let (mut session, relay_url) = match connect_managed_session(
            &mut relay_state,
            &options,
            &event_tx,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                tokio::select! {
                    maybe_command = relay_rx.recv() => {
                        match maybe_command {
                            Some(RelayWorkerCommand::Stop) | None => break 'worker,
                            Some(RelayWorkerCommand::SendEnvelope { response, .. }) => {
                                let _ = response.send(Err(anyhow::anyhow!("Not connected to any relay")));
                            }
                        }
                    }
                    _ = sleep(options.reconnect_delay) => {}
                }
                let error_message = error.to_string();
                if !error_message.is_empty() {
                    eprintln!("Relay connect retry pending: {}", error_message);
                }
                continue;
            }
        };

        let mut ping_interval = tokio::time::interval(options.ping_interval);
        ping_interval.tick().await;

        loop {
            tokio::select! {
                maybe_command = relay_rx.recv() => {
                    match maybe_command {
                        Some(RelayWorkerCommand::SendEnvelope { to, envelope_bytes, response }) => {
                            let result = match session.send_envelope(&to, envelope_bytes).await {
                                Ok(()) => wait_for_send_acceptance(&mut session, &relay_url, &event_tx)
                                    .await
                                    .map_err(|error| {
                                        let should_disconnect = error.is_fatal();
                                        (error.into_anyhow(), should_disconnect)
                                    }),
                                Err(error) => Err((error, true)),
                            };
                            if let Err((error, true)) = &result {
                                record_failure(&mut relay_state, &event_tx, &relay_url, error.to_string()).await;
                            }
                            let should_disconnect = result
                                .as_ref()
                                .err()
                                .map(|(_, should_disconnect)| *should_disconnect)
                                .unwrap_or(false);
                            let response_result = result.map_err(|(error, _)| error);
                            let _ = response.send(response_result);
                            if should_disconnect {
                                break;
                            }
                        }
                        Some(RelayWorkerCommand::Stop) | None => break 'worker,
                    }
                }
                result = session.next_deliver() => {
                    match result {
                        Ok((message_id, from, envelope_bytes)) => {
                            let received_at = now_ms();
                            if let Some(status) = from.strip_prefix("__delivery_report:") {
                                emit_event(
                                    &event_tx,
                                    RelayWorkerEvent::DeliveryReported {
                                        relay_url: relay_url.clone(),
                                        message_id,
                                        status: status.to_string(),
                                        received_at,
                                    },
                                )
                                .await;
                                continue;
                            }

                            emit_event(
                                &event_tx,
                                RelayWorkerEvent::EnvelopeReceived {
                                    relay_url: relay_url.clone(),
                                    message_id,
                                    from,
                                    envelope_bytes,
                                    received_at,
                                },
                            )
                            .await;
                        }
                        Err(error) => {
                            record_failure(&mut relay_state, &event_tx, &relay_url, error.to_string()).await;
                            break;
                        }
                    }
                }
                _ = ping_interval.tick() => {
                    if let Err(error) = session.ping().await {
                        record_failure(&mut relay_state, &event_tx, &relay_url, error.to_string()).await;
                        break;
                    }
                }
                _ = maintenance_interval.tick() => {
                    if let Err(error) = maintain_relay_set(&mut relay_state, &relay_url, &options, &event_tx).await {
                        eprintln!("Relay maintenance skipped on {}: {}", relay_url, error);
                    }
                }
            }
        }

        let _ = session.goodbye().await;
        relay_state.mark_disconnected();
        emit_event(
            &event_tx,
            RelayWorkerEvent::Disconnected {
                relay_url: relay_url.clone(),
                disconnected_at: now_ms(),
            },
        )
        .await;

        tokio::select! {
            maybe_command = relay_rx.recv() => {
                match maybe_command {
                    Some(RelayWorkerCommand::Stop) | None => break 'worker,
                    Some(RelayWorkerCommand::SendEnvelope { response, .. }) => {
                        let _ = response.send(Err(anyhow::anyhow!("Not connected to any relay")));
                    }
                }
            }
            _ = sleep(options.reconnect_delay) => {}
        }
    }

    relay_state.mark_disconnected();
    emit_event(
        &event_tx,
        RelayWorkerEvent::Disconnected {
            relay_url: relay_state.relay_url.clone(),
            disconnected_at: now_ms(),
        },
    )
    .await;
}
