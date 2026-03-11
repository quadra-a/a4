relay_deployment_log_info() {
  if [[ "${JSON_OUTPUT:-false}" != true ]]; then
    echo -e "${BLUE}[INFO]${NC} $1"
  fi
}

relay_deployment_log_success() {
  if [[ "${JSON_OUTPUT:-false}" != true ]]; then
    echo -e "${GREEN}[PASS]${NC} $1"
  fi
}

relay_deployment_log_warning() {
  if [[ "${JSON_OUTPUT:-false}" != true ]]; then
    echo -e "${YELLOW}[WARN]${NC} $1"
  fi
}

relay_deployment_log_error() {
  if [[ "${JSON_OUTPUT:-false}" != true ]]; then
    echo -e "${RED}[FAIL]${NC} $1" >&2
  fi
}

relay_deployment_require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    relay_deployment_log_error "Missing required command: $command_name"
    exit 1
  fi
}

relay_deployment_cleanup() {
  set +e
  for pid in "${RELAY_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  if [[ -n "${TEMP_ROOT:-}" ]]; then
    if [[ "${KEEP_DATA:-false}" == true ]]; then
      relay_deployment_log_info "Kept temporary artifacts at $TEMP_ROOT"
    else
      rm -rf "$TEMP_ROOT"
    fi
  fi
}

relay_deployment_wait_for_log_pattern() {
  local log_file="$1"
  local pattern="$2"
  local label="$3"
  local pid="$4"

  for _ in $(seq 1 "${WAIT_STEPS}"); do
    if [[ -f "$log_file" ]] && grep -q "$pattern" "$log_file"; then
      return 0
    fi

    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      relay_deployment_log_error "$label exited before reaching pattern: $pattern"
      [[ -f "$log_file" ]] && cat "$log_file" >&2
      return 1
    fi

    sleep "$WAIT_INTERVAL_SECS"
  done

  relay_deployment_log_error "Timed out waiting for $label pattern: $pattern"
  [[ -f "$log_file" ]] && cat "$log_file" >&2
  return 1
}

relay_deployment_start_relay() {
  local name="$1"
  local port="$2"
  local data_dir="$3"
  shift 3

  local log_file="$TEMP_ROOT/${name}.log"
  (
    cd "$RELAY_DIR"
    node dist/index.js \
      --port "$port" \
      --landing-port false \
      --data-dir "$data_dir" \
      --public-endpoint "ws://127.0.0.1:${port}" \
      "$@"
  ) >"$log_file" 2>&1 &

  local pid=$!
  RELAY_PIDS+=("$pid")
  echo "$pid|$log_file"
}

relay_deployment_emit_json_summary() {
  node "$PROBE_SCRIPT" summary \
    --smoke-file "${SMOKE_RESULT_FILE:-}" \
    --federation-file "${FEDERATION_RESULT_FILE:-}" \
    --quarantine-file "${QUARANTINE_RESULT_FILE:-}"
}
