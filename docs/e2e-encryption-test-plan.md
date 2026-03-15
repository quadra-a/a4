# quadra-a E2E Encryption Test Plan

This plan defines the test inventory that must exist before the new E2E protocol can be considered complete. It intentionally covers JavaScript, Rust, relay behavior, cross-language interoperability, and real-machine chain validation.

## Goals

- Prove that JS and Rust implement the same protocol, not just similar behavior.
- Prove that offline first messages work through pre-key bootstrapping.
- Prove that relay and federation layers route opaque ciphertext without learning application content.
- Prove that multi-device delivery works without duplicate user-visible business messages.
- Prove that tampering, replay, and key-substitution attempts fail deterministically.

## Test layers

### 1. Protocol unit tests

These run without a live relay and consume shared fixture material.

#### Shared crypto primitives

- `E2E-X3DH-001` shared-secret derivation matches the vector corpus in JS and Rust.
- `E2E-X3DH-002` signed pre-key signatures verify against the DID-backed Ed25519 identity.
- `E2E-CRYPTO-001` XChaCha20-Poly1305 encrypt/decrypt succeeds with the expected associated data.
- `E2E-CRYPTO-002` ciphertext, nonce, or associated-data tampering fails authentication.

#### Pre-key initialization

- `E2E-X3DH-003` initiator constructs a valid first message using a bundle with an OTK.
- `E2E-X3DH-004` responder consumes the claimed OTK exactly once and derives the same root key.
- `E2E-PREKEY-003` no-OTK fallback path is encoded explicitly and still establishes a valid session.

#### Double Ratchet

- `E2E-RATCHET-001` first post-X3DH send step derives the expected sending chain key.
- `E2E-RATCHET-002` peer receive step derives the expected message key and advances state.
- `E2E-RATCHET-003` out-of-order receive within the skipped-key window succeeds.
- `E2E-RATCHET-004` out-of-order receive beyond the skipped-key window fails with a stable error.
- `E2E-RATCHET-005` DH ratchet step rotates root/send/receive chains as expected.
- `E2E-RATCHET-006` compromise recovery path works after a DH step from the uncompromised peer.

#### Device directory and card validation

- `E2E-CARD-001` `AgentCard.devices` validates required fields and signature coverage.
- `E2E-CARD-002` card tampering that replaces a device key fails signature verification.
- `E2E-ID-001` local identity persistence round-trips device state across restart.
- `E2E-ID-002` signed pre-key rotation updates local state without regenerating the DID.

### 2. Shared vector tests

These assert that JS and Rust use the same fixture schema and byte-level protocol behavior.

- `E2E-VECTOR-001` both runtimes load the same X3DH vector file.
- `E2E-VECTOR-002` both runtimes serialize `PREKEY_MESSAGE` headers identically.
- `E2E-VECTOR-003` both runtimes validate the shared vector manifest schema.
- `E2E-VECTOR-004` both runtimes deserialize the same `SESSION_MESSAGE` bytes into equivalent semantic fields.

### 3. Cross-language automated interoperability

These tests run locally with both runtimes available.

- `E2E-CROSS-001` JS initiator sends the first message to Rust responder.
- `E2E-CROSS-002` Rust initiator sends the first message to JS responder.
- `E2E-CROSS-003` JS continues a ratcheted session created by Rust.
- `E2E-CROSS-004` Rust continues a ratcheted session created by JS.
- `E2E-CROSS-005` JS and Rust handle offline first-message delivery through the same relay harness.
- `E2E-CROSS-006` JS and Rust produce equivalent relay-visible headers while hiding the same application plaintext fields.

### 4. Runtime, CLI, and daemon integration

These tests validate local state handling after the protocol engine is wired into end-user flows.

#### JavaScript

- `E2E-JS-RUNTIME-001` `tell`/`send` fetches device bundles and sends only encrypted application messages.
- `E2E-JS-RUNTIME-002` incoming ciphertext decrypts to a signed application envelope and is stored as decrypted local state.
- `E2E-JS-RUNTIME-003` daemon restart reloads session state and continues the ratchet instead of starting a new session.

#### Rust

- `E2E-RUST-RUNTIME-001` Rust `tell`/daemon send path uses bundle fetch plus ratchet reuse.
- `E2E-RUST-RUNTIME-002` incoming ciphertext is decrypted, verified, and persisted without exposing raw ciphertext as a business message.
- `E2E-RUST-RUNTIME-003` restart preserves session continuity and skipped-key caches.

### 5. Relay and federation integration

- `E2E-RELAY-001` relay queue stores opaque ciphertext bytes for application messages.
- `E2E-RELAY-002` relay local delivery never requires decoding application plaintext.
- `E2E-RELAY-003` relay-control messages remain explicit and are not multiplexed through application ciphertext.
- `E2E-FED-001` federated relays route application ciphertext without decoding `protocol` or `payload`.
- `E2E-FED-002` federation preserves device-level routing metadata needed for delivery but not application plaintext.
- `E2E-PREKEY-001` pre-key bundle lookup returns the expected device directory and signed pre-key metadata.
- `E2E-PREKEY-002` claiming an OTK is atomic under concurrent requests.
- `E2E-PREKEY-004` double-claim attempts leave exactly one valid claimant.
- `E2E-PREKEY-006` low OTK inventory emits a detectable health signal.

### 6. Multi-device behavior

- `E2E-MULTI-001` first contact fans out to all active recipient devices.
- `E2E-MULTI-002` receiving the same business message on multiple devices does not surface duplicate user-visible messages.
- `E2E-MULTI-003` per-device sessions continue independently after one device goes offline.
- `E2E-MULTI-004` signed pre-key rotation on one recipient device does not invalidate other devices.

### 7. Negative and security tests

- `E2E-NEG-001` forged sender device key is rejected.
- `E2E-NEG-002` signed pre-key signature mismatch is rejected.
- `E2E-NEG-003` replay of a consumed pre-key message is rejected or treated idempotently with no second session.
- `E2E-NEG-004` replay of a session message does not create a duplicate business message.
- `E2E-NEG-005` modified ciphertext fails before business-message delivery.
- `E2E-NEG-006` modified ratchet header fails before business-message delivery.
- `E2E-NEG-007` plaintext legacy application message is rejected by the new receive path.
- `E2E-NEG-008` sender attempts to use a stale or rotated-out signed pre-key and gets a stable failure.

### 8. Real-machine full-chain tests

These use live processes on separate hosts or separately networked environments. The full procedures live in `test-scripts/e2e/REAL_MACHINE_FULL_CHAIN_TEST.md`.

- `E2E-RM-001` JS sender on host A to JS receiver on host B through relay host C.
- `E2E-RM-002` Rust sender on host A to Rust receiver on host B through relay host C.
- `E2E-RM-003` JS sender on host A to Rust receiver on host B, recipient offline for the first message.
- `E2E-RM-004` Rust sender on host A to JS receiver on host B, recipient offline for the first message.
- `E2E-RM-005` JS sender behind relay A to Rust receiver behind relay B through federation.
- `E2E-RM-006` relay log and queue inspection show no application `protocol` or `payload` plaintext.
- `E2E-RM-007` multi-device DID receives one business message on two devices with correct dedupe behavior.
- `E2E-RM-008` low OTK inventory plus pre-key replenishment is observable without breaking in-flight sessions.

## Acceptance criteria

- All P0 cases in the test matrix are green in JS and Rust.
- Shared vector files are consumed by both runtimes without per-language overrides.
- Cross-language runs pass in both initiator directions.
- Real-machine runs archive artifacts under `test-output/e2e/` for operator review.
- No relay-side assertion depends on decoding application plaintext.

## Evidence to retain

For each real-machine suite, retain:

- sender CLI output
- receiver CLI output
- relay logs
- queue inspection output
- session inspection output
- the scenario manifest and timestamps

The retained evidence is part of the completion bar. A passing terminal line without artifacts is not sufficient.
