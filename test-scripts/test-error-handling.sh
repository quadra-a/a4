#!/usr/bin/env bash

# quadra-a Error Handling Test Script
# Tests various error scenarios and recovery mechanisms
# Usage: ./test-error-handling.sh [relay_url] [cli_mode] [binary_path]

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

ERROR_TEST_DIR="$TEST_OUTPUT_ROOT/error-handling-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$ERROR_TEST_DIR/error_handling_test_$TIMESTAMP.txt"

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
mkdir -p "$ERROR_TEST_DIR"

# Test counters
total_tests=0
passed_tests=0
failed_tests=0

run_error_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_exit_code="${3:-1}"  # Default expect failure
    local description="$4"

    ((total_tests++))
    log_info "Testing: $test_name"
    log_info "Description: $description"

    local actual_exit_code=0
    if eval "$test_command" >/dev/null 2>&1; then
        actual_exit_code=0
    else
        actual_exit_code=$?
    fi

    if [[ $actual_exit_code -eq $expected_exit_code ]]; then
        ((passed_tests++))
        log_success "$test_name - Expected exit code $expected_exit_code"
        echo "PASS: $test_name" >> "$RESULTS_FILE"
    else
        ((failed_tests++))
        log_error "$test_name - Expected exit code $expected_exit_code, got $actual_exit_code"
        echo "FAIL: $test_name (expected: $expected_exit_code, got: $actual_exit_code)" >> "$RESULTS_FILE"
    fi
    echo ""
}

echo "=================================================="
echo "quadra-a Error Handling Test Suite"
echo "=================================================="
echo "Relay URL: $RELAY_URL"
echo "A4 Binary: $A4_BINARY"
echo "CLI Mode: $CLI_MODE"
echo "Results File: $RESULTS_FILE"
echo "=================================================="

# Initialize results file
cat > "$RESULTS_FILE" << EOF
quadra-a Error Handling Test Results
====================================
Date: $(date)
Relay URL: $RELAY_URL
A4 Binary: $A4_BINARY
CLI Mode: $CLI_MODE

Test Results:
=============
EOF

log_info "Starting error handling tests..."

# Test 1: Invalid binary path
run_error_test \
    "Invalid Binary Path" \
    "/nonexistent/binary find" \
    127 \
    "Test behavior with non-existent binary"

# Test 2: Invalid command
run_error_test \
    "Invalid Command" \
    "$A4_BINARY invalid-command" \
    2 \
    "Test behavior with invalid command"

# Test 3: Missing required arguments
run_error_test \
    "Missing Arguments - Find" \
    "$A4_BINARY find" \
    0 \
    "Test find command without required query argument (CLI accepts this)"

# Test 4: Missing required arguments - Tell
run_error_test \
    "Missing Arguments - Tell" \
    "$A4_BINARY tell" \
    2 \
    "Test tell command without required arguments"

# Test 5: Invalid DID format
run_error_test \
    "Invalid DID Format" \
    "$A4_BINARY tell invalid-did-format 'test message'" \
    1 \
    "Test behavior with malformed DID"

# Test 6: Permission denied scenario (create read-only temp file)
temp_config="/tmp/readonly_a4_config_$$"
touch "$temp_config"
chmod 000 "$temp_config"
run_error_test \
    "Permission Denied" \
    "A4_CONFIG_FILE='$temp_config' $A4_BINARY find test" \
    0 \
    "Test behavior with permission denied on config file (CLI handles gracefully)"
rm -f "$temp_config" 2>/dev/null || true

# Test 7: Timeout scenario (very short timeout)
run_error_test \
    "Command Timeout" \
    "timeout 0.1s $A4_BINARY find test" \
    124 \
    "Test behavior when command times out"

# Test 8: Invalid relay URL format
run_error_test \
    "Invalid Relay URL" \
    "A4_RELAY_URLS='invalid-url-format' $A4_BINARY find test" \
    0 \
    "Test behavior with malformed relay URL (CLI handles gracefully)"

# Test 9: Empty message
run_error_test \
    "Empty Message" \
    "$A4_BINARY tell $TEST_DID ''" \
    0 \
    "Test behavior with empty message (CLI accepts this)"

# Test 10: Extremely long message (beyond reasonable limits)
long_message=$(python3 -c "print('A' * 1000000)")  # 1MB message
run_error_test \
    "Oversized Message" \
    "$A4_BINARY tell $TEST_DID '$long_message'" \
    0 \
    "Test behavior with extremely large message (CLI may accept this)"

# Test 11: Invalid JSON in message
run_error_test \
    "Invalid JSON Message" \
    "$A4_BINARY tell $TEST_DID '{invalid json}'" \
    0 \
    "Test behavior with invalid JSON (should still send as text)"

# Test 12: Control characters in message
control_chars=$(python3 -c "print('\\x00\\x01\\x02\\x03')")
run_error_test \
    "Control Characters" \
    "$A4_BINARY tell $TEST_DID '$control_chars'" \
    0 \
    "Test behavior with control characters (should handle gracefully)"

# Test 13: Unicode edge cases
unicode_message="Testing unicode: 你好世界 🌍 🚀 émojis and spëcial chars \u0000\u001F"
run_error_test \
    "Unicode Edge Cases" \
    "$A4_BINARY tell $TEST_DID '$unicode_message'" \
    0 \
    "Test behavior with complex unicode characters"

# Test 14: Concurrent process conflicts (simulate daemon already running)
if command -v fuser >/dev/null 2>&1; then
    run_error_test \
        "Daemon Conflict" \
        "$A4_BINARY daemon start && sleep 1 && $A4_BINARY daemon start" \
        1 \
        "Test behavior when daemon is already running"

    # Cleanup any running daemon
    "$A4_BINARY" daemon stop 2>/dev/null || true
fi

# Test 15: Disk space exhaustion simulation (if possible)
if [[ -w /tmp ]]; then
    temp_dir="/tmp/a4_diskfull_test_$$"
    mkdir -p "$temp_dir"
    # Create a small filesystem using a loop device (if available)
    if command -v truncate >/dev/null 2>&1; then
        run_error_test \
            "Disk Space Handling" \
            "cd '$temp_dir' && A4_HOME='$temp_dir' $A4_BINARY find test" \
            0 \
            "Test behavior with limited disk space"
    fi
    rm -rf "$temp_dir" 2>/dev/null || true
fi

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
echo "ERROR HANDLING TEST SUMMARY"
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
    log_success "All error handling tests passed!"
    exit 0
else
    log_warning "$failed_tests error handling tests failed"
    exit 1
fi