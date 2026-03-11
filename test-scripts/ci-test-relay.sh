#!/usr/bin/env bash

# quadra-a Relay CI/CD Integration Script
# Optimized for continuous integration environments
# Usage: ./ci-test-relay.sh [relay_url] [a4_binary_path]

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
TEST_DID="did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"
CI_RESULTS_DIR="$TEST_OUTPUT_ROOT/ci-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
JUNIT_XML="$CI_RESULTS_DIR/junit-results-$TIMESTAMP.xml"

# Test configuration for CI
CI_TIMEOUT=30
MAX_RETRIES=3
PARALLEL_LIMIT=10

# Colors (disabled in CI if needed)
if [[ "${CI:-false}" == "true" ]]; then
    RED=""
    GREEN=""
    BLUE=""
    YELLOW=""
    NC=""
else
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    BLUE='\033[0;34m'
    YELLOW='\033[1;33m'
    NC='\033[0m'
fi

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# Test tracking
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
TEST_RESULTS=()

# Create results directory
mkdir -p "$CI_RESULTS_DIR"

# Initialize JUnit XML
init_junit_xml() {
    cat > "$JUNIT_XML" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Highway1RelayTests" tests="0" failures="0" errors="0" time="0">
EOF
}

# Add test result to JUnit XML
add_junit_test() {
    local test_name="$1"
    local status="$2"
    local duration="$3"
    local error_message="$4"

    if [[ "$status" == "PASS" ]]; then
        cat >> "$JUNIT_XML" << EOF
  <testcase classname="RelayTest" name="$test_name" time="$duration"/>
EOF
    else
        cat >> "$JUNIT_XML" << EOF
  <testcase classname="RelayTest" name="$test_name" time="$duration">
    <failure message="Test failed">$error_message</failure>
  </testcase>
EOF
    fi
}

# Finalize JUnit XML
finalize_junit_xml() {
    sed -i.bak "s/tests=\"0\"/tests=\"$TOTAL_TESTS\"/" "$JUNIT_XML"
    sed -i.bak "s/failures=\"0\"/failures=\"$FAILED_TESTS\"/" "$JUNIT_XML"
    echo "</testsuites>" >> "$JUNIT_XML"
    rm -f "$JUNIT_XML.bak"
}

# Execute test with retry logic
run_ci_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_pattern="$3"
    local retry_count=0

    ((TOTAL_TESTS++))
    log_info "Running: $test_name"

    local start_time=$(date +%s)

    while [[ $retry_count -lt $MAX_RETRIES ]]; do
        if quadra_run_with_timeout_shell "$CI_TIMEOUT" "$test_command" >/dev/null 2>&1; then
            local end_time=$(date +%s)
            local duration=$((end_time - start_time))

            log_success "$test_name"
            ((PASSED_TESTS++))
            TEST_RESULTS+=("PASS:$test_name")
            add_junit_test "$test_name" "PASS" "$duration" ""
            return 0
        else
            ((retry_count++))
            if [[ $retry_count -lt $MAX_RETRIES ]]; then
                log_warning "$test_name failed, retrying ($retry_count/$MAX_RETRIES)..."
                sleep 2
            fi
        fi
    done

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    log_error "$test_name failed after $MAX_RETRIES attempts"
    ((FAILED_TESTS++))
    TEST_RESULTS+=("FAIL:$test_name")
    add_junit_test "$test_name" "FAIL" "$duration" "Test failed after $MAX_RETRIES attempts"
    return 1
}

# CI-optimized test suite
run_ci_tests() {
    log_info "=== CI RELAY TEST SUITE ==="

    # Essential functionality tests
    run_ci_test "Basic Discovery" \
        "$A4_BINARY find --relay $RELAY_URL"

    run_ci_test "Daemon Status" \
        "$A4_BINARY daemon status"

    run_ci_test "Basic Message Send" \
        "$A4_BINARY tell '$TEST_DID' 'CI test message' --relay $RELAY_URL"

    run_ci_test "JSON Payload" \
        "$A4_BINARY tell '$TEST_DID' --payload '{\"test\":\"ci\",\"timestamp\":\"$(quadra_iso_timestamp)\"}' --relay $RELAY_URL"

    run_ci_test "Custom Protocol" \
        "$A4_BINARY tell '$TEST_DID' 'CI protocol test' --protocol 'ci/test/1.0' --relay $RELAY_URL"

    # Performance tests (reduced for CI)
    run_ci_test "Sequential Messages (10)" \
        "for i in {1..10}; do $A4_BINARY tell '$TEST_DID' 'CI seq \$i' --relay $RELAY_URL >/dev/null 2>&1; done"

    run_ci_test "Concurrent Messages (5)" \
        "pids=(); for i in {1..5}; do $A4_BINARY tell '$TEST_DID' 'CI concurrent \$i' --relay $RELAY_URL >/dev/null 2>&1 & pids+=(\$!); done; for pid in \"\${pids[@]}\"; do wait \"\$pid\"; done"

    # Payload size tests
    run_ci_test "Medium Payload (5KB)" \
        "$A4_BINARY tell '$TEST_DID' --payload '{\"test\":\"ci_payload\",\"data\":\"$(python3 -c "print('A' * 5000)")\"}' --relay $RELAY_URL"

    # Discovery tests
    run_ci_test "WebSocket Discovery" \
        "$A4_BINARY find --query 'WebSocket' --relay $RELAY_URL"

    run_ci_test "Empty Query Discovery" \
        "$A4_BINARY find --query '' --relay $RELAY_URL"

    # Error handling tests
    run_ci_test "Invalid DID Handling" \
        "$A4_BINARY tell 'invalid-did' 'Error test' --relay $RELAY_URL"

    run_ci_test "Non-existent Query" \
        "$A4_BINARY find --query 'nonexistent' --relay $RELAY_URL"
}

# Generate CI summary report
generate_ci_report() {
    local report_file="$CI_RESULTS_DIR/ci-summary-$TIMESTAMP.txt"

    cat > "$report_file" << EOF
quadra-a Relay CI Test Report
==============================
Date: $(date)
Relay URL: $RELAY_URL
A4 Binary: $A4_BINARY
Environment: ${CI_ENVIRONMENT:-local}
Build ID: ${BUILD_ID:-unknown}
Commit: ${GIT_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo "unknown")}

Test Results:
=============
Total Tests: $TOTAL_TESTS
Passed: $PASSED_TESTS
Failed: $FAILED_TESTS
Success Rate: $(quadra_divide "$PASSED_TESTS" "$TOTAL_TESTS" 1 100)%

Individual Results:
==================
EOF

    for result in "${TEST_RESULTS[@]}"; do
        echo "- $result" >> "$report_file"
    done

    cat >> "$report_file" << EOF

JUnit XML: $JUNIT_XML
Generated: $(date)
EOF

    echo "$report_file"
}

# Health check before running tests
health_check() {
    log_info "Performing health check..."

    # Check binary exists and is executable
    if [[ ! -f "$A4_BINARY" ]]; then
        log_error "a4 binary not found at: $A4_BINARY"
        exit 1
    fi

    if [[ ! -x "$A4_BINARY" ]]; then
        log_error "a4 binary is not executable: $A4_BINARY"
        exit 1
    fi

    # Check dependencies
    if ! command -v python3 &> /dev/null; then
        log_error "python3 is required"
        exit 1
    fi

    # Test basic connectivity
    if ! quadra_run_with_timeout 10 $A4_BINARY find --relay "$RELAY_URL" >/dev/null 2>&1; then
        log_error "Cannot connect to relay: $RELAY_URL"
        exit 1
    fi

    log_success "Health check passed"
}

# Main CI execution
main() {
    echo "=================================================="
    echo "quadra-a Relay CI Test Suite"
    echo "=================================================="
    echo "Relay URL: $RELAY_URL"
    echo "A4 Binary: $A4_BINARY"
    echo "CI Environment: ${CI:-false}"
    echo "Timeout: ${CI_TIMEOUT}s"
    echo "Max Retries: $MAX_RETRIES"
    echo "=================================================="

    # Initialize
    init_junit_xml

    # Health check
    health_check

    # Run tests
    local start_time=$(date +%s)
    run_ci_tests
    local end_time=$(date +%s)
    local total_duration=$((end_time - start_time))

    # Finalize results
    finalize_junit_xml
    local report_file=$(generate_ci_report)

    # Summary
    echo "=================================================="
    echo "CI TEST SUMMARY"
    echo "=================================================="
    echo -e "Total Tests: ${BLUE}$TOTAL_TESTS${NC}"
    echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
    echo -e "Failed: ${RED}$FAILED_TESTS${NC}"
    echo -e "Duration: ${BLUE}${total_duration}s${NC}"
    echo -e "Success Rate: ${BLUE}$(quadra_divide "$PASSED_TESTS" "$TOTAL_TESTS" 1 100)%${NC}"
    echo ""
    echo "Reports:"
    echo "- Summary: $report_file"
    echo "- JUnit XML: $JUNIT_XML"
    echo "=================================================="

    # Set exit code for CI
    if [[ $FAILED_TESTS -eq 0 ]]; then
        echo -e "\n${GREEN}✅ All CI tests passed!${NC}"
        exit 0
    else
        echo -e "\n${RED}❌ Some CI tests failed.${NC}"
        exit 1
    fi
}

# Run main function
main "$@"
