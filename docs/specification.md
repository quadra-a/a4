# quadra-a (`a4`) Specification

This document defines the protocol surface of `quadra-a` (`a4`) in the same spirit as the [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md): abstract model first, concrete transport binding second.

The difference in scope is intentional:

- **A2A** standardizes task-oriented agent interaction.
- **quadra-a** standardizes agent **identity, discovery, reachability, and secure message transport**.

`quadra-a` is the network layer for agents, not the workflow layer.

## 1. Scope

`quadra-a` specifies how agents:

1. derive a stable self-certifying identity,
2. publish a signed discoverable descriptor,
3. connect to relay infrastructure behind NAT/firewall boundaries,
4. discover other agents by capability or query,
5. exchange signed messages,
6. bootstrap end-to-end encrypted sessions,
7. query and publish trust signals.

`quadra-a` does **not** standardize:

- task graphs,
- tool schemas,
- agent planning semantics,
- payments,
- compute markets,
- durable application storage.

## 2. Conformance Language

The key words **MUST**, **SHOULD**, and **MAY** in this document are to be interpreted as described in RFC 2119 / RFC 8174 when, and only when, they appear in all caps.

## 3. Status

This document mixes **stable** and **draft** surfaces so the spec stays aligned with the repository as it exists today.

| Surface | Status | Notes |
| --- | --- | --- |
| `did:agent` identity derivation | Stable | Implemented in JS and Rust |
| Signed `AgentCard` model | Stable | Shared across relay, JS, and Rust |
| Signed message envelope | Stable | Shared across relay, JS, and Rust |
| Agent-facing relay session (`HELLO`, `WELCOME`, `SEND`, `DELIVER`, `DISCOVER`, `FETCH_CARD`) | Stable | Primary interoperability surface |
| Discoverability control (`PUBLISH_CARD`, `UNPUBLISH_CARD`) | Stable | Connection and publication are intentionally decoupled |
| Trust query / endorsement messages | Stable | Available in relay and client surfaces |
| Pre-key publication and pre-key fetch | Stable | Required for encrypted first contact |
| Single-device encrypted send path | Stable | Implemented in JS and Rust send flows |
| Encrypted receive persistence / display lifecycle | Draft | Implemented in current JS and Rust runtimes; public operator profile is still settling |
| Multi-device sender fan-out and dedupe | Draft | Implemented in JS and Rust runtimes, but the public interoperability profile and real-machine evidence are still being frozen |
| Relay-wide opaque ciphertext guarantees in every storage path | Draft | Local harnesses are green; retained real-machine evidence is still pending |
| Event subscription and relay federation standardization | Draft | Implementations exist, public profile is not frozen |

## 4. Normative Sources

Until generated schemas exist, the normative wire definitions live in the repository source:

- `js/core/protocol/src/discovery/agent-card-types.ts`
- `js/core/protocol/src/discovery/agent-card.ts`
- `js/core/protocol/src/messaging/envelope.ts`
- `js/core/protocol/src/messaging/codec.ts`
- `js/core/protocol/src/transport/relay-types.ts`
- `js/core/protocol/src/e2e/types.ts`
- `js/core/protocol/src/e2e/messages.ts`
- `js/core/protocol/src/e2e/application-envelope.ts`
- `rust/core/src/protocol.rs`
- `rust/core/src/e2e/types.rs`
- `rust/core/src/e2e/messages.rs`

If this document and the stable source definitions disagree, implementations SHOULD follow the stable source definitions above and update this document.

## 5. Architecture

`quadra-a` is a layered protocol stack:

1. **Identity layer** — Ed25519 keypair to `did:agent`.
2. **Directory layer** — signed `AgentCard` publication and fetch.
3. **Messaging layer** — signed application envelope with reply/thread semantics.
4. **E2E layer** — X25519 device keys, X3DH bootstrap, Double Ratchet continuation.
5. **Relay control layer** — WebSocket + CBOR session for routing, discovery, queueing, and trust queries.

Only the relay control layer is network-topology-specific. The identity, card, envelope, and E2E objects are transport-independent and can be reused by future bindings.

## 6. Canonical Data Model

### 6.1 DID

The canonical identifier format is:

```text
did:agent:<base58btc-encoded-ed25519-public-key>
```

Rules:

- An implementation MUST derive the DID directly from the Ed25519 public key.
- An implementation MUST be able to recover the Ed25519 public key from the DID alone.
- A DID is therefore self-certifying: no registry lookup is required to verify signatures.

### 6.2 Agent Card

An `AgentCard` is the signed public descriptor for an agent.

Required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `did` | string | Agent DID |
| `name` | string | Human-readable display name |
| `description` | string | Human-readable summary |
| `version` | string | Card/schema version string |
| `capabilities` | array | Structured capability list |
| `endpoints` | array | Reachable service endpoints, usually relay WebSocket URLs |
| `timestamp` | number | Unix epoch milliseconds |
| `signature` | string | Hex-encoded Ed25519 signature |

Optional fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `@context` | string[] | JSON-LD context for semantic publication |
| `devices` | array | Published X25519 device directory for E2E messaging |
| `peerId` | string | Legacy/compat field |
| `trust` | object | Relay-computed or cached trust summary |
| `metadata` | object | Open extension bag |

Each capability entry has this shape:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable capability identifier |
| `name` | string | Human-readable name |
| `description` | string | Human-readable summary |
| `parameters` | array | Optional structured parameter descriptors |
| `metadata` | object | Optional extension bag |

Capability identifiers are hierarchical strings. The current discovery profile uses `/` as a prefix separator, so `translate` matches `translate/japanese` and `translate/japanese/technical`.

### 6.3 Published Device Directory

When an agent supports encrypted messaging, `AgentCard.devices` MAY publish one or more device entries.

Each published device entry contains:

| Field | Type | Meaning |
| --- | --- | --- |
| `deviceId` | string | Stable device identifier under the DID |
| `identityKeyPublic` | string | Public X25519 identity key |
| `signedPreKeyPublic` | string | Public signed pre-key |
| `signedPreKeyId` | number | Signed pre-key identifier |
| `signedPreKeySignature` | string | Ed25519 signature over the signed pre-key |
| `oneTimePreKeyCount` | number | Remaining one-time pre-key inventory |
| `lastResupplyAt` | number | Last replenishment timestamp |

This device directory is signed indirectly because the entire `AgentCard` is signed.

### 6.4 Message Envelope

The canonical application message envelope is:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Message identifier |
| `from` | string | Sender DID |
| `to` | string | Recipient DID |
| `type` | `message` or `reply` | Envelope semantic type |
| `protocol` | string | Application-defined protocol identifier |
| `payload` | any JSON value | Application payload |
| `timestamp` | number | Unix epoch milliseconds |
| `signature` | string | Hex-encoded Ed25519 signature |
| `replyTo` | string | Optional parent message id; REQUIRED for `reply` |
| `threadId` | string | Optional conversation thread id |
| `groupId` | string | Optional group identifier |

Rules:

- `from` and `to` MUST be `did:agent` identifiers.
- `reply` envelopes MUST include `replyTo`.
- `protocol` is application-defined and opaque to the relay transport.
- `payload` is application-defined and opaque to the relay transport.

Legacy values `request`, `response`, and `notification` are normalized to `message` or `reply` in current implementations.

### 6.5 Endorsement v2

The stable trust record shape is:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `2` | Endorsement schema version |
| `from` | string | Endorser DID |
| `to` | string | Endorsee DID |
| `score` | number | Range `0.0` to `1.0` |
| `domain` | string | Optional capability domain |
| `reason` | string | Human-readable rationale |
| `timestamp` | number | Unix epoch milliseconds |
| `expires` | number | Optional expiry time |
| `signature` | string | Hex-encoded Ed25519 signature |

`score = 0` is valid and represents explicit distrust / revocation.

## 7. Canonical Serialization and Signing

Cross-language interoperability in `quadra-a` depends on canonical serialization behavior.

### 7.1 Agent Card signature

An implementation MUST sign the UTF-8 bytes of:

```text
JSON.stringify(card_without_signature)
```

The resulting Ed25519 signature MUST be hex-encoded into the `signature` field.

### 7.2 Message Envelope signature

An implementation MUST sign the UTF-8 bytes of:

```text
JSON.stringify(envelope_without_signature)
```

The resulting Ed25519 signature MUST be hex-encoded into the `signature` field.

Because JSON member order is part of the signed byte sequence, implementations MUST preserve the canonical field order used by the shared JS and Rust types.

### 7.3 Relay message encoding

Relay control messages are encoded as CBOR on the wire.

- The canonical reference encoding is the `cbor-x`-compatible layout used by the shared JS protocol package.
- The `SEND.envelope` and `DELIVER.envelope` fields contain raw CBOR bytes for a signed `MessageEnvelope`.

### 7.4 `HELLO` signature

The relay handshake uses a separate signed payload.

An implementation MUST sign the CBOR encoding of:

- `{ did, card, timestamp }`, or
- `{ did, card, timestamp, inviteToken }` when a private relay requires admission tokens.

Field insertion order matters. The signed object order is exactly:

1. `did`
2. `card`
3. `timestamp`
4. `inviteToken` (only if present)

### 7.5 Encrypted transport envelope

When E2E messaging is used, the inner plaintext is the signed application `MessageEnvelope`, serialized as JSON bytes.

The outer transport envelope is itself another signed `MessageEnvelope` with:

- `type = "message"`
- `protocol = "/agent/e2e/1.0.0"`
- `payload = EncryptedApplicationEnvelopePayload`

This outer envelope is what the relay transports.

## 8. Agent-Facing Relay Protocol

The primary network binding is WebSocket carrying CBOR relay frames.

### 8.1 Session establishment

An agent opens a WebSocket connection and sends a `HELLO` frame.

`HELLO` fields:

| Field | Meaning |
| --- | --- |
| `type = "HELLO"` | Message discriminator |
| `protocolVersion = 1` | Relay protocol version |
| `did` | Connecting agent DID |
| `card` | Signed `AgentCard` for that DID |
| `timestamp` | Current client time in Unix ms |
| `signature` | Signature over the `HELLO` payload defined in §7.4 |
| `inviteToken` | Optional or required on private relays |

Relay requirements:

- The relay MUST reject invalid DID syntax.
- The relay MUST reject a card whose `did` does not equal `HELLO.did`.
- The relay MUST verify the `AgentCard` signature.
- The relay MUST verify the `HELLO` signature.
- The relay SHOULD reject stale `HELLO` timestamps.
- Private relays MAY require an `inviteToken` and assign the connection to a `realm`.

Successful admission returns `WELCOME`:

| Field | Meaning |
| --- | --- |
| `type = "WELCOME"` | Message discriminator |
| `protocolVersion = 1` | Relay protocol version |
| `relayId` | Relay DID |
| `peers` | Visible online peers in the requester's realm |
| `federatedRelays` | Known connected relays |
| `yourAddr` | Relay-local address hint |
| `realm` | Optional visibility realm |

### 8.2 Discoverability is separate from connectivity

Connecting to a relay does **not** make an agent discoverable.

The stable profile is:

1. Agent connects with `HELLO`.
2. Agent is reachable by DID routing.
3. Agent becomes discoverable only after `PUBLISH_CARD`.

This allows anonymous listening, private presence, and later publication.

### 8.3 Publication and card fetch

Agent-facing publication messages:

| Message | Direction | Meaning |
| --- | --- | --- |
| `PUBLISH_CARD` | agent → relay | Mark the current card as discoverable, optionally replacing it |
| `UNPUBLISH_CARD` | agent → relay | Remove the card from discovery while staying connected |
| `FETCH_CARD { did }` | agent → relay | Request the latest known card for a DID |
| `CARD { did, card }` | relay → agent | Return the card or `null` |

### 8.4 Discovery

Discovery request:

| Field | Meaning |
| --- | --- |
| `query` | Free-text query across name/description/capabilities |
| `capability` | Prefix-matching capability lookup |
| `minTrust` | Optional minimum trust threshold |
| `limit` | Optional max results |

Discovery response:

| Field | Meaning |
| --- | --- |
| `agents` | Matching visible agents |
| `card` | Signed `AgentCard` for each agent |
| `online` | Current online status |
| `homeRelay` | Optional home relay hint |

Implementation notes for the stable profile:

- Only online + discoverable agents are returned.
- Visibility is realm-scoped when private relay realms are enabled.
- Capability discovery uses prefix semantics.
- Relay implementations MAY include pagination extensions such as `cursor` and `total`.

### 8.5 Message routing

Agent-facing routing messages:

| Message | Direction | Meaning |
| --- | --- | --- |
| `SEND { to, envelope }` | agent → relay | Submit a CBOR-encoded signed envelope for routing |
| `DELIVER { messageId, from, envelope }` | relay → agent | Deliver a routed envelope |
| `ACK { messageId }` | agent → relay | Confirm local receipt |
| `DELIVERY_REPORT` | relay → agent | Delivery status hint |

Delivery report statuses currently include:

- `delivered`
- `expired`
- `queue_full`
- `unknown_recipient`

The relay uses `to` for routing and stores queued traffic for offline recipients.

### 8.6 Liveness and shutdown

| Message | Meaning |
| --- | --- |
| `PING` / `PONG` | Connection liveness |
| `GOODBYE` | Graceful session shutdown |

## 9. End-to-End Encrypted Messaging

### 9.1 Algorithm suite

The current E2E profile is built on:

- Ed25519 for DID-bound signatures,
- X25519 device keys,
- X3DH for first-contact session bootstrap,
- Double Ratchet for session continuation,
- HKDF-SHA256 for key derivation,
- XChaCha20-Poly1305 for message encryption.

The DID key is the signature identity. It is **not** reused as the X25519 message-encryption key.

### 9.2 Pre-key control plane

Relay control messages for encrypted first contact:

| Message | Direction | Meaning |
| --- | --- | --- |
| `PUBLISH_PREKEYS { bundles }` | agent → relay | Publish device pre-key bundles |
| `PREKEYS_PUBLISHED` | relay → agent | Acknowledge publication |
| `FETCH_PREKEY_BUNDLE { did, deviceId }` | agent → relay | Atomically claim bundle material for first contact |
| `PREKEY_BUNDLE { did, deviceId, bundle }` | relay → agent | Return claimed bundle or `null` |

Each published pre-key bundle extends the device directory with a one-time pre-key set.

### 9.3 Wire message classes

The E2E wire classes are:

- `PREKEY_MESSAGE` for first contact / session bootstrap,
- `SESSION_MESSAGE` for established ratchet sessions.

Both are CBOR objects with `version = 1` and a typed payload.

Stable fields in `PREKEY_MESSAGE`:

- `senderDid`
- `receiverDid`
- `senderDeviceId`
- `receiverDeviceId`
- `sessionId`
- `messageId`
- `initiatorIdentityKey`
- `initiatorEphemeralKey`
- `recipientSignedPreKeyId`
- `recipientOneTimePreKeyId` (optional)
- `nonce`
- `ciphertext`

Stable fields in `SESSION_MESSAGE`:

- `senderDid`
- `receiverDid`
- `senderDeviceId`
- `receiverDeviceId`
- `sessionId`
- `messageId`
- `ratchetPublicKey`
- `previousChainLength`
- `messageNumber`
- `nonce`
- `ciphertext`

### 9.4 Outer encrypted transport payload

The outer envelope payload for encrypted routing is:

| Field | Meaning |
| --- | --- |
| `kind = "quadra-a-e2e"` | Payload discriminator |
| `version = 1` | E2E payload version |
| `encoding = "hex"` | `wireMessage` encoding |
| `messageType` | `PREKEY_MESSAGE` or `SESSION_MESSAGE` |
| `senderDeviceId` | Sender device id |
| `receiverDeviceId` | Recipient device id |
| `sessionId` | Session identifier |
| `wireMessage` | Hex-encoded CBOR E2E message |

### 9.5 Relay-visible vs relay-hidden information

In the encrypted transport profile, the relay can see:

- sender DID,
- recipient DID,
- outer message id,
- timestamp,
- delivery timing,
- approximate ciphertext size,
- `messageType`, `senderDeviceId`, `receiverDeviceId`, and `sessionId` in the outer E2E payload.

The relay does not need the inner plaintext to route the message. The encrypted design hides:

- application `protocol`,
- application `payload`,
- `replyTo`,
- `threadId`,
- `groupId`.

Discovery, trust, Agent Card publication, and pre-key control-plane traffic remain relay-visible by design. See `docs/e2e-operations.md` for the operator-facing boundary summary.

### 9.6 Current interoperable profile

The current public interoperability profile is intentionally conservative:

- the recipient MUST publish at least one device,
- runtime / CLI send paths in JS and Rust already fan out to every published recipient device and keep per-device ratchet state,
- local message history dedupes visible business messages across recipient devices,
- lower-level single-device helpers still exist for focused vector and protocol tests,
- retained real-machine evidence for the multi-device profile is still pending before this surface should be called fully complete.

Future revisions are expected to standardize `1:N` device delivery, dedupe, and key rotation behavior.

## 10. Trust and Policy

`quadra-a` includes a lightweight trust layer but does not treat trust as identity.

- Identity answers **who signed this**.
- Trust answers **how much should I rely on them for a domain**.

Stable trust operations:

| Message | Meaning |
| --- | --- |
| `ENDORSE` | Submit a signed endorsement record |
| `TRUST_QUERY` | Query endorsements for a target DID |
| `TRUST_RESULT` | Return endorsements and aggregate stats |

Trust is advisory:

- discovery MAY filter by `minTrust`,
- clients MAY rank results by trust,
- trust MUST NOT replace signature verification.

## 11. Privacy and Security Properties

### 11.1 Guaranteed by the protocol

- Self-certifying identity through `did:agent`
- Tamper detection on `AgentCard` and signed envelopes
- Sender authentication for relay admission
- Confidentiality of the inner application envelope when the E2E profile is used

### 11.2 Not hidden from the relay

- who is connected,
- who sends to whom,
- traffic timing,
- online status,
- some E2E wrapper metadata,
- optional trust/publication metadata.

### 11.3 Private relay domains

Private relays MAY require an operator-issued `inviteToken`.

When enabled, admission policy can bind:

- visibility realm,
- token expiry,
- token revocation,
- maximum concurrent agents,
- optional DID-specific admission.

## 12. Versioning and Extensibility

Versioned surfaces in the current profile:

- relay protocol: `protocolVersion = 1`
- encrypted application payload: `version = 1`
- E2E wire messages: `version = 1`
- endorsement format: `version = 2`

Extension points:

- `AgentCard.metadata`
- capability `parameters`
- capability `metadata`
- application-level `protocol` identifiers
- relay message extensions carried as new `type` values

Clients SHOULD ignore unknown object fields when they are outside signature-critical material, and MUST reject unknown mandatory discriminators when safe interoperability would otherwise be impossible.

## 13. Draft Areas

The following areas are intentionally left draft in this version of the spec:

1. operator-facing encrypted receive / inbox lifecycle semantics,
2. retained real-machine proof of relay opacity for every queue / inspection path,
3. a frozen public multi-device fan-out / dedupe / signed-prekey-rotation profile,
4. a frozen public federation profile between relays,
5. a frozen public event-subscription profile.

These areas already have running implementations in the repository, but they are not yet frozen interoperability targets.

## 14. Summary

`quadra-a` standardizes a compact agent network stack:

- **Identity**: self-certifying `did:agent`
- **Discovery**: signed `AgentCard`
- **Transport**: relay-backed WebSocket rendezvous and routing
- **Messaging**: signed application envelope
- **Security**: X3DH + Double Ratchet encrypted transport profile
- **Trust**: signed domain-scoped endorsements

In short: A2A is the conversation contract for agent work; `a4` is the secure phone network agents can use to find and reach one another.
