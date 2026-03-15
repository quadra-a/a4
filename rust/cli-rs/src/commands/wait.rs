use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::commands::message_lifecycle::{
    envelope_payload, match_unique_id, message_id, protocol, resolve_request_id_from_message,
    target_did, thread_id,
};
use crate::commands::tell::wait_for_message_outcome_via_daemon;
use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::ui::LlmFormatter;

pub struct WaitOptions {
    pub message_id: String,
    pub timeout_secs: u64,
    pub json: bool,
    pub human: bool,
}

pub async fn run(opts: WaitOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());

    if !daemon.is_running().await {
        bail!("Daemon is not running. Start it with: agent listen");
    }

    let response = daemon
        .send_command(
            "inbox",
            json!({
                "limit": 400,
                "pagination": { "limit": 400 },
                "filter": {},
            }),
        )
        .await?;
    let messages = response
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let resolved_id = resolve_message_id(&opts.message_id, &messages)?;
    let outbox = messages
        .iter()
        .filter(|message| {
            message.get("direction").and_then(|value| value.as_str()) == Some("outbound")
        })
        .find(|message| message_id(message) == Some(resolved_id.as_str()))
        .cloned();

    if outbox.is_none() {
        bail!("Only daemon-backed messages with local lifecycle history can be waited on again");
    }

    if opts.human {
        eprintln!("Waiting for result ({}s timeout)...", opts.timeout_secs);
    }

    let outcome =
        wait_for_message_outcome_via_daemon(&daemon, &resolved_id, opts.timeout_secs).await?;
    let outbox_payload = outbox.as_ref().and_then(envelope_payload).cloned();

    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "requestedId": opts.message_id,
                "resolvedId": resolved_id,
                "messageId": outbox.as_ref().and_then(message_id).unwrap_or(resolved_id.as_str()),
                "to": outbox.as_ref().and_then(target_did),
                "protocol": outbox.as_ref().and_then(protocol),
                "protocolSelection": Value::Null,
                "protocolSelectionReason": Value::Null,
                "payload": outbox_payload,
                "threadId": outbox.as_ref().and_then(thread_id),
                "waitSeconds": opts.timeout_secs,
                "result": outcome.as_ref().map(|o| json!({
                    "kind": o.kind.as_str(),
                    "status": o.status,
                    "jobId": o.job_id,
                    "terminal": o.terminal,
                    "message": o.message,
                })),
                "timedOut": outcome.is_none(),
            }))?
        );

        if outcome.is_none() {
            std::process::exit(1);
        }
        return Ok(());
    }

    if let Some(outcome) = outcome.as_ref() {
        if opts.human {
            println!(
                "{} received:",
                if outcome.kind.as_str() == "reply" {
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
            if let Some(payload) = envelope_payload(&outcome.message) {
                if let Some(text) = payload.get("text").and_then(|value| value.as_str()) {
                    println!("{}", text);
                } else {
                    println!("{}", payload);
                }
            } else {
                println!("{}", json!({}));
            }
        } else {
            LlmFormatter::section("Message Wait");
            LlmFormatter::key_value("Message ID", &resolved_id);
            LlmFormatter::key_value(
                "To",
                outbox.as_ref().and_then(target_did).unwrap_or("unknown"),
            );
            LlmFormatter::key_value(
                "Protocol",
                outbox.as_ref().and_then(protocol).unwrap_or("unknown"),
            );
            LlmFormatter::key_value("Wait Timeout", &format!("{}s", opts.timeout_secs));
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
            if let Some(payload) = envelope_payload(&outcome.message) {
                LlmFormatter::key_value("Result Body", &payload.to_string());
            }
            println!();
        }

        return Ok(());
    }

    if opts.human {
        eprintln!("No result within {}s", opts.timeout_secs);
        eprintln!("Check inbox for late results: a4 inbox --limit 5");
        eprintln!("Trace with: a4 trace {}", resolved_id);
    } else {
        LlmFormatter::section("Message Wait");
        LlmFormatter::key_value("Message ID", &resolved_id);
        LlmFormatter::key_value("Timed Out", "true");
        LlmFormatter::key_value("Trace Hint", &format!("a4 trace {}", resolved_id));
        println!();
    }
    std::process::exit(1);
}

fn resolve_message_id(requested_id: &str, messages: &[Value]) -> Result<String> {
    let requested = requested_id.trim();
    if requested.is_empty() {
        bail!("Message ID is required");
    }

    let exact = messages
        .iter()
        .find(|message| message_id(message) == Some(requested));
    let suffix_match_id = if exact.is_none() {
        match_unique_id(messages, requested)?
    } else {
        None
    };
    let matched_message = exact.or_else(|| {
        suffix_match_id.as_deref().and_then(|matched_id| {
            messages
                .iter()
                .find(|message| message_id(message) == Some(matched_id))
        })
    });

    Ok(resolve_request_id_from_message(matched_message, messages)
        .or_else(|| {
            matched_message.and_then(|message| message_id(message).map(ToString::to_string))
        })
        .unwrap_or_else(|| requested.to_string()))
}
