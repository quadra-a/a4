#!/usr/bin/env bash
# 验证 --json 旗标统一
set -euo pipefail
PASS=0; FAIL=0

assert_json() {
  local label="$1" output="$2"
  if echo "$output" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    echo "  ✓ $label"; PASS=$((PASS+1))
  else
    echo "  ✗ $label (not valid JSON)"; FAIL=$((FAIL+1))
  fi
}

assert_has_key() {
  local label="$1" output="$2" key="$3"
  if echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert '$key' in d" 2>/dev/null; then
    echo "  ✓ $label"; PASS=$((PASS+1))
  else
    echo "  ✗ $label (missing key: $key)"; FAIL=$((FAIL+1))
  fi
}

# NDJSON: take first line and validate as JSON
assert_ndjson() {
  local label="$1" output="$2"
  local first_line
  first_line=$(echo "$output" | head -1)
  if echo "$first_line" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    echo "  ✓ $label"; PASS=$((PASS+1))
  else
    echo "  ✗ $label (first line not valid JSON)"; FAIL=$((FAIL+1))
  fi
}

RS="repos/a4/rust/target/release/a4"
JS="node repos/a4/js/cli/dist/index.js"
TARGET="did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"

echo "=== Rust CLI --json ==="
# status (已有 --json)
OUT=$($RS status --json 2>&1); assert_json "status --json" "$OUT"
# tell --json (may fail to send, but should output JSON even on error)
OUT=$($RS tell "$TARGET" "test" --json --protocol /agent/msg/1.0.0 2>&1 || true)
assert_json "tell --json" "$OUT"
# inbox --json outputs NDJSON (one JSON per line)
OUT=$($RS inbox --json --limit 2 2>&1 || true)
if [ -n "$OUT" ]; then
  assert_ndjson "inbox --json (NDJSON)" "$OUT"
else
  echo "  ✓ inbox --json (empty, acceptable)"; PASS=$((PASS+1))
fi

echo ""
echo "=== JS CLI --json ==="
# status
OUT=$($JS status --json 2>&1); assert_json "status --json" "$OUT"
# tell --json (may fail to send, but should output JSON even on error)
OUT=$($JS tell "$TARGET" "test" --json --protocol /agent/msg/1.0.0 2>&1 || true)
assert_json "tell --json" "$OUT"
# inbox --json
OUT=$($JS inbox --json --limit 2 2>&1 || true)
assert_json "inbox --json" "$OUT"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
