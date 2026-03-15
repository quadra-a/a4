# quadra-a E2E Encryption Test Assets

This directory holds the planning, vector, and executable harness assets for the E2E encryption work. It now contains the shared JS↔Rust cross-language harnesses, the full local negative-security harness, and a retained-artifact real-machine harness for operator runs.

## Purpose

- define the future automated test surface before protocol code lands
- keep JS and Rust aligned on the same scenario IDs and vector schema
- document the real-machine chain that must pass before the feature is called done

## Current contents

- `TEST_MATRIX.yaml` — machine-readable list of planned suites and scenario IDs
- `REAL_MACHINE_FULL_CHAIN_TEST.md` — operator-facing live environment test plan
- `test-e2e-real-machine.sh` — retained-artifact harness for `E2E-RM-001` through `E2E-RM-008` operator runs
- `test-e2e-cross-lang.sh` — executable JS↔Rust harness for `E2E-CROSS-001`, `E2E-CROSS-002`, `E2E-CROSS-006`, federated delivery `E2E-FED-001`, and relay-backed offline delivery `E2E-CROSS-005`
- `test-e2e-negative.sh` — live local-relay negative-security harness for `E2E-NEG-001` through `E2E-NEG-008` across JS and Rust sender/receiver paths
- `tools/e2e-probe.mjs` — JS-side generator/verifier plus relay-card polling, encrypted/plaintext injection helpers, visible-header parity checks, and plaintext-scan helpers for the executable harnesses
- `vectors/README.md` — fixture directory contract for shared vectors
- `vectors/schema.json` — JSON Schema for shared vector manifests

## Harness commands

The following commands are the current executable surface for E2E validation and artifact capture.

```bash
./test-scripts/e2e/test-e2e-cross-lang.sh
./test-scripts/e2e/test-e2e-negative.sh
./test-scripts/e2e/test-e2e-real-machine.sh
node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs
```

## Real-machine artifact layout

Real-machine runs now store artifacts under `repos/a4/test-output/e2e/` with this layout:

```text
test-output/e2e/
  vectors/
  local/
  cross-lang/
  negative/
  real-machine/
    <timestamp>-<scenario-id>/
      CHECKLIST.md
      summary.json
      artifacts/
      scans/
```

## Harness rules

- scenario IDs must match `TEST_MATRIX.yaml`
- JS and Rust must consume the same vector files from `vectors/`
- relay-backed runs must capture relay logs, queue scans, and receiver output even when the scenario fails
- real-machine runs must capture artifacts even when the scenario fails
- relay inspection checks must assert the absence of application plaintext, not just successful delivery
- multi-device scenarios must record both device-level delivery and business-message dedupe behavior

## Non-goals for this directory

- no temporary plaintext compatibility tests
- no duplicate per-language vector formats
- no relay-side test that assumes access to decrypted business payloads
