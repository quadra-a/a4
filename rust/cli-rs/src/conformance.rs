use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::message_lifecycle::find_message_outcome;
use crate::commands::serve::protocol_matches_capability;
use crate::config::Config;
use crate::daemon::{inbox_message_visible, message_to_inbox_json, stored_message_status};
use quadra_a_runtime::inbox::{
    E2EDeliveryMetadata, E2EDeliveryState, MessageDirection, MessageStore, StoredMessage,
    StoredMessageE2EMetadata,
};

#[derive(Debug, Deserialize)]
struct ConformanceSpec {
    version: u32,
    subject: String,
    cases: Vec<ConformanceCase>,
}

#[derive(Debug, Deserialize)]
struct ConformanceCase {
    id: String,
    description: String,
    input: Value,
    expected: Value,
}

#[derive(Debug, Serialize)]
pub struct CaseResult {
    pub subject: String,
    pub id: String,
    pub description: String,
    pub actual: Value,
    pub expected: Value,
    pub passed: bool,
}

#[derive(Debug, Serialize)]
pub struct ConformanceReport {
    pub version: u32,
    pub runner: &'static str,
    pub results: Vec<CaseResult>,
}

pub fn default_spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/conformance")
        .to_path_buf()
}

pub fn run(spec_root: &Path) -> Result<ConformanceReport> {
    let mut entries = fs::read_dir(spec_root)
        .with_context(|| {
            format!(
                "Failed to read conformance specs from {}",
                spec_root.display()
            )
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.path());

    let mut results = Vec::new();
    let mut version = 1;

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let bytes =
            fs::read(&path).with_context(|| format!("Failed to read {}", path.display()))?;
        let spec: ConformanceSpec = serde_json::from_slice(&bytes)
            .with_context(|| format!("Invalid JSON in {}", path.display()))?;
        version = spec.version;

        for case in spec.cases {
            let actual = evaluate_case(&spec.subject, &case.input)
                .with_context(|| format!("{} {}", spec.subject, case.id))?;
            let passed = actual == case.expected;
            results.push(CaseResult {
                subject: spec.subject.clone(),
                id: case.id,
                description: case.description,
                actual,
                expected: case.expected,
                passed,
            });
        }
    }

    Ok(ConformanceReport {
        version,
        runner: "rust",
        results,
    })
}

pub fn ensure_report_passes(report: &ConformanceReport) -> Result<()> {
    let failures = report
        .results
        .iter()
        .filter(|result| !result.passed)
        .map(|result| format!("{} {}", result.subject, result.id))
        .collect::<Vec<_>>();

    if failures.is_empty() {
        Ok(())
    } else {
        bail!("Conformance failures: {}", failures.join(", "))
    }
}

fn evaluate_case(subject: &str, input: &Value) -> Result<Value> {
    match subject {
        "message-status" => evaluate_message_status(input),
        "protocol-matching" => evaluate_protocol_matching(input),
        "reply-correlation" => evaluate_reply_correlation(input),
        "block-filtering" => evaluate_block_filtering(input),
        "daemon-persistence" => evaluate_daemon_persistence(input),
        other => bail!("Unknown conformance subject: {}", other),
    }
}

fn evaluate_message_status(input: &Value) -> Result<Value> {
    let message = build_message(
        input
            .get("message")
            .ok_or_else(|| anyhow::anyhow!("message-status input.message is required"))?,
    )?;
    Ok(json!({
        "status": stored_message_status(&message),
    }))
}

fn evaluate_protocol_matching(input: &Value) -> Result<Value> {
    let protocol = input
        .get("protocol")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("protocol-matching input.protocol is required"))?;
    let capability = input
        .get("capability")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("protocol-matching input.capability is required"))?;

    Ok(json!({
        "matches": protocol_matches_capability(protocol, capability),
    }))
}

fn evaluate_reply_correlation(input: &Value) -> Result<Value> {
    let request_id = input
        .get("requestId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("reply-correlation input.requestId is required"))?;
    let messages = build_messages_json(
        input
            .get("messages")
            .ok_or_else(|| anyhow::anyhow!("reply-correlation input.messages is required"))?,
    )?;

    Ok(outcome_json(find_message_outcome(&messages, request_id)))
}

fn evaluate_block_filtering(input: &Value) -> Result<Value> {
    let mut config = Config::default();
    if let Some(blocked) = input.get("blockedDids").and_then(|value| value.as_array()) {
        let mut trust = config.trust_config.unwrap_or_default();
        for did in blocked.iter().filter_map(|value| value.as_str()) {
            trust.block_agent(did.to_string());
        }
        config.trust_config = Some(trust);
    }

    let messages = build_messages(
        input
            .get("messages")
            .ok_or_else(|| anyhow::anyhow!("block-filtering input.messages is required"))?,
    )?;
    let visible_ids = messages
        .iter()
        .filter(|message| inbox_message_visible(message, &config))
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();

    Ok(json!({
        "visibleIds": visible_ids,
    }))
}

fn evaluate_daemon_persistence(input: &Value) -> Result<Value> {
    let request_id = input
        .get("requestId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("daemon-persistence input.requestId is required"))?;
    let messages = build_messages(
        input
            .get("messages")
            .ok_or_else(|| anyhow::anyhow!("daemon-persistence input.messages is required"))?,
    )?;

    let temp_path =
        std::env::temp_dir().join(format!("a4-conformance-{}.json", uuid::Uuid::new_v4()));

    let mut store = MessageStore::new(100);
    for message in messages {
        store.store(message);
    }
    store.save_to_path(&temp_path)?;
    let loaded = MessageStore::load_from_path(&temp_path)?;
    let _ = fs::remove_file(&temp_path);

    let loaded_json = loaded
        .all_messages()
        .iter()
        .map(message_to_inbox_json)
        .collect::<Vec<_>>();
    let outcome = find_message_outcome(&loaded_json, request_id);
    let message_ids = loaded
        .all_messages()
        .iter()
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();

    Ok(json!({
        "totalMessages": loaded.all_messages().len(),
        "messageIds": message_ids,
        "outcomeId": outcome.as_ref().and_then(|value| {
            value
                .message
                .get("envelope")
                .and_then(|envelope| envelope.get("id"))
                .and_then(|value| value.as_str())
        }),
        "status": outcome.as_ref().and_then(|value| value.status.clone()),
    }))
}

fn outcome_json(outcome: Option<crate::commands::message_lifecycle::MessageOutcome>) -> Value {
    match outcome {
        Some(outcome) => json!({
            "found": true,
            "messageId": outcome.message.get("envelope")
                .and_then(|envelope| envelope.get("id"))
                .and_then(|value| value.as_str()),
            "kind": outcome.kind.as_str(),
            "status": outcome.status,
            "terminal": outcome.terminal,
        }),
        None => json!({
            "found": false,
            "messageId": Value::Null,
            "kind": Value::Null,
            "status": Value::Null,
            "terminal": false,
        }),
    }
}

fn build_messages_json(value: &Value) -> Result<Vec<Value>> {
    Ok(build_messages(value)?
        .iter()
        .map(message_to_inbox_json)
        .collect::<Vec<_>>())
}

fn build_messages(value: &Value) -> Result<Vec<StoredMessage>> {
    let items = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("messages must be an array"))?;
    items.iter().map(build_message).collect()
}

fn build_message(value: &Value) -> Result<StoredMessage> {
    let id = required_str(value, "id")?.to_string();
    let from = required_str(value, "from")?.to_string();
    let to = required_str(value, "to")?.to_string();
    let direction = match required_str(value, "direction")? {
        "inbound" => MessageDirection::Inbound,
        "outbound" => MessageDirection::Outbound,
        other => bail!("Unsupported direction: {}", other),
    };
    let timestamp = value
        .get("timestamp")
        .and_then(|item| item.as_u64())
        .unwrap_or(1);
    let read = value
        .get("read")
        .and_then(|item| item.as_bool())
        .unwrap_or(false);
    let protocol = value
        .get("protocol")
        .and_then(|item| item.as_str())
        .unwrap_or("/agent/msg/1.0.0");
    let envelope_type = value
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or("message");
    let payload = value.get("payload").cloned().unwrap_or_else(|| json!({}));
    let reply_to = value.get("replyTo").and_then(|item| item.as_str());
    let thread_id = value
        .get("threadId")
        .and_then(|item| item.as_str())
        .map(ToOwned::to_owned);

    let mut envelope = json!({
        "id": id.clone(),
        "from": from.clone(),
        "to": to.clone(),
        "type": envelope_type,
        "protocol": protocol,
        "payload": payload,
        "timestamp": timestamp,
    });
    if let Some(reply_to) = reply_to {
        envelope["replyTo"] = json!(reply_to);
    }
    if let Some(thread_id) = thread_id.as_ref() {
        envelope["threadId"] = json!(thread_id);
    }

    Ok(StoredMessage {
        id: id.clone(),
        from,
        to,
        envelope,
        timestamp,
        thread_id,
        read,
        direction,
        e2e: build_e2e(value.get("deliveries"))?,
    })
}

fn build_e2e(value: Option<&Value>) -> Result<Option<StoredMessageE2EMetadata>> {
    let Some(deliveries) = value else {
        return Ok(None);
    };

    let items = deliveries
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("deliveries must be an array"))?;
    if items.is_empty() {
        return Ok(None);
    }

    let deliveries = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let state = match required_str(item, "state")? {
                "pending" => E2EDeliveryState::Pending,
                "accepted" => E2EDeliveryState::Accepted,
                "delivered" => E2EDeliveryState::Delivered,
                "received" => E2EDeliveryState::Received,
                "failed" => E2EDeliveryState::Failed,
                other => bail!("Unsupported E2E delivery state: {}", other),
            };

            Ok(E2EDeliveryMetadata {
                transport: item
                    .get("transport")
                    .and_then(|value| value.as_str())
                    .unwrap_or("session")
                    .to_string(),
                transport_message_id: Some(format!("transport-{}", index)),
                sender_device_id: item
                    .get("senderDeviceId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("sender-1")
                    .to_string(),
                receiver_device_id: item
                    .get("receiverDeviceId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("receiver-1")
                    .to_string(),
                session_id: item
                    .get("sessionId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("session-1")
                    .to_string(),
                state,
                recorded_at: item
                    .get("recordedAt")
                    .and_then(|value| value.as_u64())
                    .unwrap_or((index + 1) as u64),
                used_skipped_message_key: None,
                error: item
                    .get("error")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Some(StoredMessageE2EMetadata {
        deliveries,
        retry: None,
    }))
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(|item| item.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing string field '{}'", field))
}
