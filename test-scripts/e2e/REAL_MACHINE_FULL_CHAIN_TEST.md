# quadra-a E2E Real-Machine Full-Chain Test Plan

This document defines the live-environment scenarios that must pass after the E2E protocol is implemented. These are not optional smoke tests. They are release gates for the encryption work.

## Objectives

- prove the full send → relay/queue/federation → receive chain with separate JS and Rust implementations
- prove offline first-message delivery using pre-key bootstrapping
- prove relay and federation nodes cannot inspect application `protocol` or `payload`
- prove multi-device recipient behavior and dedupe in a real environment

## Minimum environments

### Environment A — single relay, online peers

- Host `relay-a`: one relay process with persistent data dir
- Host `sender-a`: JS or Rust sender
- Host `receiver-a`: JS or Rust receiver

### Environment B — single relay, offline first message

- Host `relay-b`: one relay process with persistent data dir
- Host `sender-b`: sender online
- Host `receiver-b`: receiver intentionally offline for initial delivery

### Environment C — federated relays

- Host `relay-c1`: relay A
- Host `relay-c2`: relay B
- Host `sender-c`: sender connected to relay A
- Host `receiver-c`: receiver connected to relay B

### Environment D — multi-device recipient

- Host `relay-d`: one relay process
- Host `sender-d`: sender
- Host `receiver-d1`: recipient device 1
- Host `receiver-d2`: recipient device 2 under the same DID/device directory policy

## Required evidence for every scenario

- sender stdout/stderr log
- receiver stdout/stderr log
- relay log from every relay involved
- queue inspection output before and after delivery
- session inspection output on both clients when applicable
- scenario summary JSON with timestamps and binary versions

If one of these artifacts is missing, the run is incomplete even if delivery succeeded.

## Scenario catalog

### `E2E-RM-001` JS → JS same relay, both online

- Topology: Environment A
- Goal: confirm same-language online delivery in a real networked environment
- Steps:
  1. Start relay on `relay-a`
  2. Start JS receiver on `receiver-a` and publish device directory
  3. Start JS sender on `sender-a`
  4. Send one first-contact message and one follow-up ratcheted message
- Assertions:
  - receiver gets both business messages in order
  - first message uses pre-key bootstrap
  - second message reuses an existing session
  - relay queue/log output contains no plaintext business `protocol` or `payload`

### `E2E-RM-002` Rust → Rust same relay, both online

- Topology: Environment A
- Goal: prove the Rust path independently of JS
- Steps: same as `E2E-RM-001`, using Rust on both peers
- Assertions: same as `E2E-RM-001`

### `E2E-RM-003` JS → Rust offline first message

- Topology: Environment B
- Goal: prove asynchronous first-message delivery across implementations
- Steps:
  1. Start relay on `relay-b`
  2. Publish Rust receiver device directory, then stop the receiver
  3. Start JS sender and send first-contact message
  4. Inspect relay queue state while receiver is offline
  5. Start Rust receiver and let it fetch/decrypt the queued message
- Assertions:
  - queued message is stored as opaque ciphertext bytes only
  - Rust receiver establishes a valid session from the queued first message
  - no business plaintext appears in relay logs or queue inspection output

### `E2E-RM-004` Rust → JS offline first message

- Topology: Environment B
- Goal: prove asynchronous first-message delivery in the opposite initiator direction
- Steps: same as `E2E-RM-003`, swapping implementations
- Assertions: same as `E2E-RM-003`

### `E2E-RM-005` JS → Rust through federated relays

- Topology: Environment C
- Goal: prove federation can forward ciphertext without understanding it
- Steps:
  1. Start relay A and relay B with federation enabled
  2. Connect JS sender to relay A and Rust receiver to relay B
  3. Send one first-contact message and one follow-up message
  4. Inspect logs from both relays
- Assertions:
  - both messages arrive successfully across relay federation
  - neither relay log contains business `protocol` or `payload` plaintext
  - federation forwarding requires only routing metadata and opaque bytes

### `E2E-RM-006` Relay opacity inspection

- Topology: reuse any of the environments above
- Goal: explicitly check the relay privacy boundary
- Steps:
  1. Capture relay logs during message flow
  2. Dump queued message bytes from the data dir or inspection tool
  3. Search captured artifacts for known business protocol names and sample payload fragments
- Assertions:
  - relay artifacts may show sender DID, receiver DID, device IDs, timestamps, and byte lengths
  - relay artifacts must not show application `protocol`, message body, `replyTo`, or `threadId`

### `E2E-RM-007` Multi-device recipient fan-out and dedupe

- Topology: Environment D
- Goal: prove one DID with two devices can receive correctly without duplicate user-visible messages
- Steps:
  1. Start relay on `relay-d`
  2. Start two recipient devices that publish under the same DID/device directory
  3. Start sender and send one first-contact business message
  4. Send one follow-up business message
- Assertions:
  - both recipient devices receive valid ciphertext and decrypt successfully
  - local per-device session state is created independently
  - user-visible message history dedupes the business message correctly

### `E2E-RM-008` Pre-key depletion and replenishment

- Topology: Environment D or B
- Goal: prove operational health when OTK supply gets low
- Steps:
  1. Start a recipient with a deliberately small OTK inventory
  2. Send enough first-contact messages from distinct senders to exhaust or nearly exhaust the pool
  3. Observe low-inventory health reporting
  4. Replenish OTKs and continue first-contact delivery
- Assertions:
  - low inventory is visible through an operator-facing signal
  - replenishment restores first-contact capacity
  - existing ratchet sessions continue unaffected

## Real-machine success bar

All of the following must be true:

- `E2E-RM-001` through `E2E-RM-008` pass with retained artifacts
- JS and Rust each act as initiator and responder in at least one offline first-message run
- federation path is exercised at least once with cross-language peers
- relay opacity assertions are executed against stored queue data, not just logs
- multi-device dedupe is verified from actual client-visible output, not only internal state dumps
