#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$SCRIPT_DIR/../test-config.sh"

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

RUN_NEG_001=true
RUN_NEG_002=true
RUN_NEG_003=true
RUN_NEG_004=true
RUN_NEG_005=true
RUN_NEG_006=true
RUN_NEG_007=true
RUN_NEG_008=true
ARTIFACT_ROOT="${A4_ROOT}/test-output/e2e/negative/$(date +%Y%m%d-%H%M%S)"

JS_CLI="$A4_ROOT/js/cli/a4"
JS_DAEMON_ENTRY="$A4_ROOT/js/core/runtime/dist/daemon-entry.js"
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
Usage: $(basename "$0") [--neg-001-only | --neg-002-only | --neg-003-only | --neg-004-only | --neg-005-only | --neg-006-only | --neg-007-only | --neg-008-only | --artifact-dir <path>]

Runs relay-backed negative E2E security harnesses.
Currently covers:
  - E2E-NEG-001: forged sender device identity keys are rejected before PREKEY_MESSAGE session bootstrap
  - E2E-NEG-002: invalid signed pre-key signatures are rejected on the sender before relay handoff
  - E2E-NEG-003: replay of a consumed PREKEY_MESSAGE is rejected with no second session
  - E2E-NEG-004: replay of a delivered SESSION_MESSAGE does not create a duplicate visible message
  - E2E-NEG-005: tampered SESSION_MESSAGE ciphertext is rejected before inbox delivery
  - E2E-NEG-006: tampered SESSION_MESSAGE ratchet headers are rejected before inbox delivery
  - E2E-NEG-007: legacy plaintext application messages are rejected before inbox delivery
  - E2E-NEG-008: PREKEY_MESSAGEs for rotated-out signed pre-keys fail with a stable rejection surface
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
  local pid="${4:-}"

  for _ in $(seq 1 120); do
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
      log_error "rust daemon exited before readiness"
      [[ -f "$log_file" ]] && cat "$log_file" >&2
      return 1
    fi

    sleep 0.25
  done

  log_error "Timed out waiting for rust daemon readiness"
  [[ -f "$log_file" ]] && cat "$log_file" >&2
  return 1
}

wait_for_js_daemon() {
  local home="$1"
  local socket_path="$2"
  local pid_file="$3"
  local log_file="$4"
  local pid="$5"

  for _ in $(seq 1 80); do
    local status_json=""
    if status_json="$(QUADRA_A_HOME="$home" QUADRA_A_SOCKET_PATH="$socket_path" QUADRA_A_PID_FILE="$pid_file" \
      "$JS_CLI" status --format json 2>/dev/null)"; then
      if [[ "$status_json" != *'"daemon": null'* ]]; then
        return 0
      fi
    fi

    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      log_error "js daemon exited before readiness"
      [[ -f "$log_file" ]] && cat "$log_file" >&2
      return 1
    fi

    sleep 0.25
  done

  log_error "Timed out waiting for js daemon readiness"
  [[ -f "$log_file" ]] && cat "$log_file" >&2
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
        value = value.get(part)
print(json.dumps(value) if isinstance(value, (dict, list, bool)) else value)
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

rust_jsonl_total() {
  local path="$1"
  python3 - "$path" <<'PY'
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    print(sum(1 for line in handle if line.strip()))
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
      total="$(rust_jsonl_total "$output_path")"
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

assert_js_inbox_total_equals() {
  local home="$1"
  local socket_path="$2"
  local pid_file="$3"
  local thread_id="$4"
  local expected_total="$5"
  local output_path="$6"

  QUADRA_A_HOME="$home" \
  QUADRA_A_SOCKET_PATH="$socket_path" \
  QUADRA_A_PID_FILE="$pid_file" \
    "$JS_CLI" inbox --thread "$thread_id" --format json >"$output_path"

  local total
  total="$(json_page_total "$output_path")"
  if [[ "$total" -ne "$expected_total" ]]; then
    log_error "Expected JS inbox thread $thread_id total $expected_total, got $total"
    cat "$output_path" >&2
    return 1
  fi
}

assert_rust_inbox_total_equals() {
  local home="$1"
  local socket_path="$2"
  local thread_id="$3"
  local expected_total="$4"
  local output_path="$5"

  QUADRA_A_HOME="$home" \
  QUADRA_A_RS_SOCKET_PATH="$socket_path" \
    "$RUST_A4_BINARY" inbox --thread "$thread_id" --json >"$output_path"

  local total
  total="$(rust_jsonl_total "$output_path")"
  if [[ "$total" -ne "$expected_total" ]]; then
    log_error "Expected Rust inbox thread $thread_id total $expected_total, got $total"
    cat "$output_path" >&2
    return 1
  fi
}

bootstrap_js_config() {
  local home="$1"
  local socket_path="$2"
  local pid_file="$3"
  local relay_url="$4"
  local discoverable="$5"
  local name="$6"
  local description="$7"
  local listen_log="$8"
  local stop_log="$9"

  if [[ "$discoverable" == "true" ]]; then
    QUADRA_A_HOME="$home" \
    QUADRA_A_SOCKET_PATH="$socket_path" \
    QUADRA_A_PID_FILE="$pid_file" \
      "$JS_CLI" listen --background --discoverable \
        --name "$name" \
        --description "$description" \
        --relay "$relay_url" >"$listen_log" 2>&1
  else
    QUADRA_A_HOME="$home" \
    QUADRA_A_SOCKET_PATH="$socket_path" \
    QUADRA_A_PID_FILE="$pid_file" \
      "$JS_CLI" listen --background --relay "$relay_url" >"$listen_log" 2>&1
  fi

  for _ in $(seq 1 80); do
    if [[ -f "$home/config.json" ]]; then
      break
    fi
    sleep 0.25
  done

  QUADRA_A_HOME="$home" \
  QUADRA_A_SOCKET_PATH="$socket_path" \
  QUADRA_A_PID_FILE="$pid_file" \
    "$JS_CLI" stop >"$stop_log" 2>&1 || true
  wait_for_path_absent "$socket_path" "js bootstrap socket"
}

write_summary() {
  local output_path="$1"
  shift
  python3 - "$output_path" "$@" <<'PY'
import json
import sys

output_path = sys.argv[1]
keys = sys.argv[2::2]
values = sys.argv[3::2]
summary = dict(zip(keys, values))
with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump(summary, handle, indent=2)
    handle.write('\n')
PY
}

bootstrap_rust_config() {
  local home="$1"
  local socket_path="$2"
  local relay_url="$3"
  local discoverable="$4"
  local name="$5"
  local description="$6"
  local listen_log="$7"
  local stop_log="$8"

  if [[ "$discoverable" == "true" ]]; then
    QUADRA_A_HOME="$home" \
    QUADRA_A_RS_SOCKET_PATH="$socket_path" \
      "$RUST_A4_BINARY" listen --discoverable \
        --name "$name" \
        --description "$description" \
        --relay "$relay_url" \
        --json >"$listen_log" 2>&1 &
  else
    QUADRA_A_HOME="$home" \
    QUADRA_A_RS_SOCKET_PATH="$socket_path" \
      "$RUST_A4_BINARY" listen \
        --relay "$relay_url" \
        --json >"$listen_log" 2>&1 &
  fi

  local seed_pid=$!
  PROCESS_PIDS+=("$seed_pid")
  wait_for_rust_daemon "$home" "$socket_path" "$listen_log" "$seed_pid"
  QUADRA_A_HOME="$home" QUADRA_A_RS_SOCKET_PATH="$socket_path" \
    "$RUST_A4_BINARY" stop >"$stop_log" 2>&1 || true
  wait_for_process_exit "$seed_pid" "rust bootstrap" "$listen_log"
  wait_for_path_absent "$socket_path" "rust bootstrap socket"
}

mutate_signed_prekey_signature() {
  local config_path="$1"
  local device_id="$2"
  local signature_hex="$3"
  local artifact_path="$4"

  python3 - "$config_path" "$device_id" "$signature_hex" "$artifact_path" <<'PY'
import json
import sys
from pathlib import Path

config_path, device_id, signature_hex, artifact_path = sys.argv[1:5]
with open(config_path, 'r', encoding='utf-8') as handle:
    data = json.load(handle)

e2e = data.get('e2e') or {}
devices = e2e.get('devices') or {}
device = devices.get(device_id)
if not isinstance(device, dict):
    raise SystemExit(f'Config {config_path} missing device {device_id}')

signed_pre_key = device.get('signedPreKey')
if not isinstance(signed_pre_key, dict):
    raise SystemExit(f'Config {config_path} device {device_id} missing signedPreKey')

previous_signature = signed_pre_key.get('signature')
signed_pre_key['signature'] = signature_hex

with open(config_path, 'w', encoding='utf-8') as handle:
    json.dump(data, handle, indent=2)
    handle.write('\n')

artifact = {
    'status': 'updated',
    'configPath': config_path,
    'deviceId': device_id,
    'previousSignature': previous_signature,
    'signature': signature_hex,
}
Path(artifact_path).parent.mkdir(parents=True, exist_ok=True)
with open(artifact_path, 'w', encoding='utf-8') as handle:
    json.dump(artifact, handle, indent=2)
    handle.write('\n')
PY
}

run_session_message_negative_case() {
  local case_id="$1"
  local receiver_impl="$2"
  local mode="$3"
  local case_root="$ARTIFACT_ROOT/$case_id"
  mkdir -p "$case_root"

  local relay_port
  relay_port="$(next_port)"
  local relay_url="ws://127.0.0.1:${relay_port}"
  local relay_data="$case_root/relay-data"
  local relay_log="$case_root/relay.log"

  log_info "[$case_id] Starting relay"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY" \
      --port "$relay_port" \
      --landing-port false \
      --data-dir "$relay_data" \
      --public-endpoint "$relay_url" \
      --no-federation
  ) >"$relay_log" 2>&1 &
  local relay_pid=$!
  PROCESS_PIDS+=("$relay_pid")
  wait_for_log_pattern "$relay_log" "Relay agent started" "$case_id relay" "$relay_pid"

  local protocol_id
  local expected_inbox_total
  local mutation=""
  case "$mode" in
    session-replay)
      protocol_id="cross/negative/session-replay/1.0.0"
      expected_inbox_total=2
      ;;
    session-ciphertext)
      protocol_id="cross/negative/session-ciphertext/1.0.0"
      expected_inbox_total=1
      mutation="session-ciphertext"
      ;;
    session-header)
      protocol_id="cross/negative/session-header/1.0.0"
      expected_inbox_total=1
      mutation="session-header"
      ;;
    *)
      log_error "Unsupported session negative mode: $mode"
      exit 1
      ;;
  esac

  local receiver_log
  local receiver_config
  local receiver_did
  local receiver_device_id
  local receiver_pid
  local sender_config
  local thread_id="$(printf "%s" "$case_id" | tr "[:upper:]" "[:lower:]")-$(date +%s)"
  local first_json="$case_root/first-send.json"
  local second_json="$case_root/second-send.json"
  local prepared_json="$case_root/prepared.json"
  local tampered_json="$case_root/tampered.json"
  local raw_json="$case_root/raw-send.json"
  local inbox_before
  local inbox_after

  if [[ "$receiver_impl" == "rust" ]]; then
    CURRENT_RUST_HOME="$case_root/rust-receiver-home"
    CURRENT_RUST_SOCKET="/tmp/a4-neg-session-rust-receiver-$$.sock"
    receiver_log="$case_root/rust-receiver.log"
    receiver_config="$CURRENT_RUST_HOME/config.json"

    log_info "[$case_id] Starting Rust receiver daemon"
    QUADRA_A_HOME="$CURRENT_RUST_HOME" \
    QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" listen --discoverable \
        --name "$case_id Rust Receiver" \
        --description "Rust receiver for $mode negative harness" \
        --relay "$relay_url" \
        --json >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$receiver_log" "$receiver_pid"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card.json" 30000

    local js_sender_home="$case_root/js-sender-home"
    local js_sender_socket="/tmp/a4-neg-session-js-sender-$$.sock"
    local js_sender_pid_file="/tmp/a4-neg-session-js-sender-$$.pid"
    bootstrap_js_config "$js_sender_home" "$js_sender_socket" "$js_sender_pid_file" "$relay_url" false "" "" \
      "$case_root/js-sender-bootstrap.log" "$case_root/js-sender-stop.log"
    sender_config="$js_sender_home/config.json"
    inbox_before="$case_root/rust-receiver-inbox-before.jsonl"
    inbox_after="$case_root/rust-receiver-inbox-after.jsonl"
  else
    CURRENT_JS_HOME="$case_root/js-receiver-home"
    CURRENT_JS_SOCKET="/tmp/a4-neg-session-js-receiver-$$.sock"
    CURRENT_JS_PID_FILE="/tmp/a4-neg-session-js-receiver-$$.pid"
    bootstrap_js_config "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$relay_url" true \
      "$case_id JS Receiver" "JS receiver for $mode negative harness" \
      "$case_root/js-receiver-bootstrap.log" "$case_root/js-receiver-bootstrap-stop.log"
    receiver_config="$CURRENT_JS_HOME/config.json"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"
    receiver_log="$case_root/js-receiver.log"

    log_info "[$case_id] Starting JS receiver daemon in foreground"
    QUADRA_A_HOME="$CURRENT_JS_HOME" \
    QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
    QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      node "$JS_DAEMON_ENTRY" >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_js_daemon "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$receiver_log" "$receiver_pid"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card.json" 30000

    local rust_sender_home="$case_root/rust-sender-home"
    local rust_sender_socket="/tmp/a4-neg-session-rust-sender-$$.sock"
    bootstrap_rust_config "$rust_sender_home" "$rust_sender_socket" "$relay_url" false "" "" \
      "$case_root/rust-sender-bootstrap.log" "$case_root/rust-sender-stop.log"
    sender_config="$rust_sender_home/config.json"
    inbox_before="$case_root/js-receiver-inbox-before.json"
    inbox_after="$case_root/js-receiver-inbox-after.json"
  fi

  log_info "[$case_id] Sending first encrypted PREKEY_MESSAGE"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-encrypted "$sender_config" "$relay_url" "$receiver_did" \
    "$protocol_id" '{"text":"bootstrap session negative probe"}' "$first_json" "$thread_id"

  if [[ "$receiver_impl" == "rust" ]]; then
    wait_for_rust_inbox_total "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$thread_id" 1 "$inbox_before"
  else
    wait_for_js_inbox_total "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$thread_id" 1 "$inbox_before"
  fi

  if [[ "$(count_total_sessions "$receiver_config")" -ne 1 ]]; then
    log_error "[$case_id] Expected exactly one receiver session after bootstrap delivery"
    exit 1
  fi

  if [[ "$mode" == "session-replay" ]]; then
    log_info "[$case_id] Sending second encrypted SESSION_MESSAGE"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      send-encrypted "$sender_config" "$relay_url" "$receiver_did" \
      "$protocol_id" '{"text":"session replay target"}' "$second_json" "$thread_id"

    if [[ "$receiver_impl" == "rust" ]]; then
      wait_for_rust_inbox_total "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$thread_id" 2 "$inbox_after"
    else
      wait_for_js_inbox_total "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$thread_id" 2 "$inbox_after"
    fi

    if [[ "$(count_total_sessions "$receiver_config")" -ne 1 ]]; then
      log_error "[$case_id] Expected exactly one receiver session before SESSION replay"
      exit 1
    fi

    log_info "[$case_id] Replaying the delivered SESSION_MESSAGE"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      send-raw-envelope "$sender_config" "$relay_url" "$second_json" "$raw_json"
  else
    log_info "[$case_id] Preparing a second encrypted SESSION_MESSAGE for tampering"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      prepare-encrypted "$sender_config" "$relay_url" "$receiver_did" \
      "$protocol_id" '{"text":"tampered session should be rejected"}' "$prepared_json" "$thread_id"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      tamper-envelope "$sender_config" "$prepared_json" "$mutation" "$tampered_json"
    log_info "[$case_id] Sending tampered SESSION_MESSAGE"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      send-raw-envelope "$sender_config" "$relay_url" "$tampered_json" "$raw_json"
  fi

  wait_for_log_pattern "$receiver_log" "Failed to decrypt with XChaCha20-Poly1305" "$case_id receiver" "$receiver_pid"

  local inbox_total
  if [[ "$receiver_impl" == "rust" ]]; then
    assert_rust_inbox_total_equals "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$thread_id" "$expected_inbox_total" "$inbox_after"
    inbox_total="$(rust_jsonl_total "$inbox_after")"
  else
    assert_js_inbox_total_equals "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$thread_id" "$expected_inbox_total" "$inbox_after"
    inbox_total="$(json_page_total "$inbox_after")"
  fi

  if [[ "$(count_total_sessions "$receiver_config")" -ne 1 ]]; then
    log_error "[$case_id] Session-message negative case changed receiver session count unexpectedly"
    exit 1
  fi

  write_summary "$case_root/summary.json" \
    caseId "$case_id" \
    receiver "$receiver_impl" \
    mode "$mode" \
    threadId "$thread_id" \
    inboxTotal "$inbox_total" \
    totalSessions "$(count_total_sessions "$receiver_config")"
  log_success "$case_id passed"
  RESULTS+=("$case_id")

  if [[ "$receiver_impl" == "rust" ]]; then
    QUADRA_A_HOME="$CURRENT_RUST_HOME" QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" stop >"$case_root/rust-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_RUST_SOCKET" "$case_id rust socket"
    CURRENT_RUST_HOME=""
    CURRENT_RUST_SOCKET=""
  else
    QUADRA_A_HOME="$CURRENT_JS_HOME" QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      "$JS_CLI" stop >"$case_root/js-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_JS_SOCKET" "$case_id js socket"
    CURRENT_JS_HOME=""
    CURRENT_JS_SOCKET=""
    CURRENT_JS_PID_FILE=""
  fi

  if kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
}

run_neg_002_sender_case() {
  local case_id="$1"
  local sender_impl="$2"
  local receiver_impl="$3"
  local case_root="$ARTIFACT_ROOT/$case_id"
  mkdir -p "$case_root"

  local relay_port
  relay_port="$(next_port)"
  local relay_url="ws://127.0.0.1:${relay_port}"
  local relay_data="$case_root/relay-data"
  local relay_log="$case_root/relay.log"

  log_info "[$case_id] Starting relay"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY" \
      --port "$relay_port" \
      --landing-port false \
      --data-dir "$relay_data" \
      --public-endpoint "$relay_url" \
      --no-federation
  ) >"$relay_log" 2>&1 &
  local relay_pid=$!
  PROCESS_PIDS+=("$relay_pid")
  wait_for_log_pattern "$relay_log" "Relay agent started" "$case_id relay" "$relay_pid"

  local zero_signature="$(printf '00%.0s' $(seq 1 64))"
  local receiver_log
  local receiver_config
  local receiver_did
  local receiver_device_id
  local receiver_pid

  if [[ "$receiver_impl" == "rust" ]]; then
    CURRENT_RUST_HOME="$case_root/rust-receiver-home"
    CURRENT_RUST_SOCKET="/tmp/a4-neg002-rust-receiver-$$.sock"
    bootstrap_rust_config "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$relay_url" false "" "" \
      "$case_root/rust-receiver-bootstrap.log" "$case_root/rust-receiver-bootstrap-stop.log"
    receiver_config="$CURRENT_RUST_HOME/config.json"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"
    mutate_signed_prekey_signature "$receiver_config" "$receiver_device_id" "$zero_signature" \
      "$case_root/rust-receiver-mutated.json"
    receiver_log="$case_root/rust-receiver.log"

    log_info "[$case_id] Starting Rust receiver daemon with invalid signed pre-key signature"
    QUADRA_A_HOME="$CURRENT_RUST_HOME" \
    QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" listen --discoverable \
        --name "$case_id Rust Receiver" \
        --description "Rust receiver publishing invalid signed pre-key signature" \
        --relay "$relay_url" \
        --json >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$receiver_log" "$receiver_pid"
  else
    CURRENT_JS_HOME="$case_root/js-receiver-home"
    CURRENT_JS_SOCKET="/tmp/a4-neg002-js-receiver-$$.sock"
    CURRENT_JS_PID_FILE="/tmp/a4-neg002-js-receiver-$$.pid"
    bootstrap_js_config "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$relay_url" true \
      "$case_id JS Receiver" "JS receiver publishing invalid signed pre-key signature" \
      "$case_root/js-receiver-bootstrap.log" "$case_root/js-receiver-bootstrap-stop.log"
    receiver_config="$CURRENT_JS_HOME/config.json"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"
    mutate_signed_prekey_signature "$receiver_config" "$receiver_device_id" "$zero_signature" \
      "$case_root/js-receiver-mutated.json"
    receiver_log="$case_root/js-receiver.log"

    log_info "[$case_id] Starting JS receiver daemon with invalid signed pre-key signature"
    QUADRA_A_HOME="$CURRENT_JS_HOME" \
    QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
    QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      node "$JS_DAEMON_ENTRY" >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_js_daemon "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$receiver_log" "$receiver_pid"
  fi

  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card.json" 30000

  local thread_id="$(printf "%s" "$case_id" | tr "[:upper:]" "[:lower:]")-$(date +%s)"
  local send_stdout="$case_root/send.stdout.log"
  local send_stderr="$case_root/send.stderr.log"
  local send_combined="$case_root/send.combined.log"

  if [[ "$sender_impl" == "js" ]]; then
    local js_sender_home="$case_root/js-sender-home"
    local js_sender_socket="/tmp/a4-neg002-js-sender-$$.sock"
    local js_sender_pid_file="/tmp/a4-neg002-js-sender-$$.pid"
    bootstrap_js_config "$js_sender_home" "$js_sender_socket" "$js_sender_pid_file" "$relay_url" false "" "" \
      "$case_root/js-sender-bootstrap.log" "$case_root/js-sender-stop.log"

    if QUADRA_A_HOME="$js_sender_home" \
      QUADRA_A_SOCKET_PATH="$js_sender_socket" \
      QUADRA_A_PID_FILE="$js_sender_pid_file" \
      "$JS_CLI" tell "$receiver_did" "invalid signed pre-key should fail" \
        --thread "$thread_id" \
        --relay "$relay_url" \
        --format json >"$send_stdout" 2>"$send_stderr"; then
      log_error "[$case_id] JS sender unexpectedly accepted an invalid signed pre-key signature"
      exit 1
    fi
  else
    local rust_sender_home="$case_root/rust-sender-home"
    local rust_sender_socket="/tmp/a4-neg002-rust-sender-$$.sock"
    bootstrap_rust_config "$rust_sender_home" "$rust_sender_socket" "$relay_url" false "" "" \
      "$case_root/rust-sender-bootstrap.log" "$case_root/rust-sender-stop.log"

    if QUADRA_A_HOME="$rust_sender_home" \
      QUADRA_A_RS_SOCKET_PATH="$rust_sender_socket" \
      "$RUST_A4_BINARY" tell "$receiver_did" "invalid signed pre-key should fail" \
        --thread "$thread_id" \
        --relay "$relay_url" >"$send_stdout" 2>"$send_stderr"; then
      log_error "[$case_id] Rust sender unexpectedly accepted an invalid signed pre-key signature"
      exit 1
    fi
  fi

  cat "$send_stdout" "$send_stderr" >"$send_combined"
  if ! grep -q "publishes invalid signed pre-key signature" "$send_combined"; then
    log_error "[$case_id] Sender failure did not report the invalid signed pre-key signature"
    cat "$send_combined" >&2
    exit 1
  fi

  local inbox_json="$case_root/receiver-inbox.json"
  if [[ "$receiver_impl" == "rust" ]]; then
    assert_rust_inbox_total_equals "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$thread_id" 0 "$inbox_json"
  else
    assert_js_inbox_total_equals "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$thread_id" 0 "$inbox_json"
  fi

  if [[ "$(count_total_sessions "$receiver_config")" -ne 0 ]]; then
    log_error "[$case_id] Invalid signed pre-key send unexpectedly changed receiver session state"
    exit 1
  fi

  write_summary "$case_root/summary.json" \
    caseId "$case_id" \
    sender "$sender_impl" \
    receiver "$receiver_impl" \
    threadId "$thread_id" \
    inboxTotal 0 \
    totalSessions 0
  log_success "$case_id passed"
  RESULTS+=("$case_id")

  if [[ "$receiver_impl" == "rust" ]]; then
    QUADRA_A_HOME="$CURRENT_RUST_HOME" QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" stop >"$case_root/rust-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_RUST_SOCKET" "$case_id rust socket"
    CURRENT_RUST_HOME=""
    CURRENT_RUST_SOCKET=""
  else
    QUADRA_A_HOME="$CURRENT_JS_HOME" QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      "$JS_CLI" stop >"$case_root/js-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_JS_SOCKET" "$case_id js socket"
    CURRENT_JS_HOME=""
    CURRENT_JS_SOCKET=""
    CURRENT_JS_PID_FILE=""
  fi

  if kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
}

run_neg_008_rotated_signed_prekey_case() {
  local case_id="$1"
  local receiver_impl="$2"
  local case_root="$ARTIFACT_ROOT/$case_id"
  mkdir -p "$case_root"

  local relay_port
  relay_port="$(next_port)"
  local relay_url="ws://127.0.0.1:${relay_port}"
  local relay_data="$case_root/relay-data"
  local relay_log="$case_root/relay.log"

  log_info "[$case_id] Starting relay"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY" \
      --port "$relay_port" \
      --landing-port false \
      --data-dir "$relay_data" \
      --public-endpoint "$relay_url" \
      --no-federation
  ) >"$relay_log" 2>&1 &
  local relay_pid=$!
  PROCESS_PIDS+=("$relay_pid")
  wait_for_log_pattern "$relay_log" "Relay agent started" "$case_id relay" "$relay_pid"

  local receiver_config
  local receiver_did
  local receiver_device_id
  local receiver_pid
  local receiver_log="$case_root/receiver.log"
  local sender_config
  local thread_id="$(printf "%s" "$case_id" | tr "[:upper:]" "[:lower:]")-$(date +%s)"
  local prepared_json="$case_root/prepared.json"
  local raw_json="$case_root/raw-send.json"
  local inbox_json="$case_root/receiver-inbox.json"
  local rotate_json="$case_root/rotate-prekey.json"
  local protocol_id="cross/negative/rotated-signed-prekey/1.0.0"

  if [[ "$receiver_impl" == "rust" ]]; then
    CURRENT_RUST_HOME="$case_root/rust-receiver-home"
    CURRENT_RUST_SOCKET="/tmp/a4-neg008-rust-receiver-$$.sock"
    receiver_config="$CURRENT_RUST_HOME/config.json"

    log_info "[$case_id] Starting Rust receiver daemon"
    QUADRA_A_HOME="$CURRENT_RUST_HOME" \
    QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" listen --discoverable \
        --name "$case_id Rust Receiver" \
        --description "Rust receiver for rotated signed pre-key rejection harness" \
        --relay "$relay_url" \
        --json >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$receiver_log" "$receiver_pid"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card-before.json" 30000

    local js_sender_home="$case_root/js-sender-home"
    local js_sender_socket="/tmp/a4-neg008-js-sender-$$.sock"
    local js_sender_pid_file="/tmp/a4-neg008-js-sender-$$.pid"
    bootstrap_js_config "$js_sender_home" "$js_sender_socket" "$js_sender_pid_file" "$relay_url" false "" "" \
      "$case_root/js-sender-bootstrap.log" "$case_root/js-sender-stop.log"
    sender_config="$js_sender_home/config.json"
  else
    CURRENT_JS_HOME="$case_root/js-receiver-home"
    CURRENT_JS_SOCKET="/tmp/a4-neg008-js-receiver-$$.sock"
    CURRENT_JS_PID_FILE="/tmp/a4-neg008-js-receiver-$$.pid"
    bootstrap_js_config "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$relay_url" true \
      "$case_id JS Receiver" "JS receiver for rotated signed pre-key rejection harness" \
      "$case_root/js-receiver-bootstrap.log" "$case_root/js-receiver-bootstrap-stop.log"
    receiver_config="$CURRENT_JS_HOME/config.json"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"

    log_info "[$case_id] Starting JS receiver daemon in foreground"
    QUADRA_A_HOME="$CURRENT_JS_HOME" \
    QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
    QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      node "$JS_DAEMON_ENTRY" >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_js_daemon "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$receiver_log" "$receiver_pid"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card-before.json" 30000

    local rust_sender_home="$case_root/rust-sender-home"
    local rust_sender_socket="/tmp/a4-neg008-rust-sender-$$.sock"
    bootstrap_rust_config "$rust_sender_home" "$rust_sender_socket" "$relay_url" false "" "" \
      "$case_root/rust-sender-bootstrap.log" "$case_root/rust-sender-stop.log"
    sender_config="$rust_sender_home/config.json"
  fi

  log_info "[$case_id] Preparing a PREKEY_MESSAGE against the current signed pre-key"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    prepare-encrypted "$sender_config" "$relay_url" "$receiver_did" \
    "$protocol_id" '{"text":"rotated signed pre-key should reject stale prekey"}' "$prepared_json" "$thread_id"

  if [[ "$receiver_impl" == "rust" ]]; then
    QUADRA_A_HOME="$CURRENT_RUST_HOME" QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" stop >"$case_root/rust-receiver-stop-before-rotate.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver before rotate" "$receiver_log"
    wait_for_path_absent "$CURRENT_RUST_SOCKET" "$case_id rust socket before rotate"
  else
    QUADRA_A_HOME="$CURRENT_JS_HOME" QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      "$JS_CLI" stop >"$case_root/js-receiver-stop-before-rotate.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver before rotate" "$receiver_log"
    wait_for_path_absent "$CURRENT_JS_SOCKET" "$case_id js socket before rotate"
  fi

  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    rotate-prekey "$receiver_config" "$receiver_device_id" "$rotate_json"

  receiver_log="$case_root/receiver-after-rotate.log"
  if [[ "$receiver_impl" == "rust" ]]; then
    log_info "[$case_id] Restarting Rust receiver daemon after signed pre-key rotation"
    QUADRA_A_HOME="$CURRENT_RUST_HOME" \
    QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" listen --discoverable \
        --name "$case_id Rust Receiver" \
        --description "Rust receiver after signed pre-key rotation" \
        --relay "$relay_url" \
        --json >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$receiver_log" "$receiver_pid"
  else
    log_info "[$case_id] Restarting JS receiver daemon after signed pre-key rotation"
    QUADRA_A_HOME="$CURRENT_JS_HOME" \
    QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
    QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      node "$JS_DAEMON_ENTRY" >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_js_daemon "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$receiver_log" "$receiver_pid"
  fi
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card-after.json" 30000

  log_info "[$case_id] Sending stale PREKEY_MESSAGE after signed pre-key rotation"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-raw-envelope "$sender_config" "$relay_url" "$prepared_json" "$raw_json"
  wait_for_log_pattern "$receiver_log" "PREKEY_MESSAGE signed pre-key id does not match current receiver device state" "$case_id receiver" "$receiver_pid"

  if [[ "$receiver_impl" == "rust" ]]; then
    assert_rust_inbox_total_equals "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$thread_id" 0 "$inbox_json"
  else
    assert_js_inbox_total_equals "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$thread_id" 0 "$inbox_json"
  fi

  if [[ "$(count_total_sessions "$receiver_config")" -ne 0 ]]; then
    log_error "[$case_id] Rotated signed pre-key rejection unexpectedly created a receiver session"
    exit 1
  fi

  write_summary "$case_root/summary.json" \
    caseId "$case_id" \
    receiver "$receiver_impl" \
    threadId "$thread_id" \
    inboxTotal 0 \
    totalSessions 0
  log_success "$case_id passed"
  RESULTS+=("$case_id")

  if [[ "$receiver_impl" == "rust" ]]; then
    QUADRA_A_HOME="$CURRENT_RUST_HOME" QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" stop >"$case_root/rust-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_RUST_SOCKET" "$case_id rust socket"
    CURRENT_RUST_HOME=""
    CURRENT_RUST_SOCKET=""
  else
    QUADRA_A_HOME="$CURRENT_JS_HOME" QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      "$JS_CLI" stop >"$case_root/js-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_JS_SOCKET" "$case_id js socket"
    CURRENT_JS_HOME=""
    CURRENT_JS_SOCKET=""
    CURRENT_JS_PID_FILE=""
  fi

  if kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
}


run_neg_001_forged_sender_device_case() {
  local case_id="$1"
  local receiver_impl="$2"
  local case_root="$ARTIFACT_ROOT/$case_id"
  mkdir -p "$case_root"

  local relay_port
  relay_port="$(next_port)"
  local relay_url="ws://127.0.0.1:${relay_port}"
  local relay_data="$case_root/relay-data"
  local relay_log="$case_root/relay.log"

  log_info "[$case_id] Starting relay"
  (
    cd "$A4_ROOT/js/relay"
    node "$RELAY_ENTRY" \
      --port "$relay_port" \
      --landing-port false \
      --data-dir "$relay_data" \
      --public-endpoint "$relay_url" \
      --no-federation
  ) >"$relay_log" 2>&1 &
  local relay_pid=$!
  PROCESS_PIDS+=("$relay_pid")
  wait_for_log_pattern "$relay_log" "Relay agent started" "$case_id relay" "$relay_pid"

  local receiver_config
  local receiver_did
  local receiver_device_id
  local receiver_pid
  local receiver_log="$case_root/receiver.log"
  local thread_id="$(printf "%s" "$case_id" | tr "[:upper:]" "[:lower:]")-$(date +%s)"
  local prepared_json="$case_root/prepared.json"
  local raw_json="$case_root/raw-send.json"
  local inbox_json="$case_root/receiver-inbox.json"
  local protocol_id="cross/negative/forged-sender-device/1.0.0"
  local sender_original_config
  local sender_mutated_config
  local sender_did
  local sender_device_id

  if [[ "$receiver_impl" == "rust" ]]; then
    CURRENT_RUST_HOME="$case_root/rust-receiver-home"
    CURRENT_RUST_SOCKET="/tmp/a4-neg001-rust-receiver-$$.sock"
    receiver_config="$CURRENT_RUST_HOME/config.json"

    log_info "[$case_id] Starting Rust receiver daemon"
    QUADRA_A_HOME="$CURRENT_RUST_HOME" \
    QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" listen --discoverable \
        --name "$case_id Rust Receiver" \
        --description "Rust receiver for forged sender device rejection harness" \
        --relay "$relay_url" \
        --json >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$receiver_log" "$receiver_pid"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card.json" 30000

    local js_sender_home="$case_root/js-sender-home"
    local js_sender_socket="/tmp/a4-neg001-js-sender-$$.sock"
    local js_sender_pid_file="/tmp/a4-neg001-js-sender-$$.pid"
    bootstrap_js_config "$js_sender_home" "$js_sender_socket" "$js_sender_pid_file" "$relay_url" true \
      "$case_id JS Sender" "JS sender publishing the baseline device card" \
      "$case_root/js-sender-bootstrap.log" "$case_root/js-sender-stop.log"
    sender_original_config="$js_sender_home/config.json"
    sender_did="$(json_get "$sender_original_config" "identity.did")"
    sender_device_id="$(json_get "$sender_original_config" "e2e.currentDeviceId")"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$sender_did" "$sender_device_id" "$case_root/sender-card-before.json" 30000
    sender_mutated_config="$case_root/js-sender-mutated-config.json"
    cp "$sender_original_config" "$sender_mutated_config"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      replace-device-identity "$sender_mutated_config" "$sender_device_id" "$case_root/js-sender-mutated.json"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      prepare-encrypted "$sender_mutated_config" "$relay_url" "$receiver_did" \
      "$protocol_id" '{"text":"forged sender device should be rejected"}' "$prepared_json" "$thread_id"
    bootstrap_js_config "$js_sender_home" "$js_sender_socket" "$js_sender_pid_file" "$relay_url" true \
      "$case_id JS Sender" "JS sender re-publishing the original device card" \
      "$case_root/js-sender-republish.log" "$case_root/js-sender-republish-stop.log"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$sender_did" "$sender_device_id" "$case_root/sender-card-after.json" 30000
  else
    CURRENT_JS_HOME="$case_root/js-receiver-home"
    CURRENT_JS_SOCKET="/tmp/a4-neg001-js-receiver-$$.sock"
    CURRENT_JS_PID_FILE="/tmp/a4-neg001-js-receiver-$$.pid"
    bootstrap_js_config "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$relay_url" true \
      "$case_id JS Receiver" "JS receiver for forged sender device rejection harness" \
      "$case_root/js-receiver-bootstrap.log" "$case_root/js-receiver-bootstrap-stop.log"
    receiver_config="$CURRENT_JS_HOME/config.json"
    receiver_did="$(json_get "$receiver_config" "identity.did")"
    receiver_device_id="$(json_get "$receiver_config" "e2e.currentDeviceId")"

    log_info "[$case_id] Starting JS receiver daemon in foreground"
    QUADRA_A_HOME="$CURRENT_JS_HOME" \
    QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
    QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      node "$JS_DAEMON_ENTRY" >"$receiver_log" 2>&1 &
    receiver_pid=$!
    PROCESS_PIDS+=("$receiver_pid")
    wait_for_js_daemon "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$receiver_log" "$receiver_pid"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$receiver_did" "$receiver_device_id" "$case_root/receiver-card.json" 30000

    local rust_sender_home="$case_root/rust-sender-home"
    local rust_sender_socket="/tmp/a4-neg001-rust-sender-$$.sock"
    bootstrap_rust_config "$rust_sender_home" "$rust_sender_socket" "$relay_url" true \
      "$case_id Rust Sender" "Rust sender publishing the baseline device card" \
      "$case_root/rust-sender-bootstrap.log" "$case_root/rust-sender-stop.log"
    sender_original_config="$rust_sender_home/config.json"
    sender_did="$(json_get "$sender_original_config" "identity.did")"
    sender_device_id="$(json_get "$sender_original_config" "e2e.currentDeviceId")"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$sender_did" "$sender_device_id" "$case_root/sender-card-before.json" 30000
    sender_mutated_config="$case_root/rust-sender-mutated-config.json"
    cp "$sender_original_config" "$sender_mutated_config"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      replace-device-identity "$sender_mutated_config" "$sender_device_id" "$case_root/rust-sender-mutated.json"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      prepare-encrypted "$sender_mutated_config" "$relay_url" "$receiver_did" \
      "$protocol_id" '{"text":"forged sender device should be rejected"}' "$prepared_json" "$thread_id"
    bootstrap_rust_config "$rust_sender_home" "$rust_sender_socket" "$relay_url" true \
      "$case_id Rust Sender" "Rust sender re-publishing the original device card" \
      "$case_root/rust-sender-republish.log" "$case_root/rust-sender-republish-stop.log"
    node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
      wait-card "$relay_url" "$sender_did" "$sender_device_id" "$case_root/sender-card-after.json" 30000
  fi

  log_info "[$case_id] Sending PREKEY_MESSAGE with a forged sender device identity key"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-raw-envelope "$sender_original_config" "$relay_url" "$prepared_json" "$raw_json"
  wait_for_log_pattern "$receiver_log" "published identity key does not match PREKEY_MESSAGE" "$case_id receiver" "$receiver_pid"

  if [[ "$receiver_impl" == "rust" ]]; then
    assert_rust_inbox_total_equals "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$thread_id" 0 "$inbox_json"
  else
    assert_js_inbox_total_equals "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$thread_id" 0 "$inbox_json"
  fi

  if [[ "$(count_total_sessions "$receiver_config")" -ne 0 ]]; then
    log_error "[$case_id] Forged sender device message unexpectedly created a receiver session"
    exit 1
  fi

  write_summary "$case_root/summary.json" \
    caseId "$case_id" \
    receiver "$receiver_impl" \
    threadId "$thread_id" \
    inboxTotal 0 \
    totalSessions 0
  log_success "$case_id passed"
  RESULTS+=("$case_id")

  if [[ "$receiver_impl" == "rust" ]]; then
    QUADRA_A_HOME="$CURRENT_RUST_HOME" QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
      "$RUST_A4_BINARY" stop >"$case_root/rust-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_RUST_SOCKET" "$case_id rust socket"
    CURRENT_RUST_HOME=""
    CURRENT_RUST_SOCKET=""
  else
    QUADRA_A_HOME="$CURRENT_JS_HOME" QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
      "$JS_CLI" stop >"$case_root/js-receiver-stop.log" 2>&1 || true
    wait_for_process_exit "$receiver_pid" "$case_id receiver" "$receiver_log"
    wait_for_path_absent "$CURRENT_JS_SOCKET" "$case_id js socket"
    CURRENT_JS_HOME=""
    CURRENT_JS_SOCKET=""
    CURRENT_JS_PID_FILE=""
  fi

  if kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
}


while [[ $# -gt 0 ]]; do
  case "$1" in
    --neg-001-only)
      RUN_NEG_001=true
      RUN_NEG_002=false
      RUN_NEG_003=false
      RUN_NEG_004=false
      RUN_NEG_005=false
      RUN_NEG_006=false
      RUN_NEG_007=false
      RUN_NEG_008=false
      shift
      ;;
    --neg-002-only)
      RUN_NEG_001=false
      RUN_NEG_002=true
      RUN_NEG_003=false
      RUN_NEG_004=false
      RUN_NEG_005=false
      RUN_NEG_006=false
      RUN_NEG_007=false
      RUN_NEG_008=false
      shift
      ;;
    --neg-003-only)
      RUN_NEG_001=false
      RUN_NEG_002=false
      RUN_NEG_003=true
      RUN_NEG_004=false
      RUN_NEG_005=false
      RUN_NEG_006=false
      RUN_NEG_007=false
      RUN_NEG_008=false
      shift
      ;;
    --neg-004-only)
      RUN_NEG_001=false
      RUN_NEG_002=false
      RUN_NEG_003=false
      RUN_NEG_004=true
      RUN_NEG_005=false
      RUN_NEG_006=false
      RUN_NEG_007=false
      RUN_NEG_008=false
      shift
      ;;
    --neg-005-only)
      RUN_NEG_001=false
      RUN_NEG_002=false
      RUN_NEG_003=false
      RUN_NEG_004=false
      RUN_NEG_005=true
      RUN_NEG_006=false
      RUN_NEG_007=false
      RUN_NEG_008=false
      shift
      ;;
    --neg-006-only)
      RUN_NEG_001=false
      RUN_NEG_002=false
      RUN_NEG_003=false
      RUN_NEG_004=false
      RUN_NEG_005=false
      RUN_NEG_006=true
      RUN_NEG_007=false
      RUN_NEG_008=false
      shift
      ;;
    --neg-007-only)
      RUN_NEG_001=false
      RUN_NEG_002=false
      RUN_NEG_003=false
      RUN_NEG_004=false
      RUN_NEG_005=false
      RUN_NEG_006=false
      RUN_NEG_007=true
      RUN_NEG_008=false
      shift
      ;;
    --neg-008-only)
      RUN_NEG_001=false
      RUN_NEG_002=false
      RUN_NEG_003=false
      RUN_NEG_004=false
      RUN_NEG_005=false
      RUN_NEG_006=false
      RUN_NEG_007=false
      RUN_NEG_008=true
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

if [[ "$RUN_NEG_001" == false && "$RUN_NEG_002" == false && "$RUN_NEG_003" == false && "$RUN_NEG_004" == false && "$RUN_NEG_005" == false && "$RUN_NEG_006" == false && "$RUN_NEG_007" == false && "$RUN_NEG_008" == false ]]; then
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

if [[ "$RUN_NEG_003" == true ]]; then
  CASE_ID="E2E-NEG-003-rust-receiver"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_PORT="$(next_port)"
  RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"
  RELAY_DATA="$CASE_ROOT/relay-data"
  RELAY_LOG="$CASE_ROOT/relay.log"

  log_info "[$CASE_ID] Starting relay"
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
  wait_for_log_pattern "$RELAY_LOG" "Relay agent started" "$CASE_ID relay" "$RELAY_PID"

  CURRENT_RUST_HOME="$CASE_ROOT/rust-receiver-home"
  CURRENT_RUST_SOCKET="/tmp/a4-neg003-rust-receiver-$$.sock"
  RECEIVER_LOG="$CASE_ROOT/rust-receiver.log"
  RECEIVER_CARD_JSON="$CASE_ROOT/rust-receiver-card.json"
  RUST_CONFIG="$CURRENT_RUST_HOME/config.json"

  log_info "[$CASE_ID] Starting Rust receiver daemon"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "NEG-003 Rust Receiver" \
      --description "Rust receiver for PREKEY replay rejection harness" \
      --relay "$RELAY_URL" \
      --json >"$RECEIVER_LOG" 2>&1 &
  RECEIVER_PID=$!
  PROCESS_PIDS+=("$RECEIVER_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_LOG" "$RECEIVER_PID"
  RECEIVER_DID="$(json_get "$RUST_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$RUST_CONFIG" "e2e.currentDeviceId")"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$RECEIVER_CARD_JSON" 30000

  JS_SENDER_HOME="$CASE_ROOT/js-sender-home"
  JS_SENDER_SOCKET="/tmp/a4-neg003-js-sender-$$.sock"
  JS_SENDER_PID_FILE="/tmp/a4-neg003-js-sender-$$.pid"
  JS_SENDER_BOOT_LOG="$CASE_ROOT/js-sender-bootstrap.log"
  JS_SENDER_STOP_LOG="$CASE_ROOT/js-sender-stop.log"
  bootstrap_js_config "$JS_SENDER_HOME" "$JS_SENDER_SOCKET" "$JS_SENDER_PID_FILE" "$RELAY_URL" false "" "" "$JS_SENDER_BOOT_LOG" "$JS_SENDER_STOP_LOG"
  JS_SENDER_CONFIG="$JS_SENDER_HOME/config.json"
  THREAD_ID="neg003-rust-receiver-$(date +%s)"
  SEND_JSON="$CASE_ROOT/send-encrypted.json"
  REPLAY_JSON="$CASE_ROOT/replay-raw.json"
  INBOX_JSONL="$CASE_ROOT/rust-receiver-inbox.jsonl"
  INBOX_AFTER_JSONL="$CASE_ROOT/rust-receiver-inbox-after.jsonl"

  log_info "[$CASE_ID] Sending first encrypted PREKEY_MESSAGE"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-encrypted "$JS_SENDER_CONFIG" "$RELAY_URL" "$RECEIVER_DID" \
    "cross/negative/prekey-replay/1.0.0" "{\"text\":\"prekey replay probe\"}" "$SEND_JSON" "$THREAD_ID"
  wait_for_rust_inbox_total "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$THREAD_ID" 1 "$INBOX_JSONL"
  if [[ "$(count_total_sessions "$RUST_CONFIG")" -ne 1 ]]; then
    log_error "[$CASE_ID] Expected exactly one Rust receiver session after first delivery"
    exit 1
  fi

  log_info "[$CASE_ID] Replaying the consumed PREKEY_MESSAGE"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-raw-envelope "$JS_SENDER_CONFIG" "$RELAY_URL" "$SEND_JSON" "$REPLAY_JSON"
  wait_for_log_pattern "$RECEIVER_LOG" "Claimed one-time pre-key already consumed for PREKEY_MESSAGE" "$CASE_ID receiver" "$RECEIVER_PID"
  assert_rust_inbox_total_equals "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$THREAD_ID" 1 "$INBOX_AFTER_JSONL"
  if [[ "$(count_total_sessions "$RUST_CONFIG")" -ne 1 ]]; then
    log_error "[$CASE_ID] PREKEY replay created an unexpected second Rust receiver session"
    exit 1
  fi

  write_summary "$CASE_ROOT/summary.json" \
    caseId "$CASE_ID" \
    receiver rust \
    threadId "$THREAD_ID" \
    inboxTotal "$(rust_jsonl_total "$INBOX_AFTER_JSONL")" \
    totalSessions "$(count_total_sessions "$RUST_CONFIG")"
  log_success "$CASE_ID passed"
  RESULTS+=("$CASE_ID")

  QUADRA_A_HOME="$CURRENT_RUST_HOME" QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" stop >"$CASE_ROOT/rust-receiver-stop.log" 2>&1 || true
  wait_for_process_exit "$RECEIVER_PID" "$CASE_ID receiver" "$RECEIVER_LOG"
  wait_for_path_absent "$CURRENT_RUST_SOCKET" "$CASE_ID rust socket"
  CURRENT_RUST_HOME=""
  CURRENT_RUST_SOCKET=""

  CASE_ID="E2E-NEG-003-js-receiver"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_PORT="$(next_port)"
  RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"
  RELAY_DATA="$CASE_ROOT/relay-data"
  RELAY_LOG="$CASE_ROOT/relay.log"

  log_info "[$CASE_ID] Starting relay"
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
  wait_for_log_pattern "$RELAY_LOG" "Relay agent started" "$CASE_ID relay" "$RELAY_PID"

  CURRENT_JS_HOME="$CASE_ROOT/js-receiver-home"
  CURRENT_JS_SOCKET="/tmp/a4-neg003-js-receiver-$$.sock"
  CURRENT_JS_PID_FILE="/tmp/a4-neg003-js-receiver-$$.pid"
  JS_RECEIVER_BOOT_LOG="$CASE_ROOT/js-receiver-bootstrap.log"
  JS_RECEIVER_BOOT_STOP_LOG="$CASE_ROOT/js-receiver-bootstrap-stop.log"
  JS_RECEIVER_LOG="$CASE_ROOT/js-receiver.log"
  bootstrap_js_config "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$RELAY_URL" true "NEG-003 JS Receiver" "JS receiver for PREKEY replay rejection harness" "$JS_RECEIVER_BOOT_LOG" "$JS_RECEIVER_BOOT_STOP_LOG"
  JS_CONFIG="$CURRENT_JS_HOME/config.json"
  RECEIVER_DID="$(json_get "$JS_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$JS_CONFIG" "e2e.currentDeviceId")"

  log_info "[$CASE_ID] Starting JS receiver daemon in foreground"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    node "$JS_DAEMON_ENTRY" >"$JS_RECEIVER_LOG" 2>&1 &
  JS_RECEIVER_PID=$!
  PROCESS_PIDS+=("$JS_RECEIVER_PID")
  wait_for_js_daemon "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$JS_RECEIVER_LOG" "$JS_RECEIVER_PID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$CASE_ROOT/js-receiver-card.json" 30000

  RUST_SENDER_HOME="$CASE_ROOT/rust-sender-home"
  RUST_SENDER_SOCKET="/tmp/a4-neg003-rust-sender-$$.sock"
  RUST_SENDER_SEED_LOG="$CASE_ROOT/rust-sender-seed.log"
  RUST_SENDER_STOP_LOG="$CASE_ROOT/rust-sender-stop.log"
  QUADRA_A_HOME="$RUST_SENDER_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$RUST_SENDER_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "NEG-003 Rust Sender" \
      --description "Rust sender config for JS PREKEY replay rejection harness" \
      --relay "$RELAY_URL" \
      --json >"$RUST_SENDER_SEED_LOG" 2>&1 &
  RUST_SENDER_SEED_PID=$!
  PROCESS_PIDS+=("$RUST_SENDER_SEED_PID")
  wait_for_rust_daemon "$RUST_SENDER_HOME" "$RUST_SENDER_SOCKET" "$RUST_SENDER_SEED_LOG" "$RUST_SENDER_SEED_PID"
  QUADRA_A_HOME="$RUST_SENDER_HOME" QUADRA_A_RS_SOCKET_PATH="$RUST_SENDER_SOCKET" \
    "$RUST_A4_BINARY" stop >"$RUST_SENDER_STOP_LOG" 2>&1 || true
  wait_for_process_exit "$RUST_SENDER_SEED_PID" "$CASE_ID rust sender seed" "$RUST_SENDER_SEED_LOG"
  wait_for_path_absent "$RUST_SENDER_SOCKET" "$CASE_ID rust sender socket"
  RUST_SENDER_CONFIG="$RUST_SENDER_HOME/config.json"

  THREAD_ID="neg003-js-receiver-$(date +%s)"
  SEND_JSON="$CASE_ROOT/send-encrypted.json"
  REPLAY_JSON="$CASE_ROOT/replay-raw.json"
  INBOX_JSON="$CASE_ROOT/js-receiver-inbox.json"
  INBOX_AFTER_JSON="$CASE_ROOT/js-receiver-inbox-after.json"

  log_info "[$CASE_ID] Sending first encrypted PREKEY_MESSAGE"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-encrypted "$RUST_SENDER_CONFIG" "$RELAY_URL" "$RECEIVER_DID" \
    "cross/negative/prekey-replay/1.0.0" "{\"text\":\"prekey replay probe\"}" "$SEND_JSON" "$THREAD_ID"
  wait_for_js_inbox_total "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$THREAD_ID" 1 "$INBOX_JSON"
  if [[ "$(count_total_sessions "$JS_CONFIG")" -ne 1 ]]; then
    log_error "[$CASE_ID] Expected exactly one JS receiver session after first delivery"
    exit 1
  fi

  log_info "[$CASE_ID] Replaying the consumed PREKEY_MESSAGE"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-raw-envelope "$RUST_SENDER_CONFIG" "$RELAY_URL" "$SEND_JSON" "$REPLAY_JSON"
  wait_for_log_pattern "$JS_RECEIVER_LOG" "Claimed one-time pre-key already consumed for PREKEY_MESSAGE" "$CASE_ID receiver" "$JS_RECEIVER_PID"
  assert_js_inbox_total_equals "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$THREAD_ID" 1 "$INBOX_AFTER_JSON"
  if [[ "$(count_total_sessions "$JS_CONFIG")" -ne 1 ]]; then
    log_error "[$CASE_ID] PREKEY replay created an unexpected second JS receiver session"
    exit 1
  fi

  write_summary "$CASE_ROOT/summary.json" \
    caseId "$CASE_ID" \
    receiver js \
    threadId "$THREAD_ID" \
    inboxTotal "$(json_page_total "$INBOX_AFTER_JSON")" \
    totalSessions "$(count_total_sessions "$JS_CONFIG")"
  log_success "$CASE_ID passed"
  RESULTS+=("$CASE_ID")

  QUADRA_A_HOME="$CURRENT_JS_HOME" QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" stop >"$CASE_ROOT/js-receiver-stop.log" 2>&1 || true
  wait_for_process_exit "$JS_RECEIVER_PID" "$CASE_ID receiver" "$JS_RECEIVER_LOG"
  wait_for_path_absent "$CURRENT_JS_SOCKET" "$CASE_ID js socket"
  CURRENT_JS_HOME=""
  CURRENT_JS_SOCKET=""
  CURRENT_JS_PID_FILE=""
fi

if [[ "$RUN_NEG_007" == true ]]; then
  CASE_ID="E2E-NEG-007-rust-receiver"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_PORT="$(next_port)"
  RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"
  RELAY_DATA="$CASE_ROOT/relay-data"
  RELAY_LOG="$CASE_ROOT/relay.log"

  log_info "[$CASE_ID] Starting relay"
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
  wait_for_log_pattern "$RELAY_LOG" "Relay agent started" "$CASE_ID relay" "$RELAY_PID"

  CURRENT_RUST_HOME="$CASE_ROOT/rust-receiver-home"
  CURRENT_RUST_SOCKET="/tmp/a4-neg007-rust-receiver-$$.sock"
  RECEIVER_LOG="$CASE_ROOT/rust-receiver.log"
  RUST_CONFIG="$CURRENT_RUST_HOME/config.json"

  log_info "[$CASE_ID] Starting Rust receiver daemon"
  QUADRA_A_HOME="$CURRENT_RUST_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "NEG-007 Rust Receiver" \
      --description "Rust receiver for legacy plaintext rejection harness" \
      --relay "$RELAY_URL" \
      --json >"$RECEIVER_LOG" 2>&1 &
  RECEIVER_PID=$!
  PROCESS_PIDS+=("$RECEIVER_PID")
  wait_for_rust_daemon "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$RECEIVER_LOG" "$RECEIVER_PID"
  RECEIVER_DID="$(json_get "$RUST_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$RUST_CONFIG" "e2e.currentDeviceId")"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$CASE_ROOT/rust-receiver-card.json" 30000

  JS_SENDER_HOME="$CASE_ROOT/js-sender-home"
  JS_SENDER_SOCKET="/tmp/a4-neg007-js-sender-$$.sock"
  JS_SENDER_PID_FILE="/tmp/a4-neg007-js-sender-$$.pid"
  bootstrap_js_config "$JS_SENDER_HOME" "$JS_SENDER_SOCKET" "$JS_SENDER_PID_FILE" "$RELAY_URL" false "" "" "$CASE_ROOT/js-sender-bootstrap.log" "$CASE_ROOT/js-sender-stop.log"
  JS_SENDER_CONFIG="$JS_SENDER_HOME/config.json"
  THREAD_ID="neg007-rust-receiver-$(date +%s)"
  PLAINTEXT_JSON="$CASE_ROOT/plaintext-send.json"
  INBOX_JSONL="$CASE_ROOT/rust-receiver-inbox.jsonl"

  log_info "[$CASE_ID] Sending legacy plaintext application message"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-plaintext "$JS_SENDER_CONFIG" "$RELAY_URL" "$RECEIVER_DID" \
    "/agent/msg/1.0.0" "{\"text\":\"legacy plaintext should be rejected\"}" "$PLAINTEXT_JSON" "$THREAD_ID"
  wait_for_log_pattern "$RECEIVER_LOG" "Rejecting legacy plaintext relay message" "$CASE_ID receiver" "$RECEIVER_PID"
  assert_rust_inbox_total_equals "$CURRENT_RUST_HOME" "$CURRENT_RUST_SOCKET" "$THREAD_ID" 0 "$INBOX_JSONL"
  if [[ "$(count_total_sessions "$RUST_CONFIG")" -ne 0 ]]; then
    log_error "[$CASE_ID] Legacy plaintext unexpectedly created a Rust session"
    exit 1
  fi

  write_summary "$CASE_ROOT/summary.json" \
    caseId "$CASE_ID" \
    receiver rust \
    threadId "$THREAD_ID" \
    inboxTotal "$(rust_jsonl_total "$INBOX_JSONL")" \
    totalSessions "$(count_total_sessions "$RUST_CONFIG")"
  log_success "$CASE_ID passed"
  RESULTS+=("$CASE_ID")

  QUADRA_A_HOME="$CURRENT_RUST_HOME" QUADRA_A_RS_SOCKET_PATH="$CURRENT_RUST_SOCKET" \
    "$RUST_A4_BINARY" stop >"$CASE_ROOT/rust-receiver-stop.log" 2>&1 || true
  wait_for_process_exit "$RECEIVER_PID" "$CASE_ID receiver" "$RECEIVER_LOG"
  wait_for_path_absent "$CURRENT_RUST_SOCKET" "$CASE_ID rust socket"
  CURRENT_RUST_HOME=""
  CURRENT_RUST_SOCKET=""

  CASE_ID="E2E-NEG-007-js-receiver"
  CASE_ROOT="$ARTIFACT_ROOT/$CASE_ID"
  mkdir -p "$CASE_ROOT"

  RELAY_PORT="$(next_port)"
  RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"
  RELAY_DATA="$CASE_ROOT/relay-data"
  RELAY_LOG="$CASE_ROOT/relay.log"

  log_info "[$CASE_ID] Starting relay"
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
  wait_for_log_pattern "$RELAY_LOG" "Relay agent started" "$CASE_ID relay" "$RELAY_PID"

  CURRENT_JS_HOME="$CASE_ROOT/js-receiver-home"
  CURRENT_JS_SOCKET="/tmp/a4-neg007-js-receiver-$$.sock"
  CURRENT_JS_PID_FILE="/tmp/a4-neg007-js-receiver-$$.pid"
  bootstrap_js_config "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$RELAY_URL" true "NEG-007 JS Receiver" "JS receiver for legacy plaintext rejection harness" "$CASE_ROOT/js-receiver-bootstrap.log" "$CASE_ROOT/js-receiver-bootstrap-stop.log"
  JS_CONFIG="$CURRENT_JS_HOME/config.json"
  RECEIVER_DID="$(json_get "$JS_CONFIG" "identity.did")"
  RECEIVER_DEVICE_ID="$(json_get "$JS_CONFIG" "e2e.currentDeviceId")"

  log_info "[$CASE_ID] Starting JS receiver daemon in foreground"
  QUADRA_A_HOME="$CURRENT_JS_HOME" \
  QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" \
  QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    node "$JS_DAEMON_ENTRY" >"$CASE_ROOT/js-receiver.log" 2>&1 &
  JS_RECEIVER_PID=$!
  PROCESS_PIDS+=("$JS_RECEIVER_PID")
  wait_for_js_daemon "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$CASE_ROOT/js-receiver.log" "$JS_RECEIVER_PID"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    wait-card "$RELAY_URL" "$RECEIVER_DID" "$RECEIVER_DEVICE_ID" "$CASE_ROOT/js-receiver-card.json" 30000

  RUST_SENDER_HOME="$CASE_ROOT/rust-sender-home"
  RUST_SENDER_SOCKET="/tmp/a4-neg007-rust-sender-$$.sock"
  QUADRA_A_HOME="$RUST_SENDER_HOME" \
  QUADRA_A_RS_SOCKET_PATH="$RUST_SENDER_SOCKET" \
    "$RUST_A4_BINARY" listen --discoverable \
      --name "NEG-007 Rust Sender" \
      --description "Rust sender config for JS legacy plaintext rejection harness" \
      --relay "$RELAY_URL" \
      --json >"$CASE_ROOT/rust-sender-seed.log" 2>&1 &
  RUST_SENDER_SEED_PID=$!
  PROCESS_PIDS+=("$RUST_SENDER_SEED_PID")
  wait_for_rust_daemon "$RUST_SENDER_HOME" "$RUST_SENDER_SOCKET" "$CASE_ROOT/rust-sender-seed.log" "$RUST_SENDER_SEED_PID"
  QUADRA_A_HOME="$RUST_SENDER_HOME" QUADRA_A_RS_SOCKET_PATH="$RUST_SENDER_SOCKET" \
    "$RUST_A4_BINARY" stop >"$CASE_ROOT/rust-sender-stop.log" 2>&1 || true
  wait_for_process_exit "$RUST_SENDER_SEED_PID" "$CASE_ID rust sender seed" "$CASE_ROOT/rust-sender-seed.log"
  wait_for_path_absent "$RUST_SENDER_SOCKET" "$CASE_ID rust sender socket"
  RUST_SENDER_CONFIG="$RUST_SENDER_HOME/config.json"

  THREAD_ID="neg007-js-receiver-$(date +%s)"
  PLAINTEXT_JSON="$CASE_ROOT/plaintext-send.json"
  INBOX_JSON="$CASE_ROOT/js-receiver-inbox.json"

  log_info "[$CASE_ID] Sending legacy plaintext application message"
  node --experimental-strip-types "$SCRIPT_DIR/tools/e2e-probe.mjs" \
    send-plaintext "$RUST_SENDER_CONFIG" "$RELAY_URL" "$RECEIVER_DID" \
    "/agent/msg/1.0.0" "{\"text\":\"legacy plaintext should be rejected\"}" "$PLAINTEXT_JSON" "$THREAD_ID"
  wait_for_log_pattern "$CASE_ROOT/js-receiver.log" "Rejecting legacy plaintext relay message" "$CASE_ID receiver" "$JS_RECEIVER_PID"
  assert_js_inbox_total_equals "$CURRENT_JS_HOME" "$CURRENT_JS_SOCKET" "$CURRENT_JS_PID_FILE" "$THREAD_ID" 0 "$INBOX_JSON"
  if [[ "$(count_total_sessions "$JS_CONFIG")" -ne 0 ]]; then
    log_error "[$CASE_ID] Legacy plaintext unexpectedly created a JS session"
    exit 1
  fi

  write_summary "$CASE_ROOT/summary.json" \
    caseId "$CASE_ID" \
    receiver js \
    threadId "$THREAD_ID" \
    inboxTotal "$(json_page_total "$INBOX_JSON")" \
    totalSessions "$(count_total_sessions "$JS_CONFIG")"
  log_success "$CASE_ID passed"
  RESULTS+=("$CASE_ID")

  QUADRA_A_HOME="$CURRENT_JS_HOME" QUADRA_A_SOCKET_PATH="$CURRENT_JS_SOCKET" QUADRA_A_PID_FILE="$CURRENT_JS_PID_FILE" \
    "$JS_CLI" stop >"$CASE_ROOT/js-receiver-stop.log" 2>&1 || true
  wait_for_process_exit "$JS_RECEIVER_PID" "$CASE_ID receiver" "$CASE_ROOT/js-receiver.log"
  wait_for_path_absent "$CURRENT_JS_SOCKET" "$CASE_ID js socket"
  CURRENT_JS_HOME=""
  CURRENT_JS_SOCKET=""
  CURRENT_JS_PID_FILE=""
fi

if [[ "$RUN_NEG_001" == true ]]; then
  run_neg_001_forged_sender_device_case "E2E-NEG-001-rust-receiver" rust
  run_neg_001_forged_sender_device_case "E2E-NEG-001-js-receiver" js
fi

if [[ "$RUN_NEG_002" == true ]]; then
  run_neg_002_sender_case "E2E-NEG-002-js-sender" js rust
  run_neg_002_sender_case "E2E-NEG-002-rust-sender" rust js
fi

if [[ "$RUN_NEG_004" == true ]]; then
  run_session_message_negative_case "E2E-NEG-004-rust-receiver" rust session-replay
  run_session_message_negative_case "E2E-NEG-004-js-receiver" js session-replay
fi

if [[ "$RUN_NEG_005" == true ]]; then
  run_session_message_negative_case "E2E-NEG-005-rust-receiver" rust session-ciphertext
  run_session_message_negative_case "E2E-NEG-005-js-receiver" js session-ciphertext
fi

if [[ "$RUN_NEG_006" == true ]]; then
  run_session_message_negative_case "E2E-NEG-006-rust-receiver" rust session-header
  run_session_message_negative_case "E2E-NEG-006-js-receiver" js session-header
fi

if [[ "$RUN_NEG_008" == true ]]; then
  run_neg_008_rotated_signed_prekey_case "E2E-NEG-008-rust-receiver" rust
  run_neg_008_rotated_signed_prekey_case "E2E-NEG-008-js-receiver" js
fi

printf '%s\n' "${RESULTS[@]}" >"$ARTIFACT_ROOT/results.txt"
log_success "Completed negative E2E harness: ${RESULTS[*]}"
log_info "Artifacts: $ARTIFACT_ROOT"
