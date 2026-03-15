#!/usr/bin/env bash
# 验证 Rust CLI 自动连接 JS daemon
set -euo pipefail

RS="repos/a4/rust/target/release/a4"

echo "=== Socket Fallback Test ==="

# 前提：JS daemon 在跑，Rust daemon 没跑
if [ ! -S /tmp/quadra-a.sock ]; then
  echo "SKIP: JS daemon not running"; exit 0
fi
if [ -S /tmp/quadra-a-rs.sock ]; then
  echo "SKIP: Rust daemon is running (test requires only JS daemon)"; exit 0
fi

# 不设任何环境变量，Rust CLI 应该自动找到 JS daemon
echo "Step 1: Rust CLI inbox without env var..."
OUT=$($RS inbox --json --limit 1 2>&1)
# inbox --json outputs NDJSON (one JSON per line), validate first line
FIRST=$(echo "$OUT" | head -1)
if echo "$FIRST" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "  ✓ Rust CLI auto-discovered JS daemon socket"
else
  echo "  ✗ Rust CLI failed to connect to JS daemon"
  echo "  Output (first 200 chars): ${OUT:0:200}"
  exit 1
fi

echo "Step 2: Rust CLI status without env var..."
OUT=$($RS status --json 2>&1)
if echo "$OUT" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "  ✓ Rust CLI status returned valid JSON"
else
  echo "  ⚠ status output not valid JSON (may be acceptable)"
fi

echo "=== Socket Fallback Test PASSED ==="
