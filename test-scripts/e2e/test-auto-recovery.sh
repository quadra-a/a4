#!/usr/bin/env bash
# test-auto-recovery.sh — E2E decrypt failure → auto-recovery integration test
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== E2E Auto-Recovery Test ==="

# Setup two isolated agents
setup_agent ALICE
setup_agent BOB

# 1. Start both daemons
start_daemon ALICE
start_daemon BOB

# 2. Alice → Bob: establish E2E session
echo "Step 1: Alice sends initial message to Bob (PREKEY_MESSAGE)..."
ALICE_MSG=$(a4_cmd ALICE tell "$BOB_DID" "hello bob" --protocol "/agent/msg/1.0.0")
echo "  Sent: $ALICE_MSG"
sleep 2

# Verify Bob received it
BOB_INBOX=$(a4_cmd BOB inbox --format json)
assert_contains "$BOB_INBOX" "hello bob" "Bob should receive initial message"

# 3. Corrupt Bob's E2E sessions (simulate ratchet desync)
echo "Step 2: Clearing Bob's E2E sessions to simulate desync..."
python3 -c "
import json, sys, os
config_path = os.path.join('$BOB_HOME', 'config.json')
with open(config_path) as f:
    config = json.load(f)
if 'e2e' in config:
    device_id = config['e2e']['currentDeviceId']
    config['e2e']['devices'][device_id]['sessions'] = {}
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
    print('  Cleared sessions for device', device_id)
else:
    print('  No E2E config found', file=sys.stderr)
    sys.exit(1)
"

# 4. Restart Bob's daemon to pick up cleared sessions
echo "Step 3: Restarting Bob's daemon..."
stop_daemon BOB
start_daemon BOB

# 5. Alice sends another message → Bob should fail to decrypt (SESSION_MESSAGE)
echo "Step 4: Alice sends second message (SESSION_MESSAGE, should fail decrypt)..."
a4_cmd ALICE tell "$BOB_DID" "second message" --protocol "/agent/msg/1.0.0" || true
sleep 2

# 6. Verify Bob's inbox has e2e/decrypt-failed message
echo "Step 5: Checking Bob's inbox for decrypt-failed marker..."
BOB_INBOX2=$(a4_cmd BOB inbox --format json)
assert_contains "$BOB_INBOX2" "e2e/decrypt-failed" "Bob inbox should contain e2e/decrypt-failed"

# 7. Verify stale session was auto-cleared
echo "Step 6: Verifying Bob's stale session was auto-cleared..."
BOB_E2E=$(a4_cmd BOB e2e status --json 2>/dev/null || echo '{"sessionCount": 0}')
SESSION_COUNT=$(echo "$BOB_E2E" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionCount', 0))")
assert_eq "$SESSION_COUNT" "0" "Bob should have 0 sessions after auto-clear"

# 8. Bob replies to Alice → auto PREKEY_MESSAGE renegotiation
echo "Step 7: Bob replies to Alice (should auto-renegotiate via PREKEY_MESSAGE)..."
a4_cmd BOB tell "$ALICE_DID" "reply from bob" --protocol "/agent/msg/1.0.0"
sleep 2

# 9. Alice sends again → should succeed now
echo "Step 8: Alice sends third message (should succeed after renegotiation)..."
a4_cmd ALICE tell "$BOB_DID" "third message" --protocol "/agent/msg/1.0.0"
sleep 2

BOB_INBOX3=$(a4_cmd BOB inbox --format json)
assert_contains "$BOB_INBOX3" "third message" "Bob should receive third message after recovery"

echo "=== E2E Auto-Recovery Test PASSED ==="

cleanup
