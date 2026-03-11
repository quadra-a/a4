use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::config::load_config;
use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::identity::KeyPair;
use crate::protocol::{cbor_x_encode_json, Envelope, EnvelopeUnsigned};
use crate::relay::connect_first_available;
use crate::ui::LlmFormatter;

pub struct SendOptions {
    pub to: String,
    pub message: Option<String>,
    pub payload: Option<String>,
    pub msg_type: String,
    pub relay: Option<String>,
    pub protocol: String,
    pub human: bool,
    pub thread: Option<String>,
    pub new_thread: bool,
}

pub(crate) struct EnvelopeThreading {
    reply_to: Option<String>,
    thread_id: Option<String>,
}

impl EnvelopeThreading {
    pub(crate) fn new(reply_to: Option<String>, thread_id: Option<String>) -> Self {
        Self {
            reply_to,
            thread_id,
        }
    }
}

pub async fn run(opts: SendOptions) -> Result<()> {
    let config = load_config()?;
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
        crate::commands::target_resolution::resolve_target(&opts.to, &config, resolution_relay)
            .await?;
    let recipient_did = resolved_target.did.clone();

    let payload: Value = if let Some(p) = &opts.payload {
        serde_json::from_str(p).unwrap_or_else(|_| json!({"text": p}))
    } else if let Some(m) = &opts.message {
        json!({"text": m})
    } else {
        bail!("Provide --message or --payload");
    };

    // CVP-0014: Handle thread ID
    let thread_id = if opts.new_thread {
        Some(generate_thread_id())
    } else {
        opts.thread.clone()
    };

    if resolved_target.matched_by == "search" && opts.human {
        if let Some(agent) = resolved_target.agent.as_ref() {
            println!("Resolved {} to {} ({})", opts.to, agent.name, recipient_did);
        } else {
            println!("Resolved {} to {}", opts.to, recipient_did);
        }
    }

    // Try daemon fast path first
    if daemon_status.is_some() {
        let mut params = json!({
            "to": recipient_did,
            "type": opts.msg_type,
            "protocol": opts.protocol,
            "payload": payload,
        });

        if let Some(tid) = &thread_id {
            params["threadId"] = json!(tid);
        }

        let result = daemon.send_command("send", params).await;

        match result {
            Ok(response) => {
                let message_id = response
                    .get("messageId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                if opts.human {
                    println!("Message accepted locally via daemon ({})", message_id);
                    if let Some(tid) = &thread_id {
                        println!("Thread: {}", tid);
                    }
                    println!("Trace with: agent trace {}", message_id);
                } else {
                    LlmFormatter::section("Message Sent");
                    LlmFormatter::key_value("Message ID", message_id);
                    LlmFormatter::key_value("To", &recipient_did);
                    LlmFormatter::key_value("Protocol", &opts.protocol);
                    LlmFormatter::key_value("Type", &opts.msg_type);
                    LlmFormatter::key_value("Payload", &payload.to_string());
                    if let Some(tid) = &thread_id {
                        LlmFormatter::key_value("Thread ID", tid);
                    }
                    LlmFormatter::key_value("Lifecycle", "accepted_locally");
                    LlmFormatter::key_value("Trace Hint", &format!("agent trace {}", message_id));
                    println!();
                }
                return Ok(());
            }
            Err(e) => {
                if opts.human {
                    eprintln!("Daemon send failed ({}), falling back to direct relay", e);
                }
            }
        }
    }

    // Ephemeral relay fallback
    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let card = crate::commands::discover::build_card(&config, identity)?;
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
        &opts.msg_type,
        &opts.protocol,
        payload.clone(),
        EnvelopeThreading::new(None, thread_id.clone()),
        &keypair,
    )?;
    let envelope_json = serde_json::to_value(&envelope)?;
    let envelope_bytes = cbor_x_encode_json(&envelope_json);

    session
        .send_envelope(&recipient_did, envelope_bytes)
        .await?;

    // Wait for delivery report
    match session.wait_delivery_report().await {
        Ok(status) => {
            session.goodbye().await?;
            if opts.human {
                match status.as_str() {
                    "delivered" => {
                        println!("Relay handoff reported delivered");
                        if let Some(tid) = &thread_id {
                            println!("Thread: {}", tid);
                        }
                        println!("Remote execution is still unknown until a reply arrives.");
                    }
                    "queue_full" => bail!("Relay queue full for recipient"),
                    "unknown_recipient" => bail!("Recipient not found on relay"),
                    other => println!("Delivery status: {}", other),
                }
            } else {
                LlmFormatter::section("Message Sent");
                LlmFormatter::key_value("Message ID", &envelope.id);
                LlmFormatter::key_value("To", &recipient_did);
                LlmFormatter::key_value("Protocol", &opts.protocol);
                LlmFormatter::key_value("Type", &opts.msg_type);
                LlmFormatter::key_value("Payload", &payload.to_string());
                if let Some(tid) = &thread_id {
                    LlmFormatter::key_value("Thread ID", tid);
                }
                LlmFormatter::key_value(
                    "Relay Delivered",
                    if status == "delivered" {
                        "true"
                    } else {
                        "false"
                    },
                );
                LlmFormatter::key_value("Status", &status);
                LlmFormatter::key_value("Execution State", "unknown_without_reply");
                println!();
            }
        }
        Err(e) => {
            if opts.human {
                eprintln!("Warning: no delivery report received ({})", e);
            }
            session.goodbye().await?;
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
    };

    Ok(unsigned.sign(keypair))
}
