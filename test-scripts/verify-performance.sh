#!/usr/bin/env bash

# Performance verification for the current quadra-a layout.
# Verifies that the daemon-backed fast path, benchmark harness,
# and current documentation hooks are all wired correctly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"

echo "=========================================="
echo "quadra-a Performance Verification"
echo "=========================================="
echo ""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

TESTS_PASSED=0
TESTS_FAILED=0

pass() {
    echo -e "${GREEN}✓${NC} $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
    echo -e "${RED}✗${NC} $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

section() {
    echo ""
    echo "=========================================="
    echo "$1"
    echo "=========================================="
    echo ""
}

CLI="node $REPO_ROOT/js/cli/dist/index.js"

info "Using CLI: $CLI"

section "Test 1: Build Outputs"

if [ -f "$REPO_ROOT/js/core/runtime/dist/index.js" ]; then
    pass "Runtime package built"
else
    fail "Runtime package not built"
fi

if [ -f "$REPO_ROOT/js/core/protocol/dist/index.js" ]; then
    pass "Protocol package built"
else
    fail "Protocol package not built"
fi

if [ -f "$REPO_ROOT/js/cli/dist/index.js" ]; then
    pass "CLI package built"
else
    fail "CLI package not built"
fi

section "Test 2: CLI Commands"

if $CLI daemon --help >/dev/null 2>&1; then
    pass "Daemon command registered"
else
    fail "Daemon command not available"
fi

if $CLI listen --help >/dev/null 2>&1; then
    pass "Listen command available"
else
    fail "Listen command not available"
fi

if $CLI find --help >/dev/null 2>&1; then
    pass "Find command available"
else
    fail "Find command not available"
fi

if $CLI tell --help >/dev/null 2>&1; then
    pass "Tell command available"
else
    fail "Tell command not available"
fi

section "Test 3: Fast Path Wiring"

info "Checking daemon-backed send path..."
if grep -q "await client.isDaemonRunning()" "$REPO_ROOT/js/core/runtime/src/messaging.ts" \
  && grep -q "usedDaemon: true" "$REPO_ROOT/js/core/runtime/src/messaging.ts"; then
    pass "Send path prefers daemon when available"
else
    fail "Daemon-backed send path not found"
fi

info "Checking daemon-backed discovery path..."
if grep -q "client.send<DiscoveryAgent\[]>('discover'" "$REPO_ROOT/js/core/runtime/src/agent-runtime.ts"; then
    pass "Discovery path prefers daemon when available"
else
    fail "Daemon-backed discovery path not found"
fi

info "Checking result wait strategies..."
if grep -q "waitForMessageOutcomeViaSubscription" "$REPO_ROOT/js/core/runtime/src/inbox.ts" \
  && grep -q "waitForMessageOutcomeViaPolling" "$REPO_ROOT/js/core/runtime/src/inbox.ts"; then
    pass "Outcome waiting supports subscription and polling"
else
    fail "Outcome waiting strategies incomplete"
fi

section "Test 4: Benchmark Harness"

info "Checking benchmark session reuse..."
if grep -q "BENCHMARK_SESSION_MODE" "$REPO_ROOT/test-scripts/benchmark-relay.sh" \
  && grep -q "Benchmark Session Mode" "$REPO_ROOT/test-scripts/benchmark-relay.sh"; then
    pass "Benchmark script supports daemon-backed session reuse"
else
    fail "Benchmark session reuse support not found"
fi

info "Checking concurrent throughput synchronization..."
if grep -q 'pids+=("$!")' "$REPO_ROOT/test-scripts/benchmark-relay.sh"; then
    pass "Concurrent benchmark tracks child PIDs correctly"
else
    fail "Concurrent benchmark still uses fragile background tracking"
fi

info "Checking shell compatibility helper..."
if [ -f "$REPO_ROOT/test-scripts/lib/compat.sh" ]; then
    pass "Shell compatibility helper exists"
else
    fail "Shell compatibility helper missing"
fi

section "Test 5: Documentation"

if [ -f "$REPO_ROOT/test-scripts/TESTING_GUIDE.md" ]; then
    pass "Testing guide exists"
else
    fail "Testing guide missing"
fi

if [ -f "$REPO_ROOT/test-scripts/SCRIPTS_INDEX.md" ]; then
    pass "Scripts index exists"
else
    fail "Scripts index missing"
fi

if grep -q "quadra-a-basic" "$REPO_ROOT/test-scripts/TESTING_GUIDE.md"; then
    pass "Testing guide references current compliance naming"
else
    fail "Testing guide still references legacy compliance names"
fi

if grep -q "quadra-a-basic" "$REPO_ROOT/test-scripts/SCRIPTS_INDEX.md"; then
    pass "Scripts index references current compliance naming"
else
    fail "Scripts index still references legacy compliance names"
fi

section "Test Summary"

TOTAL_TESTS=$((TESTS_PASSED + TESTS_FAILED))
echo "Total tests: $TOTAL_TESTS"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}=========================================="
    echo "✓ All checks passed"
    echo "==========================================${NC}"
    echo ""
    echo "Performance-related wiring verified:"
    echo "  ✓ Daemon-backed send path"
    echo "  ✓ Daemon-backed discovery path"
    echo "  ✓ Updated benchmark harness"
    echo "  ✓ Updated compliance naming"
    exit 0
fi

echo -e "${RED}=========================================="
echo "✗ Some checks failed"
echo "==========================================${NC}"
echo ""
exit 1
