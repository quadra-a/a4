# quadra-a E2E Boundary and Operations

This document describes the E2E profile that is actually implemented today: what is encrypted, what the relay can still see, and how operators can observe pre-key health without pretending the tooling is farther along than it is.

## What is end-to-end encrypted

The application-message path uses a signed inner `MessageEnvelope` as plaintext, then wraps it in the `/agent/e2e/1.0.0` transport profile.

The current algorithm suite is:

- Ed25519 for DID-bound signatures
- X25519 for per-device encryption keys
- X3DH for first-contact session bootstrap
- Double Ratchet for ongoing session forward secrecy and post-compromise recovery
- HKDF-SHA256 for key derivation
- XChaCha20-Poly1305 for message encryption

The DID key is the signature identity. It is not reused as the X25519 message-encryption key.

## What the relay can see

The relay still sees routing and delivery metadata. In the current profile that includes:

- sender DID and recipient DID
- outer message id and delivery timing
- approximate ciphertext size
- `messageType`, `senderDeviceId`, `receiverDeviceId`, and `sessionId` from the outer E2E payload
- discovery traffic, trust queries, Agent Card publication, and pre-key control-plane messages

This means the relay can route, queue, and federate traffic without learning application content, but it is not blind to who is talking to whom or when.

## What the relay cannot see

When the `/agent/e2e/1.0.0` application transport is used correctly, the relay does not need to decrypt the inner business envelope and should not see:

- the inner application `protocol`
- the inner application `payload`
- `replyTo`
- `threadId`
- `groupId`

The local executable harnesses enforce this boundary by scanning relay logs and queue artifacts for forbidden plaintext. The real-machine harness in `test-scripts/e2e/test-e2e-real-machine.sh` retains the same evidence structure for operator runs.

## Device directory and pre-key publication

Each DID may publish one or more device entries in `AgentCard.devices`. Each device entry carries the public state needed for encrypted first contact:

- `deviceId`
- `identityKeyPublic`
- `signedPreKeyPublic`
- `signedPreKeyId`
- `signedPreKeySignature`
- `oneTimePreKeyCount`
- `lastResupplyAt`

First-contact initiators fetch claimed pre-key material through the relay control plane. Follow-up messages use the stored Double Ratchet session state instead of reusing pre-key bootstrap.

## What counts as a health signal today

The current operator-facing signals are:

- `a4 prekeys` for a dedicated local view of device inventory, signed pre-key age, session count, and the published device-directory surface
- the published device directory fields `oneTimePreKeyCount` and `lastResupplyAt`
- daemon background maintenance that replenishes low one-time pre-key inventory and rotates stale signed pre-keys
- daemon-start publication logs showing that pre-key bundles were republished
- local persisted E2E device state in the runtime configuration
- retained scenario artifacts from `test-scripts/e2e/test-e2e-cross-lang.sh`, `test-scripts/e2e/test-e2e-negative.sh`, and `test-scripts/e2e/test-e2e-real-machine.sh`

In practice today:

- JS and Rust operators can inspect `a4 prekeys` or `a4 prekeys --json` for the local/published pre-key view
- `a4 status --json` carries the lightweight `e2eHealth` summary plus `preKeyMaintenance` metadata for the daemon's last check, last action, last republish, and last error
- both runtimes publish `AgentCard.devices[].oneTimePreKeyCount` / `lastResupplyAt`, which is the interoperable low-inventory signal available to peers and operators

## Operational caveats

- Relay-control traffic is not application E2E content; it remains relay-visible by design.
- If you need transport-layer confidentiality to the relay itself, deploy the relay behind `wss://` / TLS. The E2E profile protects the inner business envelope, not the outer WebSocket hop metadata.
- Multi-device fan-out and local dedupe are implemented in JS and Rust runtimes, but the public real-machine evidence bar still requires retained operator runs before the feature should be advertised as fully complete.

## Evidence collection

Use `test-scripts/e2e/test-e2e-real-machine.sh` to create retained run directories under `test-output/e2e/real-machine/`, record sender / receiver / relay logs, capture queue and session inspections, attach binary version outputs, run plaintext scans, and finalize the scenario summary.
