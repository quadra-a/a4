#!/bin/bash

# quadra-a Relay Core Test Suite Runner
# Master script to run core relay tests with support for both Rust and TypeScript CLIs
# NOTE: This runs only core tests (quick, comprehensive, benchmark, load). Use run-all-tests.sh for complete coverage.
# Usage: ./run-core-tests.sh [cli_mode] [relay_url] [binary_path]
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
    local script_path="$SCRIPT_DIR/$script_name"

    log_info "Running: $description (CLI Mode: $cli_mode)"

    if [[ ! -f "$script_path" ]]; then
        log_error "Script not found: $script_path"
        return 1
    fi

    local log_file="$RESULTS_DIR/${script_name%.sh}_${cli_mode}_$TIMESTAMP.log"

    # Pass CLI mode and other parameters to the test script
    if "$script_path" "$RELAY_URL" "$cli_mode" "$CUSTOM_BINARY" > "$log_file" 2>&1; then
        log_success "$description ($cli_mode) completed successfully"
        echo "Log: $log_file"
        return 0
    else
        log_error "$description ($cli_mode) failed"
        echo "Error log: $log_file"
        return 1
    fi
}

# Main test execution
main() {
    echo "=================================================="
    echo "quadra-a Relay Test Suite Runner"
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
                log_error "Rust CLI not found. Build with: cd rust/cli-rs && cargo build --release"
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

    log_info "Starting core relay testing..."

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

    # Run tests for each CLI mode
    for cli_mode in "${cli_modes_to_test[@]}"; do
        echo ""
        echo "=================================================="
        echo "Testing with CLI Mode: $cli_mode"
        echo "=================================================="

        # Test 1: Quick validation test
        ((total_tests++))
        if run_test_script "test-relay-quick.sh" "Quick Validation Test" "$cli_mode"; then
            ((passed_tests++))
        else
            ((failed_tests++))
            log_warning "Quick test failed for $cli_mode - continuing with other tests"
        fi

        # Test 2: Comprehensive functionality test
        ((total_tests++))
        if run_test_script "test-relay-comprehensive.sh" "Comprehensive Functionality Test" "$cli_mode"; then
            ((passed_tests++))
        else
            ((failed_tests++))
            log_warning "Comprehensive test failed for $cli_mode - continuing with other tests"
        fi

        # Test 3: Performance benchmark (if available)
        if [[ -f "$SCRIPT_DIR/benchmark-relay.sh" ]]; then
            ((total_tests++))
            if run_test_script "benchmark-relay.sh" "Performance Benchmark" "$cli_mode"; then
                ((passed_tests++))
            else
                ((failed_tests++))
                log_warning "Benchmark failed for $cli_mode - continuing with other tests"
            fi
        fi

        # Test 4: Load test (if available)
        if [[ -f "$SCRIPT_DIR/load-test-relay.sh" ]]; then
            ((total_tests++))
            local load_log_file="$RESULTS_DIR/load-test_${cli_mode}_$TIMESTAMP.log"
            if "$SCRIPT_DIR/load-test-relay.sh" "$RELAY_URL" "$cli_mode" "$CUSTOM_BINARY" 30 > "$load_log_file" 2>&1; then
                log_success "Load Test (30s) for $cli_mode completed successfully"
                ((passed_tests++))
            else
                log_error "Load Test failed for $cli_mode"
                ((failed_tests++))
            fi
        fi
    done

    # Run dual CLI compatibility test if both CLIs are being tested
    if [[ "$CLI_MODE" == "both" && -f "$SCRIPT_DIR/test-dual-cli.sh" ]]; then
        ((total_tests++))
        local dual_log_file="$RESULTS_DIR/test-dual-cli_$TIMESTAMP.log"
        if "$SCRIPT_DIR/test-dual-cli.sh" "$RELAY_URL" > "$dual_log_file" 2>&1; then
            log_success "Dual CLI Compatibility Test completed successfully"
            ((passed_tests++))
        else
            log_error "Dual CLI Compatibility Test failed"
            ((failed_tests++))
        fi
    fi

    # Generate consolidated report
    local report_file="$RESULTS_DIR/test_suite_report_$TIMESTAMP.txt"

    cat > "$report_file" << EOF
quadra-a Relay Test Suite Report
=================================
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
Success Rate: $(echo "scale=1; $passed_tests * 100 / $total_tests" | bc -l)%

Individual Test Results:
=======================
EOF

    # Add individual test results
    for log_file in "$RESULTS_DIR"/*_$TIMESTAMP.log; do
        if [[ -f "$log_file" ]]; then
            local test_name=$(basename "$log_file" .log | sed "s/_$TIMESTAMP//")
            echo "- $test_name: $(if grep -q "PASS\|SUCCESS\|✅" "$log_file"; then echo "PASSED"; else echo "FAILED"; fi)" >> "$report_file"
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
            echo "- Cross-CLI Compatibility: $(if [[ -f "$RESULTS_DIR/test-dual-cli_$TIMESTAMP.log" ]] && grep -q "PASS\|SUCCESS\|✅" "$RESULTS_DIR/test-dual-cli_$TIMESTAMP.log"; then echo "VERIFIED"; else echo "FAILED"; fi)" >> "$report_file"
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
    echo "TEST SUITE SUMMARY"
    echo "=================================================="
    echo -e "CLI Mode: ${BLUE}$CLI_MODE${NC}"
    echo -e "Total Test Suites: ${BLUE}$total_tests${NC}"
    echo -e "Passed: ${GREEN}$passed_tests${NC}"
    echo -e "Failed: ${RED}$failed_tests${NC}"
    echo -e "Success Rate: ${BLUE}$(echo "scale=1; $passed_tests * 100 / $total_tests" | bc -l)%${NC}"
    echo ""
    echo "Consolidated Report: $report_file"
    echo "All Logs Directory: $RESULTS_DIR"
    echo "=================================================="

    if [[ $failed_tests -eq 0 ]]; then
        echo -e "\n${GREEN}🎉 ALL TEST SUITES PASSED! quadra-a is production ready.${NC}"
        echo ""
        echo "Next steps:"
        echo "• Deploy relay to production environment"
        echo "• Distribute CLI binaries to users"
        echo "• Monitor relay performance and logs"
        exit 0
    else
        echo -e "\n${YELLOW}⚠️  Some test suites failed. Please review the logs.${NC}"
        echo ""
        echo "Troubleshooting:"
        echo "• Check relay server is running and accessible"
        echo "• Verify CLI binaries are built and executable"
        echo "• Review test logs for specific error details"
        echo "• Run individual test suites for focused debugging"
        exit 1
    fi
}

# Run main function
main "$@"