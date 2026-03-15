#!/usr/bin/env bash

# quadra-a Relay Performance Benchmark Script
# Measures relay performance metrics and generates reports
# Usage: ./benchmark-relay.sh [relay_url] [cli_mode] [binary_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"
# shellcheck source=./test-config.sh
source "$SCRIPT_DIR/test-config.sh"

# Configuration
RELAY_URL="${1:-$DEFAULT_RELAY_URL}"
CLI_MODE="${2:-rust}"
CUSTOM_BINARY="${3:-}"
TEST_DID="${TEST_DID:-did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe}"
BENCHMARK_SESSION_MODE="${BENCHMARK_SESSION_MODE:-auto}"
BENCHMARK_DIR="$PROJECT_ROOT/benchmark-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
REPORT_FILE="$BENCHMARK_DIR/relay_benchmark_$TIMESTAMP.txt"
TEMP_DAEMON_STARTED=false
EFFECTIVE_SESSION_MODE="direct"
SESSION_NOTE="direct relay fallback"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }

resolve_project_path() {
    local candidate="$1"
    if [[ "$candidate" == ./* ]]; then
        echo "$PROJECT_ROOT/${candidate#./}"
        return
    fi

    echo "$candidate"
}

resolve_a4_binary() {
    if [[ -n "$CUSTOM_BINARY" ]]; then
        resolve_project_path "$CUSTOM_BINARY"
        return
    fi

    case "$CLI_MODE" in
        rust)
            local release_binary
            local debug_binary
            release_binary="$(resolve_project_path "$DEFAULT_A4_BINARY")"
            debug_binary="$(resolve_project_path "$DEBUG_A4_BINARY")"

            if [[ -f "$release_binary" ]]; then
                echo "$release_binary"
            elif [[ -f "$debug_binary" ]]; then
                echo "$debug_binary"
            elif [[ -f "$PROJECT_ROOT/rust/cli-rs/target/release/a4" ]]; then
                echo "$PROJECT_ROOT/rust/cli-rs/target/release/a4"
            elif [[ -f "$PROJECT_ROOT/rust/cli-rs/target/debug/a4" ]]; then
                echo "$PROJECT_ROOT/rust/cli-rs/target/debug/a4"
            else
                echo "a4"
            fi
            ;;
        node)
            local node_binary
            node_binary="$(resolve_project_path "$NODE_CLI_DIRECT")"
            if [[ -f "$node_binary" ]]; then
                echo "$node_binary"
            else
                echo "a4"
            fi
            ;;
        *)
            echo "$(resolve_project_path "$DEFAULT_A4_BINARY")"
            ;;
    esac
}

A4_BINARY="$(resolve_a4_binary)"

mkdir -p "$BENCHMARK_DIR"

status_output() {
    "$A4_BINARY" daemon status 2>&1 || true
}

daemon_is_running() {
    local output="$1"
    [[ "$output" == *"Daemon is running"* || "$output" == *"Daemon running"* ]]
}

daemon_targets_requested_relay() {
    local output="$1"
    [[ "$output" == *"$RELAY_URL"* ]]
}

start_background_listener() {
    if "$A4_BINARY" listen --background --relay "$RELAY_URL" >/dev/null 2>&1; then
        local attempt output
        for attempt in {1..40}; do
            output="$(status_output)"
            if daemon_is_running "$output" && daemon_targets_requested_relay "$output"; then
                return 0
            fi
            sleep 0.25
        done
    fi

    return 1
}

setup_benchmark_session() {
    local current_status
    current_status="$(status_output)"

    case "$BENCHMARK_SESSION_MODE" in
        direct)
            EFFECTIVE_SESSION_MODE="direct"
            SESSION_NOTE="direct relay fallback"
            ;;
        auto)
            if daemon_is_running "$current_status" && daemon_targets_requested_relay "$current_status"; then
                EFFECTIVE_SESSION_MODE="daemon"
                SESSION_NOTE="reused existing background listener"
                return
            fi

            if daemon_is_running "$current_status" && ! daemon_targets_requested_relay "$current_status"; then
                log_warning "Daemon is already running on a different relay; keeping benchmark on direct mode for $RELAY_URL"
                EFFECTIVE_SESSION_MODE="direct"
                SESSION_NOTE="direct relay fallback (existing daemon targets another relay)"
                return
            fi

            if start_background_listener; then
                TEMP_DAEMON_STARTED=true
                EFFECTIVE_SESSION_MODE="daemon"
                SESSION_NOTE="started temporary background listener"
            else
                log_warning "Could not start background listener; falling back to direct relay mode"
                EFFECTIVE_SESSION_MODE="direct"
                SESSION_NOTE="direct relay fallback (listener startup failed)"
            fi
            ;;
        daemon)
            if daemon_is_running "$current_status" && daemon_targets_requested_relay "$current_status"; then
                EFFECTIVE_SESSION_MODE="daemon"
                SESSION_NOTE="reused existing background listener"
                return
            fi

            if start_background_listener; then
                TEMP_DAEMON_STARTED=true
                EFFECTIVE_SESSION_MODE="daemon"
                SESSION_NOTE="started temporary background listener"
            else
                log_error "Requested daemon-backed benchmark mode, but listener startup failed"
                exit 1
            fi
            ;;
        *)
            log_error "Unknown BENCHMARK_SESSION_MODE: $BENCHMARK_SESSION_MODE"
            log_info "Supported values: auto, daemon, direct"
            exit 1
            ;;
    esac
}

cleanup_benchmark_session() {
    if [[ "$TEMP_DAEMON_STARTED" != "true" ]]; then
        return
    fi

    "$A4_BINARY" stop >/dev/null 2>&1 || "$A4_BINARY" daemon stop >/dev/null 2>&1 || true
}

trap cleanup_benchmark_session EXIT

init_report() {
    cat > "$REPORT_FILE" <<EOF2
quadra-a Relay Performance Benchmark Report
============================================
Date: $(date)
Relay URL: $RELAY_URL
A4 Binary: $A4_BINARY
Benchmark Session Mode: $EFFECTIVE_SESSION_MODE
Benchmark Session Note: $SESSION_NOTE
Timeout Backend: $(quadra_timeout_label)
Test DID: $TEST_DID
System: $(uname -a)
============================================

Notes:
- Discovery and messaging numbers measure end-to-end CLI wall-clock time.
- Direct mode includes process startup and relay session setup on each command.
- Daemon mode reuses a persistent background listener for lower latency.

EOF2
}

measure_command() {
    local description="$1"
    shift

    echo "   🔍 $description..."

    local start_time end_time duration_ns duration_ms
    start_time="$(quadra_now_ns)"
    if "$@" >/dev/null 2>&1; then
        end_time="$(quadra_now_ns)"
        duration_ns=$((end_time - start_time))
        duration_ms=$((duration_ns / 1000000))

        echo "$description: ${duration_ms}ms" >> "$REPORT_FILE"
        log_success "$description: ${duration_ms}ms"
        return 0
    else
        echo "$description: FAILED" >> "$REPORT_FILE"
        log_error "$description: FAILED"
        return 1
    fi
}

benchmark_discovery() {
    log_info "=== DISCOVERY PERFORMANCE BENCHMARK ==="
    echo "" >> "$REPORT_FILE"
    echo "Discovery Performance:" >> "$REPORT_FILE"
    echo "=====================" >> "$REPORT_FILE"

    local failures=0
    measure_command "Basic Discovery" "$A4_BINARY" find --relay "$RELAY_URL" || ((failures++))
    measure_command "WebSocket Query Discovery" "$A4_BINARY" find --query "WebSocket" --relay "$RELAY_URL" || ((failures++))
    measure_command "Multi-word Query Discovery" "$A4_BINARY" find --query "routes messages" --relay "$RELAY_URL" || ((failures++))
    measure_command "Non-existent Query Discovery" "$A4_BINARY" find --query "nonexistent" --relay "$RELAY_URL" || ((failures++))
    measure_command "Limited Discovery" "$A4_BINARY" find --limit 5 --relay "$RELAY_URL" || ((failures++))

    return $failures
}

benchmark_messaging() {
    log_info "=== MESSAGE SENDING PERFORMANCE BENCHMARK ==="
    echo "" >> "$REPORT_FILE"
    echo "Message Sending Performance:" >> "$REPORT_FILE"
    echo "===========================" >> "$REPORT_FILE"

    local json_payload
    json_payload=$(printf '{"test":"benchmark","timestamp":"%s"}' "$(quadra_iso_timestamp)")

    local failures=0
    measure_command "Basic Message Send" "$A4_BINARY" tell "$TEST_DID" "Benchmark test" --relay "$RELAY_URL" || ((failures++))
    measure_command "Message with Wait Flag" "$A4_BINARY" tell "$TEST_DID" "Request test" --wait --relay "$RELAY_URL" || ((failures++))
    measure_command "Custom Protocol Message" "$A4_BINARY" tell "$TEST_DID" "Custom protocol test" --protocol "benchmark/test/1.0" --relay "$RELAY_URL" || ((failures++))
    measure_command "JSON Payload Message" "$A4_BINARY" tell "$TEST_DID" --body "$json_payload" --body-format json --relay "$RELAY_URL" || ((failures++))

    return $failures
}

benchmark_payload_sizes() {
    log_info "=== PAYLOAD SIZE PERFORMANCE BENCHMARK ==="
    echo "" >> "$REPORT_FILE"
    echo "Payload Size Performance:" >> "$REPORT_FILE"
    echo "========================" >> "$REPORT_FILE"

    local sizes=(100 1000 5000 10000 25000 50000)
    local size payload failures=0

    for size in "${sizes[@]}"; do
        payload=$(python3 - "$size" <<'PY'
import json
import sys

size = int(sys.argv[1])
print(json.dumps({"test": f"payload_size_{size}", "data": "A" * size}, separators=(",", ":")))
PY
)
        measure_command "${size}B Payload" "$A4_BINARY" tell "$TEST_DID" --body "$payload" --body-format json --protocol "benchmark/size-$size/1.0" --relay "$RELAY_URL" || ((failures++))
    done

    return $failures
}

benchmark_sequential_throughput() {
    log_info "=== SEQUENTIAL THROUGHPUT BENCHMARK ==="
    echo "" >> "$REPORT_FILE"
    echo "Sequential Throughput:" >> "$REPORT_FILE"
    echo "=====================" >> "$REPORT_FILE"

    # Reduced counts to avoid connection pool saturation
    local counts=(5 10 20 50)
    local count i start_time end_time duration_ns duration_ms throughput

    for count in "${counts[@]}"; do
        log_info "Testing $count sequential messages..."

        start_time="$(quadra_now_ns)"
        for ((i=1; i<=count; i++)); do
            "$A4_BINARY" tell "$TEST_DID" "Sequential test $i/$count" --protocol "benchmark/sequential/1.0" --relay "$RELAY_URL" >/dev/null 2>&1

            # Add small delay to prevent connection pool exhaustion
            if [[ $i -lt $count && $count -gt 20 ]]; then
                sleep 0.05  # 50ms delay for larger batches
            fi
        done
        end_time="$(quadra_now_ns)"

        duration_ns=$((end_time - start_time))
        duration_ms=$((duration_ns / 1000000))
        throughput="$(quadra_divide "$count" "$duration_ms" 2 1000)"

        echo "$count messages: ${duration_ms}ms (${throughput} msg/s)" >> "$REPORT_FILE"
        log_success "$count sequential messages: ${duration_ms}ms (${throughput} msg/s)"
    done
}

benchmark_concurrent_throughput() {
    log_info "=== CONCURRENT THROUGHPUT BENCHMARK ==="
    echo "" >> "$REPORT_FILE"
    echo "Concurrent Throughput:" >> "$REPORT_FILE"
    echo "=====================" >> "$REPORT_FILE"

    # Reduced counts to avoid overwhelming the relay server
    local counts=(5 10 20)
    local count i start_time end_time duration_ns duration_ms throughput
    local pids=()

    for count in "${counts[@]}"; do
        log_info "Testing $count concurrent messages..."
        pids=()
        start_time="$(quadra_now_ns)"

        for ((i=1; i<=count; i++)); do
            "$A4_BINARY" tell "$TEST_DID" "Concurrent test $i/$count" --protocol "benchmark/concurrent/1.0" --relay "$RELAY_URL" >/dev/null 2>&1 &
            pids+=("$!")

            # Add small stagger to prevent connection burst
            if [[ $count -gt 10 ]]; then
                sleep 0.01  # 10ms stagger for larger concurrent batches
            fi
        done

        local failed_jobs=0
        for pid in "${pids[@]}"; do
            if ! wait "$pid"; then
                ((failed_jobs+=1))
            fi
        done
        end_time="$(quadra_now_ns)"

        duration_ns=$((end_time - start_time))
        duration_ms=$((duration_ns / 1000000))
        throughput="$(quadra_divide "$count" "$duration_ms" 2 1000)"

        if [[ "$failed_jobs" -gt 0 ]]; then
            echo "$count concurrent messages: FAILED (${failed_jobs} jobs failed)" >> "$REPORT_FILE"
            log_error "$count concurrent messages failed (${failed_jobs} jobs failed)"
            continue
        fi

        echo "$count concurrent messages: ${duration_ms}ms (${throughput} msg/s)" >> "$REPORT_FILE"
        log_success "$count concurrent messages: ${duration_ms}ms (${throughput} msg/s)"
    done
}

benchmark_daemon() {
    log_info "=== DAEMON OPERATIONS BENCHMARK ==="
    echo "" >> "$REPORT_FILE"
    echo "Daemon Operations:" >> "$REPORT_FILE"
    echo "=================" >> "$REPORT_FILE"

    measure_command "Daemon Status Check" "$A4_BINARY" daemon status
    measure_command "Inbox Check" "$A4_BINARY" inbox
    measure_command "A4 Status Check" "$A4_BINARY" status
}

extract_metric_ms() {
    local label="$1"
    local value
    value="$(grep -m1 "$label:" "$REPORT_FILE" | cut -d: -f2 | tr -d ' ms' || true)"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
        echo "$value"
    else
        echo "-1"
    fi
}

generate_summary() {
    log_info "=== GENERATING PERFORMANCE SUMMARY ==="
    echo "" >> "$REPORT_FILE"
    echo "Performance Summary:" >> "$REPORT_FILE"
    echo "===================" >> "$REPORT_FILE"

    local basic_discovery basic_message large_payload rating
    basic_discovery="$(extract_metric_ms "Basic Discovery")"
    basic_message="$(extract_metric_ms "Basic Message Send")"
    large_payload="$(extract_metric_ms "50000B Payload")"

    echo "Key Metrics:" >> "$REPORT_FILE"
    echo "- Discovery Latency: ${basic_discovery}ms" >> "$REPORT_FILE"
    echo "- Message Latency: ${basic_message}ms" >> "$REPORT_FILE"
    echo "- Large Payload (50KB): ${large_payload}ms" >> "$REPORT_FILE"

    rating="UNKNOWN"
    if [[ "$basic_discovery" -ge 0 && "$basic_message" -ge 0 ]]; then
        if [[ "$basic_discovery" -lt 500 && "$basic_message" -lt 1000 ]]; then
            rating="EXCELLENT"
        elif [[ "$basic_discovery" -lt 1000 && "$basic_message" -lt 2000 ]]; then
            rating="GOOD"
        elif [[ "$basic_discovery" -lt 2000 && "$basic_message" -lt 5000 ]]; then
            rating="ACCEPTABLE"
        else
            rating="POOR"
        fi
    fi

    echo "" >> "$REPORT_FILE"
    echo "Overall Performance Rating: $rating" >> "$REPORT_FILE"

    log_success "Performance rating: $rating"
}

main() {
    echo "=================================================="
    echo "quadra-a Relay Performance Benchmark"
    echo "=================================================="
    echo "Relay URL: $RELAY_URL"
    echo "A4 Binary: $A4_BINARY"
    echo "Requested Session Mode: $BENCHMARK_SESSION_MODE"
    echo "Report File: $REPORT_FILE"
    echo "=================================================="

    if [[ "$A4_BINARY" != "a4" && ! -f "$A4_BINARY" ]]; then
        log_error "a4 binary not found at: $A4_BINARY"
        exit 1
    fi

    setup_benchmark_session
    init_report

    local total_failures=0
    benchmark_discovery || total_failures=$((total_failures + $?))
    benchmark_messaging || total_failures=$((total_failures + $?))
    benchmark_payload_sizes || total_failures=$((total_failures + $?))
    benchmark_sequential_throughput
    benchmark_concurrent_throughput
    benchmark_daemon
    generate_summary

    echo "" >> "$REPORT_FILE"
    echo "Benchmark completed at: $(date)" >> "$REPORT_FILE"

    echo "=================================================="
    if [[ $total_failures -eq 0 ]]; then
        echo -e "${GREEN}✅ Benchmark completed successfully!${NC}"
    else
        echo -e "${YELLOW}⚠️  Benchmark completed with $total_failures failure(s)${NC}"
    fi
    echo "Report saved to: $REPORT_FILE"
    echo "=================================================="
    echo ""
    echo "Performance Summary:"
    tail -n 10 "$REPORT_FILE"

    # Exit with success even if some tests failed (benchmark is informational)
    exit 0
}

main "$@"
