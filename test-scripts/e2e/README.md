# quadra-a E2E Encryption Test Assets

This directory holds the planning and fixture assets for the E2E encryption work. It does **not** yet contain the protocol implementation or the finished harness scripts.

## Purpose

- define the future automated test surface before protocol code lands
- keep JS and Rust aligned on the same scenario IDs and vector schema
- document the real-machine chain that must pass before the feature is called done

## Current contents

- `TEST_MATRIX.yaml` — machine-readable list of planned suites and scenario IDs
- `REAL_MACHINE_FULL_CHAIN_TEST.md` — operator-facing live environment test plan
- `vectors/README.md` — fixture directory contract for shared vectors
- `vectors/schema.json` — JSON Schema for shared vector manifests

## Planned harness commands

The following command names are reserved for the eventual harness. They are documented now so later implementation does not drift.

```bash
./test-scripts/e2e/test-e2e-js.sh
./test-scripts/e2e/test-e2e-rust.sh
./test-scripts/e2e/test-e2e-cross-lang.sh
./test-scripts/e2e/test-e2e-relay.sh
./test-scripts/e2e/test-e2e-real-machine.sh
node --experimental-strip-types ./test-scripts/e2e/tools/generate-vectors.mjs
node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs
```

## Reserved artifact layout

Future runs should store artifacts under `repos/a4/test-output/e2e/` with this layout:

```text
test-output/e2e/
  vectors/
  local/
  cross-lang/
  real-machine/
    <scenario-id>/
      sender.log
      receiver.log
      relay.log
      queue-inspection.log
      session-inspection.log
      summary.json
```

## Harness rules

- scenario IDs must match `TEST_MATRIX.yaml`
- JS and Rust must consume the same vector files from `vectors/`
- real-machine runs must capture artifacts even when the scenario fails
- relay inspection checks must assert the absence of application plaintext, not just successful delivery
- multi-device scenarios must record both device-level delivery and business-message dedupe behavior

## Non-goals for this directory

- no temporary plaintext compatibility tests
- no duplicate per-language vector formats
- no relay-side test that assumes access to decrypted business payloads
