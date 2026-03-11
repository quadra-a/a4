use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const DEFAULT_MAX_STORED_MESSAGES: usize = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageDirection {
    Inbound,
    Outbound,
}

impl MessageDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageDirection::Inbound => "inbound",
            MessageDirection::Outbound => "outbound",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub envelope: Value,
    pub timestamp: u64,
    #[serde(default, rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub read: bool,
    pub direction: MessageDirection,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionSummary {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "peerDid")]
    pub peer_did: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    #[serde(rename = "lastMessageAt")]
    pub last_message_at: u64,
    #[serde(rename = "messageCount")]
    pub message_count: usize,
    pub title: String,
}

pub fn parse_envelope_value(envelope_bytes: &[u8]) -> Result<Value> {
    if let Ok(value) = quadra_a_core::protocol::cbor_decode_value(envelope_bytes) {
        return Ok(value);
    }

    serde_json::from_slice::<Value>(envelope_bytes).context("Invalid envelope payload")
}

pub fn effective_thread_id(message: &StoredMessage) -> String {
    message
        .thread_id
        .clone()
        .unwrap_or_else(|| format!("direct:{}", peer_did(message)))
}

pub fn peer_did(message: &StoredMessage) -> String {
    match message.direction {
        MessageDirection::Inbound => message.from.clone(),
        MessageDirection::Outbound => message.to.clone(),
    }
}

fn payload_text(payload: Option<&Value>) -> Option<String> {
    payload.and_then(|payload| {
        payload
            .get("text")
            .or_else(|| payload.get("message"))
            .and_then(|value| value.as_str())
            .map(|text| text.to_string())
    })
}

fn session_title(message: &StoredMessage) -> String {
    payload_text(message.envelope.get("payload"))
        .map(|text| {
            if text.chars().count() > 60 {
                text.chars().take(60).collect::<String>() + "..."
            } else {
                text
            }
        })
        .unwrap_or_else(|| format!("Conversation with {}", peer_did(message)))
}

#[derive(Clone, Debug)]
pub struct MessageStore {
    messages: Vec<StoredMessage>,
    max_messages: usize,
}

impl Default for MessageStore {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_STORED_MESSAGES)
    }
}

impl MessageStore {
    pub fn new(max_messages: usize) -> Self {
        Self {
            messages: Vec::new(),
            max_messages: max_messages.max(1),
        }
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn store(&mut self, message: StoredMessage) {
        self.messages.push(message);
        let msg_len = self.messages.len();
        if msg_len > self.max_messages {
            self.messages.drain(0..msg_len - self.max_messages);
        }
    }

    pub fn inbox_page(
        &mut self,
        limit: usize,
        unread_only: bool,
        thread_id: Option<&str>,
    ) -> (Vec<StoredMessage>, usize) {
        let mut matching: Vec<_> = self
            .messages
            .iter_mut()
            .filter(|message| {
                if unread_only && message.read {
                    return false;
                }

                if let Some(thread_id) = thread_id {
                    let effective = effective_thread_id(message);
                    if message.thread_id.as_deref() != Some(thread_id) && effective != thread_id {
                        return false;
                    }
                }

                true
            })
            .collect();

        matching.sort_by_key(|message| message.timestamp);
        let total = matching.len();
        let selected = matching.into_iter().rev().take(limit).collect::<Vec<_>>();
        let mut page = Vec::with_capacity(selected.len());
        for message in selected {
            message.read = true;
            page.push(message.clone());
        }

        (page, total)
    }

    pub fn session_summaries(&self, peer_filter: Option<&str>) -> Vec<SessionSummary> {
        let mut sessions = HashMap::<String, SessionSummary>::new();

        for message in &self.messages {
            let peer = peer_did(message);
            if let Some(peer_filter) = peer_filter {
                if peer != peer_filter {
                    continue;
                }
            }

            let thread_id = effective_thread_id(message);
            let entry = sessions
                .entry(thread_id.clone())
                .or_insert_with(|| SessionSummary {
                    thread_id: thread_id.clone(),
                    peer_did: peer.clone(),
                    started_at: message.timestamp,
                    last_message_at: message.timestamp,
                    message_count: 0,
                    title: session_title(message),
                });

            entry.peer_did = peer;
            entry.started_at = entry.started_at.min(message.timestamp);
            entry.last_message_at = entry.last_message_at.max(message.timestamp);
            entry.message_count += 1;
            if entry.title.starts_with("Conversation with") {
                entry.title = session_title(message);
            }
        }

        let mut sessions = sessions.into_values().collect::<Vec<_>>();
        sessions.sort_by(|left, right| right.last_message_at.cmp(&left.last_message_at));
        sessions
    }

    pub fn session_messages(&self, thread_id: &str, limit: usize) -> (Vec<StoredMessage>, usize) {
        let mut messages = self
            .messages
            .iter()
            .filter(|message| effective_thread_id(message) == thread_id)
            .cloned()
            .collect::<Vec<_>>();
        messages.sort_by_key(|message| message.timestamp);

        let total = messages.len();
        let start = total.saturating_sub(limit);
        let page = messages.into_iter().skip(start).collect::<Vec<_>>();
        (page, total)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        effective_thread_id, parse_envelope_value, MessageDirection, MessageStore, StoredMessage,
    };
    use serde_json::json;

    #[test]
    fn groups_direct_messages_into_synthetic_sessions() {
        let mut store = MessageStore::default();
        store.store(StoredMessage {
            id: "msg-1".to_string(),
            from: "did:agent:alice".to_string(),
            to: "did:agent:me".to_string(),
            envelope: json!({"payload": {"text": "hello"}}),
            timestamp: 10,
            thread_id: None,
            read: false,
            direction: MessageDirection::Inbound,
        });
        store.store(StoredMessage {
            id: "msg-2".to_string(),
            from: "did:agent:me".to_string(),
            to: "did:agent:alice".to_string(),
            envelope: json!({"payload": {"text": "hi back"}}),
            timestamp: 20,
            thread_id: None,
            read: true,
            direction: MessageDirection::Outbound,
        });

        let first = store
            .session_messages("direct:did:agent:alice", 10)
            .0
            .remove(0);
        assert_eq!(effective_thread_id(&first), "direct:did:agent:alice");

        let sessions = store.session_summaries(None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].thread_id, "direct:did:agent:alice");
        assert_eq!(sessions[0].message_count, 2);
        assert_eq!(sessions[0].peer_did, "did:agent:alice");
    }

    #[test]
    fn inbox_page_marks_selected_messages_read() {
        let mut store = MessageStore::new(10);
        store.store(StoredMessage {
            id: "msg-1".to_string(),
            from: "did:agent:alice".to_string(),
            to: "did:agent:me".to_string(),
            envelope: json!({"payload": {"text": "hello"}}),
            timestamp: 10,
            thread_id: None,
            read: false,
            direction: MessageDirection::Inbound,
        });

        let (page, total) = store.inbox_page(10, true, None);
        assert_eq!(total, 1);
        assert_eq!(page.len(), 1);
        assert!(page[0].read);

        let (unread_page, unread_total) = store.inbox_page(10, true, None);
        assert_eq!(unread_total, 0);
        assert!(unread_page.is_empty());
    }

    #[test]
    fn parses_json_envelope_payloads() {
        let envelope = parse_envelope_value(br#"{"id":"msg-1","protocol":"highway1/chat/1.0"}"#)
            .expect("json envelope should parse");

        assert_eq!(envelope.get("id").and_then(|v| v.as_str()), Some("msg-1"));
        assert_eq!(
            envelope.get("protocol").and_then(|v| v.as_str()),
            Some("highway1/chat/1.0")
        );
    }

    #[test]
    fn rejects_invalid_envelope_payloads() {
        let err = parse_envelope_value(&[0xff, 0x00]).expect_err("invalid payload should fail");
        assert!(err.to_string().contains("Invalid envelope payload"));
    }
}
