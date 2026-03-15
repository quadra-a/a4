/// CVP-0011 WebSocket relay client.
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use quadra_a_core::config::{resolve_reachability_policy, Config, EndorsementV2};
use quadra_a_core::e2e::{ClaimedPreKeyBundle, PublishedPreKeyBundle};
use quadra_a_core::identity::KeyPair;
use quadra_a_core::protocol::{
    build_endorse_message, build_hello_message, build_hello_signature_payload,
    build_simple_message, build_trust_query_message, cbor_decode_value, cbor_x_encode_json,
    AgentCard, CborValue, TrustResultMessage,
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

fn discovered_agent_has_valid_card(value: &Value) -> bool {
    let Ok(envelope) = serde_json::from_value::<DiscoveredAgentEnvelope>(value.clone()) else {
        return false;
    };

    if let Some(did) = envelope.did.as_deref() {
        if did != envelope.card.did.as_str() {
            return false;
        }
    }

    envelope.card.verify_signature().unwrap_or(false)
}

fn fetched_card_matches_request(did: &str, card: &AgentCard) -> bool {
    card.did == did && card.verify_signature().unwrap_or(false)
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
    connect_first_available_with_invite_token(explicit, config, did, card, keypair, None).await
}

pub async fn connect_first_available_with_invite_token(
    explicit: Option<&str>,
    config: Option<&Config>,
    did: &str,
    card: &AgentCard,
    keypair: &KeyPair,
    invite_token: Option<&str>,
) -> Result<(RelaySession, String)> {
    let relay_urls = resolve_relay_urls(explicit, config);
    connect_first_available_from_list_with_invite_token(
        &relay_urls,
        did,
        card,
        keypair,
        invite_token,
    )
    .await
}

pub async fn connect_first_available_from_list(
    relay_urls: &[String],
    did: &str,
    card: &AgentCard,
    keypair: &KeyPair,
) -> Result<(RelaySession, String)> {
    connect_first_available_from_list_with_invite_token(relay_urls, did, card, keypair, None).await
}

pub async fn connect_first_available_from_list_with_invite_token(
    relay_urls: &[String],
    did: &str,
    card: &AgentCard,
    keypair: &KeyPair,
    invite_token: Option<&str>,
) -> Result<(RelaySession, String)> {
    let candidates = if relay_urls.is_empty() {
        vec![DEFAULT_RELAY.to_string()]
    } else {
        relay_urls.to_vec()
    };

    let mut errors = Vec::new();
    for relay_url in candidates {
        match RelaySession::connect_with_invite_token(&relay_url, did, card, keypair, invite_token)
            .await
        {
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
    card.capabilities
        .iter()
        .any(|capability| capability.id.starts_with("relay/"))
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
    pending_messages: VecDeque<Value>,
}

impl RelaySession {
    pub async fn connect(
        relay_url: &str,
        did: &str,
        card: &AgentCard,
        keypair: &KeyPair,
    ) -> Result<Self> {
        Self::connect_with_invite_token(relay_url, did, card, keypair, None).await
    }

    pub async fn connect_with_invite_token(
        relay_url: &str,
        did: &str,
        card: &AgentCard,
        keypair: &KeyPair,
        invite_token: Option<&str>,
    ) -> Result<Self> {
        let (ws_stream, _) = connect_async(relay_url)
            .await
            .with_context(|| format!("Failed to connect to relay {}", relay_url))?;

        let (mut sink, mut stream) = ws_stream.split();

        let timestamp = now_ms();
        let hello_payload = build_hello_signature_payload(did, card, timestamp, invite_token)?;
        let signature = keypair.sign(&hello_payload);
        let hello_bytes = build_hello_message(did, card, timestamp, signature, invite_token)?;
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
            pending_messages: VecDeque::new(),
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

    async fn send_pong(&mut self) -> Result<()> {
        let pong = build_simple_message(vec![("type", CborValue::Text("PONG".to_string()))])?;
        self.sink.send(Message::Binary(pong)).await?;
        Ok(())
    }

    async fn next_message_with_deadline(
        &mut self,
        deadline: tokio::time::Instant,
        timeout_context: &'static str,
    ) -> Result<Value> {
        if let Some(message) = self.pending_messages.pop_front() {
            return Ok(message);
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            anyhow::bail!(timeout_context);
        }

        let msg_raw = timeout(remaining, self.stream.next())
            .await
            .context(timeout_context)?
            .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;
        decode_relay_message(msg_raw)
    }

    fn restore_pending_messages(&mut self, mut deferred: VecDeque<Value>) {
        while let Some(message) = deferred.pop_back() {
            self.pending_messages.push_front(message);
        }
    }

    pub async fn publish_card(&mut self) -> Result<()> {
        let bytes =
            build_simple_message(vec![("type", CborValue::Text("PUBLISH_CARD".to_string()))])?;
        self.send_raw(bytes).await
    }

    pub async fn publish_prekey_bundles(
        &mut self,
        bundles: &[PublishedPreKeyBundle],
    ) -> Result<()> {
        let payload = serde_json::json!({
            "type": "PUBLISH_PREKEYS",
            "bundles": bundles,
        });
        self.send_raw(cbor_x_encode_json(&payload)).await?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut deferred = VecDeque::new();
        loop {
            let msg = match self
                .next_message_with_deadline(deadline, "Timeout waiting for PREKEYS_PUBLISHED")
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    self.restore_pending_messages(deferred);
                    return Err(err);
                }
            };

            match msg.get("type").and_then(|v| v.as_str()) {
                Some("PREKEYS_PUBLISHED") => {
                    self.restore_pending_messages(deferred);
                    return Ok(());
                }
                Some("PING") => {
                    self.send_pong().await?;
                }
                _ => deferred.push_back(msg),
            }
        }
    }

    pub async fn fetch_prekey_bundle(
        &mut self,
        did: &str,
        device_id: &str,
    ) -> Result<Option<ClaimedPreKeyBundle>> {
        let bytes = build_simple_message(vec![
            ("type", CborValue::Text("FETCH_PREKEY_BUNDLE".to_string())),
            ("did", CborValue::Text(did.to_string())),
            ("deviceId", CborValue::Text(device_id.to_string())),
        ])?;
        self.send_raw(bytes).await?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut deferred = VecDeque::new();
        loop {
            let msg = match self
                .next_message_with_deadline(deadline, "Timeout waiting for PREKEY_BUNDLE")
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    self.restore_pending_messages(deferred);
                    return Err(err);
                }
            };

            match msg.get("type").and_then(|v| v.as_str()) {
                Some("PREKEY_BUNDLE")
                    if msg.get("did").and_then(|v| v.as_str()) == Some(did)
                        && msg.get("deviceId").and_then(|v| v.as_str()) == Some(device_id) =>
                {
                    let bundle = msg.get("bundle").cloned().unwrap_or(Value::Null);
                    self.restore_pending_messages(deferred);
                    if bundle.is_null() {
                        return Ok(None);
                    }
                    let bundle: ClaimedPreKeyBundle = serde_json::from_value(bundle)?;
                    return Ok(Some(bundle));
                }
                Some("PING") => {
                    self.send_pong().await?;
                }
                _ => deferred.push_back(msg),
            }
        }
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
        use quadra_a_core::protocol::{cbor_x_encode, CborXValue};
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

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut deferred = VecDeque::new();
        loop {
            let msg = match self
                .next_message_with_deadline(deadline, "Timeout waiting for DISCOVERED")
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    self.restore_pending_messages(deferred);
                    return Err(err);
                }
            };

            match msg.get("type").and_then(|v| v.as_str()) {
                Some("DISCOVERED") => {
                    let agents = msg
                        .get("agents")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(discovered_agent_has_valid_card)
                        .collect();
                    self.restore_pending_messages(deferred);
                    return Ok(agents);
                }
                Some("PING") => {
                    self.send_pong().await?;
                }
                _ => deferred.push_back(msg),
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
        let mut deferred = VecDeque::new();
        loop {
            let msg = match self
                .next_message_with_deadline(deadline, "Timeout waiting for CARD")
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    self.restore_pending_messages(deferred);
                    return Err(err);
                }
            };

            match msg.get("type").and_then(|v| v.as_str()) {
                Some("CARD") if msg.get("did").and_then(|v| v.as_str()) == Some(did) => {
                    let card = msg.get("card").cloned().unwrap_or(Value::Null);
                    self.restore_pending_messages(deferred);
                    if card.is_null() {
                        return Ok(None);
                    }
                    let card: AgentCard = serde_json::from_value(card)?;
                    if !fetched_card_matches_request(did, &card) {
                        return Ok(None);
                    }
                    return Ok(Some(card));
                }
                Some("PING") => {
                    self.send_pong().await?;
                }
                _ => deferred.push_back(msg),
            }
        }
    }

    /// Wait for the next DELIVER message, ACK it, return (messageId, from, envelope_bytes).
    pub async fn next_deliver(&mut self) -> Result<(String, String, Vec<u8>)> {
        let mut deferred = VecDeque::new();
        loop {
            let msg = if let Some(message) = self.pending_messages.pop_front() {
                message
            } else {
                let msg_raw = self
                    .stream
                    .next()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("Connection closed"))??;
                decode_relay_message(msg_raw)?
            };

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
                    let envelope_bytes = extract_bytes_field(&msg, "envelope")?;
                    self.restore_pending_messages(deferred);
                    self.ack(&message_id).await?;
                    return Ok((message_id, from, envelope_bytes));
                }
                Some("PING") => {
                    self.send_pong().await?;
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
                    self.restore_pending_messages(deferred);
                    return Ok((message_id, format!("__delivery_report:{}", status), vec![]));
                }
                _ => deferred.push_back(msg),
            }
        }
    }

    pub async fn wait_delivery_report(&mut self) -> Result<String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut deferred = VecDeque::new();
        loop {
            let msg = match self
                .next_message_with_deadline(deadline, "Timeout waiting for delivery report")
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    self.restore_pending_messages(deferred);
                    return Err(err);
                }
            };

            match msg.get("type").and_then(|v| v.as_str()) {
                Some("DELIVERY_REPORT") => {
                    let status = msg
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    self.restore_pending_messages(deferred);
                    return Ok(status);
                }
                Some("PING") => {
                    self.send_pong().await?;
                }
                _ => deferred.push_back(msg),
            }
        }
    }

    /// Publish an endorsement to the relay (CVP-0017)
    pub async fn publish_endorsement(&mut self, endorsement: &EndorsementV2) -> Result<()> {
        let bytes = build_endorse_message(endorsement)?;
        self.send_raw(bytes).await?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut deferred = VecDeque::new();
        loop {
            let msg = match self
                .next_message_with_deadline(deadline, "Timeout waiting for endorsement response")
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    self.restore_pending_messages(deferred);
                    return Err(err);
                }
            };

            match msg.get("type").and_then(|v| v.as_str()) {
                Some("ENDORSE_ACK") => {
                    self.restore_pending_messages(deferred);
                    return Ok(());
                }
                Some("ERROR") => {
                    let error_msg = msg
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error")
                        .to_string();
                    self.restore_pending_messages(deferred);
                    anyhow::bail!("Relay error publishing endorsement: {}", error_msg);
                }
                Some("PING") => {
                    self.send_pong().await?;
                }
                _ => deferred.push_back(msg),
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

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut deferred = VecDeque::new();
        loop {
            let msg = match self
                .next_message_with_deadline(deadline, "Timeout waiting for trust query response")
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    self.restore_pending_messages(deferred);
                    return Err(err);
                }
            };

            match msg.get("type").and_then(|v| v.as_str()) {
                Some("TRUST_RESULT") => {
                    let endorsements = msg
                        .get("endorsements")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| {
                                    serde_json::from_value::<
                                        quadra_a_core::protocol::RelayEndorsement,
                                    >(v.clone())
                                    .ok()
                                })
                                .map(quadra_a_core::protocol::relay_endorsement_to_local)
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

                    self.restore_pending_messages(deferred);
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
                        .unwrap_or("Unknown error")
                        .to_string();
                    self.restore_pending_messages(deferred);
                    anyhow::bail!("Relay error querying endorsements: {}", error_msg);
                }
                Some("PING") => {
                    self.send_pong().await?;
                }
                _ => deferred.push_back(msg),
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

fn extract_bytes_field(msg: &Value, field: &str) -> Result<Vec<u8>> {
    match msg.get(field) {
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|byte| u8::try_from(byte).ok())
                    .ok_or_else(|| anyhow::anyhow!("{} must be encoded as byte values", field))
            })
            .collect(),
        Some(Value::Object(obj)) => {
            if obj.get("type").and_then(|value| value.as_str()) == Some("Buffer") {
                let data = obj
                    .get("data")
                    .and_then(|value| value.as_array())
                    .ok_or_else(|| {
                        anyhow::anyhow!("{} Buffer payload must contain a byte array", field)
                    })?;
                return data
                    .iter()
                    .map(|value| {
                        value
                            .as_u64()
                            .and_then(|byte| u8::try_from(byte).ok())
                            .ok_or_else(|| {
                                anyhow::anyhow!("{} Buffer payload contains non-byte values", field)
                            })
                    })
                    .collect();
            }

            if obj.is_empty() {
                return Ok(vec![]);
            }

            let mut indexed = obj
                .iter()
                .map(|(key, value)| {
                    let index = key.parse::<usize>().ok();
                    let byte = value.as_u64().and_then(|value| u8::try_from(value).ok());
                    index.zip(byte)
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} must be encoded as raw bytes, not an inline object",
                        field
                    )
                })?;

            indexed.sort_by_key(|(index, _)| *index);
            let is_dense = indexed
                .iter()
                .enumerate()
                .all(|(expected, (actual, _))| *actual == expected);
            if !is_dense {
                anyhow::bail!("{} typed-array object is missing byte positions", field);
            }

            Ok(indexed.iter().map(|(_, byte)| *byte).collect())
        }
        Some(Value::String(_)) => {
            anyhow::bail!("{} must be encoded as raw bytes, not a string", field)
        }
        Some(value) if !value.is_null() => {
            anyhow::bail!("{} must be encoded as raw bytes, got {}", field, value)
        }
        _ => Ok(vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_relay_message, extract_bytes_field, extract_discovered_relay_endpoints,
        parse_discovered_agent_card, RelaySession,
    };
    use futures_util::{SinkExt, StreamExt};
    use quadra_a_core::e2e::{ClaimedPreKeyBundle, PublishedOneTimePreKey, PublishedPreKeyBundle};
    use quadra_a_core::identity::{derive_did, KeyPair};
    use quadra_a_core::protocol::{AgentCard, AgentCardUnsigned, Capability};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    #[derive(Default, Clone)]
    struct FakeRelayScenario {
        discovered_agents: Vec<Value>,
        fetched_cards: HashMap<String, Value>,
        fetch_prekey_bundles: HashMap<String, Vec<Value>>,
        observed_prekey_publications: Option<Arc<Mutex<Vec<Vec<PublishedPreKeyBundle>>>>>,
        prekeys_interleaved_messages: Vec<Value>,
    }

    fn signed_test_card(name: &str) -> (KeyPair, AgentCard) {
        let keypair = KeyPair::generate();
        let did = derive_did(keypair.verifying_key.as_bytes());
        let unsigned = AgentCardUnsigned {
            did: did.clone(),
            name: name.to_string(),
            description: format!("{} description", name),
            version: "1.0.0".to_string(),
            capabilities: vec![Capability {
                id: "agent/test".to_string(),
                name: "Test".to_string(),
                description: "Test capability".to_string(),
                parameters: None,
                metadata: None,
            }],
            endpoints: vec![],
            devices: None,
            peer_id: None,
            trust: None,
            metadata: None,
            timestamp: 1,
        };
        let signature = AgentCard::sign(&unsigned, &keypair);

        (
            keypair,
            AgentCard {
                did: unsigned.did,
                name: unsigned.name,
                description: unsigned.description,
                version: unsigned.version,
                capabilities: unsigned.capabilities,
                endpoints: unsigned.endpoints,
                devices: unsigned.devices,
                peer_id: unsigned.peer_id,
                trust: unsigned.trust,
                metadata: unsigned.metadata,
                timestamp: unsigned.timestamp,
                signature,
            },
        )
    }

    fn discovered_agent_value(did: &str, card: &AgentCard) -> Value {
        json!({
            "did": did,
            "card": card,
            "online": true
        })
    }

    fn sample_published_prekey_bundle(device_id: &str) -> PublishedPreKeyBundle {
        PublishedPreKeyBundle {
            device_id: device_id.to_string(),
            identity_key_public: "identity-public".to_string(),
            signed_pre_key_public: "signed-prekey-public".to_string(),
            signed_pre_key_id: 7,
            signed_pre_key_signature: "signed-prekey-signature".to_string(),
            one_time_pre_key_count: 2,
            last_resupply_at: 123,
            one_time_pre_keys: vec![
                PublishedOneTimePreKey {
                    key_id: 1,
                    public_key: "otk-1".to_string(),
                },
                PublishedOneTimePreKey {
                    key_id: 2,
                    public_key: "otk-2".to_string(),
                },
            ],
        }
    }

    fn sample_claimed_prekey_bundle(device_id: &str, key_id: u32) -> ClaimedPreKeyBundle {
        ClaimedPreKeyBundle {
            device_id: device_id.to_string(),
            identity_key_public: "identity-public".to_string(),
            signed_pre_key_public: "signed-prekey-public".to_string(),
            signed_pre_key_id: 7,
            signed_pre_key_signature: "signed-prekey-signature".to_string(),
            one_time_pre_key_count: 1,
            last_resupply_at: 123,
            one_time_pre_key: Some(PublishedOneTimePreKey {
                key_id,
                public_key: format!("otk-{}", key_id),
            }),
            remaining_one_time_pre_key_count: 1,
        }
    }

    async fn spawn_fake_relay(
        scenario: FakeRelayScenario,
    ) -> anyhow::Result<(String, tokio::task::JoinHandle<anyhow::Result<()>>)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;

        let handle = tokio::spawn(async move {
            let mut scenario = scenario;
            let (stream, _) = listener.accept().await?;
            let mut socket = accept_async(stream).await?;

            while let Some(message) = socket.next().await {
                let message = message?;
                let payload = decode_relay_message(message)?;

                match payload.get("type").and_then(|value| value.as_str()) {
                    Some("HELLO") => {
                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "WELCOME",
                                    "protocolVersion": 1,
                                    "relayId": "relay:test",
                                    "peers": 1,
                                    "federatedRelays": [],
                                    "yourAddr": "127.0.0.1"
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("DISCOVER") => {
                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "DISCOVERED",
                                    "agents": scenario.discovered_agents
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("FETCH_CARD") => {
                        let did = payload
                            .get("did")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default();
                        let card = scenario
                            .fetched_cards
                            .get(did)
                            .cloned()
                            .unwrap_or(Value::Null);

                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "CARD",
                                    "did": did,
                                    "card": card
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("PUBLISH_PREKEYS") => {
                        if let Some(observed) = &scenario.observed_prekey_publications {
                            let bundles: Vec<PublishedPreKeyBundle> = serde_json::from_value(
                                payload.get("bundles").cloned().unwrap_or_else(|| json!([])),
                            )?;
                            observed
                                .lock()
                                .expect("record published pre-key bundles")
                                .push(bundles);
                        }

                        for message in &scenario.prekeys_interleaved_messages {
                            socket.send(Message::Text(message.to_string())).await?;
                        }

                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "PREKEYS_PUBLISHED",
                                    "did": "did:relay:test",
                                    "deviceCount": payload
                                        .get("bundles")
                                        .and_then(|value| value.as_array())
                                        .map(Vec::len)
                                        .unwrap_or(0)
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("FETCH_PREKEY_BUNDLE") => {
                        let did = payload
                            .get("did")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default();
                        let device_id = payload
                            .get("deviceId")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default();
                        let key = format!("{}:{}", did, device_id);
                        let bundle = scenario
                            .fetch_prekey_bundles
                            .get_mut(&key)
                            .and_then(|responses| {
                                if responses.is_empty() {
                                    None
                                } else {
                                    Some(responses.remove(0))
                                }
                            })
                            .unwrap_or(Value::Null);

                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "PREKEY_BUNDLE",
                                    "did": did,
                                    "deviceId": device_id,
                                    "bundle": bundle
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("PING") => {
                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "PONG",
                                    "peers": 1
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("GOODBYE") => break,
                    _ => {}
                }
            }

            Ok(())
        });

        Ok((format!("ws://{}", address), handle))
    }

    #[test]
    fn reconstructs_buffer_objects_from_node_json_encoding() {
        let msg = json!({
            "envelope": {
                "type": "Buffer",
                "data": [123, 34, 105, 100, 34, 58, 34, 109, 115, 103, 45, 98, 117, 102, 34, 125]
            }
        });

        let bytes = extract_bytes_field(&msg, "envelope").expect("extract bytes field");
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

        let bytes = extract_bytes_field(&msg, "envelope").expect("extract bytes field");
        let envelope: Value =
            serde_json::from_slice(&bytes).expect("typed-array object should reconstruct");

        assert_eq!(
            envelope.get("id").and_then(|value| value.as_str()),
            Some("msg-3")
        );
    }

    #[test]
    fn rejects_inline_object_envelopes() {
        let msg = json!({
            "envelope": {
                "id": "msg-1",
                "protocol": "/shell/exec/1.0.0",
                "payload": {
                    "status": "success"
                }
            }
        });

        let err =
            extract_bytes_field(&msg, "envelope").expect_err("inline object should be rejected");
        assert!(err.to_string().contains("raw bytes"));
    }

    #[test]
    fn rejects_string_encoded_envelopes() {
        let msg = json!({
            "envelope": r#"{"id":"msg-2","protocol":"highway1/chat/1.0"}"#
        });

        let err =
            extract_bytes_field(&msg, "envelope").expect_err("string envelope should be rejected");
        assert!(err.to_string().contains("raw bytes"));
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

    #[tokio::test]
    async fn publish_prekey_bundles_sends_expected_payload() {
        let (query_keypair, query_card) = signed_test_card("Query Agent");
        let observed = Arc::new(Mutex::new(Vec::new()));
        let bundles = vec![sample_published_prekey_bundle("device-1")];

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            observed_prekey_publications: Some(Arc::clone(&observed)),
            ..FakeRelayScenario::default()
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &query_card.did, &query_card, &query_keypair)
                .await
                .expect("connect relay session");

        session
            .publish_prekey_bundles(&bundles)
            .await
            .expect("publish prekey bundles");
        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");

        let recorded = observed
            .lock()
            .expect("read recorded pre-key publications")
            .clone();
        assert_eq!(recorded, vec![bundles]);
    }

    #[tokio::test]
    async fn publish_prekey_bundles_preserves_interleaved_deliver_messages() {
        let (query_keypair, query_card) = signed_test_card("Query Agent");
        let bundles = vec![sample_published_prekey_bundle("device-1")];
        let envelope_bytes = vec![1_u8, 2, 3, 4, 5];

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            prekeys_interleaved_messages: vec![json!({
                "type": "DELIVER",
                "messageId": "queued-msg-1",
                "from": "did:agent:zsender",
                "envelope": envelope_bytes,
            })],
            ..FakeRelayScenario::default()
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &query_card.did, &query_card, &query_keypair)
                .await
                .expect("connect relay session");

        session
            .publish_prekey_bundles(&bundles)
            .await
            .expect("publish prekey bundles");

        let (message_id, from, received_bytes) = session
            .next_deliver()
            .await
            .expect("queued deliver preserved after publish response");
        assert_eq!(message_id, "queued-msg-1");
        assert_eq!(from, "did:agent:zsender");
        assert_eq!(received_bytes, vec![1_u8, 2, 3, 4, 5]);

        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");
    }

    #[tokio::test]
    async fn fetch_prekey_bundle_returns_claimed_bundle_and_null_after_exhaustion() {
        let (query_keypair, query_card) = signed_test_card("Query Agent");
        let (_, target_card) = signed_test_card("Target Agent");
        let claimed = sample_claimed_prekey_bundle("device-1", 1);

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            fetch_prekey_bundles: HashMap::from([(
                format!("{}:{}", target_card.did, "device-1"),
                vec![
                    serde_json::to_value(&claimed).expect("serialize claimed prekey bundle"),
                    Value::Null,
                ],
            )]),
            ..FakeRelayScenario::default()
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &query_card.did, &query_card, &query_keypair)
                .await
                .expect("connect relay session");

        let first = session
            .fetch_prekey_bundle(&target_card.did, "device-1")
            .await
            .expect("fetch prekey bundle");
        let second = session
            .fetch_prekey_bundle(&target_card.did, "device-1")
            .await
            .expect("fetch exhausted prekey bundle");
        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");

        assert_eq!(first, Some(claimed));
        assert_eq!(second, None);
    }

    #[tokio::test]
    async fn card_signature_verification_filters_discovered_cards_with_invalid_signatures() {
        let (query_keypair, query_card) = signed_test_card("Query Agent");
        let (_, valid_card) = signed_test_card("Valid Agent");
        let (_, invalid_card) = signed_test_card("Tampered Agent");
        let tampered_card = AgentCard {
            description: "tampered description".to_string(),
            ..invalid_card.clone()
        };

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            discovered_agents: vec![
                discovered_agent_value(&valid_card.did, &valid_card),
                discovered_agent_value(&tampered_card.did, &tampered_card),
            ],
            fetched_cards: HashMap::new(),
            ..FakeRelayScenario::default()
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &query_card.did, &query_card, &query_keypair)
                .await
                .expect("connect relay session");

        let agents = session
            .discover(Some("agent"), None, None, Some(10))
            .await
            .expect("discover agents");
        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");

        assert_eq!(agents.len(), 1);
        let parsed = parse_discovered_agent_card(agents[0].clone()).expect("parse valid card");
        assert_eq!(parsed.name, "Valid Agent");
    }

    #[tokio::test]
    async fn card_signature_verification_filters_discovered_cards_with_mismatched_envelope_dids() {
        let (query_keypair, query_card) = signed_test_card("Query Agent");
        let (_, expected_card) = signed_test_card("Expected Agent");
        let (_, other_card) = signed_test_card("Other Agent");

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            discovered_agents: vec![
                discovered_agent_value(&expected_card.did, &expected_card),
                discovered_agent_value(&expected_card.did, &other_card),
            ],
            fetched_cards: HashMap::new(),
            ..FakeRelayScenario::default()
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &query_card.did, &query_card, &query_keypair)
                .await
                .expect("connect relay session");

        let agents = session
            .discover(Some("agent"), None, None, Some(10))
            .await
            .expect("discover agents");
        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");

        assert_eq!(agents.len(), 1);
        let parsed = parse_discovered_agent_card(agents[0].clone()).expect("parse valid card");
        assert_eq!(
            parsed.did,
            agents[0]
                .get("did")
                .and_then(|value| value.as_str())
                .unwrap()
        );
    }

    #[tokio::test]
    async fn card_signature_verification_returns_none_for_invalid_fetched_cards() {
        let (query_keypair, query_card) = signed_test_card("Query Agent");
        let (_, target_card) = signed_test_card("Target Agent");
        let tampered_card = AgentCard {
            name: "Target Agent (tampered)".to_string(),
            ..target_card.clone()
        };

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            discovered_agents: Vec::new(),
            fetched_cards: HashMap::from([(
                target_card.did.clone(),
                serde_json::to_value(tampered_card).expect("serialize tampered card"),
            )]),
            ..FakeRelayScenario::default()
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &query_card.did, &query_card, &query_keypair)
                .await
                .expect("connect relay session");

        let fetched = session
            .fetch_card(&target_card.did)
            .await
            .expect("fetch card");
        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");

        assert!(fetched.is_none());
    }
}
