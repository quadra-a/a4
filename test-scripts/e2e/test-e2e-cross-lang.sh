#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$SCRIPT_DIR/../test-config.sh"

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

RUN_JS_TO_RUST=true
RUN_RUST_TO_JS=true
RUN_MULTI_JS_TO_RUST=true
RUN_MULTI_RUST_TO_JS=true
RUN_FEDERATED_JS_TO_RUST=true
RUN_OFFLINE_JS_TO_RUST=true
ARTIFACT_ROOT="${A4_ROOT}/test-output/e2e/cross-lang/$(date +%Y%m%d-%H%M%S)"

JS_CLI="$A4_ROOT/js/cli/a4"
RUST_A4_BINARY="$A4_ROOT/rust/target/debug/a4"
RELAY_ENTRY="$A4_ROOT/js/relay/dist/index.js"

PROCESS_PIDS=()
CURRENT_JS_HOME=""
CURRENT_JS_SOCKET=""
CURRENT_JS_PID_FILE=""
CURRENT_RUST_HOME=""
CURRENT_RUST_SOCKET=""

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }

print_usage() {
  cat <<USAGE
Usage: $(basename "$0") [--js-to-rust-only | --rust-to-js-only | --multi-js-to-rust-only | --multi-rust-to-js-only | --federation-js-to-rust-only | --offline-js-to-rust-only | --no-federation | --no-offline | --no-multi] [--artifact-dir <path>]

Runs the executable JS↔Rust E2E interoperability harness.
Currently covers:
  - E2E-CROSS-001: JS initiator -> Rust responder
  - E2E-CROSS-002: Rust initiator -> JS responder
  - E2E-MULTI-001: JS initiator -> Rust multi-device responder with visible-message dedupe
  - E2E-MULTI-002: Rust initiator -> JS multi-device responder with visible-message dedupe
  - E2E-CROSS-005: JS initiator -> offline Rust responder through a live local relay
  - E2E-CROSS-006: JS/Rust relay-visible header parity and hidden-plaintext assertions
  - E2E-FED-001: JS initiator -> Rust responder across two federated local relays
USAGE
}

cleanup() {
  set +e

  if [[ -n "$CURRENT_JS_HOME" ]]; then
    QUADRA_A_HOME="$CURRENT_JS_HOME" \
    QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
    QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      "$JS_CLI" stop >/dev/null 2>&1 || true
  fi

  if [[ -n "$CURRENT_RUST_HOME" ]]; then
    QUADRA_A_HOME="$CURRENT_RUST_HOME" \
    QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" stop >/dev/null 2>&1 || true
  fi

  for pid in "${PROCESS_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

wait_for_log_pattern() {
  local log_file="$1"
  local pattern="$2"
  local label="$3"
  local pid="$4"

  for _ in $(seq 1 80); do
    if [[ -f "$log_file" ]] && grep -q "$pattern" "$log_file"; then
      return 0
    fi

    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      log_error "$label exited before reaching pattern: $pattern"
      [[ -f "$log_file" ]] && cat "$log_file" >&2
      return 1
    fi

    sleep 0.25
  done

  log_error "Timed out waiting for $label pattern: $pattern"
  [[ -f "$log_file" ]] && cat "$log_file" >&2
  return 1
}

wait_for_rust_daemon() {
  local home="$1"
  local socket_path="$2"
  local log_file="$3"
  local pid="$4"

  for _ in $(seq 1 80); do
    local status_json=""
    if status_json="$(QUADRA_A_HOME="$home" QUADRA_A_RS_SOCKET_PATH="$socket_path" \
      "$RUST_A4_BINARY" status --json 2>/dev/null)"; then
      if [[ "$status_json" != *'"daemon": null'* ]]; then
        return 0
      fi
    fi

    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      log_error "rust receiver exited before daemon status became ready"
      [[ -f "$log_file" ]] && cat "$log_file" >&2
      return 1
    fi

    sleep 0.25
  done

  log_error "Timed out waiting for rust receiver daemon readiness"
  [[ -f "$log_file" ]] && cat "$log_file" >&2
  return 1
}

wait_for_process_exit() {
  local pid="$1"
  local label="$2"
  local log_file="${3:-}"

  if [[ -z "$pid" ]]; then
    return 0
  fi

  for _ in $(seq 1 80); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done

  log_error "Timed out waiting for $label process to exit"
  [[ -n "$log_file" && -f "$log_file" ]] && cat "$log_file" >&2
  return 1
}

wait_for_path_absent() {
  local path="$1"
  local label="$2"

  if [[ -z "$path" ]]; then
    return 0
  fi

  for _ in $(seq 1 80); do
    if [[ ! -e "$path" ]]; then
      return 0
    fi
    sleep 0.25
  done

  log_error "Timed out waiting for $label cleanup: $path"
  return 1
}

next_port() {
  python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(('127.0.0.1', 0))
print(sock.getsockname()[1])
sock.close()
PY
}

json_get() {
  local path="$1"
  local expr="$2"
  python3 - "$path" "$expr" <<'PY'
import json
import sys

path = sys.argv[1]
expr = sys.argv[2]
with open(path, 'r', encoding='utf-8') as handle:
    data = json.load(handle)
value = data
for part in expr.split('.'):
    if not part:
        continue
    if isinstance(value, list):
        value = value[int(part)]
    else:
        value = value[part]
if isinstance(value, bool):
    print('true' if value else 'false')
elif value is None:
    print('null')
else:
    print(value)
PY
}

assert_jsonl_message() {
  local path="$1"
  local sender_did="$2"
  local protocol="$3"
  local thread_id="$4"
  local message_text="$5"
  python3 - "$path" "$sender_did" "$protocol" "$thread_id" "$message_text" <<'PY'
import json
import sys

path, sender_did, protocol, thread_id, message_text = sys.argv[1:]
with open(path, 'r', encoding='utf-8') as handle:
    lines = [line.strip() for line in handle if line.strip()]
if not lines:
    raise SystemExit('receiver inbox output is empty')
entries = [json.loads(line) for line in lines]
for entry in entries:
    envelope = entry.get('envelope') or entry
    payload = envelope.get('payload') or {}
    if (
        envelope.get('from') == sender_did
        and envelope.get('protocol') == protocol
        and envelope.get('threadId') == thread_id
        and payload.get('text') == message_text
    ):
        print(envelope.get('id', entry.get('id', 'unknown')))
        raise SystemExit(0)
raise SystemExit('expected decrypted offline message not found in receiver inbox output')
PY
}

count_rust_sessions() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    data = json.load(handle)
e2e = data.get('e2e') or {}
current = e2e.get('currentDeviceId')
device = (e2e.get('devices') or {}).get(current) or {}
sessions = device.get('sessions') or {}
print(len(sessions))
PY
}

count_total_sessions() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    data = json.load(handle)
e2e = data.get('e2e') or {}
devices = (e2e.get('devices') or {}).values()
print(sum(len((device.get('sessions') or {})) for device in devices))
PY
}

json_page_total() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    data = json.load(handle)
print(int(data.get('total', 0)))
PY
}

assert_json_page_message() {
  local path="$1"
  local sender_did="$2"
  local protocol="$3"
  local thread_id="$4"
  local message_text="$5"
  python3 - "$path" "$sender_did" "$protocol" "$thread_id" "$message_text" <<'PY'
import json
import sys

path, sender_did, protocol, thread_id, message_text = sys.argv[1:]
with open(path, 'r', encoding='utf-8') as handle:
    data = json.load(handle)
messages = data.get('messages') or []
for entry in messages:
    envelope = entry.get('envelope') or entry
    payload = envelope.get('payload') or {}
    if (
        envelope.get('from') == sender_did
        and envelope.get('protocol') == protocol
        and envelope.get('threadId') == thread_id
        and payload.get('text') == message_text
    ):
        print(envelope.get('id', 'unknown'))
        raise SystemExit(0)
raise SystemExit('expected decrypted message not found in JSON page output')
PY
}

add_device_to_config() {
  local config_path="$1"
  local device_id="$2"
  local artifact_path="$3"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    add-device "$config_path" "$device_id" "$artifact_path"
}

rotate_prekey_in_config() {
  local config_path="$1"
  local device_id="$2"
  local artifact_path="$3"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    rotate-prekey "$config_path" "$device_id" "$artifact_path"
}

assert_jsonl_message_deliveries() {
  local path="$1"
  local message_id="$2"
  local expected_count="$3"
  local expected_state="$4"
  local expected_transport="$5"
  shift 5
  python3 - "$path" "$message_id" "$expected_count" "$expected_state" "$expected_transport" "$@" <<'PY'
import json
import sys

path, message_id, expected_count, expected_state, expected_transport, *expected_receivers = sys.argv[1:]
expected_count = int(expected_count)
with open(path, 'r', encoding='utf-8') as handle:
    entries = [json.loads(line) for line in handle if line.strip()]
for entry in entries:
    if entry.get('id') != message_id:
        continue
    deliveries = ((entry.get('e2e') or {}).get('deliveries') or [])
    if len(deliveries) != expected_count:
        raise SystemExit(f'expected {expected_count} deliveries for {message_id}, got {len(deliveries)}')
    states = {delivery.get('state') for delivery in deliveries}
    if states != {expected_state}:
        raise SystemExit(f'unexpected delivery states for {message_id}: {sorted(states)}')
    if expected_transport != '-':
        transports = {delivery.get('transport') for delivery in deliveries}
        if transports != {expected_transport}:
            raise SystemExit(f'unexpected delivery transports for {message_id}: {sorted(transports)}')
    receivers = sorted(delivery.get('receiverDeviceId') for delivery in deliveries)
    if sorted(expected_receivers) != receivers:
        raise SystemExit(f'unexpected receiver devices for {message_id}: {receivers}')
    print(message_id)
    raise SystemExit(0)
raise SystemExit(f'expected message {message_id} not found in {path}')
PY
}

assert_json_page_message_deliveries() {
  local path="$1"
  local message_id="$2"
  local expected_count="$3"
  local expected_state="$4"
  local expected_transport="$5"
  shift 5
  python3 - "$path" "$message_id" "$expected_count" "$expected_state" "$expected_transport" "$@" <<'PY'
import json
import sys

path, message_id, expected_count, expected_state, expected_transport, *expected_receivers = sys.argv[1:]
expected_count = int(expected_count)
with open(path, 'r', encoding='utf-8') as handle:
    data = json.load(handle)
messages = data.get('messages') or []
for entry in messages:
    envelope = entry.get('envelope') or entry
    if envelope.get('id') != message_id:
        continue
    deliveries = ((entry.get('e2e') or {}).get('deliveries') or [])
    if len(deliveries) != expected_count:
        raise SystemExit(f'expected {expected_count} deliveries for {message_id}, got {len(deliveries)}')
    states = {delivery.get('state') for delivery in deliveries}
    if states != {expected_state}:
        raise SystemExit(f'unexpected delivery states for {message_id}: {sorted(states)}')
    if expected_transport != '-':
        transports = {delivery.get('transport') for delivery in deliveries}
        if transports != {expected_transport}:
            raise SystemExit(f'unexpected delivery transports for {message_id}: {sorted(transports)}')
    receivers = sorted(delivery.get('receiverDeviceId') for delivery in deliveries)
    if sorted(expected_receivers) != receivers:
        raise SystemExit(f'unexpected receiver devices for {message_id}: {receivers}')
    print(message_id)
    raise SystemExit(0)
raise SystemExit(f'expected message {message_id} not found in {path}')
PY
}

wait_for_js_inbox_total() {
  local home="$1"
  local socket_path="$2"
  local pid_file="$3"
  local thread_id="$4"
  local expected_total="$5"
  local output_path="$6"

  for _ in $(seq 1 80); do
    if QUADRA_A_HOME="$home" \
      QUADRA_A_SOCKET_PATH="$socket_path" \
      QUADRA_A_PID_FILE="$pid_file" \
      "$JS_CLI" inbox --thread "$thread_id" --format json >"$output_path" 2>/dev/null; then
      local total
      total="$(json_page_total "$output_path")"
      if [[ "$total" -ge "$expected_total" ]]; then
        return 0
      fi
    fi
    sleep 0.25
  done

  log_error "Timed out waiting for JS inbox thread $thread_id to reach $expected_total visible message(s)"
  [[ -f "$output_path" ]] && cat "$output_path" >&2
  return 1
}

wait_for_rust_inbox_total() {
  local home="$1"
  local socket_path="$2"
  local thread_id="$3"
  local expected_total="$4"
  local output_path="$5"

  for _ in $(seq 1 80); do
    if QUADRA_A_HOME="$home" \
      QUADRA_A_RS_SOCKET_PATH="$socket_path" \
      "$RUST_A4_BINARY" inbox --thread "$thread_id" --json >"$output_path" 2>/dev/null; then
      local total
      total="$(python3 - "$output_path" <<'PY'
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    print(sum(1 for line in handle if line.strip()))
PY
)"
      if [[ "$total" -ge "$expected_total" ]]; then
        return 0
      fi
    fi
    sleep 0.25
  done

  log_error "Timed out waiting for Rust inbox thread $thread_id to reach $expected_total visible message(s)"
  [[ -f "$output_path" ]] && cat "$output_path" >&2
  return 1
}

wait_for_total_sessions() {
  local config_path="$1"
  local expected_total="$2"
  local label="$3"

  for _ in $(seq 1 80); do
    local total
    total="$(count_total_sessions "$config_path")"
    if [[ "$total" -ge "$expected_total" ]]; then
      return 0
    fi
    sleep 0.25
  done

  log_error "Timed out waiting for $label to reach $expected_total total session(s)"
  python3 - "$config_path" <<'PY' >&2
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    data = json.load(handle)
print(json.dumps(data.get('e2e') or {}, indent=2))
PY
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --js-to-rust-only)
      RUN_RUST_TO_JS=false
      RUN_MULTI_JS_TO_RUST=false
      RUN_MULTI_RUST_TO_JS=false
      RUN_FEDERATED_JS_TO_RUST=false
      RUN_OFFLINE_JS_TO_RUST=false
      shift
      ;;
    --rust-to-js-only)
      RUN_JS_TO_RUST=false
      RUN_MULTI_JS_TO_RUST=false
      RUN_MULTI_RUST_TO_JS=false
      RUN_FEDERATED_JS_TO_RUST=false
      RUN_OFFLINE_JS_TO_RUST=false
      shift
      ;;
    --multi-js-to-rust-only)
      RUN_JS_TO_RUST=false
      RUN_RUST_TO_JS=false
      RUN_MULTI_RUST_TO_JS=false
      RUN_FEDERATED_JS_TO_RUST=false
      RUN_OFFLINE_JS_TO_RUST=false
      shift
      ;;
    --multi-rust-to-js-only)
      RUN_JS_TO_RUST=false
      RUN_RUST_TO_JS=false
      RUN_MULTI_JS_TO_RUST=false
      RUN_FEDERATED_JS_TO_RUST=false
      RUN_OFFLINE_JS_TO_RUST=false
      shift
      ;;
    --federation-js-to-rust-only)
      RUN_JS_TO_RUST=false
      RUN_RUST_TO_JS=false
      RUN_MULTI_JS_TO_RUST=false
      RUN_MULTI_RUST_TO_JS=false
      RUN_OFFLINE_JS_TO_RUST=false
      shift
      ;;
    --offline-js-to-rust-only)
      RUN_JS_TO_RUST=false
      RUN_RUST_TO_JS=false
      RUN_MULTI_JS_TO_RUST=false
      RUN_MULTI_RUST_TO_JS=false
      RUN_FEDERATED_JS_TO_RUST=false
      shift
      ;;
    --no-federation)
      RUN_FEDERATED_JS_TO_RUST=false
      shift
      ;;
    --no-offline)
      RUN_OFFLINE_JS_TO_RUST=false
      shift
      ;;
    --no-multi)
      RUN_MULTI_JS_TO_RUST=false
      RUN_MULTI_RUST_TO_JS=false
      shift
      ;;
    --artifact-dir)
      ARTIFACT_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      log_error "Unknown argument: $1"
      print_usage
      exit 1
      ;;
  esac
done

if [[ "$RUN_JS_TO_RUST" == false && "$RUN_RUST_TO_JS" == false && "$RUN_MULTI_JS_TO_RUST" == false && "$RUN_MULTI_RUST_TO_JS" == false && "$RUN_FEDERATED_JS_TO_RUST" == false && "$RUN_OFFLINE_JS_TO_RUST" == false ]]; then
  log_error "Nothing to run"
  exit 1
fi

mkdir -p "$ARTIFACT_ROOT"

log_info "Building JS protocol/runtime/cli/relay packages"
(
  cd "$A4_ROOT/js"
  pnpm --filter @quadra-a/protocol build >/dev/null
  pnpm --filter @quadra-a/runtime build >/dev/null
  pnpm --filter @quadra-a/cli build >/dev/null
  pnpm --filter @quadra-a/relay build >/dev/null
)

log_info "Building Rust CLI binary for local harness"
(
  cd "$A4_ROOT/rust"
  cargo build -p quadra-a-cli-rs >/dev/null
)

RESULTS=()
JS_TO_RUST_ARTIFACT=""
RUST_TO_JS_ARTIFACT=""

if [[ "$RUN_JS_TO_RUST" == true ]]; then
  ARTIFACT="$ARTIFACT_ROOT/E2E-CROSS-001.js-to-rust.json"
  log_info "Generating JS -> Rust artifact"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" cross-js-to-rust "$ARTIFACT"

  log_info "Validating JS -> Rust artifact in Rust"
  (
    cd "$A4_ROOT/rust"
    QUADRA_A_CROSS_LANG_INPUT="$ARTIFACT" cargo test -p quadra-a-core cross_lang_consumes_js_artifact -- --nocapture
  )
  JS_TO_RUST_ARTIFACT="$ARTIFACT"
  log_success "E2E-CROSS-001 passed"
  RESULTS+=("E2E-CROSS-001")
fi

if [[ "$RUN_RUST_TO_JS" == true ]]; then
  ARTIFACT="$ARTIFACT_ROOT/E2E-CROSS-002.rust-to-js.json"
  log_info "Generating Rust -> JS artifact"
  (
    cd "$A4_ROOT/rust"
    QUADRA_A_CROSS_LANG_OUTPUT="$ARTIFACT" cargo test -p quadra-a-core cross_lang_emits_rust_artifact -- --nocapture
  )

  log_info "Validating Rust -> JS artifact in JS"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" verify-rust-to-js "$ARTIFACT"
  RUST_TO_JS_ARTIFACT="$ARTIFACT"
  log_success "E2E-CROSS-002 passed"
  RESULTS+=("E2E-CROSS-002")
fi

if [[ -n "$JS_TO_RUST_ARTIFACT" && -n "$RUST_TO_JS_ARTIFACT" ]]; then
  ARTIFACT="$ARTIFACT_ROOT/E2E-CROSS-006.visible-headers.json"
  log_info "Comparing relay-visible headers across JS and Rust artifacts"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    compare-visible-headers "$JS_TO_RUST_ARTIFACT" "$RUST_TO_JS_ARTIFACT" "$ARTIFACT"
  log_success "E2E-CROSS-006 passed"
  RESULTS+=("E2E-CROSS-006")
fi

if [[ "$RUN_MULTI_JS_TO_RUST" == true ]]; then
  CASE_ID="E2E-MULTI-001"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_PORT="$(next_port)"
  RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"
  RELAY_DATA="$CASE_ROOT/relay-data"
  RELAY_LOG="$CASE_ROOT/relay.log"
  SOCKET_TAG="multi-js-rs-$(date +%s)-$$"

  CURRENT_JS_HOME="$CASE_ROOT/js-sender-home"
  CURRENT_RUST_HOME="$CASE_ROOT/rust-receiver-home"
  CURRENT_JS_SOCKET="/tmp/a4-multi-js-${SOCKET_TAG}.sock"
  CURRENT_JS_PID_FILE="/tmp/a4-multi-js-${SOCKET_TAG}.pid"
  CURRENT_RUST_SOCKET="/tmp/a4-multi-rs-${SOCKET_TAG}.sock"

  log_info "Starting local relay for JS -> Rust multi-device delivery"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY" \
      --port "$RELAY_PORT" \
      --landing-port false \
      --data-dir "$RELAY_DATA" \
      --public-endpoint "$RELAY_URL" \
      --no-federation
  ) >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
  PROCESS_PIDS+=("$RELAY_PID")
  wait_for_log_pattern "$RELAY_LOG" "Relay agent started" "relay" "$RELAY_PID"

  RECEIVER_SEED_LOG="$CASE_ROOT/rust-receiver-seed.log"
  RECEIVER_STOP_LOG="$CASE_ROOT/rust-receiver-stop.log"
  RECEIVER_ADD_DEVICE_JSON="$CASE_ROOT/rust-receiver-add-device.json"
  RECEIVER_START_LOG="$CASE_ROOT/rust-receiver-runtime.log"
  RECEIVER_STATUS_JSON="$CASE_ROOT/rust-receiver-status.json"
  RECEIVER_READY_PRIMARY_JSON="$CASE_ROOT/rust-receiver-card-primary.json"
  RECEIVER_READY_SECONDARY_JSON="$CASE_ROOT/rust-receiver-card-secondary.json"
  RECEIVER_FIRST_INBOX_JSONL="$CASE_ROOT/rust-receiver-inbox-first.jsonl"
  RECEIVER_SECOND_INBOX_JSONL="$CASE_ROOT/rust-receiver-inbox-second.jsonl"
  RECEIVER_STOP_ROTATE_LOG="$CASE_ROOT/rust-receiver-stop-rotate.log"
  RECEIVER_ROTATE_PREKEY_JSON="$CASE_ROOT/rust-receiver-rotate-prekey.json"
  RECEIVER_ROTATED_START_LOG="$CASE_ROOT/rust-receiver-runtime-rotated.log"
  RECEIVER_READY_SECONDARY_ROTATED_JSON="$CASE_ROOT/rust-receiver-card-secondary-rotated.json"
  SENDER_LISTEN_LOG="$CASE_ROOT/js-sender-listen.log"
  SENDER_TELL_1_JSON="$CASE_ROOT/js-sender-tell-1.json"
  SENDER_TELL_2_JSON="$CASE_ROOT/js-sender-tell-2.json"
  SENDER_THREAD_FIRST_JSON="$CASE_ROOT/js-sender-thread-first.json"
  SENDER_THREAD_SECOND_JSON="$CASE_ROOT/js-sender-thread-second.json"

  log_info "Bootstrapping Rust receiver config"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "Cross Lang Rust Multi Receiver" \
      --description "Rust multi-device receiver for JS E2E harness" \
      --relay "$RELAY_URL" \
      --json >"$RECEIVER_SEED_LOG" 2>&1 &
  RECEIVER_SEED_PID=$!
  PROCESS_PIDS+=("$RECEIVER_SEED_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_SEED_LOG" "$RECEIVER_SEED_PID"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" stop >"$RECEIVER_STOP_LOG" 2>&1 || true
  wait_for_process_exit "$RECEIVER_SEED_PID" "rust receiver seed" "$RECEIVER_SEED_LOG"
  wait_for_path_absent "$CURRENT_RUST_SOCKET" "rust receiver socket"

  RUST_CONFIG="$CURRENT_RUST_HOME/config.json"
  RECEIVER_DID="$(json_get "$RUST_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$RUST_CONFIG" "e2e.currentDeviceId")"
  RECEIVER_SECONDARY_DEVICE_ID="device-rust-secondary"
  add_device_to_config "$RUST_CONFIG" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_ADD_DEVICE_JSON"

  log_info "Restarting Rust receiver with two published devices"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "Cross Lang Rust Multi Receiver" \
      --description "Rust multi-device receiver for JS E2E harness" \
      --relay "$RELAY_URL" \
      --json >"$RECEIVER_START_LOG" 2>&1 &
  RECEIVER_START_PID=$!
  PROCESS_PIDS+=("$RECEIVER_START_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_START_LOG" "$RECEIVER_START_PID"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" status --json >"$RECEIVER_STATUS_JSON"

  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$RECEIVER_READY_PRIMARY_JSON" 30000
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_READY_SECONDARY_JSON" 30000
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE="$(json_get "$RECEIVER_READY_SECONDARY_JSON" "device.signedPreKeyId")"

  log_info "Starting JS sender daemon"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" listen --background --relay "$RELAY_URL" >"$SENDER_LISTEN_LOG" 2>&1
  JS_SENDER_CONFIG="$CURRENT_JS_HOME/config.json"
  SENDER_DID="$(json_get "$JS_SENDER_CONFIG" "identity.did")"

  MESSAGE_PROTOCOL="cross/multi/1.0.0"
  THREAD_ID="cross-multi-js-to-rust-$(date +%s)"
  MESSAGE_TEXT_1="multi secret 1 js-to-rust $(date +%s)"
  MESSAGE_TEXT_2="multi secret 2 js-to-rust $(date +%s)"

  log_info "Sending first JS message to Rust multi-device receiver"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" tell "$RECEIVER_DID" "$MESSAGE_TEXT_1" \
      --protocol "$MESSAGE_PROTOCOL" \
      --thread "$THREAD_ID" \
      --relay "$RELAY_URL" \
      --format json >"$SENDER_TELL_1_JSON"

  if [[ "$(json_get "$SENDER_TELL_1_JSON" "usedDaemon")" != "true" ]]; then
    log_error "Expected JS sender to use daemon-backed send path"
    exit 1
  fi

  wait_for_rust_inbox_total "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$THREAD_ID" 1 "$RECEIVER_FIRST_INBOX_JSONL"
  RECEIVED_MESSAGE_ID_1="$(assert_jsonl_message "$RECEIVER_FIRST_INBOX_JSONL" "$SENDER_DID" "$MESSAGE_PROTOCOL" "$THREAD_ID" "$MESSAGE_TEXT_1")"
  if [[ "$(python3 - "$RECEIVER_FIRST_INBOX_JSONL" <<'PY'
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    print(sum(1 for line in handle if line.strip()))
PY
)" -ne 1 ]]; then
    log_error "Expected exactly one visible Rust inbox message after first multi-device send"
    cat "$RECEIVER_FIRST_INBOX_JSONL" >&2
    exit 1
  fi

  assert_jsonl_message_deliveries \
    "$RECEIVER_FIRST_INBOX_JSONL" "$RECEIVED_MESSAGE_ID_1" 2 received prekey \
    "$RECEIVER_DEVICE_ID" "$RECEIVER_SECONDARY_DEVICE_ID" >/dev/null

  wait_for_total_sessions "$RUST_CONFIG" 2 "Rust multi-device receiver"
  RECEIVER_TOTAL_SESSION_COUNT_1="$(count_total_sessions "$RUST_CONFIG")"
  wait_for_total_sessions "$JS_SENDER_CONFIG" 2 "JS multi-device sender"
  SENDER_TOTAL_SESSION_COUNT_1="$(count_total_sessions "$JS_SENDER_CONFIG")"

  log_info "Rotating Rust receiver secondary signed pre-key"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" stop >"$RECEIVER_STOP_ROTATE_LOG" 2>&1 || true
  wait_for_process_exit "$RECEIVER_START_PID" "rust receiver runtime" "$RECEIVER_START_LOG"
  wait_for_path_absent "$CURRENT_RUST_SOCKET" "rust receiver socket"
  rotate_prekey_in_config "$RUST_CONFIG" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_ROTATE_PREKEY_JSON"
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER="$(json_get "$RECEIVER_ROTATE_PREKEY_JSON" "signedPreKeyId")"
  if [[ "$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER" == "$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE" ]]; then
    log_error "Expected Rust secondary device signed pre-key ID to change after rotation"
    cat "$RECEIVER_ROTATE_PREKEY_JSON" >&2
    exit 1
  fi

  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "Cross Lang Rust Multi Receiver" \
      --description "Rust multi-device receiver for JS E2E harness" \
      --relay "$RELAY_URL" \
      --json >"$RECEIVER_ROTATED_START_LOG" 2>&1 &
  RECEIVER_ROTATED_PID=$!
  PROCESS_PIDS+=("$RECEIVER_ROTATED_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_ROTATED_START_LOG" "$RECEIVER_ROTATED_PID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_READY_SECONDARY_ROTATED_JSON" 30000
  if [[ "$(json_get "$RECEIVER_READY_SECONDARY_ROTATED_JSON" "device.signedPreKeyId")" != "$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER" ]]; then
    log_error "Relay-published Rust secondary signed pre-key ID did not match rotated config"
    cat "$RECEIVER_READY_SECONDARY_ROTATED_JSON" >&2
    exit 1
  fi
  wait_for_total_sessions "$RUST_CONFIG" 2 "Rust multi-device receiver after rotation"
  RECEIVER_TOTAL_SESSION_COUNT_ROTATED="$(count_total_sessions "$RUST_CONFIG")"

  log_info "Sending follow-up JS message to Rust multi-device receiver"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" tell "$RECEIVER_DID" "$MESSAGE_TEXT_2" \
      --protocol "$MESSAGE_PROTOCOL" \
      --thread "$THREAD_ID" \
      --relay "$RELAY_URL" \
      --format json >"$SENDER_TELL_2_JSON"

  wait_for_rust_inbox_total "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$THREAD_ID" 1 "$RECEIVER_SECOND_INBOX_JSONL"
  RECEIVED_MESSAGE_ID_2="$(assert_jsonl_message "$RECEIVER_SECOND_INBOX_JSONL" "$SENDER_DID" "$MESSAGE_PROTOCOL" "$THREAD_ID" "$MESSAGE_TEXT_2")"
  if [[ "$(python3 - "$RECEIVER_SECOND_INBOX_JSONL" <<'PY'
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    print(sum(1 for line in handle if line.strip()))
PY
)" -ne 1 ]]; then
    log_error "Expected exactly one visible Rust inbox message after rotated follow-up multi-device send"
    cat "$RECEIVER_SECOND_INBOX_JSONL" >&2
    exit 1
  fi

  assert_jsonl_message_deliveries \
    "$RECEIVER_SECOND_INBOX_JSONL" "$RECEIVED_MESSAGE_ID_2" 2 received session \
    "$RECEIVER_DEVICE_ID" "$RECEIVER_SECONDARY_DEVICE_ID" >/dev/null

  wait_for_total_sessions "$RUST_CONFIG" 2 "Rust multi-device receiver"
  RECEIVER_TOTAL_SESSION_COUNT_2="$(count_total_sessions "$RUST_CONFIG")"
  wait_for_total_sessions "$JS_SENDER_CONFIG" 2 "JS multi-device sender"
  SENDER_TOTAL_SESSION_COUNT_2="$(count_total_sessions "$JS_SENDER_CONFIG")"

  log_info "Scanning relay data and logs for forbidden plaintext"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    scan-plaintext "$RELAY_DATA" "$CASE_ROOT/queue-inspection.json" \
    "$MESSAGE_TEXT_1" "$MESSAGE_TEXT_2" "$MESSAGE_PROTOCOL" "$THREAD_ID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    scan-plaintext "$RELAY_LOG" "$CASE_ROOT/relay-log-inspection.json" \
    "$MESSAGE_TEXT_1" "$MESSAGE_TEXT_2" "$MESSAGE_PROTOCOL" "$THREAD_ID"

  SUMMARY_PATH="$CASE_ROOT/summary.json"
  SUMMARY_PATH="$SUMMARY_PATH" \
  RELAY_URL="$RELAY_URL" \
  RECEIVER_DID="$RECEIVER_DID" \
  RECEIVER_DEVICE_ID="$RECEIVER_DEVICE_ID" \
  RECEIVER_SECONDARY_DEVICE_ID="$RECEIVER_SECONDARY_DEVICE_ID" \
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE="$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE" \
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER="$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER" \
  SENDER_DID="$SENDER_DID" \
  THREAD_ID="$THREAD_ID" \
  MESSAGE_PROTOCOL="$MESSAGE_PROTOCOL" \
  MESSAGE_TEXT_1="$MESSAGE_TEXT_1" \
  MESSAGE_TEXT_2="$MESSAGE_TEXT_2" \
  RECEIVED_MESSAGE_ID_1="$RECEIVED_MESSAGE_ID_1" \
  RECEIVED_MESSAGE_ID_2="$RECEIVED_MESSAGE_ID_2" \
  RECEIVER_TOTAL_SESSION_COUNT_1="$RECEIVER_TOTAL_SESSION_COUNT_1" \
  RECEIVER_TOTAL_SESSION_COUNT_ROTATED="$RECEIVER_TOTAL_SESSION_COUNT_ROTATED" \
  RECEIVER_TOTAL_SESSION_COUNT_2="$RECEIVER_TOTAL_SESSION_COUNT_2" \
  SENDER_TOTAL_SESSION_COUNT_1="$SENDER_TOTAL_SESSION_COUNT_1" \
  SENDER_TOTAL_SESSION_COUNT_2="$SENDER_TOTAL_SESSION_COUNT_2" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

summary = {
    'status': 'passed',
    'caseId': 'E2E-MULTI-001',
    'relayUrl': os.environ['RELAY_URL'],
    'senderDid': os.environ['SENDER_DID'],
    'receiverDid': os.environ['RECEIVER_DID'],
    'receiverDeviceIds': [os.environ['RECEIVER_DEVICE_ID'], os.environ['RECEIVER_SECONDARY_DEVICE_ID']],
    'rotatedDeviceId': os.environ['RECEIVER_SECONDARY_DEVICE_ID'],
    'secondarySignedPreKeyIdBefore': int(os.environ['RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE']),
    'secondarySignedPreKeyIdAfter': int(os.environ['RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER']),
    'threadId': os.environ['THREAD_ID'],
    'messageProtocol': os.environ['MESSAGE_PROTOCOL'],
    'messageTexts': [os.environ['MESSAGE_TEXT_1'], os.environ['MESSAGE_TEXT_2']],
    'receivedMessageIds': [os.environ['RECEIVED_MESSAGE_ID_1'], os.environ['RECEIVED_MESSAGE_ID_2']],
    'senderTotalSessionCountAfterFirst': int(os.environ['SENDER_TOTAL_SESSION_COUNT_1']),
    'senderTotalSessionCountAfterSecond': int(os.environ['SENDER_TOTAL_SESSION_COUNT_2']),
    'receiverTotalSessionCountAfterFirst': int(os.environ['RECEIVER_TOTAL_SESSION_COUNT_1']),
    'receiverTotalSessionCountAfterRotation': int(os.environ['RECEIVER_TOTAL_SESSION_COUNT_ROTATED']),
    'receiverTotalSessionCountAfterSecond': int(os.environ['RECEIVER_TOTAL_SESSION_COUNT_2']),
    'assertions': {
        'publishedBothRecipientDevices': True,
        'firstContactFanOutCreatedTwoSessions': True,
        'firstBusinessMessageVisibleOnceBeforeRestart': True,
        'firstVisibleMessageRetainedTwoDeviceDeliveries': True,
        'receiverSecondaryPreKeyRotated': True,
        'publishedRotatedSecondaryPreKey': True,
        'receiverRetainedTwoPerDeviceSessionsAfterRotation': True,
        'senderRetainedTwoPerDeviceSessionsAfterRotation': True,
        'followUpContinuedPerDeviceSessions': True,
        'followUpVisibleOnceAfterRotatedRestart': True,
        'followUpAfterRotationUsedSessionTransport': True,
        'secondVisibleMessageRetainedTwoDeviceDeliveries': True,
        'relayQueueOpaqueForBusinessPlaintext': True,
        'relayLogOpaqueForBusinessPlaintext': True,
    },
}
Path(os.environ['SUMMARY_PATH']).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
PY

  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" stop >"$CASE_ROOT/js-sender-stop.log" 2>&1 || true
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" stop >"$CASE_ROOT/rust-receiver-stop-final.log" 2>&1 || true
  CURRENT_JS_HOME=""
  CURRENT_JS_SOCKET=""
  CURRENT_JS_PID_FILE=""
  CURRENT_RUST_HOME=""
  CURRENT_RUST_SOCKET=""

  log_success "E2E-MULTI-001 passed"
  RESULTS+=("E2E-MULTI-001")
fi

if [[ "$RUN_MULTI_RUST_TO_JS" == true ]]; then
  CASE_ID="E2E-MULTI-002"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_PORT="$(next_port)"
  RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"
  RELAY_DATA="$CASE_ROOT/relay-data"
  RELAY_LOG="$CASE_ROOT/relay.log"
  SOCKET_TAG="multi-rs-js-$(date +%s)-$$"

  CURRENT_JS_HOME="$CASE_ROOT/js-receiver-home"
  CURRENT_RUST_HOME="$CASE_ROOT/rust-sender-home"
  CURRENT_JS_SOCKET="/tmp/a4-multi-js-${SOCKET_TAG}.sock"
  CURRENT_JS_PID_FILE="/tmp/a4-multi-js-${SOCKET_TAG}.pid"
  CURRENT_RUST_SOCKET="/tmp/a4-multi-rs-${SOCKET_TAG}.sock"

  log_info "Starting local relay for Rust -> JS multi-device delivery"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY" \
      --port "$RELAY_PORT" \
      --landing-port false \
      --data-dir "$RELAY_DATA" \
      --public-endpoint "$RELAY_URL" \
      --no-federation
  ) >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
  PROCESS_PIDS+=("$RELAY_PID")
  wait_for_log_pattern "$RELAY_LOG" "Relay agent started" "relay" "$RELAY_PID"

  RECEIVER_SEED_LOG="$CASE_ROOT/js-receiver-seed.log"
  RECEIVER_STOP_LOG="$CASE_ROOT/js-receiver-stop.log"
  RECEIVER_ADD_DEVICE_JSON="$CASE_ROOT/js-receiver-add-device.json"
  RECEIVER_RESTART_LOG="$CASE_ROOT/js-receiver-restart.log"
  RECEIVER_READY_PRIMARY_JSON="$CASE_ROOT/js-receiver-card-primary.json"
  RECEIVER_READY_SECONDARY_JSON="$CASE_ROOT/js-receiver-card-secondary.json"
  RECEIVER_FIRST_INBOX_JSON="$CASE_ROOT/js-receiver-inbox-first.json"
  RECEIVER_SECOND_INBOX_JSON="$CASE_ROOT/js-receiver-inbox-second.json"
  RECEIVER_STOP_ROTATE_LOG="$CASE_ROOT/js-receiver-stop-rotate.log"
  RECEIVER_ROTATE_PREKEY_JSON="$CASE_ROOT/js-receiver-rotate-prekey.json"
  RECEIVER_ROTATED_RESTART_LOG="$CASE_ROOT/js-receiver-rotated-restart.log"
  RECEIVER_READY_SECONDARY_ROTATED_JSON="$CASE_ROOT/js-receiver-card-secondary-rotated.json"
  SENDER_START_LOG="$CASE_ROOT/rust-sender-start.log"
  SENDER_STATUS_JSON="$CASE_ROOT/rust-sender-status.json"
  SENDER_TELL_1_LOG="$CASE_ROOT/rust-sender-tell-1.log"
  SENDER_TELL_2_LOG="$CASE_ROOT/rust-sender-tell-2.log"

  log_info "Bootstrapping JS receiver config"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" listen --background --discoverable \
      --name "Cross Lang JS Multi Receiver" \
      --description "JS multi-device receiver for Rust E2E harness" \
      --relay "$RELAY_URL" >"$RECEIVER_SEED_LOG" 2>&1
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" stop >"$RECEIVER_STOP_LOG" 2>&1 || true
  wait_for_path_absent "$CURRENT_JS_SOCKET" "JS receiver socket"
  wait_for_path_absent "$CURRENT_JS_PID_FILE" "JS receiver pid file"

  JS_CONFIG="$CURRENT_JS_HOME/config.json"
  RECEIVER_DID="$(json_get "$JS_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$JS_CONFIG" "e2e.currentDeviceId")"
  RECEIVER_SECONDARY_DEVICE_ID="device-js-secondary"
  add_device_to_config "$JS_CONFIG" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_ADD_DEVICE_JSON"

  log_info "Restarting JS receiver with two published devices"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" listen --background --discoverable \
      --name "Cross Lang JS Multi Receiver" \
      --description "JS multi-device receiver for Rust E2E harness" \
      --relay "$RELAY_URL" >"$RECEIVER_RESTART_LOG" 2>&1

  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$RECEIVER_READY_PRIMARY_JSON" 30000
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_READY_SECONDARY_JSON" 30000
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE="$(json_get "$RECEIVER_READY_SECONDARY_JSON" "device.signedPreKeyId")"

  log_info "Starting Rust sender daemon"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "Cross Lang Rust Multi Sender" \
      --description "Rust multi-device sender for JS E2E harness" \
      --relay "$RELAY_URL" \
      --json >"$SENDER_START_LOG" 2>&1 &
  SENDER_START_PID=$!
  PROCESS_PIDS+=("$SENDER_START_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$SENDER_START_LOG" "$SENDER_START_PID"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" status --json >"$SENDER_STATUS_JSON"

  RUST_SENDER_CONFIG="$CURRENT_RUST_HOME/config.json"
  SENDER_DID="$(json_get "$RUST_SENDER_CONFIG" "identity.did")"

  MESSAGE_PROTOCOL="cross/multi/1.0.0"
  THREAD_ID="cross-multi-rust-to-js-$(date +%s)"
  MESSAGE_TEXT_1="multi secret 1 rust-to-js $(date +%s)"
  MESSAGE_TEXT_2="multi secret 2 rust-to-js $(date +%s)"

  log_info "Sending first Rust message to JS multi-device receiver"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" tell "$RECEIVER_DID" "$MESSAGE_TEXT_1" \
      --protocol "$MESSAGE_PROTOCOL" \
      --thread "$THREAD_ID" \
      --relay "$RELAY_URL" >"$SENDER_TELL_1_LOG" 2>&1

  wait_for_js_inbox_total "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$THREAD_ID" 1 "$RECEIVER_FIRST_INBOX_JSON"
  RECEIVED_MESSAGE_ID_1="$(assert_json_page_message "$RECEIVER_FIRST_INBOX_JSON" "$SENDER_DID" "$MESSAGE_PROTOCOL" "$THREAD_ID" "$MESSAGE_TEXT_1")"
  if [[ "$(json_page_total "$RECEIVER_FIRST_INBOX_JSON")" -ne 1 ]]; then
    log_error "Expected exactly one visible JS inbox message after first multi-device send"
    cat "$RECEIVER_FIRST_INBOX_JSON" >&2
    exit 1
  fi

  assert_json_page_message_deliveries \
    "$RECEIVER_FIRST_INBOX_JSON" "$RECEIVED_MESSAGE_ID_1" 2 received prekey \
    "$RECEIVER_DEVICE_ID" "$RECEIVER_SECONDARY_DEVICE_ID" >/dev/null

  wait_for_total_sessions "$JS_CONFIG" 2 "JS multi-device receiver"
  RECEIVER_TOTAL_SESSION_COUNT_1="$(count_total_sessions "$JS_CONFIG")"
  wait_for_total_sessions "$RUST_SENDER_CONFIG" 2 "Rust multi-device sender"
  SENDER_TOTAL_SESSION_COUNT_1="$(count_total_sessions "$RUST_SENDER_CONFIG")"

  log_info "Rotating JS receiver secondary signed pre-key"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" stop >"$RECEIVER_STOP_ROTATE_LOG" 2>&1 || true
  wait_for_path_absent "$CURRENT_JS_SOCKET" "JS receiver socket"
  wait_for_path_absent "$CURRENT_JS_PID_FILE" "JS receiver pid file"
  rotate_prekey_in_config "$JS_CONFIG" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_ROTATE_PREKEY_JSON"
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER="$(json_get "$RECEIVER_ROTATE_PREKEY_JSON" "signedPreKeyId")"
  if [[ "$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER" == "$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE" ]]; then
    log_error "Expected JS secondary device signed pre-key ID to change after rotation"
    cat "$RECEIVER_ROTATE_PREKEY_JSON" >&2
    exit 1
  fi

  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" listen --background --discoverable \
      --name "Cross Lang JS Multi Receiver" \
      --description "JS multi-device receiver for Rust E2E harness" \
      --relay "$RELAY_URL" >"$RECEIVER_ROTATED_RESTART_LOG" 2>&1
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_SECONDARY_DEVICE_ID" "$RECEIVER_READY_SECONDARY_ROTATED_JSON" 30000
  if [[ "$(json_get "$RECEIVER_READY_SECONDARY_ROTATED_JSON" "device.signedPreKeyId")" != "$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER" ]]; then
    log_error "Relay-published JS secondary signed pre-key ID did not match rotated config"
    cat "$RECEIVER_READY_SECONDARY_ROTATED_JSON" >&2
    exit 1
  fi
  wait_for_total_sessions "$JS_CONFIG" 2 "JS multi-device receiver after rotation"
  RECEIVER_TOTAL_SESSION_COUNT_ROTATED="$(count_total_sessions "$JS_CONFIG")"

  log_info "Sending follow-up Rust message to JS multi-device receiver"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" tell "$RECEIVER_DID" "$MESSAGE_TEXT_2" \
      --protocol "$MESSAGE_PROTOCOL" \
      --thread "$THREAD_ID" \
      --relay "$RELAY_URL" >"$SENDER_TELL_2_LOG" 2>&1

  wait_for_js_inbox_total "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$THREAD_ID" 2 "$RECEIVER_SECOND_INBOX_JSON"
  RECEIVED_MESSAGE_ID_2="$(assert_json_page_message "$RECEIVER_SECOND_INBOX_JSON" "$SENDER_DID" "$MESSAGE_PROTOCOL" "$THREAD_ID" "$MESSAGE_TEXT_2")"
  assert_json_page_message "$RECEIVER_SECOND_INBOX_JSON" "$SENDER_DID" "$MESSAGE_PROTOCOL" "$THREAD_ID" "$MESSAGE_TEXT_1" >/dev/null
  if [[ "$(json_page_total "$RECEIVER_SECOND_INBOX_JSON")" -ne 2 ]]; then
    log_error "Expected exactly two visible JS inbox messages after follow-up multi-device send"
    cat "$RECEIVER_SECOND_INBOX_JSON" >&2
    exit 1
  fi

  assert_json_page_message_deliveries \
    "$RECEIVER_SECOND_INBOX_JSON" "$RECEIVED_MESSAGE_ID_2" 2 received session \
    "$RECEIVER_DEVICE_ID" "$RECEIVER_SECONDARY_DEVICE_ID" >/dev/null

  wait_for_total_sessions "$JS_CONFIG" 2 "JS multi-device receiver"
  RECEIVER_TOTAL_SESSION_COUNT_2="$(count_total_sessions "$JS_CONFIG")"
  wait_for_total_sessions "$RUST_SENDER_CONFIG" 2 "Rust multi-device sender"
  SENDER_TOTAL_SESSION_COUNT_2="$(count_total_sessions "$RUST_SENDER_CONFIG")"

  log_info "Scanning relay data and logs for forbidden plaintext"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    scan-plaintext "$RELAY_DATA" "$CASE_ROOT/queue-inspection.json" \
    "$MESSAGE_TEXT_1" "$MESSAGE_TEXT_2" "$MESSAGE_PROTOCOL" "$THREAD_ID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    scan-plaintext "$RELAY_LOG" "$CASE_ROOT/relay-log-inspection.json" \
    "$MESSAGE_TEXT_1" "$MESSAGE_TEXT_2" "$MESSAGE_PROTOCOL" "$THREAD_ID"

  SUMMARY_PATH="$CASE_ROOT/summary.json"
  SUMMARY_PATH="$SUMMARY_PATH" \
  RELAY_URL="$RELAY_URL" \
  RECEIVER_DID="$RECEIVER_DID" \
  RECEIVER_DEVICE_ID="$RECEIVER_DEVICE_ID" \
  RECEIVER_SECONDARY_DEVICE_ID="$RECEIVER_SECONDARY_DEVICE_ID" \
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE="$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE" \
  RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER="$RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER" \
  SENDER_DID="$SENDER_DID" \
  THREAD_ID="$THREAD_ID" \
  MESSAGE_PROTOCOL="$MESSAGE_PROTOCOL" \
  MESSAGE_TEXT_1="$MESSAGE_TEXT_1" \
  MESSAGE_TEXT_2="$MESSAGE_TEXT_2" \
  RECEIVED_MESSAGE_ID_1="$RECEIVED_MESSAGE_ID_1" \
  RECEIVED_MESSAGE_ID_2="$RECEIVED_MESSAGE_ID_2" \
  RECEIVER_TOTAL_SESSION_COUNT_1="$RECEIVER_TOTAL_SESSION_COUNT_1" \
  RECEIVER_TOTAL_SESSION_COUNT_ROTATED="$RECEIVER_TOTAL_SESSION_COUNT_ROTATED" \
  RECEIVER_TOTAL_SESSION_COUNT_2="$RECEIVER_TOTAL_SESSION_COUNT_2" \
  SENDER_TOTAL_SESSION_COUNT_1="$SENDER_TOTAL_SESSION_COUNT_1" \
  SENDER_TOTAL_SESSION_COUNT_2="$SENDER_TOTAL_SESSION_COUNT_2" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

summary = {
    'status': 'passed',
    'caseId': 'E2E-MULTI-002',
    'relayUrl': os.environ['RELAY_URL'],
    'senderDid': os.environ['SENDER_DID'],
    'receiverDid': os.environ['RECEIVER_DID'],
    'receiverDeviceIds': [os.environ['RECEIVER_DEVICE_ID'], os.environ['RECEIVER_SECONDARY_DEVICE_ID']],
    'rotatedDeviceId': os.environ['RECEIVER_SECONDARY_DEVICE_ID'],
    'secondarySignedPreKeyIdBefore': int(os.environ['RECEIVER_SECONDARY_SIGNED_PREKEY_ID_BEFORE']),
    'secondarySignedPreKeyIdAfter': int(os.environ['RECEIVER_SECONDARY_SIGNED_PREKEY_ID_AFTER']),
    'threadId': os.environ['THREAD_ID'],
    'messageProtocol': os.environ['MESSAGE_PROTOCOL'],
    'messageTexts': [os.environ['MESSAGE_TEXT_1'], os.environ['MESSAGE_TEXT_2']],
    'receivedMessageIds': [os.environ['RECEIVED_MESSAGE_ID_1'], os.environ['RECEIVED_MESSAGE_ID_2']],
    'senderTotalSessionCountAfterFirst': int(os.environ['SENDER_TOTAL_SESSION_COUNT_1']),
    'senderTotalSessionCountAfterSecond': int(os.environ['SENDER_TOTAL_SESSION_COUNT_2']),
    'receiverTotalSessionCountAfterFirst': int(os.environ['RECEIVER_TOTAL_SESSION_COUNT_1']),
    'receiverTotalSessionCountAfterRotation': int(os.environ['RECEIVER_TOTAL_SESSION_COUNT_ROTATED']),
    'receiverTotalSessionCountAfterSecond': int(os.environ['RECEIVER_TOTAL_SESSION_COUNT_2']),
    'assertions': {
        'publishedBothRecipientDevices': True,
        'firstContactFanOutCreatedTwoSessions': True,
        'firstBusinessMessageVisibleOnce': True,
        'firstVisibleMessageRetainedTwoDeviceDeliveries': True,
        'receiverSecondaryPreKeyRotated': True,
        'publishedRotatedSecondaryPreKey': True,
        'receiverRetainedTwoPerDeviceSessionsAfterRotation': True,
        'senderRetainedTwoPerDeviceSessionsAfterRotation': True,
        'followUpContinuedPerDeviceSessions': True,
        'followUpAfterRotationUsedSessionTransport': True,
        'twoBusinessMessagesRemainVisibleAfterFollowUp': True,
        'secondVisibleMessageRetainedTwoDeviceDeliveries': True,
        'relayQueueOpaqueForBusinessPlaintext': True,
        'relayLogOpaqueForBusinessPlaintext': True,
    },
}
Path(os.environ['SUMMARY_PATH']).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
PY

  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" stop >"$CASE_ROOT/rust-sender-stop.log" 2>&1 || true
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" stop >"$CASE_ROOT/js-receiver-stop-final.log" 2>&1 || true
  CURRENT_JS_HOME=""
  CURRENT_JS_SOCKET=""
  CURRENT_JS_PID_FILE=""
  CURRENT_RUST_HOME=""
  CURRENT_RUST_SOCKET=""

  log_success "E2E-MULTI-002 passed"
  RESULTS+=("E2E-MULTI-002")
fi

if [[ "$RUN_FEDERATED_JS_TO_RUST" == true ]]; then
  CASE_ID="E2E-FED-001"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_A_PORT="$(next_port)"
  RELAY_B_PORT="$(next_port)"
  RELAY_A_URL="ws://127.0.0.1:${RELAY_A_PORT}"
  RELAY_B_URL="ws://127.0.0.1:${RELAY_B_PORT}"
  RELAY_A_DATA="$CASE_ROOT/relay-a-data"
  RELAY_B_DATA="$CASE_ROOT/relay-b-data"
  RELAY_A_LOG="$CASE_ROOT/relay-a.log"
  RELAY_B_LOG="$CASE_ROOT/relay-b.log"
  SOCKET_TAG="fed-$(date +%s)-$$"

  CURRENT_JS_HOME="$CASE_ROOT/js-sender-home"
  CURRENT_RUST_HOME="$CASE_ROOT/rust-receiver-home"
  CURRENT_JS_SOCKET="/tmp/a4-fed-js-${SOCKET_TAG}.sock"
  CURRENT_JS_PID_FILE="/tmp/a4-fed-js-${SOCKET_TAG}.pid"
  CURRENT_RUST_SOCKET="/tmp/a4-fed-rs-${SOCKET_TAG}.sock"

  log_info "Starting federated local relays for JS -> Rust delivery"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY"       --port "$RELAY_A_PORT"       --landing-port false       --data-dir "$RELAY_A_DATA"       --public-endpoint "$RELAY_A_URL"       --genesis-mode
  ) >"$RELAY_A_LOG" 2>&1 &
  RELAY_A_PID=$!
  PROCESS_PIDS+=("$RELAY_A_PID")
  wait_for_log_pattern "$RELAY_A_LOG" "Relay agent started" "relay-a" "$RELAY_A_PID"

  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY"       --port "$RELAY_B_PORT"       --landing-port false       --data-dir "$RELAY_B_DATA"       --public-endpoint "$RELAY_B_URL"       --seed-relay "$RELAY_A_URL"
  ) >"$RELAY_B_LOG" 2>&1 &
  RELAY_B_PID=$!
  PROCESS_PIDS+=("$RELAY_B_PID")
  wait_for_log_pattern "$RELAY_B_LOG" "Relay agent started" "relay-b" "$RELAY_B_PID"
  wait_for_log_pattern "$RELAY_A_LOG" "Received federation admitted" "relay-a admission" "$RELAY_A_PID"
  wait_for_log_pattern "$RELAY_B_LOG" "Received federation admitted" "relay-b admission" "$RELAY_B_PID"

  RECEIVER_START_LOG="$CASE_ROOT/rust-receiver-runtime-start.log"
  RECEIVER_READY_LOCAL_JSON="$CASE_ROOT/rust-receiver-card-local.json"
  RECEIVER_READY_FED_JSON="$CASE_ROOT/rust-receiver-card-federated.json"
  RECEIVER_STATUS_JSON="$CASE_ROOT/rust-receiver-status.json"
  RECEIVER_INBOX_JSONL="$CASE_ROOT/rust-receiver-inbox.jsonl"
  RECEIVER_STOP_LOG="$CASE_ROOT/rust-receiver-stop.log"
  SENDER_LISTEN_LOG="$CASE_ROOT/js-sender-listen.log"
  SENDER_TELL_JSON="$CASE_ROOT/js-sender-tell.json"
  SENDER_STOP_LOG="$CASE_ROOT/js-sender-stop.log"

  log_info "Starting Rust receiver on relay-b and publishing card/pre-keys"
  QUADRA_A_HOME="$CURRENT_RUST_HOME"   QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET"     "$RUST_A4_BINARY" listen --discoverable       --name "Federated Rust Receiver"       --description "Federated Rust receiver for JS E2E harness"       --relay "$RELAY_B_URL"       --json >"$RECEIVER_START_LOG" 2>&1 &
  RECEIVER_PID=$!
  PROCESS_PIDS+=("$RECEIVER_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_START_LOG" "$RECEIVER_PID"
  QUADRA_A_HOME="$CURRENT_RUST_HOME"   QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET"     "$RUST_A4_BINARY" status --json >"$RECEIVER_STATUS_JSON"

  RUST_CONFIG="$CURRENT_RUST_HOME/config.json"
  RECEIVER_DID="$(json_get "$RUST_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$RUST_CONFIG" "e2e.currentDeviceId")"

  log_info "Waiting for receiver card/device on home relay and federated relay"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs"     wait-card "$RELAY_B_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$RECEIVER_READY_LOCAL_JSON" 30000
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs"     wait-card "$RELAY_A_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$RECEIVER_READY_FED_JSON" 30000

  log_info "Starting JS sender daemon on relay-a"
  QUADRA_A_HOME="$CURRENT_JS_HOME"   QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET"   QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE"     "$JS_CLI" listen --background --relay "$RELAY_A_URL" >"$SENDER_LISTEN_LOG" 2>&1

  SENDER_DID="$(python3 - "$SENDER_LISTEN_LOG" <<'PY2'
import re
import sys
text = open(sys.argv[1], 'r', encoding='utf-8').read()
match = re.search(r'DID:\s*(did:[^\s]+)', text)
if not match:
    raise SystemExit('Could not find JS sender DID in listen output')
print(match.group(1))
PY2
)"

  MESSAGE_TEXT="federated secret js-to-rust $(date +%s)"
  MESSAGE_PROTOCOL="cross/federation/1.0.0"
  THREAD_ID="fed-js-to-rust-$(date +%s)"

  log_info "Sending encrypted message across federation from relay-a to relay-b"
  QUADRA_A_HOME="$CURRENT_JS_HOME"   QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET"   QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE"     "$JS_CLI" tell "$RECEIVER_DID" "$MESSAGE_TEXT"       --protocol "$MESSAGE_PROTOCOL"       --thread "$THREAD_ID"       --relay "$RELAY_A_URL"       --format json >"$SENDER_TELL_JSON"

  if [[ "$(json_get "$SENDER_TELL_JSON" "usedDaemon")" != "true" ]]; then
    log_error "Expected JS sender to use daemon-backed federated send path"
    exit 1
  fi

  if ! grep -Eq "Routed message to (known relay|federation via relay)" "$RELAY_A_LOG"; then
    log_error "Relay-a log does not show federated routing"
    cat "$RELAY_A_LOG" >&2
    exit 1
  fi

  log_info "Scanning federated relay data and logs for forbidden plaintext"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs"     scan-plaintext "$RELAY_A_DATA" "$CASE_ROOT/relay-a-data-inspection.json"     "$MESSAGE_TEXT" "$MESSAGE_PROTOCOL" "$THREAD_ID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs"     scan-plaintext "$RELAY_B_DATA" "$CASE_ROOT/relay-b-data-inspection.json"     "$MESSAGE_TEXT" "$MESSAGE_PROTOCOL" "$THREAD_ID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs"     scan-plaintext "$RELAY_A_LOG" "$CASE_ROOT/relay-a-log-inspection.json"     "$MESSAGE_TEXT" "$MESSAGE_PROTOCOL" "$THREAD_ID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs"     scan-plaintext "$RELAY_B_LOG" "$CASE_ROOT/relay-b-log-inspection.json"     "$MESSAGE_TEXT" "$MESSAGE_PROTOCOL" "$THREAD_ID"

  QUADRA_A_HOME="$CURRENT_RUST_HOME"   QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET"     "$RUST_A4_BINARY" inbox --thread "$THREAD_ID" --wait 20 --json >"$RECEIVER_INBOX_JSONL"

  RECEIVED_MESSAGE_ID="$(assert_jsonl_message "$RECEIVER_INBOX_JSONL" "$SENDER_DID" "$MESSAGE_PROTOCOL" "$THREAD_ID" "$MESSAGE_TEXT")"
  RECEIVER_SESSION_COUNT="$(count_rust_sessions "$RUST_CONFIG")"
  if [[ "$RECEIVER_SESSION_COUNT" -lt 1 ]]; then
    log_error "Expected Rust receiver to persist at least one ratchet session after federated delivery"
    exit 1
  fi

  SUMMARY_PATH="$CASE_ROOT/summary.json"
  SUMMARY_PATH="$SUMMARY_PATH"   RELAY_A_URL="$RELAY_A_URL"   RELAY_B_URL="$RELAY_B_URL"   RECEIVER_DID="$RECEIVER_DID"   RECEIVER_DEVICE_ID="$RECEIVER_DEVICE_ID"   SENDER_DID="$SENDER_DID"   THREAD_ID="$THREAD_ID"   MESSAGE_PROTOCOL="$MESSAGE_PROTOCOL"   MESSAGE_TEXT="$MESSAGE_TEXT"   RECEIVED_MESSAGE_ID="$RECEIVED_MESSAGE_ID"   RECEIVER_SESSION_COUNT="$RECEIVER_SESSION_COUNT"   python3 - <<'PY2'
import json
import os
from pathlib import Path
summary = {
    'status': 'passed',
    'caseId': 'E2E-FED-001',
    'relayAUrl': os.environ['RELAY_A_URL'],
    'relayBUrl': os.environ['RELAY_B_URL'],
    'senderDid': os.environ['SENDER_DID'],
    'receiverDid': os.environ['RECEIVER_DID'],
    'receiverDeviceId': os.environ['RECEIVER_DEVICE_ID'],
    'threadId': os.environ['THREAD_ID'],
    'messageProtocol': os.environ['MESSAGE_PROTOCOL'],
    'messageText': os.environ['MESSAGE_TEXT'],
    'receivedMessageId': os.environ['RECEIVED_MESSAGE_ID'],
    'receiverSessionCount': int(os.environ['RECEIVER_SESSION_COUNT']),
    'assertions': {
        'federatedCardVisibleOnSenderRelay': True,
        'relayAObservedFederatedRouting': True,
        'relayALogOpaqueForBusinessPlaintext': True,
        'relayBLogOpaqueForBusinessPlaintext': True,
        'relayADataOpaqueForBusinessPlaintext': True,
        'relayBDataOpaqueForBusinessPlaintext': True,
        'receiverDecryptedFederatedMessage': True,
        'receiverPersistedRatchetSession': True,
    },
}
Path(os.environ['SUMMARY_PATH']).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
PY2

  QUADRA_A_HOME="$CURRENT_JS_HOME"   QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET"   QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE"     "$JS_CLI" stop >"$SENDER_STOP_LOG" 2>&1 || true
  QUADRA_A_HOME="$CURRENT_RUST_HOME"   QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET"     "$RUST_A4_BINARY" stop >"$RECEIVER_STOP_LOG" 2>&1 || true
  CURRENT_JS_HOME=""
  CURRENT_JS_SOCKET=""
  CURRENT_JS_PID_FILE=""
  CURRENT_RUST_HOME=""
  CURRENT_RUST_SOCKET=""

  log_success "E2E-FED-001 passed"
  RESULTS+=("E2E-FED-001")
fi

if [[ "$RUN_OFFLINE_JS_TO_RUST" == true ]]; then
  CASE_ID="E2E-CROSS-005"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_PORT="$(next_port)"
  RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"
  RELAY_DATA="$CASE_ROOT/relay-data"
  RELAY_LOG="$CASE_ROOT/relay.log"
  SOCKET_TAG="$(date +%s)-$$"

  CURRENT_JS_HOME="$CASE_ROOT/js-sender-home"
  CURRENT_RUST_HOME="$CASE_ROOT/rust-receiver-home"
  CURRENT_JS_SOCKET="/tmp/a4-cross-js-${SOCKET_TAG}.sock"
  CURRENT_JS_PID_FILE="/tmp/a4-cross-js-${SOCKET_TAG}.pid"
  CURRENT_RUST_SOCKET="/tmp/a4-cross-rs-${SOCKET_TAG}.sock"

  log_info "Starting local relay for offline JS -> Rust delivery"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY" \
      --port "$RELAY_PORT" \
      --landing-port false \
      --data-dir "$RELAY_DATA" \
      --public-endpoint "$RELAY_URL" \
      --no-federation
  ) >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
  PROCESS_PIDS+=("$RELAY_PID")
  wait_for_log_pattern "$RELAY_LOG" "Relay agent started" "relay" "$RELAY_PID"

  RECEIVER_START_LOG="$CASE_ROOT/rust-receiver-runtime-start.log"
  RECEIVER_START_STATUS_JSON="$CASE_ROOT/rust-receiver-status-start.json"
  RECEIVER_READY_JSON="$CASE_ROOT/rust-receiver-card-ready.json"
  RECEIVER_STOP_LOG="$CASE_ROOT/rust-receiver-stop.log"
  RECEIVER_RESTART_LOG="$CASE_ROOT/rust-receiver-runtime-restart.log"
  RECEIVER_RESTART_STATUS_JSON="$CASE_ROOT/rust-receiver-status-restart.json"
  RECEIVER_INBOX_JSONL="$CASE_ROOT/rust-receiver-inbox.jsonl"

  log_info "Starting Rust receiver and publishing card/pre-keys"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "Cross Lang Rust Receiver" \
      --description "Offline Rust receiver for JS E2E harness" \
      --relay "$RELAY_URL" \
      --json >"$RECEIVER_START_LOG" 2>&1 &
  RECEIVER_START_PID=$!
  PROCESS_PIDS+=("$RECEIVER_START_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_START_LOG" "$RECEIVER_START_PID"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" status --json >"$RECEIVER_START_STATUS_JSON"

  RUST_CONFIG="$CURRENT_RUST_HOME/config.json"
  RECEIVER_DID="$(json_get "$RUST_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$RUST_CONFIG" "e2e.currentDeviceId")"

  log_info "Waiting for receiver card/device publication on relay"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$RECEIVER_READY_JSON" 30000

  log_info "Stopping Rust receiver to force offline queue delivery"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" stop >"$RECEIVER_STOP_LOG" 2>&1 || true
  wait_for_process_exit "$RECEIVER_START_PID" "offline rust receiver" "$RECEIVER_START_LOG"
  wait_for_path_absent "$CURRENT_RUST_SOCKET" "offline rust receiver socket"

  SENDER_LISTEN_LOG="$CASE_ROOT/js-sender-listen.log"
  SENDER_TELL_JSON="$CASE_ROOT/js-sender-tell.json"

  log_info "Starting JS sender daemon"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" listen --background --relay "$RELAY_URL" >"$SENDER_LISTEN_LOG" 2>&1

  SENDER_DID="$(python3 - "$SENDER_LISTEN_LOG" <<'PY'
import re
import sys

text = open(sys.argv[1], 'r', encoding='utf-8').read()
match = re.search(r'DID:\s*(did:[^\s]+)', text)
if not match:
    raise SystemExit('Could not find JS sender DID in listen output')
print(match.group(1))
PY
)"

  MESSAGE_TEXT="offline secret js-to-rust $(date +%s)"
  MESSAGE_PROTOCOL="cross/offline/1.0.0"
  THREAD_ID="cross-offline-js-to-rust-$(date +%s)"

  log_info "Sending first encrypted message while receiver is offline"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" tell "$RECEIVER_DID" "$MESSAGE_TEXT" \
      --protocol "$MESSAGE_PROTOCOL" \
      --thread "$THREAD_ID" \
      --relay "$RELAY_URL" \
      --format json >"$SENDER_TELL_JSON"

  if [[ "$(json_get "$SENDER_TELL_JSON" "usedDaemon")" != "true" ]]; then
    log_error "Expected JS sender to use daemon-backed send path"
    exit 1
  fi

  if ! grep -q "Message queued for offline agent $RECEIVER_DID" "$RELAY_LOG"; then
    log_error "Relay log does not show queued offline delivery for $RECEIVER_DID"
    cat "$RELAY_LOG" >&2
    exit 1
  fi

  log_info "Scanning relay data and logs for forbidden plaintext"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    scan-plaintext "$RELAY_DATA" "$CASE_ROOT/queue-inspection.json" \
    "$MESSAGE_TEXT" "$MESSAGE_PROTOCOL" "$THREAD_ID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    scan-plaintext "$RELAY_LOG" "$CASE_ROOT/relay-log-inspection.json" \
    "$MESSAGE_TEXT" "$MESSAGE_PROTOCOL" "$THREAD_ID"

  log_info "Restarting Rust receiver and waiting for decrypted delivery"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "Cross Lang Rust Receiver" \
      --description "Offline Rust receiver for JS E2E harness" \
      --relay "$RELAY_URL" \
      --json >"$RECEIVER_RESTART_LOG" 2>&1 &
  RECEIVER_RESTART_PID=$!
  PROCESS_PIDS+=("$RECEIVER_RESTART_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_RESTART_LOG" "$RECEIVER_RESTART_PID"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" status --json >"$RECEIVER_RESTART_STATUS_JSON"

  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" inbox --thread "$THREAD_ID" --wait 20 --json >"$RECEIVER_INBOX_JSONL"

  RECEIVED_MESSAGE_ID="$(assert_jsonl_message "$RECEIVER_INBOX_JSONL" "$SENDER_DID" "$MESSAGE_PROTOCOL" "$THREAD_ID" "$MESSAGE_TEXT")"
  RECEIVER_SESSION_COUNT="$(count_rust_sessions "$RUST_CONFIG")"
  if [[ "$RECEIVER_SESSION_COUNT" -lt 1 ]]; then
    log_error "Expected Rust receiver to persist at least one ratchet session"
    exit 1
  fi

  SUMMARY_PATH="$CASE_ROOT/summary.json"
  SUMMARY_PATH="$SUMMARY_PATH" \
  RELAY_URL="$RELAY_URL" \
  RECEIVER_DID="$RECEIVER_DID" \
  RECEIVER_DEVICE_ID="$RECEIVER_DEVICE_ID" \
  SENDER_DID="$SENDER_DID" \
  THREAD_ID="$THREAD_ID" \
  MESSAGE_PROTOCOL="$MESSAGE_PROTOCOL" \
  MESSAGE_TEXT="$MESSAGE_TEXT" \
  RECEIVED_MESSAGE_ID="$RECEIVED_MESSAGE_ID" \
  RECEIVER_SESSION_COUNT="$RECEIVER_SESSION_COUNT" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

summary = {
    'status': 'passed',
    'caseId': 'E2E-CROSS-005',
    'relayUrl': os.environ['RELAY_URL'],
    'senderDid': os.environ['SENDER_DID'],
    'receiverDid': os.environ['RECEIVER_DID'],
    'receiverDeviceId': os.environ['RECEIVER_DEVICE_ID'],
    'threadId': os.environ['THREAD_ID'],
    'messageProtocol': os.environ['MESSAGE_PROTOCOL'],
    'messageText': os.environ['MESSAGE_TEXT'],
    'receivedMessageId': os.environ['RECEIVED_MESSAGE_ID'],
    'receiverSessionCount': int(os.environ['RECEIVER_SESSION_COUNT']),
    'assertions': {
        'queuedOfflineOnRelay': True,
        'relayQueueOpaqueForBusinessPlaintext': True,
        'relayLogOpaqueForBusinessPlaintext': True,
        'receiverDecryptedOfflineMessage': True,
        'receiverPersistedRatchetSession': True,
    },
}
Path(os.environ['SUMMARY_PATH']).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
PY

  log_success "E2E-CROSS-005 passed"
  RESULTS+=("E2E-CROSS-005")
fi

SUMMARY_PATH="$ARTIFACT_ROOT/summary.json"
RESULTS_TEXT="$(printf '%s\n' "${RESULTS[@]}")"
SUMMARY_PATH="$SUMMARY_PATH" RESULTS_TEXT="$RESULTS_TEXT" python3 - <<'PY'
import json
import os
from pathlib import Path

case_ids = [line for line in os.environ.get('RESULTS_TEXT', '').splitlines() if line]
summary = {
    'status': 'passed',
    'cases': len(case_ids),
    'caseIds': case_ids,
}
Path(os.environ['SUMMARY_PATH']).write_text(json.dumps(summary, indent=2) + '\n')
PY

log_success "Cross-language harness passed (${RESULTS[*]})"
log_info "Artifacts written to $ARTIFACT_ROOT"
