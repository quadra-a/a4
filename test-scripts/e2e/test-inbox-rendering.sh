#!/usr/bin/env bash
# test-inbox-rendering.sh — Verify inbox correctly displays e2e/decrypt-failed messages
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Inbox Rendering Test ==="

setup_agent ALICE
setup_agent BOB

# 1. Establish E2E session
start_daemon ALICE
start_daemon BOB

echo "Step 1: Alice sends initial message to Bob..."
a4_cmd ALICE tell "$BOB_DID" "setup message" --protocol "/agent/msg/1.0.0"
sleep 2

# 2. Corrupt Bob's sessions
echo "Step 2: Clearing Bob's E2E sessions..."
python3 -c "
import json, os
config_path = os.path.join('$BOB_HOME', 'config.json')
with open(config_path) as f:
    config = json.load(f)
if 'e2e' in config:
    device_id = config['e2e']['currentDeviceId']
    config['e2e']['devices'][device_id]['sessions'] = {}
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
"

# 3. Restart Bob and trigger decrypt failure
stop_daemon BOB
start_daemon BOB

echo "Step 3: Alice sends message that will fail to decrypt..."
a4_cmd ALICE tell "$BOB_DID" "will fail" --protocol "/agent/msg/1.0.0" || true
sleep 2

# 4. Check human-readable inbox output
echo "Step 4: Checking inbox rendering..."
BOB_INBOX_HUMAN=$(a4_cmd BOB inbox --human 2>/dev/null || true)
assert_contains "$BOB_INBOX_HUMAN" "E2E decrypt failed" "Human inbox should show E2E decrypt failed"
assert_contains "$BOB_INBOX_HUMAN" "session cleared" "Human inbox should mention session cleared"

# 5. Check JSON inbox output
BOB_INBOX_JSON=$(a4_cmd BOB inbox --format json 2>/dev/null || true)
assert_contains "$BOB_INBOX_JSON" "e2e/decrypt-failed" "JSON inbox should contain e2e/decrypt-failed protocol"
assert_contains "$BOB_INBOX_JSON" "auto-renegotiate" "JSON inbox should contain auto-renegotiate hint"

echo "=== Inbox Rendering Test PASSED ==="

cleanup
