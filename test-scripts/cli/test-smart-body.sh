#!/usr/bin/env bash
# 验证 tell 根据 protocol 自动选择 text body 的包装格式，
# 并在 json body 模式下保留用户提供的对象结构
# 注意：tell 可能因 relay 不通而失败，但 --json 输出中仍应包含 envelope payload
set -euo pipefail
PASS=0; FAIL=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"
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

echo "=== Smart Body Test ==="

# Rust: /shell/exec → {"command": ...}
echo "Rust CLI:"
OUT=$(run_rs tell "$GPU_DID" "echo hello" --json --protocol /shell/exec/1.0.0 2>&1 || true)
assert_payload_key "shell/exec → command" "$OUT" "command"

# Rust: /agent/msg → {"text": ...}
OUT=$(run_rs tell "$GPU_DID" "hello" --json --protocol /agent/msg/1.0.0 2>&1 || true)
assert_payload_key "agent/msg → text" "$OUT" "text"

# Rust: --body-format json 不受协议包装影响
OUT=$(run_rs tell "$GPU_DID" --body '{"custom":"data"}' --body-format json --json --protocol /shell/exec/1.0.0 2>&1 || true)
assert_payload_key "explicit json body preserved" "$OUT" "custom"

# JS: /shell/exec → {"command": ...}
echo "JS CLI:"
OUT=$(run_js tell "$GPU_DID" "echo hello" --json --protocol /shell/exec/1.0.0 2>&1 || true)
assert_payload_key "shell/exec → command" "$OUT" "command"

# JS: default protocol → {"text": ...}
OUT=$(run_js tell "$GPU_DID" "hello" --json 2>&1 || true)
assert_payload_key "default protocol → text" "$OUT" "text"

# JS: --body-format json 不受协议包装影响
OUT=$(run_js tell "$GPU_DID" --body '{"custom":"data"}' --body-format json --json --protocol /shell/exec/1.0.0 2>&1 || true)
assert_payload_key "explicit json body preserved" "$OUT" "custom"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
