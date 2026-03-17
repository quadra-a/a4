#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${TMPDIR:-/tmp}/a4-conformance"

mkdir -p "$OUT_DIR"

(
  cd "$ROOT_DIR/js"
  pnpm run build
)

node "$ROOT_DIR/test-scripts/conformance/run-js.mjs" --out "$OUT_DIR/js.json"

(
  cd "$ROOT_DIR/rust"
  cargo run --package quadra-a-cli-rs --bin a4-conformance -- --out "$OUT_DIR/rust.json"
)

node "$ROOT_DIR/test-scripts/conformance/compare-results.mjs" \
  --js "$OUT_DIR/js.json" \
  --rust "$OUT_DIR/rust.json"

echo "Conformance suite passed."
