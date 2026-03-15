use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::commands::message_lifecycle::{
    envelope_payload, MessageOutcome, MessageOutcomeKind, MessageOutcomeTracker,
};
use crate::config::{load_config, save_config};
use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::identity::KeyPair;
use crate::protocol::{cbor_decode_value, Envelope, EnvelopeUnsigned};
use crate::relay::{connect_first_available, RelaySession};
use crate::ui::LlmFormatter;
use quadra_a_core::e2e::{ensure_local_e2e_config, E2E_APPLICATION_ENVELOPE_PROTOCOL};
use quadra_a_runtime::e2e_receive::prepare_encrypted_receive;
use quadra_a_runtime::e2e_send::prepare_encrypted_sends_with_session;

pub struct TellOptions {
    pub target: String,
    pub message: Option<String>,
    pub payload: Option<String>,
    pub protocol: String,
    pub protocol_explicit: bool,
    pub reply_to: Option<String>,
    pub thread: Option<String>,
    pub new_thread: bool,
    pub wait: Option<Option<u64>>,
    pub relay: Option<String>,
    pub json: bool,
    pub human: bool,
}

pub(crate) struct EnvelopeThreading {
    pub reply_to: Option<String>,
    pub thread_id: Option<String>,
}

impl EnvelopeThreading {
    pub(crate) fn new(reply_to: Option<String>, thread_id: Option<String>) -> Self {
        Self { reply_to, thread_id }
    }
}

struct WaitOutcomeDisplay<'a> {
    message_id: &'a str,
    recipient_did: &'a str,
    protocol: &'a str,
    payload: &'a Value,
    thread_id: Option<&'a str>,
    timeout_secs: u64,
    timeout_hint: Option<&'a str>,
}

pub async fn run(opts: TellOptions) -> Result<()> {
    let mut config = load_config()?;
    ensure_local_e2e_config(&mut config)?;

    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    let daemon = DaemonClient::new(&daemon_socket_path());
    let daemon_status = daemon.send_command("status", json!({})).await.ok();
    let resolution_relay = opts.relay.as_deref().or_else(|| {
        daemon_status
            .as_ref()
            .and_then(|status| status.get("relay").and_then(|value| value.as_str()))
    });
    let resolved_target =
        crate::commands::target_resolution::resolve_target(&opts.target, &config, resolution_relay)
            .await?;
    let recipient_did = resolved_target.did.clone();

    // Auto-detect protocol from Agent Card if not explicitly set
    let effective_protocol = if !opts.protocol_explicit && opts.protocol == "/agent/msg/1.0.0" {
        if let Some(card) = &resolved_target.agent {
            extract_primary_protocol(card).unwrap_or_else(|| opts.protocol.clone())
        } else if daemon_status.is_some() {
            // Try querying the card via daemon
            match daemon.send_command("query-card", json!({"did": &recipient_did})).await {
                Ok(response) => {
                    if let Some(card_value) = response.get("card") {
                        if let Ok(card) = serde_json::from_value::<crate::protocol::AgentCard>(card_value.clone()) {
                            extract_primary_protocol(&card).unwrap_or_else(|| opts.protocol.clone())
                        } else {
                            opts.protocol.clone()
                        }
                    } else {
                        opts.protocol.clone()
                    }
                }
                Err(_) => opts.protocol.clone(),
            }
        } else {
            opts.protocol.clone()
        }
    } else {
        opts.protocol.clone()
    };

    let payload: Value = if let Some(payload) = &opts.payload {
        serde_json::from_str(payload).unwrap_or_else(|_| json!({ "text": payload }))
    } else if let Some(message) = &opts.message {
        if effective_protocol == "/shell/exec/1.0.0" {
            json!({ "command": message })
        } else {
            json!({ "text": message })
        }
    } else {
        bail!("Provide a message or --payload");
    };

    let thread_id = if opts.new_thread {
        Some(generate_thread_id())
    } else {
        opts.thread.clone()
    };

    let wait_timeout_secs = match opts.wait {
        Some(Some(secs)) => Some(secs),
        Some(None) => Some(30),
        None => None,
    };

    if resolved_target.matched_by == "search" && opts.human {
        if let Some(agent) = resolved_target.agent.as_ref() {
            println!(
                "Resolved {} to {} ({})",
                opts.target, agent.name, recipient_did
            );
        } else {
            println!("Resolved {} to {}", opts.target, recipient_did);
        }
    }

    if daemon_status.is_some() {
        let mut params = json!({
            "to": recipient_did,
            "type": "message",
            "protocol": effective_protocol,
            "payload": payload,
        });

        if let Some(reply_to) = &opts.reply_to {
            params["replyTo"] = json!(reply_to);
        }

        if let Some(thread_id) = &thread_id {
            params["threadId"] = json!(thread_id);
        }

        match daemon.send_command("send", params).await {
            Ok(response) => {
                let message_id = response
                    .get("id")
                    .or_else(|| response.get("messageId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");

                if let Some(timeout_secs) = wait_timeout_secs {
                    if opts.human {
                        println!("Message ID: {}", message_id);
                        println!(
                            "Message sent, waiting for result ({}s timeout)...",
                            timeout_secs
                        );
                    }

                    let outcome =
                        wait_for_message_outcome_via_daemon(&daemon, message_id, timeout_secs)
                            .await?;

                    if opts.json {
                        println!("{}", serde_json::to_string_pretty(&json!({
                            "messageId": message_id,
                            "to": recipient_did,
                            "protocol": effective_protocol,
                            "payload": payload,
                            "threadId": thread_id,
                            "waitSeconds": timeout_secs,
                            "result": outcome.as_ref().map(|o| json!({
                                "kind": o.kind.as_str(),
                                "status": o.status,
                                "jobId": o.job_id,
                                "terminal": o.terminal,
                            })),
                            "timedOut": outcome.is_none(),
                        }))?);
                        if outcome.is_none() { std::process::exit(1); }
                        return Ok(());
                    }

                    let trace_hint = format!("agent trace {}", message_id);
                    render_wait_outcome(
                        opts.human,
                        outcome.as_ref(),
                        WaitOutcomeDisplay {
                            message_id,
                            recipient_did: &recipient_did,
                            protocol: &effective_protocol,
                            payload: &payload,
                            thread_id: thread_id.as_deref(),
                            timeout_secs,
                            timeout_hint: Some(trace_hint.as_str()),
                        },
                    );

                    if outcome.is_none() {
                        std::process::exit(1);
                    }
                } else if opts.json {
                    println!("{}", serde_json::to_string_pretty(&json!({
                        "messageId": message_id,
                        "to": recipient_did,
                        "protocol": effective_protocol,
                        "payload": payload,
                        "threadId": thread_id,
                        "status": "accepted_locally",
                    }))?);
                } else if opts.human {
                    println!("Message accepted locally via daemon ({})", message_id);
                    if let Some(thread_id) = &thread_id {
                        println!("Thread: {}", thread_id);
                    }
                    println!("Trace with: agent trace {}", message_id);
                } else {
                    LlmFormatter::section("Message Sent");
                    LlmFormatter::key_value("Message ID", message_id);
                    LlmFormatter::key_value("To", &recipient_did);
                    LlmFormatter::key_value("Protocol", &effective_protocol);
                    LlmFormatter::key_value("Type", "message");
                    LlmFormatter::key_value("Payload", &payload.to_string());
                    if let Some(thread_id) = &thread_id {
                        LlmFormatter::key_value("Thread ID", thread_id);
                    }
                    LlmFormatter::key_value("Lifecycle", "accepted_locally");
                    LlmFormatter::key_value("Trace Hint", &format!("agent trace {}", message_id));
                    println!();
                }
                return Ok(());
            }
            Err(error) => {
                if opts.json {
                    println!("{}", serde_json::to_string_pretty(&json!({
                        "error": format!("{}", error),
                        "to": recipient_did,
                        "protocol": effective_protocol,
                        "payload": payload,
                        "threadId": thread_id,
                        "status": "send_failed",
                    }))?);
                    std::process::exit(1);
                }
                bail!("Daemon send failed: {}. Stop daemon first for direct relay mode: a4 stop", error);
            }
        }
    }

    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let card = crate::config::build_card(&config, identity)?;
    if opts.human {
        eprintln!("Connecting to configured relays...");
    }

    let (mut session, relay_url) = connect_first_available(
        resolution_relay,
        Some(&config),
        &identity.did,
        &card,
        &keypair,
    )
    .await?;

    if opts.human {
        eprintln!("Connected to relay {}", relay_url);
    }
    let envelope = build_envelope(
        &identity.did,
        &recipient_did,
        "message",
        &effective_protocol,
        payload.clone(),
        EnvelopeThreading {
            reply_to: opts.reply_to.clone(),
            thread_id: thread_id.clone(),
        },
        &keypair,
    )?;
    let prepared =
        prepare_encrypted_sends_with_session(&mut session, &config, &keypair, envelope).await?;
    config = prepared.config.clone();
    save_config(&config)?;

    for target in &prepared.targets {
        session
            .send_envelope(&recipient_did, target.outer_envelope_bytes.clone())
            .await?;
    }

    if let Some(timeout_secs) = wait_timeout_secs {
        if opts.human {
            println!("Message ID: {}", prepared.application_envelope.id);
            println!(
                "Message sent, waiting for result ({}s timeout)...",
                timeout_secs
            );
        }

        let outcome = wait_for_message_outcome_via_relay(
            &mut session,
            &mut config,
            &prepared.application_envelope.id,
            timeout_secs,
        )
        .await?;
        session.goodbye().await?;

        if opts.json {
            println!("{}", serde_json::to_string_pretty(&json!({
                "messageId": prepared.application_envelope.id,
                "to": recipient_did,
                "protocol": effective_protocol,
                "payload": payload,
                "threadId": thread_id,
                "waitSeconds": timeout_secs,
                "result": outcome.as_ref().map(|o| json!({
                    "kind": o.kind.as_str(),
                    "status": o.status,
                    "jobId": o.job_id,
                    "terminal": o.terminal,
                })),
                "timedOut": outcome.is_none(),
            }))?);
            if outcome.is_none() { std::process::exit(1); }
        } else {
            render_wait_outcome(
                opts.human,
                outcome.as_ref(),
                WaitOutcomeDisplay {
                    message_id: &prepared.application_envelope.id,
                    recipient_did: &recipient_did,
                    protocol: &effective_protocol,
                    payload: &payload,
                    thread_id: thread_id.as_deref(),
                    timeout_secs,
                    timeout_hint: Some(
                        "This send used direct relay mode, so daemon-backed trace data is unavailable.",
                    ),
                },
            );

            if outcome.is_none() {
                std::process::exit(1);
            }
        }
    } else {
        let mut final_status = String::from("delivered");
        for _ in 0..prepared.targets.len() {
            match session.wait_delivery_report().await {
                Ok(status) => match status.as_str() {
                    "accepted" => final_status = "accepted".to_string(),
                    "delivered" => {}
                    "queue_full" => bail!("Relay queue full for recipient"),
                    "unknown_recipient" => bail!("Recipient not found on relay"),
                    other => final_status = other.to_string(),
                },
                Err(error) => {
                    if opts.human {
                        eprintln!("Warning: no delivery report received ({})", error);
                    }
                    session.goodbye().await?;
                    return Ok(());
                }
            }
        }
        session.goodbye().await?;

        if opts.json {
            println!("{}", serde_json::to_string_pretty(&json!({
                "messageId": prepared.application_envelope.id,
                "to": recipient_did,
                "protocol": effective_protocol,
                "payload": payload,
                "threadId": thread_id,
                "status": final_status,
                "relayDelivered": final_status == "delivered",
            }))?);
        } else if opts.human {
            match final_status.as_str() {
                "accepted" => {
                    println!("Relay accepted message for delivery");
                    if let Some(thread_id) = &thread_id {
                        println!("Thread: {}", thread_id);
                    }
                    println!("Remote delivery and execution are still unknown until a reply or result arrives.");
                }
                "delivered" => {
                    println!("Relay handoff reported delivered");
                    if let Some(thread_id) = &thread_id {
                        println!("Thread: {}", thread_id);
                    }
                    println!("Remote execution is still unknown until a reply or result arrives.");
                }
                other => println!("Delivery status: {}", other),
            }
        } else {
            LlmFormatter::section("Message Sent");
            LlmFormatter::key_value("Message ID", &prepared.application_envelope.id);
            LlmFormatter::key_value("To", &recipient_did);
            LlmFormatter::key_value("Protocol", &effective_protocol);
            LlmFormatter::key_value("Type", "message");
            LlmFormatter::key_value("Payload", &payload.to_string());
            if let Some(thread_id) = &thread_id {
                LlmFormatter::key_value("Thread ID", thread_id);
            }
            LlmFormatter::key_value(
                "Relay Delivered",
                if final_status == "delivered" {
                    "true"
                } else {
                    "false"
                },
            );
            LlmFormatter::key_value(
                "Relay Accepted",
                if final_status == "accepted" || final_status == "delivered" {
                    "true"
                } else {
                    "false"
                },
            );
            LlmFormatter::key_value("Status", &final_status);
            LlmFormatter::key_value("Execution State", "unknown_without_result");
            println!();
        }
    }

    Ok(())
}

fn generate_thread_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let random = &Uuid::new_v4().to_string().replace('-', "")[..13];
    format!("thread_{}_{}", timestamp, random)
}

pub(crate) fn build_envelope(
    from: &str,
    to: &str,
    msg_type: &str,
    protocol: &str,
    payload: Value,
    threading: EnvelopeThreading,
    keypair: &KeyPair,
) -> Result<Envelope> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let id = format!(
        "msg_{}_{}",
        timestamp,
        &Uuid::new_v4().to_string().replace('-', "")[..13]
    );

    let unsigned = EnvelopeUnsigned {
        id,
        from: from.to_string(),
        to: to.to_string(),
        msg_type: msg_type.to_string(),
        protocol: protocol.to_string(),
        payload,
        timestamp,
        reply_to: threading.reply_to,
        thread_id: threading.thread_id,
        group_id: None,
    };

    Ok(unsigned.sign(keypair))
}

async fn wait_for_message_outcome_via_daemon(
    daemon: &DaemonClient,
    message_id: &str,
    timeout_secs: u64,
) -> Result<Option<MessageOutcome>> {
    use std::collections::HashSet;
    use crate::commands::message_lifecycle::{message_id as get_message_id, sort_messages_by_timestamp};

    let start_time = SystemTime::now();
    let timeout_duration = Duration::from_secs(timeout_secs);
    let mut tracker = MessageOutcomeTracker::new(message_id);
    let mut seen_ids: HashSet<String> = HashSet::new();

    loop {
        if start_time.elapsed().unwrap_or_default() > timeout_duration {
            return Ok(None);
        }

        let inbox_params = json!({
            "limit": 400
        });

        if let Ok(response) = daemon.send_command("inbox", inbox_params).await {
            let messages = response
                .get("messages")
                .and_then(|messages| messages.as_array())
                .map(Vec::as_slice)
                .unwrap_or(&[]);

            // Sort messages by timestamp and process only new ones
            for message in sort_messages_by_timestamp(messages) {
                if let Some(id) = get_message_id(&message) {
                    let id_string = id.to_string();
                    if seen_ids.contains(&id_string) {
                        continue;
                    }
                    seen_ids.insert(id_string);
                }

                if let Some(outcome) = tracker.observe(&message) {
                    if outcome.terminal {
                        return Ok(Some(outcome));
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn wait_for_message_outcome_via_relay(
    session: &mut RelaySession,
    config: &mut crate::config::Config,
    message_id: &str,
    timeout_secs: u64,
) -> Result<Option<MessageOutcome>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut tracker = MessageOutcomeTracker::new(message_id);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }

        let delivered = match tokio::time::timeout(remaining, session.next_deliver()).await {
            Ok(result) => result?,
            Err(_) => return Ok(None),
        };

        let (_relay_message_id, from, envelope_bytes) = delivered;
        if let Some(status) = from.strip_prefix("__delivery_report:") {
            match status {
                "queue_full" => bail!("Relay queue full for recipient"),
                "unknown_recipient" => bail!("Recipient not found on relay"),
                _ => continue,
            }
        }

        let mut envelope = match decode_delivered_envelope(&envelope_bytes) {
            Ok(envelope) => envelope,
            Err(_) => continue,
        };

        if let Some(object) = envelope.as_object_mut() {
            object
                .entry("from".to_string())
                .or_insert_with(|| json!(from));
        }

        // If the envelope is E2E encrypted, decrypt it
        if envelope.get("protocol").and_then(|v| v.as_str()) == Some(E2E_APPLICATION_ENVELOPE_PROTOCOL) {
            let transport_envelope: Envelope = match serde_json::from_value(envelope.clone()) {
                Ok(e) => e,
                Err(err) => {
                    eprintln!("Skipping E2E envelope with invalid structure: {}", err);
                    continue;
                }
            };
            match prepare_encrypted_receive(config, &transport_envelope) {
                Ok(decrypted) => {
                    *config = decrypted.config;
                    if let Err(err) = save_config(config) {
                        eprintln!("Failed to persist E2E state after decryption: {}", err);
                    }
                    envelope = match serde_json::to_value(&decrypted.application_envelope) {
                        Ok(v) => v,
                        Err(err) => {
                            eprintln!("Skipping decrypted envelope due to serialization failure: {}", err);
                            continue;
                        }
                    };
                }
                Err(err) => {
                    eprintln!("Failed to decrypt E2E envelope: {}", err);
                    continue;
                }
            }
        }

        let inbound_message = json!({
            "direction": "inbound",
            "receivedAt": now_ms(),
            "sentAt": Value::Null,
            "envelope": envelope,
        });

        if let Some(outcome) = tracker.observe(&inbound_message) {
            if outcome.terminal {
                return Ok(Some(outcome));
            }
        }
    }
}

fn decode_delivered_envelope(envelope_bytes: &[u8]) -> Result<Value> {
    if let Ok(value) = cbor_decode_value(envelope_bytes) {
        return Ok(value);
    }

    Ok(serde_json::from_slice::<Value>(envelope_bytes)?)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn render_wait_outcome(
    human: bool,
    outcome: Option<&MessageOutcome>,
    display: WaitOutcomeDisplay<'_>,
) {
    if human {
        render_human_wait_outcome(display.timeout_secs, outcome, display.timeout_hint);
        return;
    }

    LlmFormatter::section("Message Sent");
    LlmFormatter::key_value("Message ID", display.message_id);
    LlmFormatter::key_value("To", display.recipient_did);
    LlmFormatter::key_value("Protocol", display.protocol);
    LlmFormatter::key_value("Type", "message");
    LlmFormatter::key_value("Payload", &display.payload.to_string());
    if let Some(thread_id) = display.thread_id {
        LlmFormatter::key_value("Thread ID", thread_id);
    }
    LlmFormatter::key_value("Wait Timeout", &format!("{}s", display.timeout_secs));

    if let Some(outcome) = outcome {
        let payload = outcome_payload(outcome)
            .cloned()
            .unwrap_or_else(|| json!({}));
        LlmFormatter::key_value(
            "Reply Received",
            if outcome.kind == MessageOutcomeKind::Reply {
                "true"
            } else {
                "false"
            },
        );
        LlmFormatter::key_value("Result Received", "true");
        LlmFormatter::key_value("Result Kind", outcome.kind.as_str());
        LlmFormatter::key_value(
            "Result Terminal",
            if outcome.terminal { "true" } else { "false" },
        );
        if let Some(status) = &outcome.status {
            LlmFormatter::key_value("Result Status", status);
        }
        if let Some(job_id) = &outcome.job_id {
            LlmFormatter::key_value("Job ID", job_id);
        }
        if outcome.kind == MessageOutcomeKind::Reply {
            LlmFormatter::key_value("Reply Payload", &payload.to_string());
        }
        LlmFormatter::key_value("Result Payload", &payload.to_string());
    } else {
        LlmFormatter::key_value("Reply Received", "false");
        LlmFormatter::key_value("Result Received", "false");
        LlmFormatter::key_value("Timed Out", "true");
        if let Some(timeout_hint) = display.timeout_hint {
            LlmFormatter::key_value("Trace Hint", timeout_hint);
        }
    }
    println!();
}

fn render_human_wait_outcome(
    timeout_secs: u64,
    outcome: Option<&MessageOutcome>,
    timeout_hint: Option<&str>,
) {
    if let Some(outcome) = outcome {
        println!(
            "{} received:",
            if outcome.kind == MessageOutcomeKind::Reply {
                "Reply"
            } else {
                "Result"
            }
        );
        if let Some(status) = &outcome.status {
            println!("Status: {}", status);
        }
        if let Some(job_id) = &outcome.job_id {
            println!("Job ID: {}", job_id);
        }
        if let Some(payload) = outcome_payload(outcome) {
            if let Some(text) = payload.get("text").and_then(|value| value.as_str()) {
                println!("{}", text);
            } else {
                println!("{}", payload);
            }
        } else {
            println!("{}", json!({}));
        }
        return;
    }

    eprintln!("No result within {}s", timeout_secs);
    eprintln!("Check inbox for late results: a4 inbox --limit 5");
    if let Some(timeout_hint) = timeout_hint {
        eprintln!("{}", timeout_hint);
    }
}

fn outcome_payload(outcome: &MessageOutcome) -> Option<&Value> {
    envelope_payload(&outcome.message)
}

fn extract_primary_protocol(card: &crate::protocol::AgentCard) -> Option<String> {
    // 1) Check capabilities for explicit metadata.protocol
    for capability in &card.capabilities {
        if let Some(metadata) = &capability.metadata {
            if let Some(protocol) = metadata.get("protocol").and_then(|v| v.as_str()) {
                return Some(protocol.to_string());
            }
        }
    }

    // 2) Infer protocol from well-known capability IDs
    for capability in &card.capabilities {
        match capability.id.as_str() {
            "shell/exec" => return Some("/shell/exec/1.0.0".to_string()),
            "gpu/compute" => return Some("/shell/exec/1.0.0".to_string()),
            _ => {}
        }
    }

    None
}
