use anyhow::{bail, Result};
use serde_json::Value;

const TERMINAL_OUTCOME_STATUSES: &[&str] =
    &["success", "error", "rejected", "cancelled", "timeout"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageOutcomeKind {
    Reply,
    Result,
}

impl MessageOutcomeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Result => "result",
        }
    }
}

#[derive(Debug, Clone)]
pub struct MessageOutcome {
    pub kind: MessageOutcomeKind,
    pub message: Value,
    pub status: Option<String>,
    pub job_id: Option<String>,
    pub terminal: bool,
}

#[derive(Debug, Clone)]
pub struct MessageOutcomeTracker {
    request_id: String,
    correlated_job_id: Option<String>,
    correlated_from_did: Option<String>,
    correlated_protocol: Option<String>,
}

impl MessageOutcomeTracker {
    pub fn new(request_id: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            correlated_job_id: None,
            correlated_from_did: None,
            correlated_protocol: None,
        }
    }

    pub fn observe(&mut self, message: &Value) -> Option<MessageOutcome> {
        if direction(message) != Some("inbound") {
            return None;
        }

        let direct_match = reply_to(message) == Some(self.request_id.as_str());
        let job_id = payload_job_id(message);
        let same_job = self
            .correlated_job_id
            .as_deref()
            .is_some_and(|value| job_id.as_deref() == Some(value));
        let same_sender = self
            .correlated_from_did
            .as_deref()
            .map_or(true, |value| source_did(message) == Some(value));
        let same_protocol = self
            .correlated_protocol
            .as_deref()
            .map_or(true, |value| protocol(message) == Some(value));

        if !direct_match && !(same_job && same_sender && same_protocol) {
            return None;
        }

        if direct_match {
            self.correlated_from_did = source_did(message).map(ToString::to_string);
            self.correlated_protocol = protocol(message).map(ToString::to_string);
            if let Some(job_id) = job_id.as_ref() {
                self.correlated_job_id = Some(job_id.clone());
            }
        }

        Some(build_message_outcome(&self.request_id, message))
    }
}

pub fn find_message_outcome(messages: &[Value], request_id: &str) -> Option<MessageOutcome> {
    let mut tracker = MessageOutcomeTracker::new(request_id);
    let mut latest_outcome = None;

    for message in sort_messages_by_timestamp(messages) {
        let Some(outcome) = tracker.observe(&message) else {
            continue;
        };
        let is_terminal = outcome.terminal;
        latest_outcome = Some(outcome);
        if is_terminal {
            return latest_outcome;
        }
    }

    latest_outcome
}

pub fn collect_correlated_lifecycle_messages(messages: &[Value], request_id: &str) -> Vec<Value> {
    let mut tracker = MessageOutcomeTracker::new(request_id);
    let mut collected = Vec::new();

    for message in sort_messages_by_timestamp(messages) {
        if tracker.observe(&message).is_some() && envelope_type(&message) == Some("message") {
            collected.push(message);
        }
    }

    collected
}

pub fn resolve_request_id_from_message(
    message: Option<&Value>,
    inbox_messages: &[Value],
) -> Option<String> {
    let message = message?;

    if direction(message) == Some("outbound") {
        return message_id(message).map(ToString::to_string);
    }

    if let Some(reply_to) = reply_to(message) {
        return Some(reply_to.to_string());
    }

    let job_id = payload_job_id(message)?;
    let source = source_did(message)?;
    let message_protocol = protocol(message)?;

    sort_messages_by_timestamp(inbox_messages)
        .into_iter()
        .find(|candidate| {
            direction(candidate) == Some("inbound")
                && source_did(candidate) == Some(source)
                && protocol(candidate) == Some(message_protocol)
                && reply_to(candidate).is_some()
                && payload_job_id(candidate).as_deref() == Some(job_id.as_str())
        })
        .and_then(|candidate| reply_to(&candidate).map(ToString::to_string))
}

pub fn match_unique_id(messages: &[Value], suffix: &str) -> Result<Option<String>> {
    let mut matches = messages
        .iter()
        .filter_map(message_id)
        .filter(|value| value.ends_with(suffix))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    matches.sort();
    matches.dedup();

    if matches.len() > 1 {
        bail!("Multiple messages match ID suffix: {}", suffix);
    }

    Ok(matches.into_iter().next())
}

pub fn sort_messages_by_timestamp(messages: &[Value]) -> Vec<Value> {
    let mut sorted = messages.to_vec();
    sorted.sort_by_key(|message| message_timestamp(message).unwrap_or(0));
    sorted
}

pub fn is_terminal_outcome_status(status: Option<&str>) -> bool {
    status.is_some_and(|value| TERMINAL_OUTCOME_STATUSES.contains(&value))
}

pub fn envelope_type(message: &Value) -> Option<&str> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("type"))
        .and_then(|value| value.as_str())
}

pub fn envelope_payload(message: &Value) -> Option<&Value> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("payload"))
}

pub fn message_id(message: &Value) -> Option<&str> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("id"))
        .and_then(|value| value.as_str())
}

pub fn direction(message: &Value) -> Option<&str> {
    message.get("direction").and_then(|value| value.as_str())
}

pub fn reply_to(message: &Value) -> Option<&str> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("replyTo"))
        .and_then(|value| value.as_str())
}

pub fn thread_id(message: &Value) -> Option<&str> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("threadId"))
        .and_then(|value| value.as_str())
}

pub fn protocol(message: &Value) -> Option<&str> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("protocol"))
        .and_then(|value| value.as_str())
}

pub fn target_did(message: &Value) -> Option<&str> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("to"))
        .and_then(|value| value.as_str())
}

pub fn source_did(message: &Value) -> Option<&str> {
    message
        .get("envelope")
        .and_then(|envelope| envelope.get("from"))
        .and_then(|value| value.as_str())
}

pub fn message_timestamp(message: &Value) -> Option<u64> {
    message
        .get("receivedAt")
        .or_else(|| message.get("sentAt"))
        .or_else(|| {
            message
                .get("envelope")
                .and_then(|envelope| envelope.get("timestamp"))
        })
        .and_then(|value| value.as_u64())
}

pub fn payload_status(message: &Value) -> Option<String> {
    envelope_payload(message)
        .and_then(|payload| payload.get("status"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

pub fn payload_job_id(message: &Value) -> Option<String> {
    envelope_payload(message)
        .and_then(|payload| payload.get("jobId"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn build_message_outcome(_request_id: &str, message: &Value) -> MessageOutcome {
    let kind = if envelope_type(message) == Some("reply") {
        MessageOutcomeKind::Reply
    } else {
        MessageOutcomeKind::Result
    };
    let status = payload_status(message);
    let terminal =
        kind == MessageOutcomeKind::Reply || is_terminal_outcome_status(status.as_deref());

    MessageOutcome {
        kind,
        message: message.clone(),
        status,
        job_id: payload_job_id(message),
        terminal,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        collect_correlated_lifecycle_messages, find_message_outcome, match_unique_id,
        resolve_request_id_from_message,
    };
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
                "from": "did:agent:worker",
                "to": "did:agent:sender",
                "type": msg_type,
                "protocol": "/jobs/1.0.0",
                "payload": payload,
                "timestamp": timestamp,
                "replyTo": reply_to,
            }
        })
    }

    #[test]
    fn resolves_formal_reply_immediately() {
        let reply = make_message(
            "inbound",
            "msg-reply",
            "reply",
            Some("msg-origin"),
            json!({"ok": true}),
            2,
        );

        let outcome = find_message_outcome(&[reply], "msg-origin").expect("reply outcome");

        assert_eq!(outcome.kind.as_str(), "reply");
        assert!(outcome.terminal);
        assert_eq!(
            outcome
                .message
                .get("envelope")
                .and_then(|envelope| envelope.get("id"))
                .and_then(|value| value.as_str()),
            Some("msg-reply")
        );
    }

    #[test]
    fn tracks_async_progress_and_finishes_on_terminal_job_result() {
        let running = make_message(
            "inbound",
            "msg-running",
            "message",
            Some("msg-origin"),
            json!({"status": "running", "jobId": "job-1"}),
            1,
        );
        let success = make_message(
            "inbound",
            "msg-success",
            "message",
            None,
            json!({"status": "success", "jobId": "job-1", "value": 42}),
            2,
        );

        let outcome =
            find_message_outcome(&[success, running], "msg-origin").expect("terminal outcome");

        assert_eq!(outcome.kind.as_str(), "result");
        assert_eq!(outcome.status.as_deref(), Some("success"));
        assert_eq!(outcome.job_id.as_deref(), Some("job-1"));
        assert!(outcome.terminal);
        assert_eq!(
            outcome
                .message
                .get("envelope")
                .and_then(|envelope| envelope.get("id"))
                .and_then(|value| value.as_str()),
            Some("msg-success")
        );
    }

    #[test]
    fn resolves_request_id_from_terminal_result_without_reply_to() {
        let running = make_message(
            "inbound",
            "msg-running",
            "message",
            Some("msg-origin"),
            json!({"status": "running", "jobId": "job-1"}),
            1,
        );
        let success = make_message(
            "inbound",
            "msg-success",
            "message",
            None,
            json!({"status": "success", "jobId": "job-1"}),
            2,
        );

        let resolved = resolve_request_id_from_message(Some(&success), &[running, success.clone()]);
        assert_eq!(resolved.as_deref(), Some("msg-origin"));
    }

    #[test]
    fn collects_only_correlated_async_lifecycle_messages() {
        let running = make_message(
            "inbound",
            "msg-running",
            "message",
            Some("msg-origin"),
            json!({"status": "running", "jobId": "job-1"}),
            1,
        );
        let success = make_message(
            "inbound",
            "msg-success",
            "message",
            None,
            json!({"status": "success", "jobId": "job-1"}),
            2,
        );
        let unrelated = make_message(
            "inbound",
            "msg-other",
            "message",
            Some("msg-else"),
            json!({"status": "running", "jobId": "job-2"}),
            3,
        );

        let collected =
            collect_correlated_lifecycle_messages(&[unrelated, success, running], "msg-origin");
        let ids = collected
            .iter()
            .filter_map(|message| {
                message
                    .get("envelope")
                    .and_then(|envelope| envelope.get("id"))
                    .and_then(|value| value.as_str())
            })
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["msg-running", "msg-success"]);
    }

    #[test]
    fn matches_unique_suffixes() {
        let left = make_message("outbound", "msg-left-123", "message", None, json!({}), 1);
        let right = make_message("outbound", "msg-right-456", "message", None, json!({}), 2);

        let matched = match_unique_id(&[left, right], "456").expect("suffix lookup");
        assert_eq!(matched.as_deref(), Some("msg-right-456"));
    }
}
