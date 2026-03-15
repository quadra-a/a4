#!/usr/bin/env bash
# test-daemon-mutex.sh — Verify daemon mutual exclusion
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Daemon Mutex Test ==="

setup_agent AGENT

# 1. Start first daemon
echo "Step 1: Starting first daemon..."
start_daemon AGENT

# 2. Try starting a second daemon on the same socket → should fail
echo "Step 2: Attempting to start second daemon (should fail)..."
STDERR_OUTPUT=$(a4_cmd AGENT listen --background 2>&1 || true)
if echo "$STDERR_OUTPUT" | grep -qi "already running\|daemon already"; then
  echo "  ✓ Second daemon correctly refused to start"
else
  echo "  ✗ Second daemon should have been refused"
  echo "    Output: $STDERR_OUTPUT"
  exit 1
fi

# 3. Stop first daemon
echo "Step 3: Stopping first daemon..."
stop_daemon AGENT

# 4. Start daemon again → should succeed
echo "Step 4: Starting daemon after stop (should succeed)..."
start_daemon AGENT

# Verify it's running
STATUS=$(a4_cmd AGENT status --json 2>/dev/null || echo '{}')
assert_contains "$STATUS" "did" "Daemon should be running after restart"

echo "=== Daemon Mutex Test PASSED ==="

cleanup
