#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JS_ENTRY="$REPO_ROOT/js/cli/dist/index.js"

if [ -x "$REPO_ROOT/target/debug/a4" ]; then
  RS_BIN="$REPO_ROOT/target/debug/a4"
elif [ -x "$REPO_ROOT/rust/target/debug/a4" ]; then
  RS_BIN="$REPO_ROOT/rust/target/debug/a4"
elif [ -x "$REPO_ROOT/target/release/a4" ]; then
  RS_BIN="$REPO_ROOT/target/release/a4"
elif [ -x "$REPO_ROOT/rust/target/release/a4" ]; then
  RS_BIN="$REPO_ROOT/rust/target/release/a4"
else
  RS_BIN=""
fi

run_rs() {
  if [ -n "$RS_BIN" ]; then
    "$RS_BIN" "$@"
  else
    cargo run -q -p quadra-a-cli-rs --manifest-path "$REPO_ROOT/rust/Cargo.toml" -- "$@"
  fi
}

run_js() {
  if [ ! -f "$JS_ENTRY" ]; then
    echo "Missing JS CLI build artifact: $JS_ENTRY" >&2
    exit 1
  fi

  node "$JS_ENTRY" "$@"
}
