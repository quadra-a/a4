use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::commands::message_lifecycle::{
    collect_correlated_lifecycle_messages, envelope_type, find_message_outcome, match_unique_id,
    message_id, message_timestamp, payload_job_id, protocol, reply_to,
    resolve_request_id_from_message, source_did, target_did, thread_id,
};
use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::ui::LlmFormatter;

pub struct TraceOptions {
    pub message_id: String,
    pub json: bool,
    pub human: bool,
}

pub async fn run(opts: TraceOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());

    if !daemon.is_running().await {
        bail!("Daemon is not running. Start it with: agent listen");
    }

    let response = daemon
        .send_command("inbox", json!({ "limit": 400 }))
        .await?;
    let messages = response
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let trace = build_trace(&opts.message_id, &messages)?;

    if opts.json {
        println!("{}", serde_json::to_string_pretty(&trace)?);
        return Ok(());
    }

    if opts.human {
        render_human(&trace);
    } else {
        render_llm(&trace);
    }

    Ok(())
}

fn build_trace(requested_id: &str, messages: &[Value]) -> Result<Value> {
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

    let resolved_id = resolve_request_id_from_message(matched_message, messages)
        .or_else(|| {
            matched_message.and_then(|message| message_id(message).map(ToString::to_string))
        })
        .unwrap_or_else(|| requested.to_string());

    let outbox = messages
        .iter()
        .filter(|message| {
            message.get("direction").and_then(|value| value.as_str()) == Some("outbound")
        })
        .filter(|message| message_id(message) == Some(resolved_id.as_str()))
        .max_by_key(|message| message_timestamp(message).unwrap_or(0));
    let reply = messages
        .iter()
        .filter(|message| {
            message.get("direction").and_then(|value| value.as_str()) == Some("inbound")
        })
        .filter(|message| envelope_type(message) == Some("reply"))
        .filter(|message| reply_to(message) == Some(resolved_id.as_str()))
        .max_by_key(|message| message_timestamp(message).unwrap_or(0));
    let outcome = find_message_outcome(messages, &resolved_id);
    let result_message = outcome.as_ref().map(|value| value.message.clone());
    let result_status = outcome.as_ref().and_then(|value| value.status.clone());
    let result_job_id = outcome
        .as_ref()
        .and_then(|value| value.job_id.clone())
        .or_else(|| matched_message.and_then(payload_job_id));
    let lifecycle_messages = collect_correlated_lifecycle_messages(messages, &resolved_id);

    let mut notes = vec![
        "Rust daemon currently records local message history, but not separate queued/delivered/failed queue states.".to_string(),
    ];
    if reply.is_some() {
        notes.push("A formal reply is present in the local daemon history.".to_string());
    } else if outcome.as_ref().is_some_and(|value| value.terminal) {
        let detail = result_status
            .as_deref()
            .map(|status| {
                format!(
                    "A terminal async result ({}) is present in the local daemon history.",
                    status
                )
            })
            .unwrap_or_else(|| {
                "A terminal async result is present in the local daemon history.".to_string()
            });
        notes.push(detail);
    } else if outcome.is_some() {
        let detail = result_status
            .as_deref()
            .map(|status| {
                format!(
                    "A non-terminal async result ({}) indicates remote work is in progress.",
                    status
                )
            })
            .unwrap_or_else(|| {
                "A non-terminal async result indicates remote work is in progress.".to_string()
            });
        notes.push(detail);
    } else {
        notes.push(
            "No correlated reply or async result is visible in local daemon history yet."
                .to_string(),
        );
    }
    if outbox.is_none() {
        notes.push("No matching outbound message was found in local daemon history.".to_string());
    }

    let state = if reply.is_some() {
        "replied"
    } else if outcome.as_ref().is_some_and(|value| value.terminal) {
        "result_received"
    } else if outcome.is_some() {
        "result_in_progress"
    } else if outbox.is_some() {
        "waiting_for_result"
    } else {
        "untracked"
    };

    let result_state = if reply.is_some() || outcome.as_ref().is_some_and(|value| value.terminal) {
        "terminal_result_observed"
    } else if outcome.is_some() {
        "progress_result_observed"
    } else {
        "no_result_yet"
    };

    Ok(json!({
        "requestedId": requested,
        "resolvedId": resolved_id,
        "messageId": outbox.and_then(message_id).unwrap_or(resolved_id.as_str()),
        "available": outbox.is_some() || reply.is_some() || result_message.is_some(),
        "summary": {
            "state": state,
            "dispatchPath": "daemon",
            "localQueueState": if outbox.is_some() { "logged" } else { "unknown" },
            "replyState": if reply.is_some() { "reply_observed" } else { "no_reply_yet" },
            "resultState": result_state,
            "resultStatus": result_status,
            "jobId": result_job_id,
            "threadId": outbox.and_then(thread_id).or_else(|| result_message.as_ref().and_then(thread_id)).or_else(|| reply.and_then(thread_id)),
            "protocol": outbox.and_then(protocol).or_else(|| result_message.as_ref().and_then(protocol)).or_else(|| reply.and_then(protocol)),
            "targetDid": outbox.and_then(target_did).or_else(|| result_message.as_ref().and_then(source_did)).or_else(|| reply.and_then(source_did)),
            "notes": notes,
        },
        "stages": build_trace_stages(outbox, result_message.as_ref(), reply, result_state, result_status.as_deref()),
        "outboxMessage": outbox.cloned(),
        "replyMessage": reply.cloned(),
        "resultMessage": result_message,
        "lifecycleMessages": lifecycle_messages,
    }))
}

fn build_trace_stages(
    outbox_message: Option<&Value>,
    result_message: Option<&Value>,
    reply_message: Option<&Value>,
    result_state: &str,
    result_status: Option<&str>,
) -> Vec<Value> {
    let status_suffix = result_status
        .map(|status| format!(" ({})", status))
        .unwrap_or_default();
    let execution_detail = if reply_message.is_some() {
        "A formal reply arrived, so remote processing clearly happened.".to_string()
    } else if result_message.is_some() {
        format!(
            "An async result update{} arrived from the remote agent.",
            status_suffix
        )
    } else {
        "No remote execution evidence is visible yet.".to_string()
    };
    let result_detail = if reply_message.is_some() {
        "A formal reply with matching correlation is present in local daemon history.".to_string()
    } else if result_state == "terminal_result_observed" {
        format!(
            "A terminal async result{} is present in local daemon history.",
            status_suffix
        )
    } else if result_state == "progress_result_observed" {
        format!(
            "A non-terminal async result{} indicates remote work is in progress.",
            status_suffix
        )
    } else {
        "No correlated reply or async result is present in local daemon history yet.".to_string()
    };

    vec![
        stage(
            "accepted",
            "Accepted locally",
            if outbox_message.is_some() {
                "done"
            } else {
                "unknown"
            },
            if outbox_message.is_some() {
                "The daemon recorded an outbound message for this message ID."
            } else {
                "No local outbound message matched this ID."
            },
            outbox_message.and_then(message_timestamp),
        ),
        stage(
            "transport",
            "Sender handoff",
            if outbox_message.is_some() {
                "done"
            } else {
                "unknown"
            },
            if outbox_message.is_some() {
                "This Rust daemon only records the message after relay send completed, so queue sub-states are not preserved separately."
            } else {
                "Transport handoff is not observable for this message from local daemon history."
            },
            outbox_message.and_then(message_timestamp),
        ),
        stage(
            "execution",
            "Remote execution",
            if result_message.is_some() || reply_message.is_some() {
                "done"
            } else if outbox_message.is_some() {
                "active"
            } else {
                "unknown"
            },
            execution_detail,
            result_message
                .and_then(message_timestamp)
                .or_else(|| reply_message.and_then(message_timestamp)),
        ),
        stage(
            "result",
            "Result observed",
            if reply_message.is_some() || result_state == "terminal_result_observed" {
                "done"
            } else if result_state == "progress_result_observed" || outbox_message.is_some() {
                "active"
            } else {
                "unknown"
            },
            result_detail,
            result_message
                .and_then(message_timestamp)
                .or_else(|| reply_message.and_then(message_timestamp)),
        ),
    ]
}

fn stage(key: &str, label: &str, state: &str, detail: impl Into<String>, at: Option<u64>) -> Value {
    json!({
        "key": key,
        "label": label,
        "state": state,
        "detail": detail.into(),
        "at": at.map(timestamp_string),
    })
}

fn timestamp_string(timestamp: u64) -> String {
    chrono::DateTime::from_timestamp_millis(timestamp as i64)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| timestamp.to_string())
}

fn render_human(trace: &Value) {
    use colored::Colorize;

    println!();
    println!("{}", "Message Trace".bold().cyan());
    println!();
    println!(
        "  {}: {}",
        "Requested ID".dimmed(),
        trace
            .get("requestedId")
            .and_then(|value| value.as_str())
            .unwrap_or("?")
    );
    println!(
        "  {}: {}",
        "Message ID".dimmed(),
        trace
            .get("messageId")
            .and_then(|value| value.as_str())
            .unwrap_or("?")
    );
    if let Some(summary) = trace.get("summary") {
        println!(
            "  {}: {}",
            "State".dimmed(),
            summary
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        );
        println!(
            "  {}: {}",
            "Dispatch Path".dimmed(),
            summary
                .get("dispatchPath")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        );
        println!(
            "  {}: {}",
            "Local Queue".dimmed(),
            summary
                .get("localQueueState")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        );
        println!(
            "  {}: {}",
            "Reply State".dimmed(),
            summary
                .get("replyState")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        );
        println!(
            "  {}: {}",
            "Result State".dimmed(),
            summary
                .get("resultState")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        );
        if let Some(status) = summary.get("resultStatus").and_then(|value| value.as_str()) {
            println!("  {}: {}", "Result Status".dimmed(), status);
        }
        if let Some(job_id) = summary.get("jobId").and_then(|value| value.as_str()) {
            println!("  {}: {}", "Job ID".dimmed(), job_id);
        }
        if let Some(target) = summary.get("targetDid").and_then(|value| value.as_str()) {
            println!("  {}: {}", "Target".dimmed(), target);
        }
        if let Some(thread) = summary.get("threadId").and_then(|value| value.as_str()) {
            println!("  {}: {}", "Thread".dimmed(), thread);
        }
        if let Some(protocol) = summary.get("protocol").and_then(|value| value.as_str()) {
            println!("  {}: {}", "Protocol".dimmed(), protocol);
        }
    }

    println!();
    println!("{}", "Lifecycle".bold());
    if let Some(stages) = trace.get("stages").and_then(|value| value.as_array()) {
        for stage in stages {
            let label = stage
                .get("label")
                .and_then(|value| value.as_str())
                .unwrap_or("stage");
            let state = stage
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let detail = stage
                .get("detail")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let marker = match state {
                "done" => "✓".green().to_string(),
                "warning" => "⚠".yellow().to_string(),
                "active" => "…".cyan().to_string(),
                _ => "·".dimmed().to_string(),
            };
            println!("{} {}: {}", marker, label, detail);
            if let Some(at) = stage.get("at").and_then(|value| value.as_str()) {
                println!("  at: {}", at.dimmed());
            }
        }
    }

    if let Some(notes) = trace
        .get("summary")
        .and_then(|summary| summary.get("notes"))
        .and_then(|value| value.as_array())
    {
        if !notes.is_empty() {
            println!();
            println!("{}", "Notes".bold());
            for note in notes {
                if let Some(text) = note.as_str() {
                    println!("  {} {}", "⚠".yellow(), text);
                }
            }
        }
    }

    println!();
}

fn render_llm(trace: &Value) {
    LlmFormatter::section("Message Trace");
    LlmFormatter::key_value(
        "Requested ID",
        trace
            .get("requestedId")
            .and_then(|value| value.as_str())
            .unwrap_or("?"),
    );
    LlmFormatter::key_value(
        "Message ID",
        trace
            .get("messageId")
            .and_then(|value| value.as_str())
            .unwrap_or("?"),
    );

    if let Some(summary) = trace.get("summary") {
        LlmFormatter::key_value(
            "State",
            summary
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
        );
        LlmFormatter::key_value(
            "Dispatch Path",
            summary
                .get("dispatchPath")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
        );
        LlmFormatter::key_value(
            "Local Queue",
            summary
                .get("localQueueState")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
        );
        LlmFormatter::key_value(
            "Reply State",
            summary
                .get("replyState")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
        );
        LlmFormatter::key_value(
            "Result State",
            summary
                .get("resultState")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
        );
        if let Some(status) = summary.get("resultStatus").and_then(|value| value.as_str()) {
            LlmFormatter::key_value("Result Status", status);
        }
        if let Some(job_id) = summary.get("jobId").and_then(|value| value.as_str()) {
            LlmFormatter::key_value("Job ID", job_id);
        }
        if let Some(target) = summary.get("targetDid").and_then(|value| value.as_str()) {
            LlmFormatter::key_value("Target", target);
        }
        if let Some(thread) = summary.get("threadId").and_then(|value| value.as_str()) {
            LlmFormatter::key_value("Thread", thread);
        }
        if let Some(protocol) = summary.get("protocol").and_then(|value| value.as_str()) {
            LlmFormatter::key_value("Protocol", protocol);
        }
    }

    if let Some(stages) = trace.get("stages").and_then(|value| value.as_array()) {
        println!();
        for stage in stages {
            let label = stage
                .get("label")
                .and_then(|value| value.as_str())
                .unwrap_or("stage");
            let state = stage
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let detail = stage
                .get("detail")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let suffix = stage
                .get("at")
                .and_then(|value| value.as_str())
                .map(|value| format!(" @ {}", value))
                .unwrap_or_default();
            LlmFormatter::key_value(
                &format!("Stage {}", label),
                &format!("{} — {}{}", state, detail, suffix),
            );
        }
    }

    if let Some(notes) = trace
        .get("summary")
        .and_then(|summary| summary.get("notes"))
        .and_then(|value| value.as_array())
    {
        for note in notes {
            if let Some(text) = note.as_str() {
                LlmFormatter::key_value("Note", text);
            }
        }
    }

    println!();
}

#[cfg(test)]
mod tests {
    use super::build_trace;
    use serde_json::{json, Value};

    fn make_message(
        direction: &str,
        id: &str,
        msg_type: &str,
        reply_to: Option<&str>,
        payload: Value,
        timestamp: u64,
    ) -> Value {
        json!({
            "direction": direction,
            "receivedAt": if direction == "inbound" { json!(timestamp) } else { Value::Null },
            "sentAt": if direction == "outbound" { json!(timestamp) } else { Value::Null },
            "envelope": {
                "id": id,
                "from": if direction == "outbound" { "did:agent:sender" } else { "did:agent:worker" },
                "to": if direction == "outbound" { "did:agent:worker" } else { "did:agent:sender" },
                "type": msg_type,
                "protocol": "/jobs/1.0.0",
                "payload": payload,
                "timestamp": timestamp,
                "replyTo": reply_to,
            }
        })
    }

    #[test]
    fn traces_async_progress_state() {
        let outbound = make_message(
            "outbound",
            "msg-origin",
            "message",
            None,
            json!({"prompt": "run"}),
            1,
        );
        let running = make_message(
            "inbound",
            "msg-running",
            "message",
            Some("msg-origin"),
            json!({"status": "running", "jobId": "job-1"}),
            2,
        );

        let trace = build_trace("msg-origin", &[outbound, running]).expect("trace");
        let summary = trace.get("summary").expect("summary");

        assert_eq!(
            summary.get("state").and_then(|value| value.as_str()),
            Some("result_in_progress")
        );
        assert_eq!(
            summary.get("resultState").and_then(|value| value.as_str()),
            Some("progress_result_observed")
        );
        assert_eq!(
            summary.get("resultStatus").and_then(|value| value.as_str()),
            Some("running")
        );
        assert_eq!(
            summary.get("jobId").and_then(|value| value.as_str()),
            Some("job-1")
        );
        assert_eq!(trace.get("replyMessage"), Some(&Value::Null));
        assert_eq!(
            trace
                .get("resultMessage")
                .and_then(|value| value.get("envelope"))
                .and_then(|envelope| envelope.get("id"))
                .and_then(|value| value.as_str()),
            Some("msg-running")
        );
        assert_eq!(
            trace
                .get("lifecycleMessages")
                .and_then(|value| value.as_array())
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn traces_terminal_async_result_from_result_message_id() {
        let outbound = make_message(
            "outbound",
            "msg-origin",
            "message",
            None,
            json!({"prompt": "run"}),
            1,
        );
        let running = make_message(
            "inbound",
            "msg-running",
            "message",
            Some("msg-origin"),
            json!({"status": "running", "jobId": "job-1"}),
            2,
        );
        let success = make_message(
            "inbound",
            "msg-success",
            "message",
            None,
            json!({"status": "success", "jobId": "job-1", "value": 42}),
            3,
        );

        let trace = build_trace("msg-success", &[outbound, running, success]).expect("trace");
        let summary = trace.get("summary").expect("summary");

        assert_eq!(
            trace.get("resolvedId").and_then(|value| value.as_str()),
            Some("msg-origin")
        );
        assert_eq!(
            summary.get("state").and_then(|value| value.as_str()),
            Some("result_received")
        );
        assert_eq!(
            summary.get("resultState").and_then(|value| value.as_str()),
            Some("terminal_result_observed")
        );
        assert_eq!(
            summary.get("resultStatus").and_then(|value| value.as_str()),
            Some("success")
        );
        assert_eq!(
            summary.get("jobId").and_then(|value| value.as_str()),
            Some("job-1")
        );
        assert_eq!(
            trace
                .get("resultMessage")
                .and_then(|value| value.get("envelope"))
                .and_then(|envelope| envelope.get("id"))
                .and_then(|value| value.as_str()),
            Some("msg-success")
        );
        assert_eq!(
            trace
                .get("lifecycleMessages")
                .and_then(|value| value.as_array())
                .map(Vec::len),
            Some(2)
        );
    }
}
