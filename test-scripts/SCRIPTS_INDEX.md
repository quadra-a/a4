# quadra-a Relay Test Scripts Index

A compact index of the current relay test harness in `repos/a4/test-scripts`.

## Quick Start

```bash
# Smoke test
./test-relay-quick.sh

# Quick Agent Groups overlay smoke test
./test-quick-agent-groups.sh

# Discovery/card signature regression suite
./test-discovery-card-signatures.sh

# Benchmark CLI wall-clock latency and throughput
./benchmark-relay.sh

# Validate collected results
./validate-test-results.sh ./test-output/results quadra-a-basic
```

## Core Scripts

| Script | Purpose |
| --- | --- |
| `test-relay-quick.sh` | Fast smoke test for discovery and messaging |
| `test-discovery-card-signatures.sh` | Runs the JS protocol and Rust runtime regressions for client-side Agent Card verification |
| `test-quick-agent-groups.sh` | Local public-relay smoke test for Quick Agent Groups overlay discovery and filtering |
| `test-relay-deployment.sh` | Real local deployment test for startup, federation admission, and quarantine |
| `lib/relay-deployment.sh` | Reusable shell helpers for deployment startup, teardown, and summaries |
| `tools/quick-agent-groups-probe.mjs` | Probe for Quick Agent Groups overlay discovery, joined-member delivery, and non-member filtering |
| `tools/relay-deployment-probe.mjs` | Reusable federation/quarantine/summary probes for live relay processes |
| `test-relay-comprehensive.sh` | Broader functional validation |
| `benchmark-relay.sh` | Benchmark CLI latency/throughput, with daemon-backed mode |
| `load-test-relay.sh` | Sustained load and burst scenarios |
| `stress-test-relay.sh` | Scenario-driven stress testing |
| `ci-test-relay.sh` | CI-friendly test runner with retries and JUnit output |
| `run-js-workspace-tests.sh` | CI-friendly JS workspace runner using `vitest run` and per-step logs |
| `run-master-tests.sh` | Orchestrates the main suites |
| `validate-test-results.sh` | Scores results against compliance thresholds |
| `verify-performance.sh` | Verifies the current performance wiring and docs |

## E2E encryption assets

These include planning/fixture assets, executable local JS↔Rust harnesses, and a retained-artifact real-machine harness. Real-machine evidence collection is now scripted even though the full retained operator runs are still pending.

| Asset | Purpose |
| --- | --- |
| `e2e/README.md` | Overview of the current E2E harness surface and artifact layout |
| `e2e/TEST_MATRIX.yaml` | Shared scenario catalog for JS, Rust, relay, and real-machine suites |
| `e2e/REAL_MACHINE_FULL_CHAIN_TEST.md` | Live environment chain validation plan |
| `e2e/test-e2e-real-machine.sh` | Creates retained real-machine scenario directories, captures artifacts, runs plaintext scans, and enforces completeness checks |
| `e2e/test-e2e-cross-lang.sh` | Runs executable JS↔Rust cross-language checks for `E2E-CROSS-001`, `E2E-CROSS-002`, `E2E-CROSS-006`, federated delivery `E2E-FED-001`, and relay-backed offline delivery `E2E-CROSS-005` |
| `e2e/test-e2e-negative.sh` | Runs live local-relay negative-security checks for `E2E-NEG-001` through `E2E-NEG-008` across JS and Rust sender/receiver paths |
| `e2e/tools/e2e-probe.mjs` | Generates JS artifacts, prepares/tampers raw encrypted envelopes, polls published cards, and scans relay artifacts for forbidden plaintext in the executable harnesses |
| `e2e/vectors/README.md` | Shared vector directory contract |
| `e2e/vectors/schema.json` | JSON Schema for future shared vector files |

## Compliance Standards

```bash
./validate-test-results.sh ./test-output/results quadra-a-basic
./validate-test-results.sh ./test-output/results quadra-a-production
./validate-test-results.sh ./test-output/results enterprise
```

Legacy aliases still accepted:

- `highway1-basic`
- `highway1-production`

## Notes

- Prefer `quadra-a-*` naming in docs and automation.
- On macOS, scripts automatically use `gtimeout` or a Python fallback when GNU `timeout` is unavailable.
- `test-quick-agent-groups.sh` validates the overlay-level Quick Agent Groups flow on a normal public relay; it does not require relay-native realm provisioning.
- `test-relay-deployment.sh` is now a thin orchestrator over `lib/relay-deployment.sh` and `tools/relay-deployment-probe.mjs`, so deployment probes can be reused independently.
- `benchmark-relay.sh` defaults to `BENCHMARK_SESSION_MODE=auto`, which reuses a background listener when possible.
