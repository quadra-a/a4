/// CVP-0011 wire protocol types and CBOR serialization helpers.
///
/// Key invariants (must match TypeScript relay server exactly):
/// - HELLO signature: sign CBOR({ did, card, timestamp[, inviteToken] }) with keys in that insertion order
/// - Envelope signature: sign JSON.stringify(envelope) with fields in order:
///   id, from, to, type, protocol, payload, timestamp, replyTo
/// - Agent card signature: sign JSON.stringify(card_without_signature)
/// - All signatures are hex-encoded strings in JSON, raw bytes in CBOR relay messages
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Agent Card ────────────────────────────────────────────────────────────────

/// Capability as used in the relay wire protocol (matches relay/src/types.ts)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Agent card sent in HELLO and returned in DISCOVERED.
/// Field order in JSON serialization matters for signature verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCard {
    pub did: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub capabilities: Vec<Capability>,
    pub endpoints: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "peerId")]
    pub peer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub timestamp: u64,
    pub signature: String,
}

impl AgentCard {
    /// Sign the card: JSON.stringify(card_without_signature), then hex-encode.
    pub fn sign(
        card_without_sig: &AgentCardUnsigned,
        keypair: &crate::identity::KeyPair,
    ) -> String {
        let json = serde_json::to_string(card_without_sig).expect("serialize card");
        let sig_bytes = keypair.sign(json.as_bytes());
        hex::encode(sig_bytes)
    }
}

/// Agent card without the signature field — used for signing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCardUnsigned {
    pub did: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub capabilities: Vec<Capability>,
    pub endpoints: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "peerId")]
    pub peer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub timestamp: u64,
}

// ── Message Envelope ──────────────────────────────────────────────────────────

/// Envelope fields in the exact order required for signing.
/// JSON.stringify preserves insertion order in V8, so we must match it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub protocol: String,
    pub payload: Value,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "replyTo")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
    pub signature: String,
}

/// Envelope without signature — used for signing.
#[derive(Debug, Clone, Serialize)]
pub struct EnvelopeUnsigned {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub protocol: String,
    pub payload: Value,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "replyTo")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
}

impl EnvelopeUnsigned {
    pub fn sign(self, keypair: &crate::identity::KeyPair) -> Envelope {
        let json = serde_json::to_string(&self).expect("serialize envelope");
        let sig_bytes = keypair.sign(json.as_bytes());
        let signature = hex::encode(sig_bytes);
        Envelope {
            id: self.id,
            from: self.from,
            to: self.to,
            msg_type: self.msg_type,
            protocol: self.protocol,
            payload: self.payload,
            timestamp: self.timestamp,
            reply_to: self.reply_to,
            thread_id: self.thread_id,
            signature,
        }
    }
}

// ── CBOR relay message encoding ───────────────────────────────────────────────

/// Encode a value to CBOR bytes using ciborium (standard CBOR).
#[allow(dead_code)]
pub fn cbor_encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    ciborium::into_writer(value, &mut buf)?;
    Ok(buf)
}

/// Encode a serde_json::Value to CBOR bytes using cbor-x-compatible encoding.
/// Use this for any data that will be decoded by cbor-x on the Node.js side.
pub fn cbor_x_encode_json(value: &Value) -> Vec<u8> {
    let cbor_val = json_to_cbor_x(value);
    cbor_x_encode(&cbor_val)
}

/// Decode CBOR bytes into a serde_json::Value (for flexible relay message parsing).
pub fn cbor_decode_value(data: &[u8]) -> Result<Value> {
    let value: ciborium::Value = ciborium::from_reader(data)?;
    let json = cbor_value_to_json(value)?;
    Ok(json)
}

fn cbor_value_to_json(v: ciborium::Value) -> Result<Value> {
    use ciborium::Value as CV;
    Ok(match v {
        CV::Null => Value::Null,
        CV::Bool(b) => Value::Bool(b),
        CV::Integer(i) => {
            let n: i128 = i.into();
            if let Ok(u) = u64::try_from(n) {
                Value::Number(u.into())
            } else if let Ok(i) = i64::try_from(n) {
                Value::Number(i.into())
            } else {
                Value::Number(serde_json::Number::from_f64(n as f64).unwrap_or(0.into()))
            }
        }
        CV::Float(f) => {
            const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

            if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER {
                if f >= 0.0 {
                    Value::Number(serde_json::Number::from(f as u64))
                } else {
                    Value::Number(serde_json::Number::from(f as i64))
                }
            } else {
                Value::Number(serde_json::Number::from_f64(f).unwrap_or(0.into()))
            }
        }
        CV::Text(s) => Value::String(s),
        CV::Bytes(b) => {
            // Represent bytes as array of numbers (matches JS Uint8Array behavior)
            Value::Array(
                b.into_iter()
                    .map(|byte| Value::Number(byte.into()))
                    .collect(),
            )
        }
        CV::Array(arr) => Value::Array(
            arr.into_iter()
                .map(cbor_value_to_json)
                .collect::<Result<_>>()?,
        ),
        CV::Map(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                let key = match k {
                    CV::Text(s) => s,
                    other => format!("{:?}", other),
                };
                obj.insert(key, cbor_value_to_json(v)?);
            }
            Value::Object(obj)
        }
        CV::Tag(_, inner) => cbor_value_to_json(*inner)?,
        _ => Value::Null,
    })
}

// ── cbor-x-compatible encoder ─────────────────────────────────────────────────
//
// cbor-x (used by the TypeScript relay) has specific encoding rules that differ
// from ciborium's defaults:
//   - Maps: always b9 NNNN (16-bit length), even for small maps
//   - Arrays: compact encoding (80-97 for 0-23 items, 98 NN for 24-255, etc.)
//   - Numbers: float64 (fb) for values > i32::MAX or with fractional parts
//   - Strings, bools, null: standard CBOR
//   - Bytes: standard CBOR (44 NN ...)
//
// The relay server re-encodes { did, card, timestamp } with cbor-x to verify the
// HELLO signature, so we must sign the cbor-x encoding, not ciborium's encoding.

/// A simple JSON-like value for cbor-x-compatible encoding.
pub enum CborXValue<'a> {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(&'a str),
    Bytes(&'a [u8]),
    Array(Vec<CborXValue<'a>>),
    Map(Vec<(&'a str, CborXValue<'a>)>),
}

/// Encode a value using cbor-x-compatible rules.
pub fn cbor_x_encode(val: &CborXValue<'_>) -> Vec<u8> {
    let mut buf = Vec::new();
    encode_value(val, &mut buf);
    buf
}

fn encode_value(val: &CborXValue<'_>, buf: &mut Vec<u8>) {
    match val {
        CborXValue::Null => buf.push(0xf6),
        CborXValue::Bool(true) => buf.push(0xf5),
        CborXValue::Bool(false) => buf.push(0xf4),
        CborXValue::Int(n) => encode_int(*n, buf),
        CborXValue::Float(f) => {
            buf.push(0xfb);
            buf.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        CborXValue::Str(s) => encode_str(s, buf),
        CborXValue::Bytes(b) => {
            encode_head(2, b.len() as u64, buf);
            buf.extend_from_slice(b);
        }
        CborXValue::Array(items) => {
            encode_head(4, items.len() as u64, buf);
            for item in items {
                encode_value(item, buf);
            }
        }
        CborXValue::Map(pairs) => {
            // cbor-x always uses 16-bit length for maps (b9 NNNN)
            let n = pairs.len() as u16;
            buf.push(0xb9);
            buf.extend_from_slice(&n.to_be_bytes());
            for (k, v) in pairs {
                encode_str(k, buf);
                encode_value(v, buf);
            }
        }
    }
}

fn encode_int(n: i64, buf: &mut Vec<u8>) {
    if n >= 0 {
        encode_head(0, n as u64, buf);
    } else {
        encode_head(1, (-1 - n) as u64, buf);
    }
}

fn encode_str(s: &str, buf: &mut Vec<u8>) {
    encode_head(3, s.len() as u64, buf);
    buf.extend_from_slice(s.as_bytes());
}

fn encode_head(major: u8, n: u64, buf: &mut Vec<u8>) {
    let mt = major << 5;
    if n <= 23 {
        buf.push(mt | n as u8);
    } else if n <= 0xff {
        buf.push(mt | 24);
        buf.push(n as u8);
    } else if n <= 0xffff {
        buf.push(mt | 25);
        buf.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n <= 0xffff_ffff {
        buf.push(mt | 26);
        buf.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        buf.push(mt | 27);
        buf.extend_from_slice(&n.to_be_bytes());
    }
}

/// Convert a serde_json::Value to CborXValue, using cbor-x number encoding rules.
/// Numbers > i32::MAX are encoded as float64 (matching cbor-x behavior for JS numbers).
fn json_to_cbor_x(v: &Value) -> CborXValue<'_> {
    match v {
        Value::Null => CborXValue::Null,
        Value::Bool(b) => CborXValue::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i >= i32::MIN as i64 && i <= i32::MAX as i64 {
                    return CborXValue::Int(i);
                }
            }
            CborXValue::Float(n.as_f64().unwrap_or(0.0))
        }
        Value::String(s) => CborXValue::Str(s.as_str()),
        Value::Array(arr) => CborXValue::Array(arr.iter().map(json_to_cbor_x).collect()),
        Value::Object(obj) => CborXValue::Map(
            obj.iter()
                .map(|(k, v)| (k.as_str(), json_to_cbor_x(v)))
                .collect(),
        ),
    }
}

// ── HELLO message builder ─────────────────────────────────────────────────────

/// Build the CBOR bytes for the HELLO signature payload.
/// Must produce the same bytes as: encodeCBOR({ did, card, timestamp }) in cbor-x.
/// The relay server re-encodes this exact structure to verify the signature.
pub fn build_hello_signature_payload(
    did: &str,
    card: &AgentCard,
    timestamp: u64,
    invite_token: Option<&str>,
) -> Result<Vec<u8>> {
    let card_json = serde_json::to_value(card)?;
    let card_cbor = json_to_cbor_x(&card_json);

    let invite_token = invite_token
        .map(str::trim)
        .filter(|token| !token.is_empty());
    let mut fields = vec![
        ("did", CborXValue::Str(did)),
        ("card", card_cbor),
        ("timestamp", CborXValue::Float(timestamp as f64)),
    ];
    if let Some(invite_token) = invite_token {
        fields.push(("inviteToken", CborXValue::Str(invite_token)));
    }

    let payload = CborXValue::Map(fields);

    Ok(cbor_x_encode(&payload))
}

/// Build the full HELLO CBOR message to send to the relay.
/// The message itself also uses cbor-x encoding so the relay can decode it.
pub fn build_hello_message(
    did: &str,
    card: &AgentCard,
    timestamp: u64,
    signature: Vec<u8>,
    invite_token: Option<&str>,
) -> Result<Vec<u8>> {
    let card_json = serde_json::to_value(card)?;
    let card_cbor = json_to_cbor_x(&card_json);

    let invite_token = invite_token
        .map(str::trim)
        .filter(|token| !token.is_empty());
    let mut fields = vec![
        ("type", CborXValue::Str("HELLO")),
        ("protocolVersion", CborXValue::Int(1)),
        ("did", CborXValue::Str(did)),
        ("card", card_cbor),
        ("timestamp", CborXValue::Float(timestamp as f64)),
        ("signature", CborXValue::Bytes(&signature)),
    ];
    if let Some(invite_token) = invite_token {
        fields.push(("inviteToken", CborXValue::Str(invite_token)));
    }

    let msg = CborXValue::Map(fields);

    Ok(cbor_x_encode(&msg))
}

/// Build a simple CBOR map message (for PING, ACK, GOODBYE, etc.).
/// Uses cbor-x encoding so the relay can decode it.
pub fn build_simple_message(fields: Vec<(&str, ciborium::Value)>) -> Result<Vec<u8>> {
    // Convert ciborium::Value fields to CborXValue for encoding
    fn cv_to_cbor_x(v: &ciborium::Value) -> Vec<u8> {
        use ciborium::Value as CV;
        match v {
            CV::Text(s) => {
                let mut buf = Vec::new();
                encode_str(s, &mut buf);
                buf
            }
            CV::Integer(i) => {
                let n: i128 = (*i).into();
                let mut buf = Vec::new();
                encode_int(n as i64, &mut buf);
                buf
            }
            CV::Bool(b) => vec![if *b { 0xf5 } else { 0xf4 }],
            CV::Null => vec![0xf6],
            _ => vec![0xf6], // fallback
        }
    }

    let n = fields.len() as u16;
    let mut buf = Vec::new();
    buf.push(0xb9);
    buf.extend_from_slice(&n.to_be_bytes());
    for (k, v) in &fields {
        encode_str(k, &mut buf);
        buf.extend_from_slice(&cv_to_cbor_x(v));
    }
    Ok(buf)
}

pub use ciborium::Value as CborValue;

// ── CVP-0017 Trust Protocol Messages ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEndorsement {
    pub version: u32,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    pub score: f64,
    pub reason: String,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<u64>,
    pub signature: String,
}

/// ENDORSE message for publishing endorsements to relay (CVP-0017)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndorseMessage {
    pub endorsement: RelayEndorsement,
}

/// TRUST_QUERY message for querying endorsements from relay (CVP-0017)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustQueryMessage {
    pub target: String,
    pub domain: Option<String>,
    pub cursor: Option<String>,
}

/// TRUST_RESULT message returned by relay for trust queries (CVP-0017)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustResultMessage {
    pub endorsements: Vec<crate::config::EndorsementV2>,
    pub total_count: u32,
    pub average_score: f64,
    pub next_cursor: Option<String>,
}

pub fn relay_endorsement_reason(endorsement: &crate::config::EndorsementV2) -> String {
    endorsement
        .comment
        .clone()
        .filter(|comment| !comment.trim().is_empty())
        .unwrap_or_else(|| format!("{} endorsement", endorsement.endorsement_type))
}

pub fn relay_unsigned_endorsement_value(endorsement: &crate::config::EndorsementV2) -> Value {
    json!({
        "version": 2,
        "from": endorsement.endorser,
        "to": endorsement.endorsee,
        "domain": endorsement.domain,
        "score": endorsement.strength,
        "reason": relay_endorsement_reason(endorsement),
        "timestamp": endorsement.timestamp,
        "expires": endorsement.expires,
    })
}

pub fn relay_endorsement_to_local(endorsement: RelayEndorsement) -> crate::config::EndorsementV2 {
    crate::config::EndorsementV2 {
        endorser: endorsement.from,
        endorsee: endorsement.to,
        domain: endorsement.domain,
        endorsement_type: "general".to_string(),
        strength: endorsement.score,
        comment: if endorsement.reason.trim().is_empty() {
            None
        } else {
            Some(endorsement.reason)
        },
        timestamp: endorsement.timestamp,
        expires: endorsement.expires,
        version: endorsement.version.to_string(),
        signature: endorsement.signature,
    }
}

/// Build ENDORSE CBOR message to send to relay
pub fn build_endorse_message(endorsement: &crate::config::EndorsementV2) -> Result<Vec<u8>> {
    let mut endorsement_json = relay_unsigned_endorsement_value(endorsement);
    endorsement_json["signature"] = Value::String(endorsement.signature.clone());
    let endorsement_cbor = json_to_cbor_x(&endorsement_json);

    let msg = CborXValue::Map(vec![
        ("type", CborXValue::Str("ENDORSE")),
        ("endorsement", endorsement_cbor),
    ]);

    Ok(cbor_x_encode(&msg))
}

/// Build TRUST_QUERY CBOR message to send to relay
pub fn build_trust_query_message(
    target_did: &str,
    domain: Option<&str>,
    _limit: Option<u32>,
    _offset: Option<u32>,
) -> Result<Vec<u8>> {
    let mut fields = vec![
        ("type", CborXValue::Str("TRUST_QUERY")),
        ("target", CborXValue::Str(target_did)),
    ];

    if let Some(domain) = domain {
        fields.push(("domain", CborXValue::Str(domain)));
    }

    let msg = CborXValue::Map(fields);
    Ok(cbor_x_encode(&msg))
}

#[cfg(test)]
mod tests {
    use super::{
        build_hello_message, build_hello_signature_payload, cbor_decode_value, cbor_value_to_json,
        AgentCard, Capability,
    };
    use ciborium::Value as CborValue;
    use serde_json::json;

    fn sample_card() -> AgentCard {
        AgentCard {
            did: "did:agent:zTest".to_string(),
            name: "Test Agent".to_string(),
            description: "Protocol test agent".to_string(),
            version: "1.0.0".to_string(),
            capabilities: vec![Capability {
                id: "echo".to_string(),
                name: "Echo".to_string(),
                description: "Echo replies".to_string(),
                parameters: None,
                metadata: Some(json!({ "protocol": "/echo/1.0.0" })),
            }],
            endpoints: vec![],
            peer_id: None,
            trust: None,
            metadata: None,
            timestamp: 1_700_000_000_000,
            signature: "abcd".to_string(),
        }
    }

    #[test]
    fn normalizes_integral_cbor_floats_to_json_integers() {
        let value =
            cbor_value_to_json(CborValue::Float(1_773_056_269_398.0)).expect("decode succeeds");
        assert_eq!(value.as_u64(), Some(1_773_056_269_398));
    }

    #[test]
    fn preserves_fractional_cbor_floats() {
        let value = cbor_value_to_json(CborValue::Float(0.75)).expect("decode succeeds");
        assert_eq!(value.as_f64(), Some(0.75));
    }

    #[test]
    fn hello_signature_payload_includes_invite_token_when_present() {
        let payload = build_hello_signature_payload(
            "did:agent:zTest",
            &sample_card(),
            1_700_000_000_123,
            Some("test-token"),
        )
        .expect("payload builds");
        let decoded = cbor_decode_value(&payload).expect("payload decodes");

        assert_eq!(
            decoded.get("inviteToken").and_then(|value| value.as_str()),
            Some("test-token")
        );
    }

    #[test]
    fn hello_message_omits_invite_token_when_absent() {
        let hello = build_hello_message(
            "did:agent:zTest",
            &sample_card(),
            1_700_000_000_123,
            vec![1, 2, 3, 4],
            None,
        )
        .expect("message builds");
        let decoded = cbor_decode_value(&hello).expect("message decodes");

        assert_eq!(decoded.get("inviteToken"), None);
        assert_eq!(
            decoded.get("type").and_then(|value| value.as_str()),
            Some("HELLO")
        );
    }
}
