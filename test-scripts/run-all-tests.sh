#!/bin/bash

# quadra-a Relay Complete Test Suite Runner
# Master script to run ALL available relay tests with support for both Rust and TypeScript CLIs
# Usage: ./run-all-tests.sh [cli_mode] [relay_url] [binary_path]
# cli_mode: rust|node|both (default: both)

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
CLI_MODE="${1:-both}"
RELAY_URL="${2:-ws://relay-sg-1.quadra-a.com:8080}"
CUSTOM_BINARY="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

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

# Create results directory
mkdir -p "$RESULTS_DIR"

# Test execution wrapper
run_test_script() {
    local script_name="$1"
    local description="$2"
    local cli_mode="$3"
    local extra_args="${4:-}"
    local script_path="$SCRIPT_DIR/$script_name"

    log_info "Running: $description (CLI Mode: $cli_mode)"

    if [[ ! -f "$script_path" ]]; then
        log_warning "Script not found: $script_path - skipping"
        return 2  # Return 2 for skipped tests
    fi

    local log_file="$RESULTS_DIR/${script_name%.sh}_${cli_mode}_$TIMESTAMP.log"

    # Pass CLI mode and other parameters to the test script
    if [[ -n "$extra_args" ]]; then
        if "$script_path" "$RELAY_URL" "$cli_mode" "$CUSTOM_BINARY" $extra_args > "$log_file" 2>&1; then
            log_success "$description ($cli_mode) completed successfully"
            echo "Log: $log_file"
            return 0
        else
            log_error "$description ($cli_mode) failed"
            echo "Error log: $log_file"
            return 1
        fi
    else
        if "$script_path" "$RELAY_URL" "$cli_mode" "$CUSTOM_BINARY" > "$log_file" 2>&1; then
            log_success "$description ($cli_mode) completed successfully"
            echo "Log: $log_file"
            return 0
        else
            log_error "$description ($cli_mode) failed"
            echo "Error log: $log_file"
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

    log_info "Running: $description"

    if [[ ! -f "$script_path" ]]; then
        log_warning "Script not found: $script_path - skipping"
        return 2  # Return 2 for skipped tests
    fi

    local log_file="$RESULTS_DIR/${script_name%.sh}_$TIMESTAMP.log"

    if eval "$custom_command" > "$log_file" 2>&1; then
        log_success "$description completed successfully"
        echo "Log: $log_file"
        return 0
    else
        log_error "$description failed"
        echo "Error log: $log_file"
        return 1
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
    echo "=================================================="

    local total_tests=0
    local passed_tests=0
    local failed_tests=0
    local skipped_tests=0

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
        echo ""
        echo "=================================================="
        echo "Core Tests - CLI Mode: $cli_mode"
        echo "=================================================="

        # Test 1: Quick validation test
        ((total_tests++))
        case $(run_test_script "test-relay-quick.sh" "Quick Validation Test" "$cli_mode") in
            0) ((passed_tests++)) ;;
            1) ((failed_tests++)); log_warning "Quick test failed for $cli_mode - continuing with other tests" ;;
            2) ((skipped_tests++)) ;;
        esac

        # Test 2: Comprehensive functionality test
        ((total_tests++))
        case $(run_test_script "test-relay-comprehensive.sh" "Comprehensive Functionality Test" "$cli_mode") in
            0) ((passed_tests++)) ;;
            1) ((failed_tests++)); log_warning "Comprehensive test failed for $cli_mode - continuing with other tests" ;;
            2) ((skipped_tests++)) ;;
        esac

        # Test 3: Performance benchmark
        ((total_tests++))
        case $(run_test_script "benchmark-relay.sh" "Performance Benchmark" "$cli_mode") in
            0) ((passed_tests++)) ;;
            1) ((failed_tests++)); log_warning "Benchmark failed for $cli_mode - continuing with other tests" ;;
            2) ((skipped_tests++)) ;;
        esac

        # Test 4: Load test (30 seconds)
        ((total_tests++))
        case $(run_test_script "load-test-relay.sh" "Load Test (30s)" "$cli_mode" "30") in
            0) ((passed_tests++)) ;;
            1) ((failed_tests++)); log_warning "Load test failed for $cli_mode - continuing with other tests" ;;
            2) ((skipped_tests++)) ;;
        esac

        # Test 5: Stress test
        ((total_tests++))
        case $(run_test_script "stress-test-relay.sh" "Stress Test" "$cli_mode") in
            0) ((passed_tests++)) ;;
            1) ((failed_tests++)); log_warning "Stress test failed for $cli_mode - continuing with other tests" ;;
            2) ((skipped_tests++)) ;;
        esac

        # Test 6: CI/CD test
        ((total_tests++))
        case $(run_test_script "ci-test-relay.sh" "CI/CD Integration Test" "$cli_mode") in
            0) ((passed_tests++)) ;;
            1) ((failed_tests++)); log_warning "CI test failed for $cli_mode - continuing with other tests" ;;
            2) ((skipped_tests++)) ;;
        esac
    done

    echo ""
    echo "=================================================="
    echo "System-Level Tests"
    echo "=================================================="

    # Test 7: Integration test suite
    ((total_tests++))
    case $(run_special_test "test-suite-integration.sh" "Integration Test Suite" "\"$SCRIPT_DIR/test-suite-integration.sh\"") in
        0) ((passed_tests++)) ;;
        1) ((failed_tests++)); log_warning "Integration test failed - continuing with other tests" ;;
        2) ((skipped_tests++)) ;;
    esac

    # Test 8: Results validation (run after all other tests)
    ((total_tests++))
    case $(run_special_test "validate-test-results.sh" "Results Validation" "\"$SCRIPT_DIR/validate-test-results.sh\" \"$RESULTS_DIR\" \"quadra-a-basic\"") in
        0) ((passed_tests++)) ;;
        1) ((failed_tests++)); log_warning "Results validation failed" ;;
        2) ((skipped_tests++)) ;;
    esac

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
✓ System Integration Tests
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

    # Final summary
    echo "=================================================="
    echo "COMPLETE TEST SUITE SUMMARY"
    echo "=================================================="
    echo -e "CLI Mode: ${BLUE}$CLI_MODE${NC}"
    echo -e "Total Test Suites: ${BLUE}$total_tests${NC}"
    echo -e "Passed: ${GREEN}$passed_tests${NC}"
    echo -e "Failed: ${RED}$failed_tests${NC}"
    echo -e "Skipped: ${YELLOW}$skipped_tests${NC}"
    if [[ $((total_tests - skipped_tests)) -gt 0 ]]; then
        echo -e "Success Rate: ${BLUE}$(echo "scale=1; $passed_tests * 100 / ($total_tests - $skipped_tests)" | bc -l 2>/dev/null || echo "N/A")%${NC}"
    fi
    echo ""
    echo "Consolidated Report: $report_file"
    echo "All Logs Directory: $RESULTS_DIR"
    echo "=================================================="

    if [[ $failed_tests -eq 0 ]]; then
        echo -e "\n${GREEN}🎉 ALL AVAILABLE TEST SUITES PASSED! quadra-a is production ready.${NC}"
        echo ""
        echo "Test Coverage Summary:"
        echo "• Core functionality: ✅ Validated"
        echo "• Performance benchmarks: ✅ Completed"
        echo "• Load & stress testing: ✅ Passed"
        echo "• CI/CD integration: ✅ Verified"
        echo "• System integration: ✅ Confirmed"
        echo "• Results validation: ✅ Compliant"
        echo ""
        echo "Next steps:"
        echo "• Deploy relay to production environment"
        echo "• Distribute CLI binaries to users"
        echo "• Monitor relay performance and logs"
        if [[ $skipped_tests -gt 0 ]]; then
            echo "• Note: $skipped_tests test(s) were skipped due to missing scripts"
        fi
        exit 0
    else
        echo -e "\n${YELLOW}⚠️  Some test suites failed. Please review the logs.${NC}"
        echo ""
        echo "Failed Tests: $failed_tests"
        if [[ $skipped_tests -gt 0 ]]; then
            echo "Skipped Tests: $skipped_tests (missing scripts)"
        fi
        echo ""
        echo "Troubleshooting:"
        echo "• Check relay server is running and accessible"
        echo "• Verify CLI binaries are built and executable"
        echo "• Review test logs for specific error details"
        echo "• Run individual test suites for focused debugging"
        echo "• Use run-core-tests.sh for basic functionality testing"
        exit 1
    fi
}

# Run main function
main "$@"