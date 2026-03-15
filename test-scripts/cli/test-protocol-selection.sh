#!/usr/bin/env bash
# 验证 Rust 和 JS CLI 的协议选择结果一致，
# 并在自动选择时返回明确的 selection reason
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"
TARGET="did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"

extract_json_field() {
  local output="$1" field="$2"
  echo "$output" | python3 -c "
import json,sys
d=json.load(sys.stdin)
value = d.get('$field')
print('' if value is None else value)
" 2>/dev/null || echo "?"
}

echo "=== Protocol Selection Test ==="

# Rust / JS: 不指定 --protocol，检查协议选择结果
RS_OUT=$(run_rs tell "$TARGET" "protocol-test" --json 2>&1 || true)
RS_PROTO=$(extract_json_field "$RS_OUT" "protocol")
RS_SELECTION=$(extract_json_field "$RS_OUT" "protocolSelection")
RS_REASON=$(extract_json_field "$RS_OUT" "protocolSelectionReason")

JS_OUT=$(run_js tell "$TARGET" "protocol-test" --json 2>&1 || true)
JS_PROTO=$(extract_json_field "$JS_OUT" "protocol")
JS_SELECTION=$(extract_json_field "$JS_OUT" "protocolSelection")
JS_REASON=$(extract_json_field "$JS_OUT" "protocolSelectionReason")

echo "  Rust protocol:     $RS_PROTO ($RS_SELECTION)"
echo "  JS protocol:       $JS_PROTO ($JS_SELECTION)"

if [ "$RS_PROTO" = "$JS_PROTO" ]; then
  echo "  ✓ Protocols match"
else
  echo "  ✗ Protocols differ!"
  exit 1
fi

if [ "$RS_SELECTION" = "$JS_SELECTION" ]; then
  echo "  ✓ Selection mode matches"
else
  echo "  ✗ Selection mode differs!"
  exit 1
fi

case "$RS_SELECTION" in
  default)
    if [ "$RS_PROTO" = "/agent/msg/1.0.0" ]; then
      echo "  ✓ Default selection stays on /agent/msg/1.0.0"
    else
      echo "  ✗ Default selection should stay on /agent/msg/1.0.0"
      exit 1
    fi
    ;;
  auto)
    if [ "$RS_PROTO" != "/agent/msg/1.0.0" ]; then
      echo "  ✓ Auto-selection changed protocol from the default"
    else
      echo "  ✗ Auto-selection should not keep the default protocol"
      exit 1
    fi
    if [ -n "$RS_REASON" ] && [ "$RS_REASON" = "$JS_REASON" ]; then
      echo "  ✓ Auto-selection reason is explicit and aligned"
    else
      echo "  ✗ Auto-selection reason missing or mismatched"
      exit 1
    fi
    ;;
  *)
    echo "  ✗ Unexpected protocol selection mode: $RS_SELECTION"
    exit 1
    ;;
esac

echo "=== Protocol Selection Test PASSED ==="
