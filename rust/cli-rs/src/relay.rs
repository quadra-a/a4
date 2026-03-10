/// CVP-0011 WebSocket relay client.
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::config::{resolve_reachability_policy, Config, EndorsementV2};
use crate::identity::KeyPair;
use crate::protocol::{
    build_endorse_message, build_hello_message, build_hello_signature_payload,
    build_simple_message, build_trust_query_message, cbor_decode_value, AgentCard, CborValue,
    TrustResultMessage,
};

pub const DEFAULT_RELAY: &str = "ws://relay-sg-1.quadra-a.com:8080";

#[derive(Debug, Deserialize)]
struct DiscoveredAgentEnvelope {
    did: Option<String>,
    #[serde(default)]
    trust: Option<Value>,
    card: AgentCard,
}

fn normalize_relay_endpoint(endpoint: &str) -> Option<String> {
    let normalized = endpoint.trim();
    if normalized.is_empty() {
        return None;
    }

    if normalized.starts_with("ws://") || normalized.starts_with("wss://") {
        Some(normalized.to_string())
    } else {
        None
    }
}

pub fn resolve_relay_urls(explicit: Option<&str>, config: Option<&Config>) -> Vec<String> {
    let mut relay_urls = resolve_reachability_policy(explicit, config).bootstrap_providers;
    relay_urls.retain(|relay_url| !relay_url.trim().is_empty());
    if relay_urls.is_empty() {
        relay_urls.push(DEFAULT_RELAY.to_string());
    }
    relay_urls
}

#[allow(dead_code)]
pub fn resolve_relay_url(explicit: Option<&str>, config: Option<&Config>) -> String {
    resolve_relay_urls(explicit, config)
        .into_iter()
        .next()
        .unwrap_or_else(|| DEFAULT_RELAY.to_string())
}

pub async fn connect_first_available(
    explicit: Option<&str>,
    config: Option<&Config>,
    did: &str,
    card: &AgentCard,
    keypair: &KeyPair,
) -> Result<(RelaySession, String)> {
    let relay_urls = resolve_relay_urls(explicit, config);
    connect_first_available_from_list(&relay_urls, did, card, keypair).await
}

pub async fn connect_first_available_from_list(
    relay_urls: &[String],
    did: &str,
    card: &AgentCard,
    keypair: &KeyPair,
) -> Result<(RelaySession, String)> {
    let candidates = if relay_urls.is_empty() {
        vec![DEFAULT_RELAY.to_string()]
    } else {
        relay_urls.to_vec()
    };

    let mut errors = Vec::new();
    for relay_url in candidates {
        match RelaySession::connect(&relay_url, did, card, keypair).await {
            Ok(session) => return Ok((session, relay_url)),
            Err(error) => errors.push(format!("{}: {}", relay_url, error)),
        }
    }

    anyhow::bail!(
        "Failed to connect to any relay: {}",
        if errors.is_empty() {
            "no configured relays".to_string()
        } else {
            errors.join(" | ")
        }
    )
}

pub fn has_relay_capability(card: &AgentCard) -> bool {
    card.capabilities.iter().any(|capability| capability.id.starts_with("relay/"))
}

pub fn extract_relay_endpoints(card: &AgentCard) -> Vec<String> {
    if !has_relay_capability(card) {
        return Vec::new();
    }

    let mut seen = HashSet::new();
    let mut endpoints = Vec::new();
    for endpoint in &card.endpoints {
        if let Some(normalized) = normalize_relay_endpoint(endpoint) {
            if seen.insert(normalized.clone()) {
                endpoints.push(normalized);
            }
        }
    }
    endpoints
}

pub fn parse_discovered_agent_card(value: Value) -> Option<AgentCard> {
    if let Ok(card) = serde_json::from_value::<AgentCard>(value.clone()) {
        return Some(card);
    }

    if let Ok(mut envelope) = serde_json::from_value::<DiscoveredAgentEnvelope>(value) {
        if let Some(did) = envelope.did.take() {
            envelope.card.did = did;
        }
        if envelope.card.trust.is_none() {
            envelope.card.trust = envelope.trust.take();
        }
        return Some(envelope.card);
    }

    None
}

pub fn extract_discovered_relay_endpoints(values: &[Value]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut endpoints = Vec::new();

    for value in values {
        let Some(card) = parse_discovered_agent_card(value.clone()) else {
            continue;
        };

        for endpoint in extract_relay_endpoints(&card) {
            if seen.insert(endpoint.clone()) {
                endpoints.push(endpoint);
            }
        }
    }

    endpoints
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = futures_util::stream::SplitSink<WsStream, Message>;
type WsSource = futures_util::stream::SplitStream<WsStream>;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct RelaySession {
    pub relay_id: String,
    pub peers: u64,
    sink: WsSink,
    stream: WsSource,
}

impl RelaySession {
    pub async fn connect(
        relay_url: &str,
        did: &str,
        card: &AgentCard,
        keypair: &KeyPair,
    ) -> Result<Self> {
        let (ws_stream, _) = connect_async(relay_url)
            .await
            .with_context(|| format!("Failed to connect to relay {}", relay_url))?;

        let (mut sink, mut stream) = ws_stream.split();

        let config = crate::config::load_config().ok();
        let invite_token = crate::config::resolve_relay_invite_token(None, config.as_ref());
        let timestamp = now_ms();
        let hello_payload =
            build_hello_signature_payload(did, card, timestamp, invite_token.as_deref())?;
        let signature = keypair.sign(&hello_payload);
        let hello_bytes =
            build_hello_message(did, card, timestamp, signature, invite_token.as_deref())?;
        sink.send(Message::Binary(hello_bytes)).await?;

        // Wait for WELCOME
        let welcome_raw = timeout(Duration::from_secs(10), stream.next())
            .await
            .context("Timeout waiting for WELCOME")?
            .ok_or_else(|| anyhow::anyhow!("Relay closed before WELCOME"))??;

        let msg = decode_relay_message(welcome_raw)?;
        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type != "WELCOME" {
            anyhow::bail!("Expected WELCOME, got: {}", msg_type);
        }

        let relay_id = msg
            .get("relayId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let peers = msg.get("peers").and_then(|v| v.as_u64()).unwrap_or(0);

        Ok(RelaySession {
            relay_id,
            peers,
            sink,
            stream,
        })
    }

    pub async fn send_raw(&mut self, bytes: Vec<u8>) -> Result<()> {
        self.sink.send(Message::Binary(bytes)).await?;
        Ok(())
    }

    pub async fn ping(&mut self) -> Result<()> {
        let bytes = build_simple_message(vec![("type", CborValue::Text("PING".to_string()))])?;
        self.send_raw(bytes).await
    }

    pub async fn publish_card(&mut self) -> Result<()> {
        let bytes =
            build_simple_message(vec![("type", CborValue::Text("PUBLISH_CARD".to_string()))])?;
        self.send_raw(bytes).await
    }

    pub async fn unpublish_card(&mut self) -> Result<()> {
        let bytes = build_simple_message(vec![(
            "type",
            CborValue::Text("UNPUBLISH_CARD".to_string()),
        )])?;
        self.send_raw(bytes).await
    }

    pub async fn goodbye(&mut self) -> Result<()> {
        let bytes = build_simple_message(vec![("type", CborValue::Text("GOODBYE".to_string()))])?;
        let _ = self.send_raw(bytes).await;
        let _ = self.sink.close().await;
        Ok(())
    }

    pub async fn ack(&mut self, message_id: &str) -> Result<()> {
        let bytes = build_simple_message(vec![
            ("type", CborValue::Text("ACK".to_string())),
            ("messageId", CborValue::Text(message_id.to_string())),
        ])?;
        self.send_raw(bytes).await
    }

    pub async fn send_envelope(&mut self, to_did: &str, envelope_bytes: Vec<u8>) -> Result<()> {
        use crate::protocol::{cbor_x_encode, CborXValue};
        let msg = CborXValue::Map(vec![
            ("type", CborXValue::Str("SEND")),
            ("to", CborXValue::Str(to_did)),
            ("envelope", CborXValue::Bytes(&envelope_bytes)),
        ]);
        self.send_raw(cbor_x_encode(&msg)).await
    }

    pub async fn discover(
        &mut self,
        query: Option<&str>,
        capability: Option<&str>,
        min_trust: Option<f64>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>> {
        use ciborium::Value as CV;
        let mut fields = vec![(
            CV::Text("type".to_string()),
            CV::Text("DISCOVER".to_string()),
        )];
        if let Some(query) = query {
            fields.push((CV::Text("query".to_string()), CV::Text(query.to_string())));
        }
        if let Some(capability) = capability {
            fields.push((
                CV::Text("capability".to_string()),
                CV::Text(capability.to_string()),
            ));
        }
        if let Some(min_trust) = min_trust {
            fields.push((CV::Text("minTrust".to_string()), CV::Float(min_trust)));
        }
        if let Some(l) = limit {
            fields.push((
                CV::Text("limit".to_string()),
                CV::Integer(ciborium::value::Integer::from(l)),
            ));
        }
        let map = CV::Map(fields);
        let mut buf = Vec::new();
        ciborium::into_writer(&map, &mut buf)?;
        self.send_raw(buf).await?;

        // Poll for DISCOVERED, responding to PING along the way
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Timeout waiting for DISCOVERED");
            }
            let msg_raw = timeout(remaining, self.stream.next())
                .await
                .context("Timeout waiting for DISCOVERED")?
                .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;

            let msg = decode_relay_message(msg_raw)?;
            match msg.get("type").and_then(|v| v.as_str()) {
                Some("DISCOVERED") => {
                    let agents = msg
                        .get("agents")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    return Ok(agents);
                }
                Some("PING") => {
                    let pong =
                        build_simple_message(vec![("type", CborValue::Text("PONG".to_string()))])?;
                    self.sink.send(Message::Binary(pong)).await?;
                }
                _ => {}
            }
        }
    }

    pub async fn fetch_card(&mut self, did: &str) -> Result<Option<AgentCard>> {
        let bytes = build_simple_message(vec![
            ("type", CborValue::Text("FETCH_CARD".to_string())),
            ("did", CborValue::Text(did.to_string())),
        ])?;
        self.send_raw(bytes).await?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Timeout waiting for CARD");
            }
            let msg_raw = timeout(remaining, self.stream.next())
                .await
                .context("Timeout waiting for CARD")?
                .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;

            let msg = decode_relay_message(msg_raw)?;
            match msg.get("type").and_then(|v| v.as_str()) {
                Some("CARD") if msg.get("did").and_then(|v| v.as_str()) == Some(did) => {
                    let card = msg.get("card").cloned().unwrap_or(Value::Null);
                    if card.is_null() {
                        return Ok(None);
                    }
                    return Ok(Some(serde_json::from_value(card)?));
                }
                Some("PING") => {
                    let pong =
                        build_simple_message(vec![("type", CborValue::Text("PONG".to_string()))])?;
                    self.sink.send(Message::Binary(pong)).await?;
                }
                _ => {}
            }
        }
    }

    /// Wait for the next DELIVER message, ACK it, return (messageId, from, envelope_bytes).
    pub async fn next_deliver(&mut self) -> Result<(String, String, Vec<u8>)> {
        loop {
            let msg_raw = self
                .stream
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;
            let msg = decode_relay_message(msg_raw)?;
            match msg.get("type").and_then(|v| v.as_str()) {
                Some("DELIVER") => {
                    let message_id = msg
                        .get("messageId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let from = msg
                        .get("from")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let envelope_bytes = extract_bytes_field(&msg, "envelope");
                    self.ack(&message_id).await?;
                    return Ok((message_id, from, envelope_bytes));
                }
                Some("PING") => {
                    let pong =
                        build_simple_message(vec![("type", CborValue::Text("PONG".to_string()))])?;
                    self.sink.send(Message::Binary(pong)).await?;
                }
                Some("DELIVERY_REPORT") => {
                    let status = msg
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let message_id = msg
                        .get("messageId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    return Ok((message_id, format!("__delivery_report:{}", status), vec![]));
                }
                _ => {}
            }
        }
    }

    pub async fn wait_delivery_report(&mut self) -> Result<String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Timeout waiting for delivery report");
            }
            let msg_raw = timeout(remaining, self.stream.next())
                .await
                .context("Timeout waiting for delivery report")?
                .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;

            let msg = decode_relay_message(msg_raw)?;
            match msg.get("type").and_then(|v| v.as_str()) {
                Some("DELIVERY_REPORT") => {
                    let status = msg
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    return Ok(status);
                }
                Some("PING") => {
                    let pong =
                        build_simple_message(vec![("type", CborValue::Text("PONG".to_string()))])?;
                    self.sink.send(Message::Binary(pong)).await?;
                }
                _ => {}
            }
        }
    }

    /// Publish an endorsement to the relay (CVP-0017)
    pub async fn publish_endorsement(&mut self, endorsement: &EndorsementV2) -> Result<()> {
        let bytes = build_endorse_message(endorsement)?;
        self.send_raw(bytes).await?;

        // Wait for acknowledgment or error
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Timeout waiting for endorsement acknowledgment");
            }
            let msg_raw = timeout(remaining, self.stream.next())
                .await
                .context("Timeout waiting for endorsement response")?
                .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;

            let msg = decode_relay_message(msg_raw)?;
            match msg.get("type").and_then(|v| v.as_str()) {
                Some("ENDORSE_ACK") => {
                    return Ok(());
                }
                Some("ERROR") => {
                    let error_msg = msg
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error");
                    anyhow::bail!("Relay error publishing endorsement: {}", error_msg);
                }
                Some("PING") => {
                    let pong =
                        build_simple_message(vec![("type", CborValue::Text("PONG".to_string()))])?;
                    self.sink.send(Message::Binary(pong)).await?;
                }
                _ => {}
            }
        }
    }

    /// Query endorsements from the relay (CVP-0017)
    pub async fn query_endorsements(
        &mut self,
        target_did: &str,
        domain: Option<&str>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<TrustResultMessage> {
        let bytes = build_trust_query_message(target_did, domain, limit, offset)?;
        self.send_raw(bytes).await?;

        // Wait for TRUST_RESULT
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("Timeout waiting for trust query result");
            }
            let msg_raw = timeout(remaining, self.stream.next())
                .await
                .context("Timeout waiting for trust query response")?
                .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;

            let msg = decode_relay_message(msg_raw)?;
            match msg.get("type").and_then(|v| v.as_str()) {
                Some("TRUST_RESULT") => {
                    let endorsements = msg
                        .get("endorsements")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| {
                                    serde_json::from_value::<crate::protocol::RelayEndorsement>(
                                        v.clone(),
                                    )
                                    .ok()
                                })
                                .map(crate::protocol::relay_endorsement_to_local)
                                .collect()
                        })
                        .unwrap_or_default();

                    let total_count = msg
                        .get("endorsementCount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;

                    let average_score = msg
                        .get("averageScore")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);

                    let next_cursor = msg
                        .get("nextCursor")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    return Ok(TrustResultMessage {
                        endorsements,
                        total_count,
                        average_score,
                        next_cursor,
                    });
                }
                Some("ERROR") => {
                    let error_msg = msg
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error");
                    anyhow::bail!("Relay error querying endorsements: {}", error_msg);
                }
                Some("PING") => {
                    let pong =
                        build_simple_message(vec![("type", CborValue::Text("PONG".to_string()))])?;
                    self.sink.send(Message::Binary(pong)).await?;
                }
                _ => {}
            }
        }
    }
}

fn decode_relay_message(msg: Message) -> Result<Value> {
    match msg {
        Message::Binary(data) => cbor_decode_value(&data),
        Message::Text(text) => Ok(serde_json::from_str(&text)?),
        Message::Close(frame) => {
            let reason = frame
                .map(|f| format!("{} (code {})", f.reason, f.code))
                .unwrap_or_else(|| "no reason given".to_string());
            anyhow::bail!("Connection closed by relay: {}", reason)
        }
        other => anyhow::bail!("Unexpected WebSocket message: {:?}", other),
    }
}

fn extract_bytes_field(msg: &Value, field: &str) -> Vec<u8> {
    match msg.get(field) {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_u64().and_then(|b| u8::try_from(b).ok()))
            .collect(),
        Some(Value::String(s)) => hex::decode(s).unwrap_or_else(|_| s.as_bytes().to_vec()),
        Some(Value::Object(obj)) => {
            if obj.get("type").and_then(|value| value.as_str()) == Some("Buffer") {
                if let Some(data) = obj.get("data").and_then(|value| value.as_array()) {
                    return data
                        .iter()
                        .filter_map(|value| value.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                        .collect();
                }
            }

            if obj.is_empty() {
                return vec![];
            }

            let mut indexed = obj
                .iter()
                .map(|(key, value)| {
                    let index = key.parse::<usize>().ok();
                    let byte = value.as_u64().and_then(|value| u8::try_from(value).ok());
                    index.zip(byte)
                })
                .collect::<Option<Vec<_>>>();

            if let Some(entries) = indexed.as_mut() {
                if entries.len() == obj.len() {
                    entries.sort_by_key(|(index, _)| *index);
                    let is_dense = entries
                        .iter()
                        .enumerate()
                        .all(|(expected, (actual, _))| *actual == expected);
                    if is_dense {
                        return entries.iter().map(|(_, byte)| *byte).collect();
                    }
                }
            }

            serde_json::to_vec(&Value::Object(obj.clone())).unwrap_or_default()
        }
        Some(value) if !value.is_null() => serde_json::to_vec(value).unwrap_or_default(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_bytes_field, extract_discovered_relay_endpoints};
    use serde_json::{json, Value};

    #[test]
    fn reconstructs_buffer_objects_from_node_json_encoding() {
        let msg = json!({
            "envelope": {
                "type": "Buffer",
                "data": [123, 34, 105, 100, 34, 58, 34, 109, 115, 103, 45, 98, 117, 102, 34, 125]
            }
        });

        let bytes = extract_bytes_field(&msg, "envelope");
        let envelope: Value =
            serde_json::from_slice(&bytes).expect("buffer object should reconstruct");

        assert_eq!(
            envelope.get("id").and_then(|value| value.as_str()),
            Some("msg-buf")
        );
    }

    #[test]
    fn reconstructs_byte_objects_from_json_encoded_uint8_arrays() {
        let msg = json!({
            "envelope": {
                "0": 123,
                "1": 34,
                "2": 105,
                "3": 100,
                "4": 34,
                "5": 58,
                "6": 34,
                "7": 109,
                "8": 115,
                "9": 103,
                "10": 45,
                "11": 51,
                "12": 34,
                "13": 125
            }
        });

        let bytes = extract_bytes_field(&msg, "envelope");
        let envelope: Value =
            serde_json::from_slice(&bytes).expect("typed-array object should reconstruct");

        assert_eq!(
            envelope.get("id").and_then(|value| value.as_str()),
            Some("msg-3")
        );
    }

    #[test]
    fn extracts_inline_object_envelope_as_json_bytes() {
        let msg = json!({
            "envelope": {
                "id": "msg-1",
                "protocol": "/shell/exec/1.0.0",
                "payload": {
                    "status": "success"
                }
            }
        });

        let bytes = extract_bytes_field(&msg, "envelope");
        let envelope: Value =
            serde_json::from_slice(&bytes).expect("inline envelope should serialize");

        assert_eq!(
            envelope.get("id").and_then(|value| value.as_str()),
            Some("msg-1")
        );
        assert_eq!(
            envelope.get("protocol").and_then(|value| value.as_str()),
            Some("/shell/exec/1.0.0")
        );
        assert_eq!(
            envelope
                .get("payload")
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str()),
            Some("success")
        );
    }

    #[test]
    fn falls_back_to_utf8_for_non_hex_string_envelopes() {
        let msg = json!({
            "envelope": r#"{"id":"msg-2","protocol":"highway1/chat/1.0"}"#
        });

        let bytes = extract_bytes_field(&msg, "envelope");
        let envelope: Value =
            serde_json::from_slice(&bytes).expect("json string envelope should serialize");

        assert_eq!(
            envelope.get("id").and_then(|value| value.as_str()),
            Some("msg-2")
        );
        assert_eq!(
            envelope.get("protocol").and_then(|value| value.as_str()),
            Some("highway1/chat/1.0")
        );
    }

    #[test]
    fn extracts_discovered_relay_endpoints_from_cards() {
        let discovered = vec![
            json!({
                "did": "did:agent:zrelay1",
                "card": {
                    "did": "did:agent:zrelay1",
                    "name": "Relay One",
                    "description": "relay",
                    "version": "1.0.0",
                    "capabilities": [{
                        "id": "relay/message-routing",
                        "name": "Relay",
                        "description": "routes messages"
                    }],
                    "endpoints": ["ws://relay-one.example", "https://ignore.example"],
                    "timestamp": 1,
                    "signature": "sig"
                }
            }),
            json!({
                "did": "did:agent:zrelay2",
                "card": {
                    "did": "did:agent:zrelay2",
                    "name": "Relay Two",
                    "description": "relay",
                    "version": "1.0.0",
                    "capabilities": [{
                        "id": "relay/large-file",
                        "name": "Relay",
                        "description": "moves files"
                    }],
                    "endpoints": ["wss://relay-two.example", "ws://relay-one.example"],
                    "timestamp": 2,
                    "signature": "sig-2"
                }
            }),
        ];

        let endpoints = extract_discovered_relay_endpoints(&discovered);
        assert_eq!(
            endpoints,
            vec![
                "ws://relay-one.example".to_string(),
                "wss://relay-two.example".to_string(),
            ]
        );
    }

    #[test]
    fn ignores_non_relay_discovery_results() {
        let discovered = vec![json!({
            "did": "did:agent:zagent",
            "card": {
                "did": "did:agent:zagent",
                "name": "Worker",
                "description": "not a relay",
                "version": "1.0.0",
                "capabilities": [{
                    "id": "agent/research",
                    "name": "Research",
                    "description": "does research"
                }],
                "endpoints": ["ws://not-a-relay.example"],
                "timestamp": 3,
                "signature": "sig-3"
            }
        })];

        assert!(extract_discovered_relay_endpoints(&discovered).is_empty());
    }

}
