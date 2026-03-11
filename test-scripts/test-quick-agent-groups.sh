#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-config.sh"
source "$SCRIPT_DIR/lib/relay-deployment.sh"

RELAY_DIR="$A4_ROOT/js/relay"
PROTOCOL_DIR="$A4_ROOT/js/core/protocol"
RUNTIME_DIR="$A4_ROOT/js/core/runtime"
PROBE_SCRIPT="$SCRIPT_DIR/tools/quick-agent-groups-probe.mjs"
PORT="${PORT:-9600}"
TIMEOUT_MS="${TIMEOUT_MS:-5000}"
SKIP_BUILD=false
JSON_OUTPUT=false
KEEP_DATA=false
TEMP_ROOT=""
RESULT_FILE=""
RELAY_PIDS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --skip-build           Reuse current dist/ outputs
  --json                 Print probe JSON only
  --keep-data            Keep temporary relay artifacts
  --port <port>          Local relay port (default: ${PORT})
  --timeout-ms <ms>      Probe timeout (default: ${TIMEOUT_MS})
  -h, --help             Show this help

Examples:
  $(basename "$0")
  $(basename "$0") --skip-build --port 9650
  $(basename "$0") --json
USAGE
}

trap relay_deployment_cleanup EXIT

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-build)
        SKIP_BUILD=true
        shift
        ;;
      --json)
        JSON_OUTPUT=true
        shift
        ;;
      --keep-data)
        KEEP_DATA=true
        shift
        ;;
      --port)
        PORT="$2"
        shift 2
        ;;
      --timeout-ms)
        TIMEOUT_MS="$2"
        shift 2
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      *)
        relay_deployment_log_error "Unknown argument: $1"
        print_usage >&2
        exit 1
        ;;
    esac
  done
}

run_build() {
  if [[ "$SKIP_BUILD" == true ]]; then
    relay_deployment_log_info "Skipping protocol/runtime/relay builds"
    return
  fi

  relay_deployment_log_info "Building protocol/runtime/relay dist"
  if [[ "$JSON_OUTPUT" == true ]]; then
    (
      cd "$PROTOCOL_DIR"
      pnpm build
      cd "$RUNTIME_DIR"
      pnpm build
      cd "$RELAY_DIR"
      pnpm build
    ) >"$TEMP_ROOT/build.log" 2>&1
  else
    (
      cd "$PROTOCOL_DIR"
      pnpm build
      cd "$RUNTIME_DIR"
      pnpm build
      cd "$RELAY_DIR"
      pnpm build
    )
  fi
}

main() {
  parse_args "$@"
  relay_deployment_require_command node
  relay_deployment_require_command pnpm

  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/quick-agent-groups-test-XXXXXX")"
  run_build

  relay_deployment_log_info "Starting local public relay on port $PORT"
  local relay_info pid log_file
  relay_info="$(relay_deployment_start_relay quick-agent-groups "$PORT" "$TEMP_ROOT/relay-data")"
  pid="${relay_info%%|*}"
  log_file="${relay_info#*|}"
  relay_deployment_wait_for_log_pattern "$log_file" "✓ Relay agent started" "quick-agent-groups relay" "$pid"

  RESULT_FILE="$TEMP_ROOT/quick-agent-groups.json"
  NODE_NO_WARNINGS=1 node "$PROBE_SCRIPT" smoke \
    --a4-root "$A4_ROOT" \
    --relay-url "ws://127.0.0.1:${PORT}" \
    --timeout-ms "$TIMEOUT_MS" \
    > "$RESULT_FILE"

  if [[ "$JSON_OUTPUT" == true ]]; then
    cat "$RESULT_FILE"
    return
  fi

  relay_deployment_log_success "Quick Agent Groups smoke test passed"
  echo
  echo "========================================"
  echo "Quick Agent Groups Test Summary"
  echo "========================================"
  echo "result:     $RESULT_FILE"
  echo "artifacts:  $TEMP_ROOT"
}

main "$@"
