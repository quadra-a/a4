#!/usr/bin/env bash
# 验证 Rust 和 JS CLI 默认协议都是 /agent/msg/1.0.0
set -euo pipefail

RS="repos/a4/rust/target/release/a4"
JS="node repos/a4/js/cli/dist/index.js"
TARGET="did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"

echo "=== Default Protocol Test ==="

# Rust: 不指定 --protocol，检查 --json 输出中的 protocol 字段
RS_OUT=$($RS tell "$TARGET" "protocol-test" --json 2>&1 || true)
RS_PROTO=$(echo "$RS_OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
# protocol 可能在顶层，也可能在 trace.summary 里
p = d.get('protocol') or (d.get('trace',{}) or {}).get('summary',{}).get('protocol','')
print(p)
" 2>/dev/null || echo "?")

JS_OUT=$($JS tell "$TARGET" "protocol-test" --json 2>&1 || true)
JS_PROTO=$(echo "$JS_OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
p = d.get('protocol') or (d.get('trace',{}) or {}).get('summary',{}).get('protocol','')
print(p)
" 2>/dev/null || echo "?")

echo "  Rust default protocol: $RS_PROTO"
echo "  JS default protocol:   $JS_PROTO"

if [ "$RS_PROTO" = "$JS_PROTO" ]; then
  echo "  ✓ Protocols match"
else
  echo "  ✗ Protocols differ!"
  exit 1
fi

if [ "$RS_PROTO" = "/agent/msg/1.0.0" ]; then
  echo "  ✓ Default is /agent/msg/1.0.0"
else
  echo "  ✗ Expected /agent/msg/1.0.0, got $RS_PROTO"
  exit 1
fi

echo "=== Default Protocol Test PASSED ==="
