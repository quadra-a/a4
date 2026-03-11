#!/usr/bin/env bash

# quadra-a Network Connectivity Test Script
# Tests various network connectivity scenarios and failure modes
# Usage: ./test-network-connectivity.sh [relay_url] [cli_mode] [binary_path]

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"

# Configuration
RELAY_URL="${1:-$DEFAULT_RELAY_URL}"
CLI_MODE="${2:-rust}"
CUSTOM_BINARY="${3:-}"

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

NETWORK_TEST_DIR="$TEST_OUTPUT_ROOT/network-connectivity-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$NETWORK_TEST_DIR/network_connectivity_test_$TIMESTAMP.txt"

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

# Create results directory
mkdir -p "$NETWORK_TEST_DIR"

# Test counters
total_tests=0
passed_tests=0
failed_tests=0

run_network_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_exit_code="${3:-1}"  # Default expect failure
    local description="$4"
    local timeout_seconds="${5:-30}"

    ((total_tests++))
    log_info "Testing: $test_name"
    log_info "Description: $description"

    local actual_exit_code=0
    local start_time=$(date +%s)

    if quadra_run_with_timeout "$timeout_seconds" bash -c "$test_command" >/dev/null 2>&1; then
        actual_exit_code=0
    else
        actual_exit_code=$?
    fi

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    if [[ $actual_exit_code -eq $expected_exit_code ]]; then
        ((passed_tests++))
        log_success "$test_name - Expected exit code $expected_exit_code (${duration}s)"
        echo "PASS: $test_name (${duration}s)" >> "$RESULTS_FILE"
    else
        ((failed_tests++))
        log_error "$test_name - Expected exit code $expected_exit_code, got $actual_exit_code (${duration}s)"
        echo "FAIL: $test_name (expected: $expected_exit_code, got: $actual_exit_code, ${duration}s)" >> "$RESULTS_FILE"
    fi
    echo ""
}

echo "=================================================="
echo "quadra-a Network Connectivity Test Suite"
echo "=================================================="
echo "Relay URL: $RELAY_URL"
echo "A4 Binary: $A4_BINARY"
echo "CLI Mode: $CLI_MODE"
echo "Results File: $RESULTS_FILE"
echo "=================================================="

# Initialize results file
cat > "$RESULTS_FILE" << EOF
quadra-a Network Connectivity Test Results
==========================================
Date: $(date)
Relay URL: $RELAY_URL
A4 Binary: $A4_BINARY
CLI Mode: $CLI_MODE

Test Results:
=============
EOF

log_info "Starting network connectivity tests..."

# Test 1: Invalid hostname
run_network_test \
    "Invalid Hostname" \
    "A4_RELAY_URLS='ws://nonexistent-host-12345.invalid:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with non-existent hostname" \
    15

# Test 2: Invalid port
run_network_test \
    "Invalid Port" \
    "A4_RELAY_URLS='ws://relay-sg-1.quadra-a.com:99999' $A4_BINARY find test" \
    1 \
    "Test behavior with invalid port number" \
    15

# Test 3: Wrong protocol (HTTP instead of WebSocket)
run_network_test \
    "Wrong Protocol HTTP" \
    "A4_RELAY_URLS='http://relay-sg-1.quadra-a.com:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with HTTP instead of WebSocket protocol" \
    15

# Test 4: HTTPS instead of WebSocket
run_network_test \
    "Wrong Protocol HTTPS" \
    "A4_RELAY_URLS='https://relay-sg-1.quadra-a.com:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with HTTPS instead of WebSocket protocol" \
    15

# Test 5: Malformed URL
run_network_test \
    "Malformed URL" \
    "A4_RELAY_URLS='not-a-valid-url' $A4_BINARY find test" \
    1 \
    "Test behavior with completely malformed URL" \
    10

# Test 6: Empty URL
run_network_test \
    "Empty URL" \
    "A4_RELAY_URLS='' $A4_BINARY find test" \
    1 \
    "Test behavior with empty relay URL" \
    10

# Test 7: Multiple invalid URLs
run_network_test \
    "Multiple Invalid URLs" \
    "A4_RELAY_URLS='ws://invalid1.test:8080,ws://invalid2.test:8080,ws://invalid3.test:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with multiple invalid relay URLs" \
    20

# Test 8: Connection timeout (very slow response simulation)
run_network_test \
    "Connection Timeout" \
    "A4_RELAY_URLS='ws://httpbin.org:80' $A4_BINARY find test" \
    1 \
    "Test behavior with connection that times out" \
    10

# Test 9: DNS resolution failure
run_network_test \
    "DNS Resolution Failure" \
    "A4_RELAY_URLS='ws://this-domain-should-not-exist-12345.com:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with DNS resolution failure" \
    15

# Test 10: Port blocked/filtered
run_network_test \
    "Blocked Port" \
    "A4_RELAY_URLS='ws://google.com:12345' $A4_BINARY find test" \
    1 \
    "Test behavior with blocked/filtered port" \
    15

# Test 11: Valid host but wrong service
run_network_test \
    "Wrong Service" \
    "A4_RELAY_URLS='ws://google.com:80' $A4_BINARY find test" \
    1 \
    "Test behavior with valid host but wrong service" \
    15

# Test 12: IPv6 address (if supported)
run_network_test \
    "IPv6 Address" \
    "A4_RELAY_URLS='ws://[::1]:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with IPv6 address" \
    10

# Test 13: Localhost variations
run_network_test \
    "Localhost Connection" \
    "A4_RELAY_URLS='ws://localhost:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with localhost connection (should fail if no local relay)" \
    10

# Test 14: Network interface down simulation (if possible)
if command -v ip >/dev/null 2>&1; then
    # This test is more complex and may require privileges, so we'll simulate it
    run_network_test \
        "Network Interface Simulation" \
        "A4_RELAY_URLS='ws://127.0.0.1:8080' $A4_BINARY find test" \
        1 \
        "Test behavior with local network interface" \
        10
fi

# Test 15: Proxy environment variables (simulate proxy issues)
run_network_test \
    "Proxy Environment" \
    "HTTP_PROXY='http://invalid-proxy:8080' HTTPS_PROXY='http://invalid-proxy:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with invalid proxy settings" \
    15

# Test 16: Very long hostname
long_hostname=$(python3 -c "print('a' * 250 + '.com')")
run_network_test \
    "Long Hostname" \
    "A4_RELAY_URLS='ws://$long_hostname:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with extremely long hostname" \
    10

# Test 17: Special characters in hostname
run_network_test \
    "Special Characters Hostname" \
    "A4_RELAY_URLS='ws://test@#\$%.com:8080' $A4_BINARY find test" \
    1 \
    "Test behavior with special characters in hostname" \
    10

# Test 18: Multiple relay URLs with mixed validity
run_network_test \
    "Mixed Valid/Invalid URLs" \
    "A4_RELAY_URLS='ws://invalid.test:8080,$RELAY_URL,ws://another-invalid.test:8080' $A4_BINARY find test" \
    0 \
    "Test behavior with mixed valid/invalid relay URLs (should succeed with valid one)" \
    20

# Test 19: Network congestion simulation (multiple concurrent connections)
run_network_test \
    "Concurrent Connections" \
    "for i in {1..5}; do $A4_BINARY find test & done; wait" \
    0 \
    "Test behavior with multiple concurrent connections" \
    30

# Test 20: Rapid connection/disconnection
run_network_test \
    "Rapid Connect/Disconnect" \
    "for i in {1..3}; do $A4_BINARY find test; sleep 0.1; done" \
    0 \
    "Test behavior with rapid connection/disconnection cycles" \
    20

# Generate summary
echo "" >> "$RESULTS_FILE"
echo "Summary:" >> "$RESULTS_FILE"
echo "========" >> "$RESULTS_FILE"
echo "Total Tests: $total_tests" >> "$RESULTS_FILE"
echo "Passed: $passed_tests" >> "$RESULTS_FILE"
echo "Failed: $failed_tests" >> "$RESULTS_FILE"
echo "Success Rate: $(echo "scale=1; $passed_tests * 100 / $total_tests" | bc -l 2>/dev/null || echo "N/A")%" >> "$RESULTS_FILE"

# Final summary
echo "=================================================="
echo "NETWORK CONNECTIVITY TEST SUMMARY"
echo "=================================================="
echo "Total Tests: $total_tests"
echo "Passed: $passed_tests"
echo "Failed: $failed_tests"
if [[ $total_tests -gt 0 ]]; then
    success_rate=$(echo "scale=1; $passed_tests * 100 / $total_tests" | bc -l 2>/dev/null || echo "N/A")
    echo "Success Rate: ${success_rate}%"
fi
echo ""
echo "Detailed results saved to: $RESULTS_FILE"
echo "=================================================="

if [[ $failed_tests -eq 0 ]]; then
    log_success "All network connectivity tests passed!"
    exit 0
else
    log_warning "$failed_tests network connectivity tests failed"
    exit 1
fi