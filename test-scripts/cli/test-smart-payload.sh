#!/usr/bin/env bash
# 验证 tell 根据 protocol 自动选择 payload 格式
# 注意：tell 可能因 relay 不通而失败，但 --json 输出中仍应包含 payload
set -euo pipefail
PASS=0; FAIL=0

RS="repos/a4/rust/target/release/a4"
JS="node repos/a4/js/cli/dist/index.js"
GPU_DID="did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"

assert_payload_key() {
  local label="$1" output="$2" key="$3"
  if echo "$output" | python3 -c "
import json,sys
d=json.load(sys.stdin)
payload = d.get('payload', {})
assert '$key' in payload, f'payload keys: {list(payload.keys())}'
" 2>/dev/null; then
    echo "  ✓ $label"; PASS=$((PASS+1))
  else
    echo "  ✗ $label (payload missing key: $key)"; FAIL=$((FAIL+1))
    echo "    output: $(echo "$output" | head -3)"
  fi
}

echo "=== Smart Payload Test ==="

# Rust: /shell/exec → {"command": ...}
echo "Rust CLI:"
OUT=$($RS tell "$GPU_DID" "echo hello" --json --protocol /shell/exec/1.0.0 2>&1 || true)
assert_payload_key "shell/exec → command" "$OUT" "command"

# Rust: /agent/msg → {"text": ...}
OUT=$($RS tell "$GPU_DID" "hello" --json --protocol /agent/msg/1.0.0 2>&1 || true)
assert_payload_key "agent/msg → text" "$OUT" "text"

# Rust: --payload 不受影响
OUT=$($RS tell "$GPU_DID" --payload '{"custom":"data"}' --json --protocol /shell/exec/1.0.0 2>&1 || true)
assert_payload_key "explicit --payload preserved" "$OUT" "custom"

# JS: /shell/exec → {"command": ...}
echo "JS CLI:"
OUT=$($JS tell "$GPU_DID" "echo hello" --json --protocol /shell/exec/1.0.0 2>&1 || true)
assert_payload_key "shell/exec → command" "$OUT" "command"

# JS: default protocol → {"text": ...}
OUT=$($JS tell "$GPU_DID" "hello" --json 2>&1 || true)
assert_payload_key "default protocol → text" "$OUT" "text"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
