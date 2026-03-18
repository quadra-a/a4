# quadra-a E2E Encryption Execution TODO

This document turns the agreed E2E direction into an implementation checklist that can be executed across `js`, `rust`, and `relay` without reopening protocol decisions.

## Locked decisions

- Agent application messages move to a new protocol family built on `X3DH + Double Ratchet + X25519 + HKDF-SHA256 + XChaCha20-Poly1305`.
- `did:agent` remains the Ed25519 identity and signature surface. It is not reused as the message-encryption key.
- A DID may publish multiple devices. Each device gets its own X25519 identity key, signed pre-key, one-time pre-key pool, and ratchet sessions.
- Relay transport, discovery, trust queries, and other relay-control traffic remain outside the application E2E envelope.
- No migration window is planned. Legacy plaintext agent application messages are removed once the new path is wired.
- JavaScript/TypeScript and Rust are implemented together and held to the same test vectors and interoperability gates.

## Completion gates

- `Gate A`: shared protocol spec and fixture schema are frozen.
- `Gate B`: JS and Rust both pass protocol unit tests against shared vectors.
- `Gate C`: JS↔Rust cross-language tests pass for pre-key init, ratchet continuation, offline first message, and multi-device fan-out.
- `Gate D`: relay queue and federation paths store and forward opaque ciphertext only.
- `Gate E`: real-machine full-chain scenarios pass with evidence captured from logs, queue state, and client output.

## Progress status (2026-03-12)

- Checkpoint scope: the shared protocol/vector layer, the local device-bootstrap / signed-card-publication layer, the relay pre-key control plane, the shared X3DH first-message bootstrap/session layer, the shared Double Ratchet core/state-vector layer, the single-device runtime encrypted send + receive path in JS/Rust, the deterministic local multi-device runtime fan-out + receive-dedupe building blocks in JS/Rust, per-device local delivery metadata in JS/Rust message stores, per-device signed pre-key rotation continuity helpers in JS/Rust, the current relay byte-opaque queue/federation routing refactor, the JS relay-client inbound serialization fix for strict per-connection message ordering, an executable JS↔Rust artifact interoperability harness for `E2E-CROSS-001` / `E2E-CROSS-002`, a relay-visible header parity harness for `E2E-CROSS-006`, a live local dual-relay federated delivery harness for `E2E-FED-001`, a live local-relay offline first-message harness for `E2E-CROSS-005`, and the local multi-device relay harness cases `E2E-MULTI-001` / `E2E-MULTI-002` with signed pre-key rotation continuity are now landed; full-chain automation and real-machine evidence are still pending.
- `Gate A`: in progress. `PREKEY_MESSAGE` / `SESSION_MESSAGE` wire shapes, X3DH + Double Ratchet KDF inputs, shared vector schema, the published `AgentCard.devices` field shape, the relay-control pre-key fetch/claim messages, and the inner signed application-envelope transport/decrypt contract are now locked in code; discovery-side validation and end-to-end encrypted fetch-path hardening are still pending.
- `Gate B`: in progress. JS and Rust both pass their shared-vector protocol tests for signed pre-key fixtures, X3DH bootstrap/session, `PREKEY_MESSAGE` / `SESSION_MESSAGE` codecs, the shared Double Ratchet bootstrap/reply path with skipped-key recovery, the signed inner application-envelope encrypt/decrypt contract, focused runtime send/receive-path tests that bootstrap then reuse ratchet state, focused local multi-device fan-out/session-reuse tests, delivery-metadata merge/unit tests, signed pre-key rotation continuity unit tests, the initial executable JS↔Rust artifact interop harness, the relay-visible header parity harness, the federated delivery harness, the relay-backed offline first-message harness, and focused JS relay-client / relay-federation control-plane regressions that now serialize per-connection inbound relay frames while preserving interleaved async traffic and failing pending requests promptly on disconnect; remaining work here is broader negative coverage, discovery/fetch hardening, and real-machine evidence.
- `Gate C`: in progress. `E2E-CROSS-001` (JS initiator → Rust responder), `E2E-CROSS-002` (Rust initiator → JS responder), `E2E-CROSS-006` (JS/Rust relay-visible header parity plus hidden-plaintext assertions), `E2E-FED-001` (JS initiator → Rust responder across two federated local relays), `E2E-CROSS-005` (JS initiator → offline Rust responder through a live local relay), `E2E-MULTI-001` (JS initiator → Rust multi-device responder with secondary-device signed pre-key rotation continuity), and `E2E-MULTI-002` (Rust initiator → JS multi-device responder with secondary-device signed pre-key rotation continuity) now run under `test-scripts/e2e/test-e2e-cross-lang.sh` with captured artifacts, relay logs, queue scans, session counts, relay-published card observations, and receiver output; broader real-machine evidence is still pending.
- `Gate D`: in progress. JS relay queueing and federation forwarding now treat application envelopes as opaque byte payloads, relay-directed `SEND` tunneling for control-plane messages is disabled, federated pre-key bundle lookup now resolves through the target home relay without exposing business plaintext, and JS/Rust client/runtime surfaces now only accept/store decrypted inner business envelopes locally; full-chain real-machine evidence and operator-facing documentation are still pending.
- `Gate E`: planning only. Operator checklist docs exist, but runnable real-machine harnesses and artifact capture are still missing.
- Validation evidence at this checkpoint:
  - `pnpm exec vitest run test/e2e-vectors.test.ts test/e2e-device-state.test.ts` from `js/core/protocol` ✅
  - `pnpm exec vitest run src/agent-runtime.test.ts src/e2e-config.test.ts` from `js/core/runtime` ✅
  - `pnpm exec vitest run` from `js/core/runtime` ✅
  - `pnpm run build` from `js/core/runtime` ✅
  - `cargo test -p quadra-a-core e2e:: -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime build_agent_card_from_config_publishes_device_directory -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime prepare_encrypted_send_fetches_prekey_once_then_reuses_session -- --nocapture` from `rust` ✅
  - `pnpm exec vitest run src/__tests__/prekey-store.test.ts src/__tests__/prekey-control.test.ts` from `js/relay` ✅
  - `cargo test -p quadra-a-runtime publish_prekey_bundles_sends_expected_payload -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime fetch_prekey_bundle_returns_claimed_bundle_and_null_after_exhaustion -- --nocapture` from `rust` ✅
  - `pnpm exec vitest run src/e2e-send.test.ts` from `js/core/runtime` ✅
  - `cargo check -p quadra-a-runtime -p quadra-a-cli` from `rust` ✅
  - `cargo test -p quadra-a-runtime e2e_send:: -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime inbox:: -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime publish_prekey_bundles_preserves_interleaved_deliver_messages -- --nocapture` from `rust` ✅
  - `pnpm exec vitest run test/e2e-bootstrap.test.ts test/e2e-vectors.test.ts` from `js/core/protocol` ✅
  - `pnpm exec vitest run test/e2e-bootstrap.test.ts test/e2e-ratchet.test.ts test/e2e-vectors.test.ts` from `js/core/protocol` ✅
  - `pnpm exec vitest run test/relay-client-card-verification.test.ts test/relay-client-control-plane.test.ts` from `js/core/protocol` ✅
  - `pnpm run build` from `js/core/protocol` ✅
  - `pnpm exec vitest run test/e2e-device-state.test.ts src/messaging/storage.test.ts` from `js/core/protocol` ✅
  - `pnpm exec vitest run src/e2e-send.test.ts src/e2e-receive.test.ts` from `js/core/runtime` ✅
  - `pnpm exec vitest run test/e2e-bootstrap.test.ts test/e2e-application-envelope.test.ts` from `js/core/protocol` ✅
  - `cargo test -p quadra-a-core rejects_` from `rust` ✅
  - `cargo check -p quadra-a-core` from `rust` ✅
  - `cargo test -p quadra-a-core rotates_one_device_signed_pre_key_without_disturbing_sessions` from `rust` ✅
  - `cargo test -p quadra-a-runtime store_merges_duplicate_e2e_deliveries_per_direction` from `rust` ✅
  - `pnpm exec vitest run src/__tests__/federation-manager.test.ts src/__tests__/relay-federation-directory.test.ts` from `js/relay` ✅
  - `pnpm run build` from `js/relay` ✅
  - `bash test-scripts/e2e/test-e2e-cross-lang.sh --no-offline` from `repos/a4` ✅ (`E2E-CROSS-001`, `E2E-CROSS-002`, `E2E-CROSS-006`, `E2E-MULTI-001`, `E2E-MULTI-002`, `E2E-FED-001`; artifacts under `test-output/e2e/cross-lang/20260312-013505/`)
  - `bash test-scripts/e2e/test-e2e-cross-lang.sh --multi-js-to-rust-only` from `repos/a4` ✅ (`E2E-MULTI-001` with secondary-device signed pre-key rotation continuity; artifacts under `test-output/e2e/cross-lang/20260312-012857/`)
  - `bash test-scripts/e2e/test-e2e-cross-lang.sh --multi-rust-to-js-only` from `repos/a4` ✅ (`E2E-MULTI-002` with secondary-device signed pre-key rotation continuity; artifacts under `test-output/e2e/cross-lang/20260312-012928/`)
  - `cargo test -p quadra-a-core double_ratchet_fixture_matches_bootstrap_and_dh_reply -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-core continues_ratchet_session_and_handles_responder_dh_reply -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-core recovers_out_of_order_messages_from_skipped_keys -- --nocapture` from `rust` ✅
  - `cargo fmt --all --check` from `rust` ✅
  - `cargo test -p quadra-a-core builds_and_consumes_prekey_message_with_otk -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-core supports_prekey_message_no_otk_fallback -- --nocapture` from `rust` ✅
  - `cargo check` from `rust` ✅
  - `pnpm exec vitest run test/e2e-application-envelope.test.ts test/e2e-bootstrap.test.ts test/e2e-ratchet.test.ts` from `js/core/protocol` ✅
  - `pnpm exec vitest run src/e2e-send.test.ts src/e2e-receive.test.ts` from `js/core/runtime` ✅
  - `cargo test -p quadra-a-core encrypts_and_decrypts_application_envelope_across_prekey_and_session_messages -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime prepare_encrypted_receive_bootstraps_then_reuses_session -- --nocapture` from `rust` ✅
  - `pnpm exec vitest run src/__tests__/queue.test.ts src/__tests__/federation-manager.test.ts src/__tests__/relay-federation-directory.test.ts` from `js/relay` ✅
  - `cargo test -p quadra-a-runtime reconstructs_buffer_objects_from_node_json_encoding -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime rejects_inline_object_envelopes -- --nocapture` from `rust` ✅
  - `cargo test -p quadra-a-runtime rejects_string_encoded_envelopes -- --nocapture` from `rust` ✅
  - `bash test-scripts/e2e/test-e2e-cross-lang.sh --offline-js-to-rust-only` from `repos/a4` ✅ (`E2E-CROSS-005`; artifacts under `test-output/e2e/cross-lang/20260312-013606/`)

## Workstreams

### 0. Spec freeze and fixture contract

- [x] Freeze the wire shapes for `PREKEY_MESSAGE` and `SESSION_MESSAGE`.
  - Status: completed in the shared JS/Rust codec layer and locked by deterministic vectors under `test-scripts/e2e/vectors/prekey-message/` and `test-scripts/e2e/vectors/session-message/`.
  - Done when every field is named, typed, ordered, and assigned a byte-level encoding.
  - Test points: `E2E-VECTOR-001`, `E2E-VECTOR-002`.
- [ ] Freeze the device directory shape published in `AgentCard.devices`.
  - Progress: the field shape is now wired into JS/Rust card types and signed-card publication paths, and the signed-pre-key payload/fixture coverage exists under `test-scripts/e2e/vectors/agent-card-devices/`; device-directory validation rules and discovery/fetch-path hardening are still pending.
  - Done when the card fields, signature coverage, and required validation rules are documented.
  - Test points: `E2E-CARD-001`, `E2E-CARD-002`.
- [x] Freeze the associated-data layout and KDF inputs for all message classes.
  - Status: completed for the current shared layer covering X3DH derivation, Double Ratchet root/chain KDF inputs, and `PREKEY_MESSAGE` / `SESSION_MESSAGE` associated-data builders in both runtimes; the inner signed application-envelope contract remains a separate pending item below.
  - Done when JS and Rust can derive identical intermediate values from a shared fixture.
  - Test points: `E2E-X3DH-001`, `E2E-RATCHET-001`, `E2E-CRYPTO-001`.
- [x] Publish the shared vector manifest schema used by both runtimes.
  - Status: committed as `test-scripts/e2e/vectors/schema.json` and consumed by both runtimes.
  - Done when the schema is committed and referenced by the test plan.
  - Test points: `E2E-VECTOR-003`.

### 1. Identity, card, and device directory

- [x] Extend local identity storage to persist device-level X25519 material.
  - Status: completed for the current single-device bootstrap layer in JS and Rust config/runtime storage. `listen` / `init` now create and reuse persisted device ID, X25519 identity key pair, signed pre-key, OTK inventory, and placeholder session map without regenerating on each publish/build.
  - JS and Rust both store device ID, identity key pair, signed pre-key, OTK pool metadata, and ratchet sessions.
  - Done when init/listen flows can create and reload the same device state without regeneration.
  - Test points: `E2E-ID-001`, `E2E-ID-002`.
- [x] Extend `AgentCard` to publish a signed `devices` directory.
  - Status: completed for JS and Rust card-building/publication surfaces. Signed cards now include top-level `devices` entries derived from persisted local E2E device state; discovery-side signature validation and fetch-path hardening continue in parallel.
  - Include `deviceId`, `identityKeyPublic`, `signedPreKeyPublic`, `signedPreKeyId`, `signedPreKeySignature`, `oneTimePreKeyCount`, and `lastResupplyAt`.
  - Done when discovery/fetch-card responses expose the same card shape in JS and Rust.
  - Test points: `E2E-CARD-001`, `E2E-DISCOVERY-001`.
- [x] Define signed pre-key rotation and OTK replenishment rules.
  - Status: completed for the local JS/Rust device-state layer. Both runtimes now preserve the existing device identity key and session map, replace only the signed pre-key, replenish the local OTK pool, and bump `lastResupplyAt` without changing the DID or disturbing sibling devices.
  - Done when a device can rotate keys without invalidating the DID or breaking other devices.
  - Test points: `E2E-PREKEY-005`, `E2E-MULTI-004`.

### 2. Relay pre-key service and opaque routing

- [x] Add relay-control messages for pre-key bundle retrieval and one-time pre-key consumption.
  - Status: completed for JS and Rust relay/client surfaces with persistent relay-side bundle storage, atomic one-time pre-key claim/consume semantics, federated home-relay bundle lookup/claim support on the JS relay, and targeted JS/Rust validation coverage.
  - Done when a client can atomically fetch/claim bundle material without using the application message channel.
  - Test points: `E2E-PREKEY-001`, `E2E-PREKEY-002`, `E2E-PREKEY-004`.
- [x] Remove relay assumptions that regular agent message envelopes are decodable plaintext.
  - Status: completed for the current JS relay and Rust client/runtime surfaces. Offline queueing, local delivery, and federation routing now keep application envelopes as opaque byte payloads, and Rust relay delivery parsing rejects inline-object and string-encoded envelope fallbacks.
  - Done when application message handling treats ciphertext as opaque bytes in local delivery, queueing, and federation.
  - Test points: `E2E-RELAY-001`, `E2E-RELAY-002`, `E2E-FED-001`.
- [x] Keep relay-control and federation-control traffic explicit and separate from application E2E payloads.
  - Status: completed for the current relay control-plane. `FETCH_CARD`, discovery, trust, health, and other relay/federation control flows stay on explicit top-level message types, relay-directed `SEND` envelopes are no longer interpreted as tunneled control messages, and the JS relay client now routes control replies through a single inbound dispatcher so interleaved `DELIVER` / `DELIVERY_REPORT` traffic is preserved while pending control requests fail fast on disconnect.
  - Done when no control-plane feature depends on decoding application ciphertext.
  - Test points: `E2E-RELAY-003`.

### 3. Shared crypto engine and protocol codec

- [x] Implement X25519 key helpers and deterministic fixture loading in JS and Rust.
  - Status: completed in `js/core/protocol/src/e2e/` and `rust/core/src/e2e/`, with both runtimes consuming the same vector corpus.
  - Done when both runtimes can parse the same fixture set and produce identical public keys and shared secrets.
  - Test points: `E2E-X3DH-001`, `E2E-X3DH-002`.
- [x] Implement X3DH initiator and responder logic with optional no-OTK fallback.
  - Status: completed in the shared JS/Rust E2E layer with first-message `PREKEY_MESSAGE` construction/consumption helpers, local session persistence records, local OTK consumption marking, and explicit no-OTK fallback coverage.
  - Done when the first offline message can establish a session and consume an OTK exactly once.
  - Test points: `E2E-X3DH-003`, `E2E-X3DH-004`, `E2E-PREKEY-003`.
- [x] Implement Double Ratchet state machine, header codec, skipped-key handling, and rekey logic.
  - Status: completed in the shared JS/Rust E2E layer with deterministic bootstrap/reply vectors, skipped-key recovery coverage, and explicit DH-ratchet rekey tests.
  - Done when both runtimes accept the same vector corpus and handle out-of-order delivery within the configured window.
  - Test points: `E2E-RATCHET-001` through `E2E-RATCHET-006`.
- [ ] Define the encrypted-plaintext envelope contract.
  - Progress: the shared JS/Rust core now defines a relay-visible `/agent/e2e/1.0.0` transport envelope that carries only encrypted `PREKEY_MESSAGE` / `SESSION_MESSAGE` payloads plus device/session routing metadata, the plaintext is the signed application envelope, both runtimes now decrypt/verify that inner envelope on receive before storing business messages locally, the JS relay queue/federation paths now forward only opaque outer-envelope bytes, `E2E-CROSS-006` asserts JS/Rust visible-header parity plus the absence of plaintext `protocol` / `payload` leakage in artifact-level transport outputs, `E2E-FED-001` now scans both federated relay logs/data directories to confirm that business plaintext stays hidden during cross-relay delivery, and `E2E-MULTI-001` / `E2E-MULTI-002` now confirm that multi-device fan-out still keeps relay-visible state opaque. Real-machine evidence is still pending.
  - The plaintext is the signed application envelope; the relay-visible wrapper is not allowed to leak `protocol`, `payload`, `replyTo`, `threadId`, or `groupId`.
  - Done when relay logs, queue state, and federation links only carry routing metadata and ciphertext.
  - Test points: `E2E-CRYPTO-003`, `E2E-RELAY-001`, `E2E-RM-006`.

### 4. JavaScript / TypeScript integration

- [x] Add protocol-level E2E types, codecs, and vector-driven tests under `js/core/protocol`.
  - Status: completed with fixture-backed coverage in `js/core/protocol/test/e2e-vectors.test.ts`.
  - Done when JS can produce and consume fixture-backed pre-key and session messages.
  - Test points: `E2E-JS-UNIT-001` through `E2E-JS-UNIT-008`.
- [x] Wire JS runtime and CLI send flows through device directory lookup, bundle fetch, and ratchet session reuse.
  - Status: completed for the current single-device send path in daemon-backed and direct-relay JS flows. `tell`/`send` now fetch the target card, claim a pre-key bundle only for first contact, reuse stored ratchet sessions afterward, persist updated local session state, and emit only the generic encrypted outer envelope on the relay. Multi-device fan-out remains a separate pending workstream below.
  - Done when `tell`/`send` no longer emit plaintext application messages.
  - Test points: `E2E-JS-RUNTIME-001`, `E2E-CROSS-001`, `E2E-RM-001`.
- [x] Wire JS runtime receive flows through decryption, signature verification, dedupe, and session persistence.
  - Status: completed for the current single-device receive path in daemon-backed JS flows. The daemon now detects `/agent/e2e/1.0.0` transport envelopes, verifies both outer and inner signatures, advances/persists local ratchet state, and stores only the decrypted inner business envelope in inbox/session state. Multi-device dedupe remains a separate pending workstream below.
  - Done when daemon/session storage displays only decrypted local state and never raw ciphertext blobs as business messages.
  - Test points: `E2E-JS-RUNTIME-002`, `E2E-MULTI-002`, `E2E-RM-004`.

### 5. Rust integration

- [x] Add protocol-level E2E types, codecs, and vector-driven tests under `rust/core`.
  - Status: completed with fixture-backed coverage in `rust/core/src/e2e/tests.rs`.
  - Done when Rust can produce and consume the same pre-key and session vectors as JS.
  - Test points: `E2E-RUST-UNIT-001` through `E2E-RUST-UNIT-008`.
- [x] Wire Rust CLI/runtime send flows through bundle fetch, session bootstrap, and ratchet continuation.
  - Status: completed for the current single-device send path in direct-relay and daemon-backed Rust flows. `a4 tell` / `a4 send` and daemon `send` now ensure local E2E state exists, fetch the target card, claim a pre-key bundle only for first contact, reuse persisted ratchet sessions afterward, persist updated config state, and emit only the generic encrypted outer envelope on the relay. Multi-device fan-out remains a separate pending workstream below.
  - Done when `a4 tell` and daemon-backed send paths only emit encrypted application messages.
  - Test points: `E2E-RUST-RUNTIME-001`, `E2E-CROSS-002`, `E2E-RM-002`.
- [x] Wire Rust receive flows through decrypt → verify → store → display.
  - Status: completed for the current single-device receive path in daemon-backed Rust flows. The daemon now detects `/agent/e2e/1.0.0` transport envelopes, verifies both outer and inner signatures, advances/persists local ratchet state, and stores only the decrypted inner business envelope for inbox/session inspection. Multi-device dedupe remains a separate pending workstream below.
  - Done when session inspection and message lifecycle tooling work from decrypted local state.
  - Test points: `E2E-RUST-RUNTIME-002`, `E2E-MULTI-003`, `E2E-RM-005`.

### 6. Multi-device behavior

- [x] Define fan-out behavior for first contact to all active devices of a DID.
  - Status: completed. JS `prepareEncryptedSends(...)` and Rust `prepare_encrypted_sends_with_session(...)` deterministically sort the published device directory, reject duplicate device IDs, sign the business envelope once, fan out first-contact encryption to every published recipient device, reuse per-device sessions on follow-up sends, and now also survive secondary-device signed pre-key rotation continuity in `E2E-MULTI-001` / `E2E-MULTI-002`.
  - Done when sender behavior is deterministic and testable for `1:N` target-device delivery.
  - Test points: `E2E-MULTI-001`, `E2E-RM-007`.
- [x] Add device-level dedupe so one business message is not shown multiple times to the user.
  - Status: completed for the current JS/Rust local runtime surfaces. JS `StoredMessage.e2e.deliveries[]` and Rust `StoredMessage.e2e.deliveries[]` now record per-device delivery metadata, duplicate inbound copies merge onto the same visible business message by `(senderDeviceId, receiverDeviceId, sessionId)`, and outbound send paths can update the same delivery records from pending/sent/failed state. The local harness now asserts one visible receiver-side business message with two delivery records before and after signed pre-key rotation boundaries.
  - Done when one user-visible message is retained with per-device delivery metadata.
  - Test points: `E2E-MULTI-002`, `E2E-RM-007`.
- [x] Support signed pre-key rotation and session continuity per device.
  - Status: completed for the current local JS/Rust runtime path. JS `rotateLocalDeviceSignedPreKey(...)`, Rust `rotate_local_device_signed_pre_key(...)`, and the harness-side `e2e-probe rotate-prekey` flow now rotate one secondary device, republish the card, preserve pre-existing ratchet sessions, and demonstrate follow-up `SESSION_MESSAGE` delivery continuity in `E2E-MULTI-001` / `E2E-MULTI-002` without breaking sibling devices.
  - Done when replacing one device pre-key does not break other devices under the same DID.
  - Test points: `E2E-MULTI-004`, `E2E-RM-008`.

### 7. Testing, validation, and real-machine evidence

- [x] Add shared vector files and loaders used by JS and Rust.
  - Status: completed via shared manifests under `test-scripts/e2e/vectors/` plus JS/Rust loaders.
  - Done when both runtimes consume the exact same fixture corpus.
  - Test points: `E2E-VECTOR-001` through `E2E-VECTOR-004`.
- [ ] Add JS↔Rust cross-language automated suites for online, offline, federation, and multi-device flows.
  - Progress: `test-scripts/e2e/test-e2e-cross-lang.sh` now covers `E2E-CROSS-001`, `E2E-CROSS-002`, `E2E-CROSS-006`, federated dual-relay delivery `E2E-FED-001`, relay-backed offline delivery `E2E-CROSS-005`, plus multi-device relay delivery `E2E-MULTI-001` and `E2E-MULTI-002`, including artifact capture for visible-header parity, federated relay log/data plaintext scans, relay logs, queue plaintext scans, session counts, receiver output, relay-published rotated-card observations, and signed pre-key rotation continuity evidence. The harness now also waits for daemon stop/restart boundaries so Rust multi-device restart coverage is stable. Remaining work here is broader P0/P1 expansion and real-machine evidence, not basic multi-device automation.
  - Done when all P0 cross-language cases are green in local automation.
  - Test points: `E2E-CROSS-001` through `E2E-CROSS-006`.
- [ ] Add real-machine full-chain harnesses and operator checklists.
  - Progress: operator checklist docs already exist in `test-scripts/e2e/REAL_MACHINE_FULL_CHAIN_TEST.md`, and `test-scripts/e2e/test-e2e-real-machine.sh` now creates retained run directories under `test-output/e2e/real-machine/`, captures artifacts and version outputs, records plaintext-scan reports, and enforces scenario completeness before finalization. Actual retained `E2E-RM-001` through `E2E-RM-008` operator runs are still pending.
  - Evidence: `bash test-scripts/e2e/test-e2e-real-machine.sh init E2E-RM-001`; local smoke validation of `init` / `record-file` / `record-version` / `assert` / `validate` / `finalize` against a retained artifact directory.
  - Done when the scenarios in `test-scripts/e2e/REAL_MACHINE_FULL_CHAIN_TEST.md` can be run repeatably and store artifacts under `test-output/e2e/`.
  - Test points: `E2E-RM-001` through `E2E-RM-008`.
- [x] Add negative security tests for tampering, replay, impersonation, and OTK double-consumption.
  - Progress: completed. JS protocol tests now reject tampered encrypted transport signatures, impersonated decrypted inner-envelope signatures, replayed `SESSION_MESSAGE`s after ratchet advancement, double-consumption of the same claimed OTK, forged sender-device bindings in `PREKEY_MESSAGE`s, stale signed-prekey bootstrap attempts after rotation, and tampered `SESSION_MESSAGE` ciphertext/header variants; Rust core tests cover the same classes with matching stable error surfaces; JS/Rust runtime send/receive tests lock sender-side rejection of invalid signed pre-key signatures plus the live receive-path rejection of replayed consumed `PREKEY_MESSAGE`s, forged sender-device bootstrap attempts, rotated-out signed-prekey bootstrap attempts, and legacy plaintext application envelopes; and `test-scripts/e2e/test-e2e-negative.sh` now runs live local-relay daemon harnesses for every `E2E-NEG-001` through `E2E-NEG-008` case across the relevant JS and Rust sender/receiver paths with stable failure surfaces, inbox non-delivery or non-duplication, and no unexpected session creation.
  - Evidence: `pnpm --filter @quadra-a/protocol exec vitest run test/relay-client-control-plane.test.ts`; `pnpm --filter @quadra-a/runtime exec vitest run src/e2e-send.test.ts src/e2e-receive.test.ts`; `pnpm exec vitest run test/e2e-application-envelope.test.ts`; `cargo test -p quadra-a-runtime prepare_encrypted_send_`; `cargo test -p quadra-a-runtime prepare_encrypted_receive_`; `cargo test -p quadra-a-core rejects_`; `bash test-scripts/e2e/test-e2e-negative.sh --neg-001-only` (`test-output/e2e/negative/20260312-035526`); `bash test-scripts/e2e/test-e2e-negative.sh --neg-002-only` (`test-output/e2e/negative/20260312-031204`); `bash test-scripts/e2e/test-e2e-negative.sh --neg-004-only` (`test-output/e2e/negative/20260312-031239`); `bash test-scripts/e2e/test-e2e-negative.sh --neg-005-only` (`test-output/e2e/negative/20260312-031349`); `bash test-scripts/e2e/test-e2e-negative.sh --neg-006-only` (`test-output/e2e/negative/20260312-031446`); `bash test-scripts/e2e/test-e2e-negative.sh --neg-008-only` (`test-output/e2e/negative/20260312-032901`); existing `E2E-NEG-003` / `E2E-NEG-007` evidence remains under `test-output/e2e/negative/20260312-022341`; full negative sweep evidence is archived under `test-output/e2e/negative/20260312-035707`.
  - Done when the harness explicitly rejects each attack class with a stable error surface.
  - Test points: `E2E-NEG-001` through `E2E-NEG-008`.

### 8. Docs, operator guidance, and truth-in-advertising

- [x] Update public docs to describe the actual E2E boundary and algorithm suite.
  - Progress: completed in `README.md`, `docs/specification.md`, and `docs/e2e-operations.md`.
  - Done when README, relay docs, and protocol docs no longer claim features that the code does not implement.
  - Test points: doc review only.
- [x] Document relay-visible metadata and relay-hidden application content.
  - Progress: completed in `README.md`, `docs/specification.md`, and `docs/e2e-operations.md`.
  - Done when operators know exactly what logs and queue state may still reveal.
  - Test points: `E2E-RM-006`.
- [x] Document pre-key replenishment and operational health signals.
  - Progress: completed in `docs/e2e-operations.md` with the current published-card and local-config/status signals, including the explicit note that no dedicated pre-key health CLI is frozen yet.
  - Done when operators and CLI users can detect low OTK inventory before first-message delivery breaks.
  - Test points: `E2E-PREKEY-006`, `E2E-RM-008`.

## Sequencing

1. Finish the planning assets in `docs/` and `test-scripts/e2e/`. `Status: completed.`
2. Implement shared vector schema and fixture generation. `Status: completed.`
3. Land relay pre-key service and opaque routing refactor. `Status: in progress; relay pre-key publication/fetch and byte-opaque queue/federation routing are landed in code and unit tests, the real-machine artifact harness exists, and retained operator evidence is still pending.`
4. Land JS and Rust protocol engines behind vector tests. `Status: in progress; shared codec/vector layer, X3DH bootstrap engine, Double Ratchet state machine, and the inner application-envelope encrypt/decrypt wiring are landed, the core negative suites are green, and real-machine evidence is the main remaining gap.`
5. Land runtime/CLI integrations in JS and Rust. `Status: in progress; local device bootstrap, signed card publication, encrypted send, encrypted receive, local session persistence, deterministic local multi-device fan-out, and signed-prekey rotation continuity are wired, but retained real-machine chain validation is still pending.`
6. Land cross-language automation. `Status: in progress; executable JS↔Rust interop for `E2E-CROSS-001` / `E2E-CROSS-002`, relay-visible header parity for `E2E-CROSS-006`, federated delivery for `E2E-FED-001`, the relay-backed offline first-message suite `E2E-CROSS-005`, multi-device suites `E2E-MULTI-001` / `E2E-MULTI-002`, and the full local negative suite are landed; real-machine evidence is the main remaining gap.`
7. Run the real-machine chain and archive evidence. `Status: in progress; the retained-artifact harness is landed, but the operator-run scenario corpus is still pending.`

## Stop conditions

Do not call the feature complete until all of the following are true:

- Both JS and Rust can send the first offline message to each other using the same fixture-derived protocol behavior.
- Multi-device fan-out, dedupe, and key rotation are covered in automation and real-machine runs.
- Relay queue state and federation links never need to decode the application plaintext.
- The real-machine scenarios show that relay logs and stored queue bytes do not contain application `protocol` or `payload` plaintext.
