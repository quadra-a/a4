#!/usr/bin/env bash
# helpers.sh — Shared utilities for E2E integration tests
set -euo pipefail

TEST_TMPDIR=""
PIDS=()

cleanup() {
  echo "Cleaning up..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ -n "$TEST_TMPDIR" && -d "$TEST_TMPDIR" ]]; then
    rm -rf "$TEST_TMPDIR"
  fi
}
trap cleanup EXIT

# Resolve the a4 binary — prefer Rust, fall back to JS
resolve_a4_bin() {
  local rust_bin
  rust_bin="$(cd "$(dirname "$0")/../.." && pwd)/rust/target/debug/a4"
  if [[ -x "$rust_bin" ]]; then
    echo "$rust_bin"
    return
  fi
  # Fall back to PATH
  if command -v a4 &>/dev/null; then
    command -v a4
    return
  fi
  echo "ERROR: No a4 binary found" >&2
  exit 1
}

A4_BIN="$(resolve_a4_bin)"

setup_agent() {
  local name="$1"
  TEST_TMPDIR="${TEST_TMPDIR:-$(mktemp -d)}"
  local home="$TEST_TMPDIR/$name"
  mkdir -p "$home"

  # Create identity
  QUADRA_A_HOME="$home" "$A4_BIN" listen --background 2>/dev/null || true
  sleep 1
  QUADRA_A_HOME="$home" "$A4_BIN" daemon stop 2>/dev/null || true

  local did
  did=$(QUADRA_A_HOME="$home" "$A4_BIN" identity --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('did',''))" 2>/dev/null || echo "")

  # Export variables for the caller
  eval "${name}_HOME=\"$home\""
  eval "${name}_DID=\"$did\""
  echo "  Setup $name: home=$home did=$did"
}

start_daemon() {
  local name="$1"
  local home_var="${name}_HOME"
  local home="${!home_var}"
  echo "  Starting $name daemon..."
  QUADRA_A_HOME="$home" "$A4_BIN" listen --background 2>/dev/null
  sleep 2
}

stop_daemon() {
  local name="$1"
  local home_var="${name}_HOME"
  local home="${!home_var}"
  QUADRA_A_HOME="$home" "$A4_BIN" daemon stop 2>/dev/null || true
  sleep 1
}

a4_cmd() {
  local name="$1"
  shift
  local home_var="${name}_HOME"
  local home="${!home_var}"
  QUADRA_A_HOME="$home" "$A4_BIN" "$@"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="${3:-assert_contains failed}"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✓ $msg"
  else
    echo "  ✗ $msg"
    echo "    Expected to find: $needle"
    echo "    In: ${haystack:0:200}..."
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="${3:-assert_not_contains failed}"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✗ $msg"
    echo "    Did not expect to find: $needle"
    exit 1
  else
    echo "  ✓ $msg"
  fi
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local msg="${3:-assert_eq failed}"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $msg"
  else
    echo "  ✗ $msg (expected=$expected actual=$actual)"
    exit 1
  fi
}
