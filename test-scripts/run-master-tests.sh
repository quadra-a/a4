#!/usr/bin/env bash

# quadra-a Relay Test Suite - Master Test Runner
# Orchestrates all test suites and generates comprehensive reports
# Usage: ./run-master-tests.sh [options]

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]:-$0}")"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"

MASTER_RESULTS_DIR="$TEST_OUTPUT_ROOT/master-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
MASTER_RUN_ID="master_$TIMESTAMP"

# Default configuration
RELAY_URL="${QUADRA_A_RELAY_URL:-${HW1_RELAY_URL:-ws://relay-sg-1.quadra-a.com:8080}}"
if [[ -n "${A4_BINARY:-}" ]]; then
    A4_BINARY="$A4_BINARY"
elif [[ -f "$PROJECT_ROOT/rust/target/release/a4" ]]; then
    A4_BINARY="./rust/target/release/a4"
elif [[ -f "$PROJECT_ROOT/rust/target/debug/a4" ]]; then
    A4_BINARY="./rust/target/debug/a4"
elif [[ -f "$PROJECT_ROOT/js/cli/a4" ]]; then
    A4_BINARY="./js/cli/a4"
else
    A4_BINARY="a4"
fi
PARALLEL_EXECUTION=true
GENERATE_REPORTS=true
ARCHIVE_RESULTS=true
CLEANUP_AFTER=false

# Test suite configuration
ALL_TEST_SUITES=(benchmark ci comprehensive load quick stress validation)

suite_script_for() {
    case "$1" in
        quick) echo "$SCRIPT_DIR/test-relay-quick.sh" ;;
        comprehensive) echo "$SCRIPT_DIR/test-relay-comprehensive.sh" ;;
        benchmark) echo "$SCRIPT_DIR/benchmark-relay.sh" ;;
        load) echo "$SCRIPT_DIR/load-test-relay.sh" ;;
        stress) echo "$SCRIPT_DIR/stress-test-relay.sh" ;;
        ci) echo "$SCRIPT_DIR/ci-test-relay.sh" ;;
        validation) echo "$SCRIPT_DIR/validate-test-results.sh" ;;
        *) return 1 ;;
    esac
}

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

# Parse command line options
parse_options() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --relay)
                RELAY_URL="$2"
                shift 2
                ;;
            --binary)
                A4_BINARY="$2"
                shift 2
                ;;
            --suites)
                IFS=',' read -ra SELECTED_SUITES <<< "$2"
                shift 2
                ;;
            --no-parallel)
                PARALLEL_EXECUTION=false
                shift
                ;;
            --no-reports)
                GENERATE_REPORTS=false
                shift
                ;;
            --no-archive)
                ARCHIVE_RESULTS=false
                shift
                ;;
            --cleanup)
                CLEANUP_AFTER=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

# Show help
show_help() {
    cat << EOF
quadra-a Relay Master Test Runner

Usage: $SCRIPT_NAME [options]

Options:
  --relay URL           Relay URL to test (default: ws://relay-sg-1.quadra-a.com:8080)
  --binary PATH         Path to `a4` binary (default: auto-detect release/debug/Node CLI)
  --suites LIST         Comma-separated list of test suites to run
  --no-parallel         Run test suites sequentially instead of in parallel
  --no-reports          Skip report generation
  --no-archive          Skip result archiving
  --cleanup             Clean up intermediate files after completion
  --help, -h            Show this help message

Available Test Suites:
  quick                 Quick functionality tests (~30 seconds)
  comprehensive         Full test suite (~5 minutes)
  benchmark             Performance benchmarking (~3 minutes)
  load                  Load testing (~5 minutes)
  stress                Stress testing with scenarios (~10 minutes)
  ci                    CI-optimized tests (~2 minutes)
  validation            Compliance validation (requires existing results)

Examples:
  $SCRIPT_NAME                                    # Run all test suites
  $SCRIPT_NAME --suites quick,benchmark          # Run only quick and benchmark tests
  $SCRIPT_NAME --relay ws://localhost:8080       # Test against local relay
  $SCRIPT_NAME --no-parallel --cleanup           # Sequential execution with cleanup

Environment Variables:
  QUADRA_A_RELAY_URL    Default relay URL
  HW1_RELAY_URL         Legacy relay URL alias
  A4_BINARY          Default binary path
  CI                    Set to 'true' for CI mode

EOF
}

# Initialize master test run
init_master_run() {
    log_info "Initializing master test run: $MASTER_RUN_ID"

    # Create master results directory
    mkdir -p "$MASTER_RESULTS_DIR/$MASTER_RUN_ID"/{logs,reports,artifacts,summaries}

    # Create master metadata
    cat > "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" << EOF
{
  "master_run_id": "$MASTER_RUN_ID",
  "start_time": "$(quadra_iso_timestamp)",
  "configuration": {
    "relay_url": "$RELAY_URL",
    "a4_binary": "$A4_BINARY",
    "parallel_execution": $PARALLEL_EXECUTION,
    "generate_reports": $GENERATE_REPORTS,
    "archive_results": $ARCHIVE_RESULTS,
    "cleanup_after": $CLEANUP_AFTER
  },
  "environment": {
    "system": "$(uname -a)",
    "user": "$(whoami)",
    "pwd": "$PWD",
    "ci_mode": "${CI:-false}"
  },
  "test_suites": [],
  "status": "running"
}
EOF

    log_success "Master test run initialized"
}

# Execute test suite
execute_test_suite() {
    local suite_name="$1"
    local suite_script="$2"

    log_info "Executing test suite: $suite_name"

    local suite_start=$(date +%s)
    local suite_log="$MASTER_RESULTS_DIR/$MASTER_RUN_ID/logs/${suite_name}_suite.log"
    local suite_status="success"

    # Check if script exists
    if [[ ! -f "$suite_script" ]]; then
        log_error "Test suite script not found: $suite_script"
        suite_status="failed"
    else
        # Execute the test suite
        case "$suite_name" in
            "load")
                # Load test with shorter duration for master run
                if quadra_run_with_timeout 600 "$suite_script" "$RELAY_URL" "$A4_BINARY" 300 > "$suite_log" 2>&1; then
                    suite_status="success"
                else
                    suite_status="failed"
                fi
                ;;
            "stress")
                # Stress test with default scenario
                if quadra_run_with_timeout 900 "$suite_script" "$RELAY_URL" "$A4_BINARY" default > "$suite_log" 2>&1; then
                    suite_status="success"
                else
                    suite_status="failed"
                fi
                ;;
            "validation")
                # Validation requires existing results
                if [[ -d "./test-results" ]]; then
                    if quadra_run_with_timeout 300 "$suite_script" "./test-results" quadra-a-basic > "$suite_log" 2>&1; then
                        suite_status="success"
                    else
                        suite_status="failed"
                    fi
                else
                    log_warning "Skipping validation - no test results found"
                    suite_status="skipped"
                fi
                ;;
            *)
                # Standard test suites
                if quadra_run_with_timeout 900 "$suite_script" "$RELAY_URL" "$A4_BINARY" > "$suite_log" 2>&1; then
                    suite_status="success"
                else
                    suite_status="failed"
                fi
                ;;
        esac
    fi

    local suite_end=$(date +%s)
    local suite_duration=$((suite_end - suite_start))

    # Update master metadata
    local suite_metadata=$(cat << EOF
{
  "name": "$suite_name",
  "script": "$suite_script",
  "status": "$suite_status",
  "start_time": "$(quadra_epoch_to_iso "$suite_start")",
  "end_time": "$(quadra_epoch_to_iso "$suite_end")",
  "duration": $suite_duration,
  "log_file": "$suite_log"
}
EOF
)

    # Add suite to master metadata
    local temp_file=$(mktemp)
    if command -v jq &> /dev/null; then
        jq ".test_suites += [$suite_metadata]" "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" > "$temp_file"
        mv "$temp_file" "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json"
    fi

    if [[ "$suite_status" == "success" ]]; then
        log_success "Test suite '$suite_name' completed successfully in ${suite_duration}s"
    elif [[ "$suite_status" == "skipped" ]]; then
        log_warning "Test suite '$suite_name' skipped"
    else
        log_error "Test suite '$suite_name' failed after ${suite_duration}s"
    fi

    [[ "$suite_status" == "success" ]]
}

# Run test suites
run_test_suites() {
    log_info "=== RUNNING TEST SUITES ==="

    local suites_to_run=()

    # Determine which suites to run
    if [[ -n "${SELECTED_SUITES:-}" ]]; then
        suites_to_run=("${SELECTED_SUITES[@]}")
    else
        suites_to_run=("${ALL_TEST_SUITES[@]}")
    fi

    log_info "Test suites to run: ${suites_to_run[*]}"

    local total_suites=${#suites_to_run[@]}
    local successful_suites=0
    local failed_suites=0
    local skipped_suites=0

    if [[ "$PARALLEL_EXECUTION" == "true" && ${#suites_to_run[@]} -gt 1 ]]; then
        log_info "Running test suites in parallel..."

        # Run suites in parallel
        local pids=()
        for suite in "${suites_to_run[@]}"; do
            local suite_script
            if suite_script="$(suite_script_for "$suite")"; then
                execute_test_suite "$suite" "$suite_script" &
                pids+=($!)
            else
                log_error "Unknown test suite: $suite"
                ((failed_suites++))
            fi
        done

        # Wait for all suites to complete
        for pid in "${pids[@]}"; do
            if wait $pid; then
                ((successful_suites++))
            else
                ((failed_suites++))
            fi
        done
    else
        log_info "Running test suites sequentially..."

        # Run suites sequentially
        for suite in "${suites_to_run[@]}"; do
            local suite_script
            if suite_script="$(suite_script_for "$suite")"; then
                if execute_test_suite "$suite" "$suite_script"; then
                    ((successful_suites++))
                else
                    ((failed_suites++))
                fi
            else
                log_error "Unknown test suite: $suite"
                ((failed_suites++))
            fi
        done
    fi

    # Update final metadata
    local temp_file=$(mktemp)
    if command -v jq &> /dev/null; then
        jq ".end_time = \"$(quadra_iso_timestamp)\" | .total_suites = $total_suites | .successful_suites = $successful_suites | .failed_suites = $failed_suites | .skipped_suites = $skipped_suites | .status = \"$(if [[ $failed_suites -eq 0 ]]; then echo "success"; else echo "failed"; fi)\"" "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" > "$temp_file"
        mv "$temp_file" "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json"
    fi

    log_info "Test suites execution completed"
    log_info "Successful: $successful_suites, Failed: $failed_suites, Skipped: $skipped_suites"

    return $(if [[ $failed_suites -eq 0 ]]; then echo 0; else echo 1; fi)
}

# Collect artifacts from individual test runs
collect_artifacts() {
    if [[ "$GENERATE_REPORTS" != "true" ]]; then
        return 0
    fi

    log_info "=== COLLECTING ARTIFACTS ==="

    local artifacts_dir="$MASTER_RESULTS_DIR/$MASTER_RUN_ID/artifacts"

    # Collect results from various test result directories
    local result_dirs=(
        "./test-results"
        "./benchmark-results"
        "./load-test-results"
        "./stress-test-results"
        "./ci-test-results"
        "./validation-results"
    )

    for result_dir in "${result_dirs[@]}"; do
        if [[ -d "$result_dir" ]]; then
            log_info "Collecting artifacts from: $result_dir"
            cp -r "$result_dir" "$artifacts_dir/" 2>/dev/null || true
        fi
    done

    log_success "Artifacts collected"
}

# Generate master report
generate_master_report() {
    if [[ "$GENERATE_REPORTS" != "true" ]]; then
        return 0
    fi

    log_info "=== GENERATING MASTER REPORT ==="

    local report_dir="$MASTER_RESULTS_DIR/$MASTER_RUN_ID/reports"
    local summary_file="$MASTER_RESULTS_DIR/$MASTER_RUN_ID/summaries/master_summary.txt"

    # Generate text summary
    cat > "$summary_file" << EOF
quadra-a Relay Master Test Report
==================================
Generated: $(date)
Master Run ID: $MASTER_RUN_ID
Relay URL: $RELAY_URL
A4 Binary: $A4_BINARY

Configuration:
=============
Parallel Execution: $PARALLEL_EXECUTION
Generate Reports: $GENERATE_REPORTS
Archive Results: $ARCHIVE_RESULTS
Cleanup After: $CLEANUP_AFTER

Test Suite Results:
==================
EOF

    # Add individual suite results
    if command -v jq &> /dev/null && [[ -f "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" ]]; then
        jq -r '.test_suites[] | "- \(.name): \(.status) (\(.duration)s)"' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" >> "$summary_file" 2>/dev/null || echo "- No suite data available" >> "$summary_file"

        echo "" >> "$summary_file"
        echo "Overall Statistics:" >> "$summary_file"
        echo "==================" >> "$summary_file"
        jq -r '"Total Suites: " + (.total_suites // 0 | tostring)' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" >> "$summary_file" 2>/dev/null
        jq -r '"Successful: " + (.successful_suites // 0 | tostring)' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" >> "$summary_file" 2>/dev/null
        jq -r '"Failed: " + (.failed_suites // 0 | tostring)' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" >> "$summary_file" 2>/dev/null
        jq -r '"Success Rate: " + ((.successful_suites // 0) * 100 / (.total_suites // 1) | floor | tostring) + "%"' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" >> "$summary_file" 2>/dev/null
    fi

    cat >> "$summary_file" << EOF

Files and Directories:
=====================
- Master Results: $MASTER_RESULTS_DIR/$MASTER_RUN_ID/
- Logs: $MASTER_RESULTS_DIR/$MASTER_RUN_ID/logs/
- Reports: $MASTER_RESULTS_DIR/$MASTER_RUN_ID/reports/
- Artifacts: $MASTER_RESULTS_DIR/$MASTER_RUN_ID/artifacts/
- Metadata: $MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json

Generated at: $(date)
EOF

    # Generate HTML report if artifacts are available
    if [[ -d "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/artifacts" ]] && [[ -f "$SCRIPT_DIR/generate-test-report.sh" ]]; then
        log_info "Generating HTML master report..."
        "$SCRIPT_DIR/generate-test-report.sh" "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/artifacts" "$report_dir/master_report.html" 2>/dev/null || log_warning "HTML report generation failed"
    fi

    log_success "Master report generated: $summary_file"
    echo "$summary_file"
}

# Archive results
archive_results() {
    if [[ "$ARCHIVE_RESULTS" != "true" ]]; then
        return 0
    fi

    log_info "=== ARCHIVING RESULTS ==="

    local archive_file="$MASTER_RESULTS_DIR/${MASTER_RUN_ID}.tar.gz"

    # Create archive
    tar -czf "$archive_file" -C "$MASTER_RESULTS_DIR" "$MASTER_RUN_ID" 2>/dev/null

    if [[ -f "$archive_file" ]]; then
        local archive_size=$(du -h "$archive_file" | cut -f1)
        log_success "Results archived: $archive_file ($archive_size)"
    else
        log_error "Failed to create archive"
    fi
}

# Cleanup intermediate files
cleanup() {
    if [[ "$CLEANUP_AFTER" != "true" ]]; then
        return 0
    fi

    log_info "=== CLEANING UP ==="

    # Clean up individual test result directories
    local cleanup_dirs=(
        "./test-results"
        "./benchmark-results"
        "./load-test-results"
        "./stress-test-results"
        "./ci-test-results"
        "./validation-results"
    )

    for cleanup_dir in "${cleanup_dirs[@]}"; do
        if [[ -d "$cleanup_dir" ]]; then
            rm -rf "$cleanup_dir"
            log_info "Cleaned up: $cleanup_dir"
        fi
    done

    log_success "Cleanup completed"
}

# Main master test function
main() {
    echo "=================================================="
    echo "quadra-a Relay Master Test Runner"
    echo "=================================================="
    echo "Master Run ID: $MASTER_RUN_ID"
    echo "Relay URL: $RELAY_URL"
    echo "A4 Binary: $A4_BINARY"
    echo "Parallel Execution: $PARALLEL_EXECUTION"
    echo "=================================================="

    # Parse options
    parse_options "$@"

    # Check prerequisites
    if [[ ! -f "$A4_BINARY" ]]; then
        log_error "a4 binary not found at: $A4_BINARY"
        log_info "Please build the binary first: cd rust/cli-rs && cargo build --release"
        exit 1
    fi

    # Initialize master run
    init_master_run

    # Run test suites
    local suites_success=true
    if ! run_test_suites; then
        suites_success=false
    fi

    # Collect artifacts
    collect_artifacts

    # Generate master report
    local report_file=$(generate_master_report)

    # Archive results
    archive_results

    # Cleanup
    cleanup

    # Final summary
    echo "=================================================="
    echo "MASTER TEST RUN SUMMARY"
    echo "=================================================="
    echo "Master Run ID: $MASTER_RUN_ID"
    echo "Results Directory: $MASTER_RESULTS_DIR/$MASTER_RUN_ID"

    if command -v jq &> /dev/null && [[ -f "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json" ]]; then
        local total_suites=$(jq -r '.total_suites // 0' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json")
        local successful_suites=$(jq -r '.successful_suites // 0' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json")
        local failed_suites=$(jq -r '.failed_suites // 0' "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json")

        echo "Test Suites: $successful_suites/$total_suites successful"
        echo "Success Rate: $(quadra_divide "$successful_suites" "$total_suites" 1 100)%"
    fi

    if [[ -n "$report_file" ]]; then
        echo "Summary Report: $report_file"
    fi

    if [[ -f "$MASTER_RESULTS_DIR/$MASTER_RUN_ID/reports/master_report.html" ]]; then
        echo "HTML Report: $MASTER_RESULTS_DIR/$MASTER_RUN_ID/reports/master_report.html"
    fi

    echo "Metadata: $MASTER_RESULTS_DIR/$MASTER_RUN_ID/metadata.json"
    echo "=================================================="

    if [[ "$suites_success" == "true" ]]; then
        echo -e "\n${GREEN}🎉 All test suites completed successfully!${NC}"
        exit 0
    else
        echo -e "\n${RED}❌ Some test suites failed.${NC}"
        echo -e "${YELLOW}Check the logs and reports for details.${NC}"
        exit 1
    fi
}

# Run main function
main "$@"
