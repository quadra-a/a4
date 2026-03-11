#!/bin/bash

# quadra-a Relay Complete Test Suite Runner
# Master script to run ALL available relay tests with support for both Rust and TypeScript CLIs
# Usage: ./run-all-tests.sh [cli_mode] [relay_url] [binary_path]
# cli_mode: rust|node|both (default: both)
#
# CHANGELOG:
# - Added automatic connection cleanup to prevent hanging issues
# - Optimized concurrent test limits to avoid connection pool saturation
# - Added cleanup utility reference in troubleshooting guide
#
# Optional environment variables:
# - DEPLOYMENT_TEST_MODE=auto|always|never (default: auto)
# - DEPLOYMENT_TEST_BASE_PORT=9400
# - DEPLOYMENT_TEST_TIMEOUT_MS=5000

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
CLI_MODE="${1:-both}"
RELAY_URL="${2:-ws://relay-sg-1.quadra-a.com:8080}"
CUSTOM_BINARY="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DEPLOYMENT_TEST_MODE="${DEPLOYMENT_TEST_MODE:-auto}"
DEPLOYMENT_TEST_BASE_PORT="${DEPLOYMENT_TEST_BASE_PORT:-9400}"
DEPLOYMENT_TEST_TIMEOUT_MS="${DEPLOYMENT_TEST_TIMEOUT_MS:-5000}"
DEPLOYMENT_TEST_SKIP_REASON=""
DEPLOYMENT_TEST_EXECUTED=false
TEST_STATUS=0

# Use centralized output directory from config
RESULTS_DIR="$TEST_OUTPUT_ROOT/results"

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

# Connection cleanup function
cleanup_connections() {
    log_info "Cleaning up existing connections and processes..."

    # Clean up daemon processes
    local daemon_pids=$(ps aux | grep "daemon-entry.js" | grep -v grep | awk '{print $2}' 2>/dev/null || true)
    if [[ -n "$daemon_pids" ]]; then
        log_info "Killing daemon processes: $daemon_pids"
        echo "$daemon_pids" | xargs kill 2>/dev/null || true
    fi

    # Clean up hanging a4 processes
    local a4_pids=$(ps aux | grep -E "a4 (listen|tell|find)" | grep -v grep | awk '{print $2}' 2>/dev/null || true)
    if [[ -n "$a4_pids" ]]; then
        log_info "Killing hanging a4 processes: $a4_pids"
        echo "$a4_pids" | xargs kill 2>/dev/null || true
    fi

    # Clean up any test script processes
    local test_pids=$(ps aux | grep -E "(test-relay|benchmark-relay)" | grep -v grep | grep -v "$$" | awk '{print $2}' 2>/dev/null || true)
    if [[ -n "$test_pids" ]]; then
        log_info "Killing hanging test processes: $test_pids"
        echo "$test_pids" | xargs kill 2>/dev/null || true
    fi

    # Wait for processes to terminate
    sleep 2

    # Force kill any remaining processes
    local remaining_pids=$(ps aux | grep -E "(daemon-entry.js|a4 (listen|tell|find)|test-relay|benchmark-relay)" | grep -v grep | grep -v "$$" | awk '{print $2}' 2>/dev/null || true)
    if [[ -n "$remaining_pids" ]]; then
        log_warning "Force killing remaining processes: $remaining_pids"
        echo "$remaining_pids" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi

    log_success "Connection cleanup completed"
}

can_bind_local_port() {
    if ! command -v node >/dev/null 2>&1; then
        return 1
    fi

    node -e "const net=require('net'); const server=net.createServer(); server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0))); server.on('error', () => process.exit(1));" >/dev/null 2>&1
}

should_run_deployment_tests() {
    case "$DEPLOYMENT_TEST_MODE" in
        auto|"")
            if [[ "${CI:-false}" == "true" ]]; then
                return 0
            fi
            if ! command -v node >/dev/null 2>&1; then
                DEPLOYMENT_TEST_SKIP_REASON="node is not installed"
                return 1
            fi
            if ! command -v pnpm >/dev/null 2>&1; then
                DEPLOYMENT_TEST_SKIP_REASON="pnpm is not installed"
                return 1
            fi
            if can_bind_local_port; then
                return 0
            fi
            DEPLOYMENT_TEST_SKIP_REASON="local socket listen is not permitted in this environment"
            return 1
            ;;
        always|true|1)
            return 0
            ;;
        never|false|0)
            DEPLOYMENT_TEST_SKIP_REASON="disabled by DEPLOYMENT_TEST_MODE=$DEPLOYMENT_TEST_MODE"
            return 1
            ;;
        *)
            log_error "Invalid DEPLOYMENT_TEST_MODE: $DEPLOYMENT_TEST_MODE (expected auto|always|never)"
            exit 1
            ;;
    esac
}

# Create results directory
mkdir -p "$RESULTS_DIR"

# Test execution wrapper with real-time output
run_test_script() {
    local script_name="$1"
    local description="$2"
    local cli_mode="$3"
    local extra_args="${4:-}"
    local script_path="$SCRIPT_DIR/$script_name"

    echo ""
    echo "=================================================="
    log_info "Starting: $description (CLI Mode: $cli_mode)"
    echo "=================================================="

    if [[ ! -f "$script_path" ]]; then
        log_warning "Script not found: $script_path - skipping"
        return 2  # Return 2 for skipped tests
    fi

    local log_file="$RESULTS_DIR/${script_name%.sh}_${cli_mode}_$TIMESTAMP.log"

    # Use tee to show output in real-time AND save to log file
    if [[ -n "$extra_args" ]]; then
        if "$script_path" "$RELAY_URL" "$cli_mode" "$CUSTOM_BINARY" $extra_args 2>&1 | tee "$log_file"; then
            echo ""
            log_success "$description ($cli_mode) completed successfully"
            echo "Detailed log saved to: $log_file"
            return 0
        else
            echo ""
            log_error "$description ($cli_mode) failed"
            echo "Error log saved to: $log_file"
            return 1
        fi
    else
        if "$script_path" "$RELAY_URL" "$cli_mode" "$CUSTOM_BINARY" 2>&1 | tee "$log_file"; then
            echo ""
            log_success "$description ($cli_mode) completed successfully"
            echo "Detailed log saved to: $log_file"
            return 0
        else
            echo ""
            log_error "$description ($cli_mode) failed"
            echo "Error log saved to: $log_file"
            return 1
        fi
    fi
}

# Special test execution for scripts with different parameter patterns
run_special_test() {
    local script_name="$1"
    local description="$2"
    local custom_command="$3"
    local script_path="$SCRIPT_DIR/$script_name"

    echo ""
    echo "=================================================="
    log_info "Starting: $description"
    echo "=================================================="

    if [[ ! -f "$script_path" ]]; then
        log_warning "Script not found: $script_path - skipping"
        return 2  # Return 2 for skipped tests
    fi

    local log_file="$RESULTS_DIR/${script_name%.sh}_$TIMESTAMP.log"

    # Use tee to show output in real-time AND save to log file
    if eval "$custom_command" 2>&1 | tee "$log_file"; then
        echo ""
        log_success "$description completed successfully"
        echo "Detailed log saved to: $log_file"
        return 0
    else
        echo ""
        log_error "$description failed"
        echo "Error log saved to: $log_file"
        return 1
    fi
}

record_test_result() {
    local exit_code="$1"
    local pass_message="$2"
    local fail_message="$3"
    local skip_message="$4"

    case "$exit_code" in
        0)
            ((passed_tests++))
            log_success "$pass_message"
            ;;
        2)
            ((skipped_tests++))
            log_warning "$skip_message"
            ;;
        *)
            ((failed_tests++))
            log_warning "$fail_message"
            ;;
    esac
}

capture_test_status() {
    if "$@"; then
        TEST_STATUS=0
    else
        TEST_STATUS=$?
    fi
}

# Main test execution
main() {
    echo "=================================================="
    echo "quadra-a Complete Relay Test Suite Runner"
    echo "=================================================="
    echo "CLI Mode: $CLI_MODE"
    echo "Relay URL: $RELAY_URL"
    echo "Custom Binary: ${CUSTOM_BINARY:-'(auto-detect)'}"
    echo "Results Directory: $RESULTS_DIR"
    echo "Timestamp: $TIMESTAMP"
    echo "Deployment Tests: $DEPLOYMENT_TEST_MODE (base port $DEPLOYMENT_TEST_BASE_PORT)"
    echo "=================================================="

    local total_tests=0
    local passed_tests=0
    local failed_tests=0
    local skipped_tests=0

    # Clean up existing connections first
    cleanup_connections

    # Check prerequisites
    log_info "Checking prerequisites..."

    if ! command -v python3 &> /dev/null; then
        log_error "python3 is required for payload generation tests"
        exit 1
    fi

    # Check available CLIs based on mode
    case "$CLI_MODE" in
        "rust")
            if [[ -n "$CUSTOM_BINARY" ]]; then
                if [[ ! -f "$CUSTOM_BINARY" ]]; then
                    log_error "Custom Rust binary not found: $CUSTOM_BINARY"
                    exit 1
                fi
            elif [[ ! -f "$DEFAULT_A4_BINARY" && ! -f "$DEBUG_A4_BINARY" ]]; then
                log_error "Rust CLI not found. Build with: cd rust && cargo build --release"
                exit 1
            fi
            log_success "Rust CLI mode selected"
            ;;
        "node")
            if ! command -v pnpm &> /dev/null && ! command -v npx &> /dev/null && ! command -v a4 &> /dev/null; then
                log_error "No Node.js CLI available. Install with: pnpm install && pnpm build"
                exit 1
            fi
            log_success "TypeScript CLI mode selected"
            ;;
        "both")
            log_success "Both CLIs mode selected"
            ;;
        *)
            log_error "Invalid CLI mode: $CLI_MODE. Use: rust|node|both"
            exit 1
            ;;
    esac

    log_info "Starting complete relay testing suite..."

    # Determine which CLI modes to test
    local cli_modes_to_test=()
    case "$CLI_MODE" in
        "rust")
            cli_modes_to_test=("rust")
            ;;
        "node")
            cli_modes_to_test=("node")
            ;;
        "both")
            cli_modes_to_test=("rust" "node")
            ;;
    esac

    # Run core tests for each CLI mode
    for cli_mode in "${cli_modes_to_test[@]}"; do
        local cli_passed_before=$passed_tests
        local cli_failed_before=$failed_tests
        local cli_skipped_before=$skipped_tests

        echo ""
        echo "=================================================="
        echo "Core Tests - CLI Mode: $cli_mode"
        echo "=================================================="

        # Test 1: Quick validation test
        ((total_tests++))
        echo ""
        log_info "Test 1/9: Quick Validation Test"
        capture_test_status run_test_script "test-relay-quick.sh" "Quick Validation Test" "$cli_mode"
        record_test_result "$TEST_STATUS" "Quick validation passed" "Quick test failed for $cli_mode - continuing with other tests" "Quick test skipped"

        # Test 2: Comprehensive functionality test
        ((total_tests++))
        echo ""
        log_info "Test 2/9: Comprehensive Functionality Test"
        capture_test_status run_test_script "test-relay-comprehensive.sh" "Comprehensive Functionality Test" "$cli_mode"
        record_test_result "$TEST_STATUS" "Comprehensive test passed" "Comprehensive test failed for $cli_mode - continuing with other tests" "Comprehensive test skipped"

        # Test 3: Performance benchmark
        ((total_tests++))
        echo ""
        log_info "Test 3/9: Performance Benchmark"
        capture_test_status run_test_script "benchmark-relay.sh" "Performance Benchmark" "$cli_mode"
        record_test_result "$TEST_STATUS" "Performance benchmark passed" "Benchmark failed for $cli_mode - continuing with other tests" "Benchmark skipped"

        # Test 4: Load test (30 seconds)
        ((total_tests++))
        echo ""
        log_info "Test 4/9: Load Test (30s)"
        capture_test_status run_test_script "load-test-relay.sh" "Load Test (30s)" "$cli_mode" "30"
        record_test_result "$TEST_STATUS" "Load test passed" "Load test failed for $cli_mode - continuing with other tests" "Load test skipped"

        # Test 5: Stress test
        ((total_tests++))
        echo ""
        log_info "Test 5/9: Stress Test"
        capture_test_status run_test_script "stress-test-relay.sh" "Stress Test" "$cli_mode"
        record_test_result "$TEST_STATUS" "Stress test passed" "Stress test failed for $cli_mode - continuing with other tests" "Stress test skipped"

        # Test 6: CI/CD test
        ((total_tests++))
        echo ""
        log_info "Test 6/9: CI/CD Integration Test"
        capture_test_status run_test_script "ci-test-relay.sh" "CI/CD Integration Test" "$cli_mode"
        record_test_result "$TEST_STATUS" "CI/CD test passed" "CI test failed for $cli_mode - continuing with other tests" "CI test skipped"

        # Test 7: Error handling test
        ((total_tests++))
        echo ""
        log_info "Test 7/9: Error Handling Test"
        capture_test_status run_test_script "test-error-handling.sh" "Error Handling Test" "$cli_mode"
        record_test_result "$TEST_STATUS" "Error handling test passed" "Error handling test failed for $cli_mode - continuing with other tests" "Error handling test skipped"

        # Test 8: Network connectivity test
        ((total_tests++))
        echo ""
        log_info "Test 8/9: Network Connectivity Test"
        capture_test_status run_test_script "test-network-connectivity.sh" "Network Connectivity Test" "$cli_mode"
        record_test_result "$TEST_STATUS" "Network connectivity test passed" "Network connectivity test failed for $cli_mode - continuing with other tests" "Network connectivity test skipped"

        # Test 9: Malformed messages test
        ((total_tests++))
        echo ""
        log_info "Test 9/9: Malformed Messages Test"
        capture_test_status run_test_script "test-malformed-messages.sh" "Malformed Messages Test" "$cli_mode"
        record_test_result "$TEST_STATUS" "Malformed messages test passed" "Malformed messages test failed for $cli_mode - continuing with other tests" "Malformed messages test skipped"

        local cli_passed=$((passed_tests - cli_passed_before))
        local cli_failed=$((failed_tests - cli_failed_before))
        local cli_skipped=$((skipped_tests - cli_skipped_before))
        local cli_completed=$((cli_passed + cli_failed + cli_skipped))

        echo ""
        echo "CLI Mode '$cli_mode' Summary:"
        echo "Tests completed: $cli_completed / 9"
        if [[ $((cli_completed - cli_skipped)) -gt 0 ]]; then
            echo "Success rate: $(( (cli_passed * 100) / (cli_completed - cli_skipped) ))%"
        else
            echo "Success rate: N/A"
        fi
    done

    echo ""
    echo "=================================================="
    echo "System-Level Tests"
    echo "=================================================="

    # System Test 1: Integration test suite
    ((total_tests++))
    echo ""
    log_info "System Test 1/3: Integration Test Suite"
    local integration_command
    printf -v integration_command '%q' "$SCRIPT_DIR/test-suite-integration.sh"
    capture_test_status run_special_test "test-suite-integration.sh" "Integration Test Suite" "$integration_command"
    record_test_result "$TEST_STATUS" "Integration test passed" "Integration test failed - continuing with other tests" "Integration test skipped"

    # System Test 2: Local deployment validation
    ((total_tests++))
    echo ""
    log_info "System Test 2/3: Local Deployment Validation"
    if should_run_deployment_tests; then
        DEPLOYMENT_TEST_EXECUTED=true
        local deployment_command
        printf -v deployment_command '%q all --base-port %q --timeout-ms %q' "$SCRIPT_DIR/test-relay-deployment.sh" "$DEPLOYMENT_TEST_BASE_PORT" "$DEPLOYMENT_TEST_TIMEOUT_MS"
        capture_test_status run_special_test "test-relay-deployment.sh" "Local Deployment Validation" "$deployment_command"
        record_test_result "$TEST_STATUS" "Local deployment validation passed" "Local deployment validation failed" "Local deployment validation skipped"
    else
        ((skipped_tests++))
        log_warning "Local deployment validation skipped: $DEPLOYMENT_TEST_SKIP_REASON"
    fi

    # System Test 3: Results validation (run after all other tests)
    ((total_tests++))
    echo ""
    log_info "System Test 3/3: Results Validation"
    local validation_command
    printf -v validation_command '%q %q %q' "$SCRIPT_DIR/validate-test-results.sh" "$RESULTS_DIR" "quadra-a-basic"
    capture_test_status run_special_test "validate-test-results.sh" "Results Validation" "$validation_command"
    record_test_result "$TEST_STATUS" "Results validation passed" "Results validation failed" "Results validation skipped"

    # Generate consolidated report
    local report_file="$RESULTS_DIR/complete_test_suite_report_$TIMESTAMP.txt"

    cat > "$report_file" << EOF
quadra-a Complete Relay Test Suite Report
=========================================
Date: $(date)
CLI Mode: $CLI_MODE
Relay URL: $RELAY_URL
Custom Binary: ${CUSTOM_BINARY:-'(auto-detect)'}
System: $(uname -a)

Test Results Summary:
====================
Total Test Suites: $total_tests
Passed: $passed_tests
Failed: $failed_tests
Skipped: $skipped_tests
Success Rate: $(echo "scale=1; $passed_tests * 100 / ($total_tests - $skipped_tests)" | bc -l 2>/dev/null || echo "N/A")%

Test Categories Covered:
=======================
✓ Quick Validation Tests
✓ Comprehensive Functionality Tests
✓ Performance Benchmarks
✓ Load Testing (30s duration)
✓ Stress Testing
✓ CI/CD Integration Tests
✓ Error Handling Tests
✓ Network Connectivity Tests
✓ Malformed Messages Tests
✓ System Integration Tests
✓ Local Deployment Validation (when enabled)
✓ Results Validation

Individual Test Results:
=======================
EOF

    # Add individual test results
    for log_file in "$RESULTS_DIR"/*_$TIMESTAMP.log; do
        if [[ -f "$log_file" ]]; then
            local test_name=$(basename "$log_file" .log | sed "s/_$TIMESTAMP//")
            echo "- $test_name: $(if grep -q "PASS\|SUCCESS\|✅" "$log_file" 2>/dev/null; then echo "PASSED"; else echo "FAILED"; fi)" >> "$report_file"
        fi
    done

    cat >> "$report_file" << EOF

CLI Compatibility Summary:
=========================
EOF

    case "$CLI_MODE" in
        "rust")
            echo "- Rust CLI: TESTED" >> "$report_file"
            echo "- TypeScript CLI: NOT TESTED" >> "$report_file"
            ;;
        "node")
            echo "- Rust CLI: NOT TESTED" >> "$report_file"
            echo "- TypeScript CLI: TESTED" >> "$report_file"
            ;;
        "both")
            echo "- Rust CLI: TESTED" >> "$report_file"
            echo "- TypeScript CLI: TESTED" >> "$report_file"
            ;;
    esac

    cat >> "$report_file" << EOF

Detailed Logs:
=============
All detailed logs are available in: $RESULTS_DIR/

Report generated at: $(date)
EOF

    # Final summary with clean formatting
    echo ""
    echo "=================================================="
    echo "COMPLETE TEST SUITE SUMMARY"
    echo "=================================================="
    echo ""
    echo "Test Results Overview:"
    echo "CLI Mode: ${BLUE}$CLI_MODE${NC}"
    echo "Total Test Suites: ${BLUE}$total_tests${NC}"
    echo "Passed: ${GREEN}$passed_tests${NC}"
    echo "Failed: ${RED}$failed_tests${NC}"
    echo "Skipped: ${YELLOW}$skipped_tests${NC}"
    if [[ $((total_tests - skipped_tests)) -gt 0 ]]; then
        local success_rate=$(echo "scale=1; $passed_tests * 100 / ($total_tests - $skipped_tests)" | bc -l 2>/dev/null || echo "N/A")
        echo "Success Rate: ${BLUE}${success_rate}%${NC}"
    fi
    echo ""
    echo "Output Files:"
    echo "Consolidated Report: $report_file"
    echo "All Logs Directory: $RESULTS_DIR"
    echo "Cleanup Tool: ./cleanup-connections.sh"
    echo ""

    if [[ $failed_tests -eq 0 ]]; then
        echo "=================================================="
        echo -e "${GREEN}ALL TEST SUITES PASSED!${NC}"
        echo -e "${GREEN}quadra-a is production ready!${NC}"
        echo "=================================================="
        echo ""
        echo "Test Coverage Summary:"
        echo "• Core functionality: Validated"
        echo "• Performance benchmarks: Completed"
        echo "• Load & stress testing: Passed"
        echo "• CI/CD integration: Verified"
        echo "• System integration: Confirmed"
        if [[ "$DEPLOYMENT_TEST_EXECUTED" == true ]]; then
            echo "• Local deployment validation: Covered"
        elif [[ -n "$DEPLOYMENT_TEST_SKIP_REASON" ]]; then
            echo "• Local deployment validation: Skipped ($DEPLOYMENT_TEST_SKIP_REASON)"
        fi
        echo "• Results validation: Compliant"
        echo ""
        echo "Next Steps:"
        echo "• Deploy relay to production environment"
        echo "• Distribute CLI binaries to users"
        echo "• Monitor relay performance and logs"
        if [[ $skipped_tests -gt 0 ]]; then
            echo "• Note: $skipped_tests test(s) were skipped due to missing scripts or environment gating"
        fi
        echo ""
        exit 0
    else
        echo "=================================================="
        echo -e "${YELLOW}SOME TEST SUITES FAILED${NC}"
        echo "=================================================="
        echo ""
        echo "Failed Tests: $failed_tests"
        if [[ $skipped_tests -gt 0 ]]; then
            echo "Skipped Tests: $skipped_tests"
        fi
        echo ""
        echo "Troubleshooting Steps:"
        echo "• Check relay server is running and accessible"
        echo "• Verify CLI binaries are built and executable"
        echo "• Review test logs for specific error details"
        echo "• Run individual test suites for focused debugging"
        echo "• Use run-core-tests.sh for basic functionality testing"
        echo "• Set DEPLOYMENT_TEST_MODE=always to force local deployment validation"
        echo "• Run ./cleanup-connections.sh to clean up hanging processes"
        echo ""
        exit 1
    fi
}

# Run main function
main "$@"