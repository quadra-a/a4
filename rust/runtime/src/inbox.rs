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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum E2EDeliveryState {
    Pending,
    Sent,
    Received,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct E2EDeliveryMetadata {
    pub transport: String,
    #[serde(rename = "senderDeviceId")]
    pub sender_device_id: String,
    #[serde(rename = "receiverDeviceId")]
    pub receiver_device_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub state: E2EDeliveryState,
    #[serde(rename = "recordedAt")]
    pub recorded_at: u64,
    #[serde(default, rename = "usedSkippedMessageKey", skip_serializing_if = "Option::is_none")]
    pub used_skipped_message_key: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct E2ERetryMetadata {
    #[serde(rename = "replayCount")]
    pub replay_count: u32,
    #[serde(default, rename = "lastRequestedAt", skip_serializing_if = "Option::is_none")]
    pub last_requested_at: Option<u64>,
    #[serde(default, rename = "lastReplayedAt", skip_serializing_if = "Option::is_none")]
    pub last_replayed_at: Option<u64>,
    #[serde(default, rename = "lastReason", skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredMessageE2EMetadata {
    pub deliveries: Vec<E2EDeliveryMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<E2ERetryMetadata>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub e2e: Option<StoredMessageE2EMetadata>,
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

fn build_e2e_delivery_key(delivery: &E2EDeliveryMetadata) -> String {
    format!(
        "{}:{}:{}",
        delivery.sender_device_id, delivery.receiver_device_id, delivery.session_id
    )
}

fn merge_e2e_deliveries(
    existing: &[E2EDeliveryMetadata],
    incoming: &[E2EDeliveryMetadata],
) -> Vec<E2EDeliveryMetadata> {
    let mut merged = std::collections::BTreeMap::<String, E2EDeliveryMetadata>::new();

    for delivery in existing {
        merged.insert(build_e2e_delivery_key(delivery), delivery.clone());
    }

    for delivery in incoming {
        let key = build_e2e_delivery_key(delivery);
        if let Some(current) = merged.get_mut(&key) {
            current.transport = delivery.transport.clone();
            current.state = delivery.state.clone();
            current.recorded_at = delivery.recorded_at;
            if delivery.used_skipped_message_key.is_some() {
                current.used_skipped_message_key = delivery.used_skipped_message_key;
            }
            current.error = match (&delivery.error, &delivery.state) {
                (Some(error), _) => Some(error.clone()),
                (None, E2EDeliveryState::Failed) => current.error.clone(),
                (None, _) => None,
            };
        } else {
            merged.insert(key, delivery.clone());
        }
    }

    merged.into_values().collect()
}

fn merge_message_e2e(existing: &mut StoredMessage, incoming: Option<&StoredMessageE2EMetadata>) {
    let Some(incoming) = incoming else {
        return;
    };

    let merged = merge_e2e_deliveries(
        existing
            .e2e
            .as_ref()
            .map(|metadata| metadata.deliveries.as_slice())
            .unwrap_or(&[]),
        &incoming.deliveries,
    );
    existing.e2e = Some(StoredMessageE2EMetadata {
        deliveries: merged,
        retry: merge_e2e_retry(existing.e2e.as_ref().and_then(|metadata| metadata.retry.clone()), incoming.retry.clone()),
    });
}

fn merge_e2e_retry(
    existing: Option<E2ERetryMetadata>,
    incoming: Option<E2ERetryMetadata>,
) -> Option<E2ERetryMetadata> {
    match (existing, incoming) {
        (None, None) => None,
        (Some(existing), None) => Some(existing),
        (None, Some(incoming)) => Some(incoming),
        (Some(existing), Some(incoming)) => Some(E2ERetryMetadata {
            replay_count: existing.replay_count.max(incoming.replay_count),
            last_requested_at: incoming.last_requested_at.or(existing.last_requested_at),
            last_replayed_at: incoming.last_replayed_at.or(existing.last_replayed_at),
            last_reason: incoming.last_reason.or(existing.last_reason),
        }),
    }
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
        if let Some(existing) = self
            .messages
            .iter_mut()
            .find(|existing| existing.id == message.id && existing.direction == message.direction)
        {
            merge_message_e2e(existing, message.e2e.as_ref());
            return;
        }

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

    pub fn peer_count(&self) -> usize {
        let mut peers = std::collections::HashSet::new();
        for message in &self.messages {
            peers.insert(peer_did(message));
        }
        peers.len()
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

    pub fn upsert_e2e_delivery(
        &mut self,
        message_id: &str,
        direction: MessageDirection,
        delivery: E2EDeliveryMetadata,
    ) -> bool {
        let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.id == message_id && message.direction == direction)
        else {
            return false;
        };

        merge_message_e2e(
            message,
            Some(&StoredMessageE2EMetadata {
                deliveries: vec![delivery],
                retry: None,
            }),
        );
        true
    }

    pub fn upsert_e2e_retry(
        &mut self,
        message_id: &str,
        direction: MessageDirection,
        retry: E2ERetryMetadata,
    ) -> bool {
        let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.id == message_id && message.direction == direction)
        else {
            return false;
        };

        merge_message_e2e(
            message,
            Some(&StoredMessageE2EMetadata {
                deliveries: Vec::new(),
                retry: Some(retry),
            }),
        );
        true
    }

    pub fn get_message(
        &self,
        message_id: &str,
        direction: MessageDirection,
    ) -> Option<StoredMessage> {
        self.messages
            .iter()
            .find(|message| message.id == message_id && message.direction == direction)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        effective_thread_id, parse_envelope_value, E2EDeliveryMetadata, E2EDeliveryState,
        E2ERetryMetadata, MessageDirection, MessageStore, StoredMessage, StoredMessageE2EMetadata,
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
            e2e: None,
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
            e2e: None,
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
            e2e: None,
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
    fn store_dedupes_duplicate_ids_per_direction() {
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
            e2e: None,
        });
        store.store(StoredMessage {
            id: "msg-1".to_string(),
            from: "did:agent:alice".to_string(),
            to: "did:agent:me".to_string(),
            envelope: json!({"payload": {"text": "hello duplicate"}}),
            timestamp: 11,
            thread_id: None,
            read: false,
            direction: MessageDirection::Inbound,
            e2e: None,
        });
        store.store(StoredMessage {
            id: "msg-1".to_string(),
            from: "did:agent:me".to_string(),
            to: "did:agent:alice".to_string(),
            envelope: json!({"payload": {"text": "same id outbound is separate"}}),
            timestamp: 12,
            thread_id: None,
            read: true,
            direction: MessageDirection::Outbound,
            e2e: None,
        });

        assert_eq!(store.len(), 2);
        let (messages, total) = store.inbox_page(10, false, None);
        assert_eq!(total, 2);
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn store_merges_duplicate_e2e_deliveries_per_direction() {
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
            e2e: Some(StoredMessageE2EMetadata {
                deliveries: vec![E2EDeliveryMetadata {
                    transport: "prekey".to_string(),
                    sender_device_id: "device-alice".to_string(),
                    receiver_device_id: "device-me-primary".to_string(),
                    session_id: "session-a".to_string(),
                    state: E2EDeliveryState::Received,
                    recorded_at: 10,
                    used_skipped_message_key: Some(false),
                    error: None,
                }],
                retry: None,
            }),
        });
        store.store(StoredMessage {
            id: "msg-1".to_string(),
            from: "did:agent:alice".to_string(),
            to: "did:agent:me".to_string(),
            envelope: json!({"payload": {"text": "hello duplicate"}}),
            timestamp: 11,
            thread_id: None,
            read: false,
            direction: MessageDirection::Inbound,
            e2e: Some(StoredMessageE2EMetadata {
                deliveries: vec![E2EDeliveryMetadata {
                    transport: "session".to_string(),
                    sender_device_id: "device-alice".to_string(),
                    receiver_device_id: "device-me-secondary".to_string(),
                    session_id: "session-b".to_string(),
                    state: E2EDeliveryState::Received,
                    recorded_at: 11,
                    used_skipped_message_key: Some(true),
                    error: None,
                }],
                retry: None,
            }),
        });

        assert_eq!(store.len(), 1);
        let (messages, total) = store.inbox_page(10, false, None);
        assert_eq!(total, 1);
        assert_eq!(messages[0].e2e.as_ref().expect("e2e metadata").deliveries.len(), 2);
    }

    #[test]
    fn store_merges_outbound_retry_metadata() {
        let mut store = MessageStore::new(10);
        store.store(StoredMessage {
            id: "msg-retry".to_string(),
            from: "did:agent:me".to_string(),
            to: "did:agent:peer".to_string(),
            envelope: json!({"payload": {"text": "retry me"}}),
            timestamp: 10,
            thread_id: None,
            read: true,
            direction: MessageDirection::Outbound,
            e2e: Some(StoredMessageE2EMetadata {
                deliveries: vec![],
                retry: Some(E2ERetryMetadata {
                    replay_count: 0,
                    last_requested_at: Some(100),
                    last_replayed_at: None,
                    last_reason: None,
                }),
            }),
        });

        assert!(store.upsert_e2e_retry(
            "msg-retry",
            MessageDirection::Outbound,
            E2ERetryMetadata {
                replay_count: 1,
                last_requested_at: Some(200),
                last_replayed_at: Some(250),
                last_reason: Some("decrypt-failed".to_string()),
            },
        ));

        let stored = store
            .get_message("msg-retry", MessageDirection::Outbound)
            .expect("message exists");
        assert_eq!(
            stored.e2e.expect("retry metadata").retry,
            Some(E2ERetryMetadata {
                replay_count: 1,
                last_requested_at: Some(200),
                last_replayed_at: Some(250),
                last_reason: Some("decrypt-failed".to_string()),
            })
        );
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
