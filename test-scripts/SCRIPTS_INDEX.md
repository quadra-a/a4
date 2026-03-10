# quadra-a Relay Test Scripts Index

A compact index of the current relay test harness in `repos/a4/test-scripts`.

## Quick Start

```bash
# Smoke test
./test-relay-quick.sh

# Benchmark CLI wall-clock latency and throughput
./benchmark-relay.sh

# Validate collected results
./validate-test-results.sh ./test-output/results quadra-a-basic
```

## Core Scripts

| Script | Purpose |
| --- | --- |
| `test-relay-quick.sh` | Fast smoke test for discovery and messaging |
| `test-relay-comprehensive.sh` | Broader functional validation |
| `benchmark-relay.sh` | Benchmark CLI latency/throughput, with daemon-backed mode |
| `load-test-relay.sh` | Sustained load and burst scenarios |
| `stress-test-relay.sh` | Scenario-driven stress testing |
| `ci-test-relay.sh` | CI-friendly test runner with retries and JUnit output |
| `run-master-tests.sh` | Orchestrates the main suites |
| `validate-test-results.sh` | Scores results against compliance thresholds |
| `verify-performance.sh` | Verifies the current performance wiring and docs |

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
- `benchmark-relay.sh` defaults to `BENCHMARK_SESSION_MODE=auto`, which reuses a background listener when possible.
