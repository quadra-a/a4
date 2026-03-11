#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-config.sh"
source "$SCRIPT_DIR/lib/relay-deployment.sh"

RELAY_DIR="$A4_ROOT/js/relay"
PROBE_SCRIPT="$SCRIPT_DIR/tools/relay-deployment-probe.mjs"
MODE="all"
SKIP_BUILD=false
KEEP_DATA=false
JSON_OUTPUT=false
BASE_PORT="${BASE_PORT:-9400}"
TIMEOUT_MS="${TIMEOUT_MS:-5000}"
WAIT_INTERVAL_SECS="${WAIT_INTERVAL_SECS:-0.2}"
WAIT_STEPS="${WAIT_STEPS:-80}"
TEMP_ROOT=""

RELAY_PIDS=()
SMOKE_RESULT_FILE=""
FEDERATION_RESULT_FILE=""
QUARANTINE_RESULT_FILE=""

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_usage() {
  cat <<USAGE
Usage: $(basename "$0") [mode] [options]

Modes:
  all          Run smoke + federation + quarantine checks (default)
  smoke        Run single-relay deployment smoke test
  federation   Run two-relay federation admission deployment test
  quarantine   Run repeated-failure quarantine deployment test

Options:
  --skip-build           Reuse the current js/relay/dist output
  --keep-data            Keep temporary relay data/log directories
  --json                 Print aggregated JSON only
  --base-port <port>     Starting local port (default: ${BASE_PORT})
  --timeout-ms <ms>      Per-step timeout for Node probes (default: ${TIMEOUT_MS})
  -h, --help             Show this help

Examples:
  $(basename "$0")
  $(basename "$0") federation --skip-build --base-port 9500
  $(basename "$0") quarantine --json
USAGE
}

trap relay_deployment_cleanup EXIT

parse_args() {
  local mode_set=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      all|smoke|federation|quarantine)
        if [[ "$mode_set" == true ]]; then
          relay_deployment_log_error "Mode specified more than once"
          exit 1
        fi
        MODE="$1"
        mode_set=true
        shift
        ;;
      --skip-build)
        SKIP_BUILD=true
        shift
        ;;
      --keep-data)
        KEEP_DATA=true
        shift
        ;;
      --json)
        JSON_OUTPUT=true
        shift
        ;;
      --base-port)
        BASE_PORT="$2"
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
    relay_deployment_log_info "Skipping js/relay build"
    return
  fi

  relay_deployment_log_info "Building js/relay dist"
  if [[ "$JSON_OUTPUT" == true ]]; then
    (
      cd "$RELAY_DIR"
      pnpm run build
    ) >"$TEMP_ROOT/build.log" 2>&1
  else
    (
      cd "$RELAY_DIR"
      pnpm run build
    )
  fi
}

run_smoke_test() {
  local port="$1"
  local output_file="$TEMP_ROOT/smoke.json"

  relay_deployment_log_info "Running single-relay deployment smoke test on port $port"
  (
    cd "$RELAY_DIR"
    NODE_NO_WARNINGS=1 node --experimental-strip-types scripts/smoke-relay.ts \
      --port "$port" \
      --public-endpoint "ws://127.0.0.1:${port}" \
      --skip-build \
      --json
  ) >"$output_file"

  SMOKE_RESULT_FILE="$output_file"
  relay_deployment_log_success "Smoke deployment test passed"
}

run_federation_test() {
  local port_a="$1"
  local port_b="$2"
  local dir_a="$TEMP_ROOT/federation-a"
  local dir_b="$TEMP_ROOT/federation-b"
  mkdir -p "$dir_a" "$dir_b"

  relay_deployment_log_info "Running two-relay federation deployment test on ports $port_a/$port_b"

  local relay_a_info relay_b_info pid_a log_a pid_b log_b
  relay_a_info="$(relay_deployment_start_relay relay-a "$port_a" "$dir_a" --genesis-mode)"
  pid_a="${relay_a_info%%|*}"
  log_a="${relay_a_info#*|}"
  relay_deployment_wait_for_log_pattern "$log_a" "✓ Relay agent started" "relay-a" "$pid_a"

  relay_b_info="$(relay_deployment_start_relay relay-b "$port_b" "$dir_b" --seed-relay "ws://127.0.0.1:${port_a}")"
  pid_b="${relay_b_info%%|*}"
  log_b="${relay_b_info#*|}"
  relay_deployment_wait_for_log_pattern "$log_b" "✓ Relay agent started" "relay-b" "$pid_b"
  relay_deployment_wait_for_log_pattern "$log_a" "Received federation admitted" "relay-a admission" "$pid_a"
  relay_deployment_wait_for_log_pattern "$log_b" "Received federation admitted" "relay-b admission" "$pid_b"

  local output_file="$TEMP_ROOT/federation.json"
  NODE_NO_WARNINGS=1 node --experimental-strip-types "$PROBE_SCRIPT" federation \
    --relay-dir "$RELAY_DIR" \
    --endpoint-a "ws://127.0.0.1:${port_a}" \
    --endpoint-b "ws://127.0.0.1:${port_b}" \
    --timeout-ms "$TIMEOUT_MS" \
    >"$output_file"

  FEDERATION_RESULT_FILE="$output_file"
  relay_deployment_log_success "Federation deployment test passed"
}

run_quarantine_test() {
  local port="$1"
  local data_dir="$TEMP_ROOT/quarantine"
  mkdir -p "$data_dir"

  relay_deployment_log_info "Running federation quarantine deployment test on port $port"

  local relay_info pid log_file
  relay_info="$(relay_deployment_start_relay relay-quarantine "$port" "$data_dir")"
  pid="${relay_info%%|*}"
  log_file="${relay_info#*|}"
  relay_deployment_wait_for_log_pattern "$log_file" "✓ Relay agent started" "relay-quarantine" "$pid"

  local output_file="$TEMP_ROOT/quarantine.json"
  NODE_NO_WARNINGS=1 node --experimental-strip-types "$PROBE_SCRIPT" quarantine \
    --relay-dir "$RELAY_DIR" \
    --endpoint "ws://127.0.0.1:${port}" \
    --timeout-ms "$TIMEOUT_MS" \
    >"$output_file"

  QUARANTINE_RESULT_FILE="$output_file"
  relay_deployment_log_success "Quarantine deployment test passed"
}

print_human_summary() {
  echo
  echo "========================================"
  echo "Relay Deployment Test Summary"
  echo "========================================"
  [[ -n "$SMOKE_RESULT_FILE" ]] && echo "smoke:      $SMOKE_RESULT_FILE"
  [[ -n "$FEDERATION_RESULT_FILE" ]] && echo "federation: $FEDERATION_RESULT_FILE"
  [[ -n "$QUARANTINE_RESULT_FILE" ]] && echo "quarantine: $QUARANTINE_RESULT_FILE"
  [[ -n "$TEMP_ROOT" ]] && echo "artifacts:  $TEMP_ROOT"
}

main() {
  parse_args "$@"
  relay_deployment_require_command node
  relay_deployment_require_command pnpm

  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/relay-deployment-test-XXXXXX")"

  run_build

  case "$MODE" in
    all)
      run_smoke_test "$BASE_PORT"
      run_federation_test "$((BASE_PORT + 1))" "$((BASE_PORT + 2))"
      run_quarantine_test "$((BASE_PORT + 3))"
      ;;
    smoke)
      run_smoke_test "$BASE_PORT"
      ;;
    federation)
      run_federation_test "$BASE_PORT" "$((BASE_PORT + 1))"
      ;;
    quarantine)
      run_quarantine_test "$BASE_PORT"
      ;;
  esac

  if [[ "$JSON_OUTPUT" == true ]]; then
    relay_deployment_emit_json_summary
  else
    print_human_summary
  fi
}

main "$@"
