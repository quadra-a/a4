#!/usr/bin/env bash
# test-e2e-commands.sh — Verify `a4 e2e status` and `a4 e2e reset`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== E2E Commands Test ==="

setup_agent ALICE
setup_agent BOB

# 1. Start daemons and establish E2E session
start_daemon ALICE
start_daemon BOB

echo "Step 1: Alice sends message to Bob (establish E2E session)..."
a4_cmd ALICE tell "$BOB_DID" "hello for e2e test" --protocol "/agent/msg/1.0.0"
sleep 2

# 2. Check e2e status shows session
echo "Step 2: Checking Alice e2e status..."
ALICE_E2E=$(a4_cmd ALICE e2e status --json)
SESSION_COUNT=$(echo "$ALICE_E2E" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionCount', 0))")
if [[ "$SESSION_COUNT" -ge 1 ]]; then
  echo "  ✓ Alice has $SESSION_COUNT session(s) after sending"
else
  echo "  ✗ Alice should have at least 1 session (got $SESSION_COUNT)"
  exit 1
fi

# 3. Reset sessions
echo "Step 3: Resetting Alice's E2E sessions..."
a4_cmd ALICE e2e reset
sleep 1

# 4. Verify sessions cleared
echo "Step 4: Verifying sessions cleared..."
ALICE_E2E2=$(a4_cmd ALICE e2e status --json)
SESSION_COUNT2=$(echo "$ALICE_E2E2" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionCount', 0))")
assert_eq "$SESSION_COUNT2" "0" "Alice should have 0 sessions after reset"

# 5. Send message again → should auto-rebuild session via PREKEY_MESSAGE
echo "Step 5: Alice sends message after reset (should auto-rebuild session)..."
a4_cmd ALICE tell "$BOB_DID" "rebuilt session" --protocol "/agent/msg/1.0.0"
sleep 2

BOB_INBOX=$(a4_cmd BOB inbox --format json)
assert_contains "$BOB_INBOX" "rebuilt session" "Bob should receive message after session rebuild"

# 6. Verify new session exists
ALICE_E2E3=$(a4_cmd ALICE e2e status --json)
SESSION_COUNT3=$(echo "$ALICE_E2E3" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionCount', 0))")
if [[ "$SESSION_COUNT3" -ge 1 ]]; then
  echo "  ✓ Alice has $SESSION_COUNT3 session(s) after rebuild"
else
  echo "  ✗ Alice should have at least 1 session after rebuild (got $SESSION_COUNT3)"
  exit 1
fi

# 7. Test per-peer reset
echo "Step 6: Testing per-peer reset..."
a4_cmd ALICE e2e reset "$BOB_DID"
ALICE_E2E4=$(a4_cmd ALICE e2e status --json)
SESSION_COUNT4=$(echo "$ALICE_E2E4" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionCount', 0))")
assert_eq "$SESSION_COUNT4" "0" "Alice should have 0 sessions after per-peer reset"

echo "=== E2E Commands Test PASSED ==="

cleanup
