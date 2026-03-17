use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Read};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::commands::message_lifecycle::{
    envelope_payload, envelope_type, message_id, message_timestamp, protocol, reply_to,
    source_did, MessageOutcome, MessageOutcomeKind, MessageOutcomeTracker,
};
use crate::config::load_config;
use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::e2e_state::with_local_e2e_state_transaction;
use crate::identity::KeyPair;
use crate::protocol::{cbor_decode_value, Envelope, EnvelopeUnsigned};
use crate::relay::{connect_first_available, RelaySession};
use crate::ui::LlmFormatter;
use quadra_a_core::e2e::E2E_APPLICATION_ENVELOPE_PROTOCOL;
use quadra_a_runtime::e2e_receive::prepare_encrypted_receive;
use quadra_a_runtime::e2e_send::prepare_encrypted_sends_with_session;

pub struct TellOptions {
    pub target: String,
    pub message: Option<String>,
    pub body: Option<String>,
    pub body_file: Option<String>,
    pub body_stdin: bool,
    pub body_format: Option<String>,
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

#[derive(Clone, Copy)]
enum TellBodyFormat {
    Text,
    Json,
}

impl TellBodyFormat {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Json => "json",
        }
    }
}

#[derive(Clone, Copy)]
enum ProtocolSelection {
    Explicit,
    Default,
    Auto,
}

impl ProtocolSelection {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Default => "default",
            Self::Auto => "auto",
        }
    }
}

struct ResolvedTellBody {
    format: TellBodyFormat,
    payload: Value,
}

pub(crate) struct EnvelopeThreading {
    pub reply_to: Option<String>,
    pub thread_id: Option<String>,
}

impl EnvelopeThreading {
    pub(crate) fn new(reply_to: Option<String>, thread_id: Option<String>) -> Self {
        Self {
            reply_to,
            thread_id,
        }
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

fn wrap_text_body(protocol: &str, body: &str) -> Value {
    if protocol == "/shell/exec/1.0.0" {
        json!({ "command": body })
    } else {
        json!({ "text": body })
    }
}

fn parse_body_format(body_format: Option<&str>) -> Result<TellBodyFormat> {
    match body_format.map(str::trim) {
        Some("text") => Ok(TellBodyFormat::Text),
        Some("json") => Ok(TellBodyFormat::Json),
        Some(other) => bail!("Body format must be 'text' or 'json', got '{}'", other),
        None => bail!("Body format is required with --body, --body-file, and --body-stdin"),
    }
}

fn read_stdin_body() -> Result<String> {
    let mut body = String::new();
    io::stdin().read_to_string(&mut body)?;
    Ok(body)
}

fn validate_tell_body_input(opts: &TellOptions) -> Result<()> {
    let mut source_count = 0;
    if opts.message.is_some() {
        source_count += 1;
    }
    if opts.body.is_some() {
        source_count += 1;
    }
    if opts.body_file.is_some() {
        source_count += 1;
    }
    if opts.body_stdin {
        source_count += 1;
    }

    if source_count != 1 {
        bail!(
            "Provide exactly one body source: positional message, --body, --body-file, or --body-stdin"
        );
    }

    if opts.message.is_some() {
        if let Some(body_format) = opts.body_format.as_deref() {
            if body_format.trim() != "text" {
                bail!("Positional message always uses --body-format text");
            }
        }
        return Ok(());
    }

    if opts.body_format.is_none() {
        bail!("Body format is required with --body, --body-file, and --body-stdin");
    }

    Ok(())
}

fn resolve_tell_body(opts: &TellOptions, effective_protocol: &str) -> Result<ResolvedTellBody> {
    validate_tell_body_input(opts)?;

    if let Some(message) = &opts.message {
        return Ok(ResolvedTellBody {
            format: TellBodyFormat::Text,
            payload: wrap_text_body(effective_protocol, message),
        });
    }

    let format = parse_body_format(opts.body_format.as_deref())?;
    let raw_body = if let Some(body) = &opts.body {
        body.clone()
    } else if let Some(path) = &opts.body_file {
        fs::read_to_string(path)?
    } else {
        read_stdin_body()?
    };

    let payload = match format {
        TellBodyFormat::Text => wrap_text_body(effective_protocol, &raw_body),
        TellBodyFormat::Json => {
            let parsed: Value = serde_json::from_str(&raw_body)
                .map_err(|_| anyhow::anyhow!("JSON body must be valid JSON"))?;
            if !parsed.is_object() {
                bail!("JSON body must be a JSON object");
            }
            parsed
        }
    };

    Ok(ResolvedTellBody { format, payload })
}

pub async fn run(opts: TellOptions) -> Result<()> {
    validate_tell_body_input(&opts)?;
    let mut config = load_config()?;

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
    let mut protocol_selection = if opts.protocol_explicit {
        ProtocolSelection::Explicit
    } else {
        ProtocolSelection::Default
    };
    let mut protocol_selection_reason: Option<&str> = None;
    let effective_protocol = if !opts.protocol_explicit && opts.protocol == "/agent/msg/1.0.0" {
        let mut declared_protocols = if let Some(card) = &resolved_target.agent {
            collect_declared_protocols(card)
        } else if daemon_status.is_some() {
            match daemon
                .send_command("query-card", json!({"did": &recipient_did}))
                .await
            {
                Ok(response) => {
                    if let Some(card_value) = response.get("card") {
                        if let Ok(card) =
                            serde_json::from_value::<crate::protocol::AgentCard>(card_value.clone())
                        {
                            collect_declared_protocols(&card)
                        } else {
                            Vec::new()
                        }
                    } else {
                        Vec::new()
                    }
                }
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };

        if declared_protocols.len() > 1 {
            bail!(
                "Target advertises multiple protocols ({}). Pass --protocol explicitly.",
                describe_protocols(&declared_protocols)
            );
        }

        if let Some(protocol) = declared_protocols.pop() {
            protocol_selection = ProtocolSelection::Auto;
            protocol_selection_reason = Some("auto-selected from target capabilities");
            protocol
        } else {
            opts.protocol.clone()
        }
    } else {
        opts.protocol.clone()
    };

    let ResolvedTellBody {
        format: body_format,
        payload,
    } = resolve_tell_body(&opts, &effective_protocol)?;

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
                            "Protocol: {} ({})",
                            effective_protocol,
                            protocol_selection_reason.unwrap_or(protocol_selection.as_str())
                        );
                        println!(
                            "Message sent, waiting for result ({}s timeout)...",
                            timeout_secs
                        );
                    }

                    let outcome =
                        wait_for_message_outcome_via_daemon(&daemon, message_id, timeout_secs)
                            .await?;

                    if opts.json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&build_wait_json_response(
                                message_id,
                                &recipient_did,
                                &effective_protocol,
                                protocol_selection,
                                protocol_selection_reason,
                                body_format,
                                &payload,
                                thread_id.as_deref(),
                                timeout_secs,
                                outcome.as_ref(),
                            ))?
                        );
                        if outcome.is_none() {
                            std::process::exit(1);
                        }
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
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&json!({
                            "messageId": message_id,
                            "to": recipient_did,
                            "protocol": effective_protocol,
                            "protocolSelection": protocol_selection.as_str(),
                            "protocolSelectionReason": protocol_selection_reason,
                            "bodyFormat": body_format.as_str(),
                            "payload": payload,
                            "threadId": thread_id,
                            "status": "accepted",
                        }))?
                    );
                } else if opts.human {
                    println!("Relay accepted message via daemon ({})", message_id);
                    println!(
                        "Protocol: {} ({})",
                        effective_protocol,
                        protocol_selection_reason.unwrap_or(protocol_selection.as_str())
                    );
                    if let Some(thread_id) = &thread_id {
                        println!("Thread: {}", thread_id);
                    }
                    println!("Trace with: agent trace {}", message_id);
                } else {
                    LlmFormatter::section("Message Sent");
                    LlmFormatter::key_value("Message ID", message_id);
                    LlmFormatter::key_value("To", &recipient_did);
                    LlmFormatter::key_value("Protocol", &effective_protocol);
                    LlmFormatter::key_value("Protocol Selection", protocol_selection.as_str());
                    if let Some(reason) = protocol_selection_reason {
                        LlmFormatter::key_value("Protocol Selection Reason", reason);
                    }
                    LlmFormatter::key_value("Body Format", body_format.as_str());
                    LlmFormatter::key_value("Type", "message");
                    LlmFormatter::key_value("Body", &payload.to_string());
                    if let Some(thread_id) = &thread_id {
                        LlmFormatter::key_value("Thread ID", thread_id);
                    }
                    LlmFormatter::key_value("Lifecycle", "accepted");
                    LlmFormatter::key_value("Trace Hint", &format!("agent trace {}", message_id));
                    println!();
                }
                return Ok(());
            }
            Err(error) => {
                if opts.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&json!({
                            "error": format!("{}", error),
                            "to": recipient_did,
                            "protocol": effective_protocol,
                            "protocolSelection": protocol_selection.as_str(),
                            "protocolSelectionReason": protocol_selection_reason,
                            "bodyFormat": body_format.as_str(),
                            "payload": payload,
                            "threadId": thread_id,
                            "status": "send_failed",
                        }))?
                    );
                    std::process::exit(1);
                }
                bail!(
                    "Daemon send failed: {}. Stop daemon first for direct relay mode: a4 stop",
                    error
                );
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
    let identity_for_send = identity.clone();
    let envelope_for_send = envelope.clone();
    let (prepared, next_config) = with_local_e2e_state_transaction(|config| {
        let session = &mut session;
        let identity_for_send = identity_for_send.clone();
        let envelope_for_send = envelope_for_send.clone();
        async move {
            let keypair = KeyPair::from_hex(&identity_for_send.private_key)?;
            let prepared =
                prepare_encrypted_sends_with_session(session, &config, &keypair, envelope_for_send)
                    .await?;
            let next_config = prepared.config.clone();
            Ok((prepared, next_config))
        }
    })
    .await?;
    config = next_config;

    for target in &prepared.targets {
        session
            .send_envelope(&recipient_did, target.outer_envelope_bytes.clone())
            .await?;
    }

    if let Some(timeout_secs) = wait_timeout_secs {
        if opts.human {
            println!("Message ID: {}", prepared.application_envelope.id);
            println!(
                "Protocol: {} ({})",
                effective_protocol,
                protocol_selection_reason.unwrap_or(protocol_selection.as_str())
            );
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
            println!(
                "{}",
                serde_json::to_string_pretty(&build_wait_json_response(
                    &prepared.application_envelope.id,
                    &recipient_did,
                    &effective_protocol,
                    protocol_selection,
                    protocol_selection_reason,
                    body_format,
                    &payload,
                    thread_id.as_deref(),
                    timeout_secs,
                    outcome.as_ref(),
                ))?
            );
            if outcome.is_none() {
                std::process::exit(1);
            }
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
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "messageId": prepared.application_envelope.id,
                    "to": recipient_did,
                    "protocol": effective_protocol,
                    "protocolSelection": protocol_selection.as_str(),
                    "protocolSelectionReason": protocol_selection_reason,
                    "bodyFormat": body_format.as_str(),
                    "payload": payload,
                    "threadId": thread_id,
                    "status": final_status,
                    "relayDelivered": final_status == "delivered",
                }))?
            );
        } else if opts.human {
            println!(
                "Protocol: {} ({})",
                effective_protocol,
                protocol_selection_reason.unwrap_or(protocol_selection.as_str())
            );
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
            LlmFormatter::key_value("Protocol Selection", protocol_selection.as_str());
            if let Some(reason) = protocol_selection_reason {
                LlmFormatter::key_value("Protocol Selection Reason", reason);
            }
            LlmFormatter::key_value("Body Format", body_format.as_str());
            LlmFormatter::key_value("Type", "message");
            LlmFormatter::key_value("Body", &payload.to_string());
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

pub(crate) async fn wait_for_message_outcome_via_daemon(
    daemon: &DaemonClient,
    message_id: &str,
    timeout_secs: u64,
) -> Result<Option<MessageOutcome>> {
    use crate::commands::message_lifecycle::{
        message_id as get_message_id, sort_messages_by_timestamp,
    };
    use std::collections::HashSet;

    let start_time = SystemTime::now();
    let timeout_duration = Duration::from_secs(timeout_secs);
    let mut tracker = MessageOutcomeTracker::new(message_id);
    let mut seen_ids: HashSet<String> = HashSet::new();

    loop {
        if start_time.elapsed().unwrap_or_default() > timeout_duration {
            return Ok(None);
        }

        let inbox_params = json!({
            "limit": 400,
            "pagination": { "limit": 400 },
            "filter": {},
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
        if envelope.get("protocol").and_then(|v| v.as_str())
            == Some(E2E_APPLICATION_ENVELOPE_PROTOCOL)
        {
            let transport_envelope: Envelope = match serde_json::from_value(envelope.clone()) {
                Ok(e) => e,
                Err(err) => {
                    eprintln!("Skipping E2E envelope with invalid structure: {}", err);
                    continue;
                }
            };
            let transport_envelope_for_receive = transport_envelope.clone();
            match with_local_e2e_state_transaction(|config_snapshot| async move {
                let decrypted =
                    prepare_encrypted_receive(&config_snapshot, &transport_envelope_for_receive)?;
                let next_config = decrypted.config.clone();
                Ok((decrypted, next_config))
            })
            .await
            {
                Ok((decrypted, next_config)) => {
                    *config = next_config;
                    envelope = match serde_json::to_value(&decrypted.application_envelope) {
                        Ok(v) => v,
                        Err(err) => {
                            eprintln!(
                                "Skipping decrypted envelope due to serialization failure: {}",
                                err
                            );
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

fn serialize_stored_message(message: &Value) -> Value {
    json!({
        "id": message_id(message),
        "timestamp": message_timestamp(message),
        "from": source_did(message),
        "protocol": protocol(message),
        "type": envelope_type(message),
        "replyTo": reply_to(message),
        "payload": envelope_payload(message).cloned(),
    })
}

fn build_wait_json_response(
    message_id: &str,
    recipient_did: &str,
    effective_protocol: &str,
    protocol_selection: ProtocolSelection,
    protocol_selection_reason: Option<&str>,
    body_format: TellBodyFormat,
    payload: &Value,
    thread_id: Option<&str>,
    timeout_secs: u64,
    outcome: Option<&MessageOutcome>,
) -> Value {
    json!({
        "messageId": message_id,
        "to": recipient_did,
        "protocol": effective_protocol,
        "protocolSelection": protocol_selection.as_str(),
        "protocolSelectionReason": protocol_selection_reason,
        "bodyFormat": body_format.as_str(),
        "payload": payload,
        "threadId": thread_id,
        "waitSeconds": timeout_secs,
        "reply": outcome
            .filter(|outcome| outcome.kind == MessageOutcomeKind::Reply)
            .map(|outcome| serialize_stored_message(&outcome.message)),
        "result": outcome.map(|outcome| json!({
            "kind": outcome.kind.as_str(),
            "status": outcome.status,
            "jobId": outcome.job_id,
            "terminal": outcome.terminal,
            "message": serialize_stored_message(&outcome.message),
        })),
        "timedOut": outcome.is_none(),
    })
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

    LlmFormatter::section("Message Wait");
    LlmFormatter::key_value("Message ID", display.message_id);
    LlmFormatter::key_value("To", display.recipient_did);
    LlmFormatter::key_value("Protocol", display.protocol);
    LlmFormatter::key_value("Type", "message");
    LlmFormatter::key_value("Body", &display.payload.to_string());
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
            LlmFormatter::key_value("Reply Body", &payload.to_string());
        }
        LlmFormatter::key_value("Result Body", &payload.to_string());
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
    let mut declared_protocols = collect_declared_protocols(card);
    if declared_protocols.len() == 1 {
        declared_protocols.pop()
    } else {
        None
    }
}

fn collect_declared_protocols(card: &crate::protocol::AgentCard) -> Vec<String> {
    let mut declared_protocols = Vec::new();
    for capability in &card.capabilities {
        if let Some(metadata) = &capability.metadata {
            if let Some(protocol) = metadata.get("protocol").and_then(|value| value.as_str()) {
                let protocol = protocol.trim();
                if !protocol.is_empty()
                    && !declared_protocols.iter().any(|entry| entry == protocol)
                {
                    declared_protocols.push(protocol.to_string());
                }
            }
        }
    }
    declared_protocols
}

fn describe_protocols(protocols: &[String]) -> String {
    protocols
        .iter()
        .map(|protocol| format!("\"{}\"", protocol))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::{
        build_wait_json_response, extract_primary_protocol, validate_tell_body_input,
        ProtocolSelection, TellBodyFormat, TellOptions,
    };
    use crate::commands::message_lifecycle::{MessageOutcome, MessageOutcomeKind};
    use crate::protocol::{AgentCard, Capability};
    use serde_json::{json, Value};

    fn sample_card(capabilities: Vec<Capability>) -> AgentCard {
        AgentCard {
            did: "did:agent:test".to_string(),
            name: "Test".to_string(),
            description: "Test card".to_string(),
            version: "1.0.0".to_string(),
            capabilities,
            endpoints: vec![],
            devices: None,
            peer_id: None,
            trust: None,
            metadata: None,
            timestamp: 1,
            signature: String::new(),
        }
    }

    fn sample_message(msg_type: &str, reply_to: Option<&str>, payload: Value) -> Value {
        json!({
            "direction": "inbound",
            "receivedAt": 42,
            "sentAt": Value::Null,
            "envelope": {
                "id": "msg_reply",
                "from": "did:agent:worker",
                "to": "did:agent:sender",
                "type": msg_type,
                "protocol": "/agent/msg/1.0.0",
                "payload": payload,
                "timestamp": 42,
                "replyTo": reply_to,
            }
        })
    }

    #[test]
    fn wait_json_response_includes_reply_and_result_message_for_replies() {
        let outcome = MessageOutcome {
            kind: MessageOutcomeKind::Reply,
            message: sample_message("reply", Some("msg_origin"), json!({ "text": "done" })),
            status: None,
            job_id: None,
            terminal: true,
        };

        let value = build_wait_json_response(
            "msg_origin",
            "did:agent:target",
            "/agent/msg/1.0.0",
            ProtocolSelection::Auto,
            Some("auto-selected from target capabilities"),
            TellBodyFormat::Text,
            &json!({ "text": "hello" }),
            Some("thread_123"),
            30,
            Some(&outcome),
        );

        assert_eq!(value["reply"]["payload"]["text"], "done");
        assert_eq!(value["result"]["message"]["payload"]["text"], "done");
        assert_eq!(value["result"]["message"]["replyTo"], "msg_origin");
        assert_eq!(value["timedOut"], false);
    }

    #[test]
    fn wait_json_response_keeps_reply_null_for_non_reply_results() {
        let outcome = MessageOutcome {
            kind: MessageOutcomeKind::Result,
            message: sample_message(
                "message",
                Some("msg_origin"),
                json!({ "status": "success", "jobId": "job-1", "value": 42 }),
            ),
            status: Some("success".to_string()),
            job_id: Some("job-1".to_string()),
            terminal: true,
        };

        let value = build_wait_json_response(
            "msg_origin",
            "did:agent:target",
            "/jobs/1.0.0",
            ProtocolSelection::Default,
            None,
            TellBodyFormat::Json,
            &json!({ "task": "compute" }),
            None,
            15,
            Some(&outcome),
        );

        assert!(value["reply"].is_null());
        assert_eq!(value["result"]["message"]["payload"]["status"], "success");
        assert_eq!(value["result"]["message"]["payload"]["jobId"], "job-1");
    }

    #[test]
    fn extract_primary_protocol_prefers_metadata_protocol() {
        let card = sample_card(vec![
            Capability {
                id: "custom/echo".to_string(),
                name: "Echo".to_string(),
                description: "Echo protocol".to_string(),
                parameters: None,
                metadata: Some(json!({ "protocol": "/echo/1.0.0" })),
            },
            Capability {
                id: "shell/exec".to_string(),
                name: "Shell".to_string(),
                description: "Shell execution".to_string(),
                parameters: None,
                metadata: None,
            },
        ]);

        assert_eq!(
            extract_primary_protocol(&card).as_deref(),
            Some("/echo/1.0.0")
        );
    }

    #[test]
    fn extract_primary_protocol_returns_none_without_unique_protocol() {
        let card = sample_card(vec![Capability {
            id: "gpu/compute".to_string(),
            name: "GPU".to_string(),
            description: "GPU compute".to_string(),
            parameters: None,
            metadata: None,
        }]);

        assert_eq!(extract_primary_protocol(&card), None);
    }

    #[test]
    fn validate_tell_body_rejects_positional_json_format() {
        let error = validate_tell_body_input(&TellOptions {
            target: "gpu".to_string(),
            message: Some("hello".to_string()),
            body: None,
            body_file: None,
            body_stdin: false,
            body_format: Some("json".to_string()),
            protocol: "/agent/msg/1.0.0".to_string(),
            protocol_explicit: false,
            reply_to: None,
            thread: None,
            new_thread: false,
            wait: None,
            relay: None,
            json: false,
            human: false,
        })
        .expect_err("positional json body should fail");

        assert!(error
            .to_string()
            .contains("Positional message always uses --body-format text"));
    }
}
