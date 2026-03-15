#!/usr/bin/env bash
# run-all-e2e-tests.sh — Run all E2E integration tests and summarize results
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TESTS=(
  "test-daemon-mutex.sh"
  "test-e2e-commands.sh"
  "test-auto-recovery.sh"
  "test-inbox-rendering.sh"
)

PASSED=0
FAILED=0
FAILURES=()

echo "╔══════════════════════════════════════╗"
echo "║   E2E Integration Test Suite         ║"
echo "╚══════════════════════════════════════╝"
echo ""

for test in "${TESTS[@]}"; do
  echo "────────────────────────────────────────"
  echo "Running: $test"
  echo "────────────────────────────────────────"

  if bash "$SCRIPT_DIR/$test"; then
    PASSED=$((PASSED + 1))
    echo ""
  else
    FAILED=$((FAILED + 1))
    FAILURES+=("$test")
    echo ""
    echo "  ✗ FAILED: $test"
    echo ""
  fi
done

TOTAL=$((PASSED + FAILED))

echo "════════════════════════════════════════"
echo "Results: $PASSED/$TOTAL passed"

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  echo ""
  exit 1
else
  echo "All tests passed."
  exit 0
fi
