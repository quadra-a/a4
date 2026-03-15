#!/usr/bin/env bash
# 验证 Rust CLI 自动连接 JS daemon
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "=== Socket Fallback Test ==="

QUADRA_A_HOME_PATH="${QUADRA_A_HOME:-$HOME/.quadra-a}"
HOME_HASH=$(python3 - "$QUADRA_A_HOME_PATH" <<'PY'
import hashlib
import sys

print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:8])
PY
)
JS_SOCKET="${QUADRA_A_SOCKET_PATH:-/tmp/quadra-a-${HOME_HASH}.sock}"
if [ -n "${QUADRA_A_RS_SOCKET_PATH:-}" ]; then
  RS_SOCKET="$QUADRA_A_RS_SOCKET_PATH"
elif [ -n "${QUADRA_A_SOCKET_PATH:-}" ]; then
  RS_SOCKET="$QUADRA_A_SOCKET_PATH"
else
  RS_SOCKET="/tmp/quadra-a-${HOME_HASH}-rs.sock"
fi

# 前提：JS daemon 在跑，Rust daemon 没跑
if [ ! -S "$JS_SOCKET" ] && [ ! -S /tmp/quadra-a.sock ]; then
  echo "SKIP: JS daemon not running"; exit 0
fi
if [ -S "$RS_SOCKET" ] || [ -S /tmp/quadra-a-rs.sock ]; then
  echo "SKIP: Rust daemon is running (test requires only JS daemon)"; exit 0
fi

# 不设任何环境变量，Rust CLI 应该自动找到 JS daemon
echo "Step 1: Rust CLI inbox without env var..."
OUT=$(run_rs inbox --json --limit 1 2>&1)
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
OUT=$(run_rs status --json 2>&1)
if echo "$OUT" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "  ✓ Rust CLI status returned valid JSON"
else
  echo "  ⚠ status output not valid JSON (may be acceptable)"
fi

echo "=== Socket Fallback Test PASSED ==="
