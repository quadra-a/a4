#!/usr/bin/env bash

# quadra-a Relay Stress Test Script
# Advanced stress testing with configurable scenarios
# Usage: ./stress-test-relay.sh [relay_url] [a4_binary_path] [scenario]

set -e

if [[ -n "${BASH_VERSION:-}" && "${BASH_VERSINFO[0]:-0}" -lt 4 && -z "${ZSH_VERSION:-}" ]]; then
    if command -v zsh >/dev/null 2>&1; then
        exec zsh "$0" "$@"
    fi
fi

# Load test configuration
source "$(dirname "$0")/test-config.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"

# Configuration
RELAY_URL="${1:-$DEFAULT_RELAY_URL}"
CLI_MODE="${2:-rust}"
CUSTOM_BINARY="${3:-}"
SCENARIO="${4:-basic}"  # Default scenario (moved to 4th parameter)

# Resolve A4_BINARY based on CLI_MODE and CUSTOM_BINARY
if [[ -n "$CUSTOM_BINARY" ]]; then
    A4_BINARY="$CUSTOM_BINARY"
elif [[ "$CLI_MODE" == "rust" ]]; then
    A4_BINARY="$DEFAULT_A4_BINARY"
elif [[ "$CLI_MODE" == "node" ]]; then
    A4_BINARY="$NODE_CLI_DIRECT"
else
    A4_BINARY="$DEFAULT_A4_BINARY"
fi
# SCENARIO moved to 4th parameter - see above
TEST_DID="did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"
STRESS_DIR="$TEST_OUTPUT_ROOT/stress-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$STRESS_DIR/stress_test_$TIMESTAMP.json"

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

# Test scenarios configuration
declare -A SCENARIOS

# Default scenario
SCENARIOS[default]="connections:50,duration:60,rate:20,payload:1000"

# Light stress
SCENARIOS[light]="connections:10,duration:30,rate:5,payload:500"

# Medium stress
SCENARIOS[medium]="connections:25,duration:60,rate:15,payload:2000"

# Heavy stress
SCENARIOS[heavy]="connections:100,duration:120,rate:50,payload:5000"

# Extreme stress
SCENARIOS[extreme]="connections:200,duration:300,rate:100,payload:10000"

# Endurance test
SCENARIOS[endurance]="connections:20,duration:1800,rate:10,payload:1000"

# Burst test
SCENARIOS[burst]="connections:500,duration:10,rate:200,payload:100"

# Create results directory
mkdir -p "$STRESS_DIR"

# Parse scenario configuration
parse_scenario() {
    local scenario_config="${SCENARIOS[$SCENARIO]}"

    if [[ -z "$scenario_config" ]]; then
        log_error "Unknown scenario: $SCENARIO"
        log_info "Available scenarios: ${!SCENARIOS[@]}"
        exit 1
    fi

    # Parse configuration
    IFS=',' read -ra CONFIG <<< "$scenario_config"
    for param in "${CONFIG[@]}"; do
        IFS=':' read -ra PAIR <<< "$param"
        case "${PAIR[0]}" in
            connections) MAX_CONNECTIONS="${PAIR[1]}" ;;
            duration) TEST_DURATION="${PAIR[1]}" ;;
            rate) MESSAGE_RATE="${PAIR[1]}" ;;
            payload) PAYLOAD_SIZE="${PAIR[1]}" ;;
        esac
    done

    log_info "Scenario: $SCENARIO"
    log_info "Max Connections: $MAX_CONNECTIONS"
    log_info "Duration: ${TEST_DURATION}s"
    log_info "Message Rate: ${MESSAGE_RATE}/s"
    log_info "Payload Size: ${PAYLOAD_SIZE}B"
}

# Initialize results tracking
init_results() {
    cat > "$RESULTS_FILE" << EOF
{
  "test_info": {
    "scenario": "$SCENARIO",
    "relay_url": "$RELAY_URL",
    "timestamp": "$(quadra_iso_timestamp)",
    "max_connections": $MAX_CONNECTIONS,
    "duration": $TEST_DURATION,
    "message_rate": $MESSAGE_RATE,
    "payload_size": $PAYLOAD_SIZE
  },
  "results": {
    "connection_tests": [],
    "message_tests": [],
    "discovery_tests": [],
    "performance_metrics": {}
  }
}
EOF
}

# Add result to JSON
add_result() {
    local test_type="$1"
    local result_data="$2"

    # Use jq to add result (if available), otherwise append manually
    if command -v jq &> /dev/null; then
        local temp_file=$(mktemp)
        jq ".results.${test_type} += [$result_data]" "$RESULTS_FILE" > "$temp_file"
        mv "$temp_file" "$RESULTS_FILE"
    fi
}

# Connection stress test
connection_stress_test() {
    log_info "=== CONNECTION STRESS TEST ==="

    local successful_connections=0
    local failed_connections=0
    local connection_times=()

    log_info "Testing $MAX_CONNECTIONS concurrent connections..."

    local start_time=$(date +%s%N)

    # Start concurrent connections
    for ((i=1; i<=MAX_CONNECTIONS; i++)); do
        {
            local conn_start=$(date +%s%N)
            if quadra_run_with_timeout 30 $A4_BINARY join --relay "$RELAY_URL" --json >/dev/null 2>&1; then
                local conn_end=$(date +%s%N)
                local conn_time=$(((conn_end - conn_start) / 1000000))
                echo "SUCCESS:$conn_time" >> "$STRESS_DIR/connections_$TIMESTAMP.tmp"
            else
                echo "FAILURE" >> "$STRESS_DIR/connections_$TIMESTAMP.tmp"
            fi
        } &

        # Limit concurrent processes to avoid system overload
        if ((i % 50 == 0)); then
            wait
        fi

        # Small delay to avoid overwhelming the system
        sleep 0.01
    done

    wait
    local end_time=$(date +%s%N)
    local total_time=$(((end_time - start_time) / 1000000))

    # Process results
    if [[ -f "$STRESS_DIR/connections_$TIMESTAMP.tmp" ]]; then
        successful_connections=$(grep -c "SUCCESS" "$STRESS_DIR/connections_$TIMESTAMP.tmp" || echo "0")
        failed_connections=$(grep -c "FAILURE" "$STRESS_DIR/connections_$TIMESTAMP.tmp" || echo "0")
        rm -f "$STRESS_DIR/connections_$TIMESTAMP.tmp"
    fi

    local success_rate
    success_rate="$(quadra_divide "$successful_connections" "$MAX_CONNECTIONS" 2 100)"

    # Check if test passed (require at least 80% success rate)
    if [[ $successful_connections -eq 0 ]]; then
        log_error "Connection test FAILED: 0/$MAX_CONNECTIONS successful"
        local result_data="{\"successful\": $successful_connections, \"failed\": $failed_connections, \"total_time_ms\": $total_time, \"success_rate\": $success_rate}"
        add_result "connection_tests" "$result_data"
        return 1
    elif [[ $(echo "$success_rate < 80" | bc -l) -eq 1 ]]; then
        log_warning "Connection test completed with low success rate: $successful_connections/$MAX_CONNECTIONS (${success_rate}%)"
        log_info "Total time: ${total_time}ms"
        local result_data="{\"successful\": $successful_connections, \"failed\": $failed_connections, \"total_time_ms\": $total_time, \"success_rate\": $success_rate}"
        add_result "connection_tests" "$result_data"
        return 1
    else
        log_success "Connection test completed"
        log_info "Successful: $successful_connections/$MAX_CONNECTIONS (${success_rate}%)"
        log_info "Total time: ${total_time}ms"
        local result_data="{\"successful\": $successful_connections, \"failed\": $failed_connections, \"total_time_ms\": $total_time, \"success_rate\": $success_rate}"
        add_result "connection_tests" "$result_data"
        return 0
    fi
}

# Message throughput stress test
message_throughput_test() {
    log_info "=== MESSAGE THROUGHPUT STRESS TEST ==="

    local total_messages=$((MESSAGE_RATE * TEST_DURATION))
    local successful_messages=0
    local failed_messages=0
    local message_times=()

    log_info "Sending $total_messages messages over ${TEST_DURATION}s (${MESSAGE_RATE}/s)"

    local start_time=$(date +%s)
    local message_interval
    message_interval="$(quadra_divide 1 "$MESSAGE_RATE" 3)"

    # Generate test payload
    local test_payload="{\"stress_test\":true,\"data\":\"$(python3 -c "print('X' * $PAYLOAD_SIZE)")\"}"

    for ((i=1; i<=total_messages; i++)); do
        local msg_start=$(date +%s%N)

        if $A4_BINARY tell "$TEST_DID" --payload "$test_payload" --protocol "stress/throughput/1.0" --relay $RELAY_URL >/dev/null 2>&1; then
            ((successful_messages++))
        else
            ((failed_messages++))
        fi

        # Rate limiting
        sleep "$message_interval"

        # Progress update
        if ((i % (total_messages / 10) == 0)); then
            local progress=$((i * 100 / total_messages))
            local elapsed=$(($(date +%s) - start_time))
            local current_rate
            current_rate="$(quadra_divide "$i" "$elapsed" 1)"
            log_info "Progress: ${progress}% (${i}/${total_messages}, ${current_rate}/s)"
        fi

        # Check if we should stop early
        local elapsed=$(($(date +%s) - start_time))
        if ((elapsed >= TEST_DURATION)); then
            break
        fi
    done

    local end_time=$(date +%s)
    local actual_duration=$((end_time - start_time))
    local actual_rate
    local success_rate
    actual_rate="$(quadra_divide "$successful_messages" "$actual_duration" 2)"
    success_rate="$(quadra_divide "$successful_messages" "$((successful_messages + failed_messages))" 2 100)"

    # Check if test passed (require at least 80% success rate)
    if [[ $successful_messages -eq 0 ]]; then
        log_error "Throughput test FAILED: 0/$((successful_messages + failed_messages)) successful - all messages failed"
        local result_data="{\"total_sent\": $((successful_messages + failed_messages)), \"successful\": $successful_messages, \"failed\": $failed_messages, \"actual_rate\": $actual_rate, \"duration\": $actual_duration, \"success_rate\": $success_rate}"
        add_result "message_tests" "$result_data"
        return 1
    elif [[ $(echo "$success_rate < 80" | bc -l) -eq 1 ]]; then
        log_warning "Throughput test completed with low success rate"
        log_info "Messages sent: $((successful_messages + failed_messages))"
        log_info "Successful: $successful_messages (${success_rate}%)"
        log_info "Actual rate: ${actual_rate}/s"
        log_info "Duration: ${actual_duration}s"
        local result_data="{\"total_sent\": $((successful_messages + failed_messages)), \"successful\": $successful_messages, \"failed\": $failed_messages, \"actual_rate\": $actual_rate, \"duration\": $actual_duration, \"success_rate\": $success_rate}"
        add_result "message_tests" "$result_data"
        return 1
    else
        log_success "Throughput test completed"
        log_info "Messages sent: $((successful_messages + failed_messages))"
        log_info "Successful: $successful_messages (${success_rate}%)"
        log_info "Actual rate: ${actual_rate}/s"
        log_info "Duration: ${actual_duration}s"
        local result_data="{\"total_sent\": $((successful_messages + failed_messages)), \"successful\": $successful_messages, \"failed\": $failed_messages, \"actual_rate\": $actual_rate, \"duration\": $actual_duration, \"success_rate\": $success_rate}"
        add_result "message_tests" "$result_data"
        return 0
    fi
}

# Discovery stress test
discovery_stress_test() {
    log_info "=== DISCOVERY STRESS TEST ==="

    local discovery_queries=("" "WebSocket" "relay" "routes messages" "indexes agents" "nonexistent")
    local queries_per_second=10
    local discovery_duration=30
    local total_queries=$((queries_per_second * discovery_duration))

    local successful_queries=0
    local failed_queries=0
    local query_times=()

    log_info "Running $total_queries discovery queries over ${discovery_duration}s"

    local start_time=$(date +%s)
    local query_interval
    query_interval="$(quadra_divide 1 "$queries_per_second" 3)"

    for ((i=1; i<=total_queries; i++)); do
        local query=${discovery_queries[$((i % ${#discovery_queries[@]}))]}
        local query_start=$(date +%s%N)

        if $A4_BINARY find --query "$query" --relay $RELAY_URL >/dev/null 2>&1; then
            local query_end=$(date +%s%N)
            local query_time=$(((query_end - query_start) / 1000000))
            query_times+=($query_time)
            ((successful_queries++))
        else
            ((failed_queries++))
        fi

        sleep "$query_interval"

        # Check duration
        local elapsed=$(($(date +%s) - start_time))
        if ((elapsed >= discovery_duration)); then
            break
        fi
    done

    local end_time=$(date +%s)
    local actual_duration=$((end_time - start_time))
    local success_rate
    success_rate="$(quadra_divide "$successful_queries" "$((successful_queries + failed_queries))" 2 100)"

    # Calculate average query time
    local avg_query_time=0
    if ((successful_queries > 0)); then
        local total_time=0
        for time in "${query_times[@]}"; do
            total_time=$((total_time + time))
        done
        avg_query_time=$((total_time / successful_queries))
    fi

    # Check if test passed (require at least 80% success rate)
    if [[ $successful_queries -eq 0 ]]; then
        log_error "Discovery stress test FAILED: 0/$((successful_queries + failed_queries)) successful - all queries failed"
        local result_data="{\"total_queries\": $((successful_queries + failed_queries)), \"successful\": $successful_queries, \"failed\": $failed_queries, \"avg_time_ms\": $avg_query_time, \"success_rate\": $success_rate}"
        add_result "discovery_tests" "$result_data"
        return 1
    elif [[ $(echo "$success_rate < 80" | bc -l) -eq 1 ]]; then
        log_warning "Discovery stress test completed with low success rate"
        log_info "Queries: $((successful_queries + failed_queries))"
        log_info "Successful: $successful_queries (${success_rate}%)"
        log_info "Average query time: ${avg_query_time}ms"
        local result_data="{\"total_queries\": $((successful_queries + failed_queries)), \"successful\": $successful_queries, \"failed\": $failed_queries, \"avg_time_ms\": $avg_query_time, \"success_rate\": $success_rate}"
        add_result "discovery_tests" "$result_data"
        return 1
    else
        log_success "Discovery stress test completed"
        log_info "Queries: $((successful_queries + failed_queries))"
        log_info "Successful: $successful_queries (${success_rate}%)"
        log_info "Average query time: ${avg_query_time}ms"
        local result_data="{\"total_queries\": $((successful_queries + failed_queries)), \"successful\": $successful_queries, \"failed\": $failed_queries, \"avg_time_ms\": $avg_query_time, \"success_rate\": $success_rate}"
        add_result "discovery_tests" "$result_data"
        return 0
    fi
}

# System resource monitoring
monitor_resources() {
    log_info "=== RESOURCE MONITORING ==="

    local monitor_duration=$TEST_DURATION
    local monitor_interval=5
    local cpu_samples=()
    local memory_samples=()

    log_info "Monitoring system resources for ${monitor_duration}s"

    for ((i=0; i<monitor_duration; i+=monitor_interval)); do
        # CPU usage (macOS)
        local cpu_usage=$(top -l 1 -n 0 | grep "CPU usage" | awk '{print $3}' | sed 's/%//' || echo "0")
        cpu_samples+=($cpu_usage)

        # Memory usage (simplified)
        local memory_pressure=$(vm_stat | grep "Pages active" | awk '{print $3}' | sed 's/\.//' || echo "0")
        memory_samples+=($memory_pressure)

        sleep $monitor_interval
    done &

    local monitor_pid=$!

    # Return monitor PID for cleanup
    echo $monitor_pid
}

# Generate stress test report
generate_stress_report() {
    log_info "=== GENERATING STRESS TEST REPORT ==="

    local report_file="$STRESS_DIR/stress_report_$TIMESTAMP.txt"

    cat > "$report_file" << EOF
quadra-a Relay Stress Test Report
==================================
Date: $(date)
Scenario: $SCENARIO
Relay URL: $RELAY_URL
A4 Binary: $A4_BINARY

Test Configuration:
==================
Max Connections: $MAX_CONNECTIONS
Test Duration: ${TEST_DURATION}s
Message Rate: ${MESSAGE_RATE}/s
Payload Size: ${PAYLOAD_SIZE}B

Results Summary:
===============
EOF

    # Extract results from JSON if available
    if [[ -f "$RESULTS_FILE" ]] && command -v jq &> /dev/null; then
        echo "Connection Tests:" >> "$report_file"
        jq -r '.results.connection_tests[] | "- Success Rate: \(.success_rate)%, Total Time: \(.total_time_ms)ms"' "$RESULTS_FILE" >> "$report_file" 2>/dev/null || echo "- No connection test data" >> "$report_file"

        echo "" >> "$report_file"
        echo "Message Tests:" >> "$report_file"
        jq -r '.results.message_tests[] | "- Success Rate: \(.success_rate)%, Actual Rate: \(.actual_rate)/s"' "$RESULTS_FILE" >> "$report_file" 2>/dev/null || echo "- No message test data" >> "$report_file"

        echo "" >> "$report_file"
        echo "Discovery Tests:" >> "$report_file"
        jq -r '.results.discovery_tests[] | "- Success Rate: \(.success_rate)%, Avg Time: \(.avg_time_ms)ms"' "$RESULTS_FILE" >> "$report_file" 2>/dev/null || echo "- No discovery test data" >> "$report_file"
    fi

    cat >> "$report_file" << EOF

Files:
======
- Detailed Results: $RESULTS_FILE
- Report: $report_file

Generated: $(date)
EOF

    echo "$report_file"
}

# Main stress test execution
main() {
    echo "=================================================="
    echo "quadra-a Relay Stress Test"
    echo "=================================================="
    echo "Scenario: $SCENARIO"
    echo "Relay URL: $RELAY_URL"
    echo "A4 Binary: $A4_BINARY"
    echo "=================================================="

    # Check prerequisites
    if [[ ! -f "$A4_BINARY" ]]; then
        log_error "a4 binary not found at: $A4_BINARY"
        exit 1
    fi

    if ! command -v bc &> /dev/null; then
        log_error "bc is required for calculations"
        exit 1
    fi

    # Parse scenario configuration
    parse_scenario

    # Initialize results
    init_results

    # Start resource monitoring
    local monitor_pid=$(monitor_resources)

    # Run stress tests
    local test_failures=0
    if ! connection_stress_test; then
        ((test_failures++))
    fi
    if ! message_throughput_test; then
        ((test_failures++))
    fi
    if ! discovery_stress_test; then
        ((test_failures++))
    fi

    # Stop resource monitoring
    kill $monitor_pid 2>/dev/null || true

    # Generate report
    local report_file=$(generate_stress_report)

    echo "=================================================="
    if [[ $test_failures -eq 0 ]]; then
        echo -e "${GREEN}✅ Stress test completed successfully!${NC}"
        echo "Scenario: $SCENARIO"
        echo "Report: $report_file"
        echo "Results: $RESULTS_FILE"
        echo "=================================================="
        exit 0
    else
        echo -e "${RED}❌ Stress test completed with $test_failures failure(s)${NC}"
        echo "Scenario: $SCENARIO"
        echo "Report: $report_file"
        echo "Results: $RESULTS_FILE"
        echo "=================================================="
        exit 1
    fi
}

# Show available scenarios
show_scenarios() {
    echo "Available stress test scenarios:"
    echo "==============================="
    for scenario in "${!SCENARIOS[@]}"; do
        echo "- $scenario: ${SCENARIOS[$scenario]}"
    done
    echo ""
    echo "Usage: $0 [relay_url] [a4_binary_path] [scenario]"
}

# Handle help and scenario listing
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    show_scenarios
    exit 0
fi

if [[ "$1" == "--list-scenarios" ]]; then
    show_scenarios
    exit 0
fi

# Run main function
main "$@"
