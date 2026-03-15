#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS=(
  test-protocol-selection.sh
  test-unified-flags.sh
  test-socket-fallback.sh
  test-smart-body.sh
  test-inbox-job-aggregation.sh
)
PASSED=0; FAILED=0; FAILURES=()

echo "╔══════════════════════════════════════╗"
echo "║   CLI Unification Test Suite         ║"
echo "╚══════════════════════════════════════╝"

for test in "${TESTS[@]}"; do
  echo ""; echo "── $test ──"
  if bash "$SCRIPT_DIR/$test"; then
    PASSED=$((PASSED+1))
  else
    FAILED=$((FAILED+1)); FAILURES+=("$test")
  fi
done

echo ""; echo "════════════════════════════════════════"
echo "Results: $PASSED/$((PASSED+FAILED)) passed"
[ $FAILED -eq 0 ] || { printf '  Failed: %s\n' "${FAILURES[@]}"; exit 1; }
