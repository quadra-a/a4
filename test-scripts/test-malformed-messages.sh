#!/usr/bin/env bash

# quadra-a Malformed Messages Edge Cases Test Script
# Tests various edge cases with malformed, corrupted, and unusual messages
# Usage: ./test-malformed-messages.sh [relay_url] [cli_mode] [binary_path]

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

MALFORMED_TEST_DIR="$TEST_OUTPUT_ROOT/malformed-messages-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$MALFORMED_TEST_DIR/malformed_messages_test_$TIMESTAMP.txt"

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
mkdir -p "$MALFORMED_TEST_DIR"

# Test counters
total_tests=0
passed_tests=0
failed_tests=0

run_malformed_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_exit_code="${3:-0}"  # Default expect success (graceful handling)
    local description="$4"
    local timeout_seconds="${5:-30}"

    ((total_tests++))
    log_info "Testing: $test_name"
    log_info "Description: $description"

    local actual_exit_code=0
    local start_time=$(date +%s)
    local output_file="/tmp/malformed_test_output_$$"

    if quadra_run_with_timeout "$timeout_seconds" bash -c "$test_command" >"$output_file" 2>&1; then
        actual_exit_code=0
    else
        actual_exit_code=$?
    fi

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Check if the command produced any output (for debugging)
    local output_size=0
    if [[ -f "$output_file" ]]; then
        output_size=$(wc -c < "$output_file" 2>/dev/null || echo 0)
    fi

    if [[ $actual_exit_code -eq $expected_exit_code ]]; then
        ((passed_tests++))
        log_success "$test_name - Expected exit code $expected_exit_code (${duration}s, ${output_size}B output)"
        echo "PASS: $test_name (${duration}s, ${output_size}B)" >> "$RESULTS_FILE"
    else
        ((failed_tests++))
        log_error "$test_name - Expected exit code $expected_exit_code, got $actual_exit_code (${duration}s, ${output_size}B output)"
        echo "FAIL: $test_name (expected: $expected_exit_code, got: $actual_exit_code, ${duration}s, ${output_size}B)" >> "$RESULTS_FILE"

        # Save error output for debugging
        if [[ -f "$output_file" && $output_size -gt 0 ]]; then
            echo "  Error output: $(head -n 3 "$output_file" | tr '\n' ' ')" >> "$RESULTS_FILE"
        fi
    fi

    # Cleanup
    rm -f "$output_file" 2>/dev/null || true
    echo ""
}

echo "=================================================="
echo "quadra-a Malformed Messages Test Suite"
echo "=================================================="
echo "Relay URL: $RELAY_URL"
echo "A4 Binary: $A4_BINARY"
echo "CLI Mode: $CLI_MODE"
echo "Results File: $RESULTS_FILE"
echo "=================================================="

# Initialize results file
cat > "$RESULTS_FILE" << EOF
quadra-a Malformed Messages Test Results
========================================
Date: $(date)
Relay URL: $RELAY_URL
A4 Binary: $A4_BINARY
CLI Mode: $CLI_MODE

Test Results:
=============
EOF

log_info "Starting malformed messages tests..."

# Test 1: Empty message
run_malformed_test \
    "Empty Message" \
    "$A4_BINARY tell $TEST_DID ''" \
    1 \
    "Test behavior with completely empty message" \
    10

# Test 2: Null bytes in message
null_message=$(printf "Hello\x00World\x00Test")
run_malformed_test \
    "Null Bytes Message" \
    "$A4_BINARY tell $TEST_DID '$null_message'" \
    0 \
    "Test behavior with null bytes in message" \
    15

# Test 3: Control characters
control_message=$(python3 -c "print(''.join(chr(i) for i in range(32)) + 'Normal text')")
run_malformed_test \
    "Control Characters" \
    "$A4_BINARY tell $TEST_DID '$control_message'" \
    0 \
    "Test behavior with all control characters" \
    15

# Test 4: Invalid UTF-8 sequences
run_malformed_test \
    "Invalid UTF-8" \
    "echo -ne 'Hello\xFF\xFE\xFDWorld' | $A4_BINARY tell $TEST_DID -" \
    0 \
    "Test behavior with invalid UTF-8 byte sequences" \
    15

# Test 5: Extremely long message (1MB)
run_malformed_test \
    "1MB Message" \
    "python3 -c \"print('A' * 1048576)\" | $A4_BINARY tell $TEST_DID -" \
    1 \
    "Test behavior with 1MB message (should be rejected)" \
    30

# Test 6: Extremely long message (10MB)
run_malformed_test \
    "10MB Message" \
    "python3 -c \"print('B' * 10485760)\" | $A4_BINARY tell $TEST_DID -" \
    1 \
    "Test behavior with 10MB message (should be rejected)" \
    45

# Test 7: Binary data
run_malformed_test \
    "Binary Data" \
    "dd if=/dev/urandom bs=1024 count=1 2>/dev/null | $A4_BINARY tell $TEST_DID -" \
    0 \
    "Test behavior with random binary data" \
    20

# Test 8: JSON with syntax errors
malformed_json='{"key": "value", "broken": json, "missing": }'
run_malformed_test \
    "Malformed JSON" \
    "$A4_BINARY tell $TEST_DID '$malformed_json'" \
    0 \
    "Test behavior with syntactically invalid JSON" \
    15

# Test 9: Deeply nested JSON
deep_json=$(python3 -c "print('{' * 1000 + '\"key\": \"value\"' + '}' * 1000)")
run_malformed_test \
    "Deeply Nested JSON" \
    "$A4_BINARY tell $TEST_DID '$deep_json'" \
    0 \
    "Test behavior with extremely deeply nested JSON" \
    20

# Test 10: Unicode edge cases
unicode_edge=$(python3 -c "
import sys
# Various Unicode edge cases
edge_cases = [
    '\uFFFE',  # Byte order mark
    '\uFFFF',  # Non-character
    '\U0001F4A9',  # Pile of poo emoji
    '\u200B',  # Zero-width space
    '\u202E',  # Right-to-left override
    '\u0301',  # Combining acute accent
    'A\u0300\u0301\u0302\u0303',  # Multiple combining characters
]
print(''.join(edge_cases) + ' Normal text')
")
run_malformed_test \
    "Unicode Edge Cases" \
    "$A4_BINARY tell $TEST_DID '$unicode_edge'" \
    0 \
    "Test behavior with Unicode edge cases and combining characters" \
    15

# Test 11: SQL injection attempt
sql_injection="'; DROP TABLE agents; --"
run_malformed_test \
    "SQL Injection Attempt" \
    "$A4_BINARY tell $TEST_DID '$sql_injection'" \
    0 \
    "Test behavior with SQL injection patterns" \
    15

# Test 12: Script injection attempt
script_injection='<script>alert("xss")</script>'
run_malformed_test \
    "Script Injection Attempt" \
    "$A4_BINARY tell $TEST_DID '$script_injection'" \
    0 \
    "Test behavior with script injection patterns" \
    15

# Test 13: Path traversal attempt
path_traversal="../../../etc/passwd"
run_malformed_test \
    "Path Traversal Attempt" \
    "$A4_BINARY tell $TEST_DID '$path_traversal'" \
    0 \
    "Test behavior with path traversal patterns" \
    15

# Test 14: Command injection attempt
command_injection="; rm -rf / #"
run_malformed_test \
    "Command Injection Attempt" \
    "$A4_BINARY tell $TEST_DID '$command_injection'" \
    0 \
    "Test behavior with command injection patterns" \
    15

# Test 15: Format string attack
format_string="%x %x %x %x %x %x %x %x"
run_malformed_test \
    "Format String Attack" \
    "$A4_BINARY tell $TEST_DID '$format_string'" \
    0 \
    "Test behavior with format string attack patterns" \
    15

# Test 16: Buffer overflow attempt
buffer_overflow=$(python3 -c "print('A' * 65536)")
run_malformed_test \
    "Buffer Overflow Attempt" \
    "$A4_BINARY tell $TEST_DID '$buffer_overflow'" \
    0 \
    "Test behavior with potential buffer overflow (64KB)" \
    20

# Test 17: Invalid DID formats
invalid_dids=(
    "not-a-did"
    "did:"
    "did:invalid"
    "did:a4:"
    "did:a4:invalid-base58"
    "did:a4:$(python3 -c 'print("z" + "A" * 1000)')"
    ""
    "did:a4:z123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
)

for invalid_did in "${invalid_dids[@]}"; do
    run_malformed_test \
        "Invalid DID: ${invalid_did:0:20}..." \
        "$A4_BINARY tell '$invalid_did' 'test message'" \
        1 \
        "Test behavior with invalid DID format: $invalid_did" \
        10
done

# Test 18: Message with only whitespace
whitespace_message="   \t\n\r   "
run_malformed_test \
    "Whitespace Only Message" \
    "$A4_BINARY tell $TEST_DID '$whitespace_message'" \
    0 \
    "Test behavior with message containing only whitespace" \
    15

# Test 19: Message with mixed line endings
mixed_endings="Line 1\r\nLine 2\nLine 3\rLine 4"
run_malformed_test \
    "Mixed Line Endings" \
    "$A4_BINARY tell $TEST_DID '$mixed_endings'" \
    0 \
    "Test behavior with mixed line ending styles" \
    15

# Test 20: Repeated characters
repeated_chars=$(python3 -c "print('🚀' * 10000)")
run_malformed_test \
    "Repeated Unicode Characters" \
    "$A4_BINARY tell $TEST_DID '$repeated_chars'" \
    0 \
    "Test behavior with 10,000 repeated Unicode characters" \
    20

# Test 21: Protocol-specific edge cases
protocol_tests=(
    "quadra-a/chat/1.0"
    "test/$(python3 -c 'print("a" * 1000)')/1.0"
    "test/unicode-🚀-测试/1.0"
    ""
    "invalid/protocol/format"
    "protocol-with-no-version"
    "protocol/with/too/many/slashes/1.0"
)

for protocol in "${protocol_tests[@]}"; do
    run_malformed_test \
        "Protocol Test: ${protocol:0:30}..." \
        "$A4_BINARY find --protocol '$protocol' test" \
        0 \
        "Test behavior with protocol: $protocol" \
        15
done

# Test 22: Concurrent malformed messages
run_malformed_test \
    "Concurrent Malformed Messages" \
    "for i in {1..5}; do $A4_BINARY tell $TEST_DID 'Message \$i with \x00 null' & done; wait" \
    0 \
    "Test behavior with multiple concurrent malformed messages" \
    30

# Test 23: Message corruption simulation
corrupted_message=$(python3 -c "
import random
import string
# Create a message and then corrupt random bytes
msg = 'This is a test message that will be corrupted'
msg_bytes = list(msg.encode('utf-8'))
# Corrupt 10% of bytes
for _ in range(len(msg_bytes) // 10):
    idx = random.randint(0, len(msg_bytes) - 1)
    msg_bytes[idx] = random.randint(0, 255)
try:
    print(bytes(msg_bytes).decode('utf-8', errors='replace'))
except:
    print('CORRUPTED_MESSAGE')
")
run_malformed_test \
    "Message Corruption Simulation" \
    "$A4_BINARY tell $TEST_DID '$corrupted_message'" \
    0 \
    "Test behavior with simulated message corruption" \
    15

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
echo "MALFORMED MESSAGES TEST SUMMARY"
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
    log_success "All malformed messages tests passed!"
    exit 0
else
    log_warning "$failed_tests malformed messages tests failed"
    exit 1
fi