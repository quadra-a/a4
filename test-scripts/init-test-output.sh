#!/bin/bash

# quadra-a Test Output Directory Initialization
# Creates the centralized test output directory structure
# Usage: ./init-test-output.sh

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

# Create centralized output directory structure
create_output_directories() {
    log_info "Creating centralized test output directories..."

    # Main output directory
    mkdir -p "$TEST_OUTPUT_ROOT"

    # Subdirectories
    mkdir -p "$RESULTS_DIR"
    mkdir -p "$LOG_DIRECTORY"
    mkdir -p "$REPORTS_DIR"
    mkdir -p "$ARTIFACTS_DIR"

    # Specific test type directories
    mkdir -p "$TEST_OUTPUT_ROOT/ci-results"
    mkdir -p "$TEST_OUTPUT_ROOT/integration-results"
    mkdir -p "$TEST_OUTPUT_ROOT/load-results"
    mkdir -p "$TEST_OUTPUT_ROOT/stress-results"
    mkdir -p "$TEST_OUTPUT_ROOT/master-results"
    mkdir -p "$TEST_OUTPUT_ROOT/validation-results"
    mkdir -p "$TEST_OUTPUT_ROOT/automation-results"
    mkdir -p "$TEST_OUTPUT_ROOT/test-environment"

    log_success "Test output directories created at: $TEST_OUTPUT_ROOT"
}

# Clean legacy directories (optional)
clean_legacy_directories() {
    log_info "Cleaning legacy output directories..."

    local legacy_dirs=(
        "$LEGACY_TEST_RESULTS"
        "$LEGACY_CI_RESULTS"
        "$LEGACY_INTEGRATION_RESULTS"
        "$LEGACY_LOAD_RESULTS"
        "$LEGACY_STRESS_RESULTS"
        "$LEGACY_MASTER_RESULTS"
        "./test-logs"
        "./validation-results"
        "./automation-results"
        "./test-environment"
    )

    for dir in "${legacy_dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            log_info "Removing legacy directory: $dir"
            rm -rf "$dir"
        fi
    done

    log_success "Legacy directories cleaned"
}

# Main execution
main() {
    echo "=================================================="
    echo "quadra-a Test Output Directory Initialization"
    echo "=================================================="
    echo "Output Root: $TEST_OUTPUT_ROOT"
    echo "=================================================="

    create_output_directories

    if [[ "${1:-}" == "--clean-legacy" ]]; then
        clean_legacy_directories
    fi

    echo ""
    echo "Directory structure:"
    echo "  $TEST_OUTPUT_ROOT/"
    echo "  ├── results/           # Test results"
    echo "  ├── logs/              # Test logs"
    echo "  ├── reports/           # HTML reports"
    echo "  ├── artifacts/         # Test artifacts"
    echo "  ├── ci-results/        # CI test results"
    echo "  ├── integration-results/ # Integration test results"
    echo "  ├── load-results/      # Load test results"
    echo "  ├── stress-results/    # Stress test results"
    echo "  ├── master-results/    # Master test results"
    echo "  ├── validation-results/ # Validation results"
    echo "  ├── automation-results/ # Automation results"
    echo "  └── test-environment/  # Test environment data"
    echo ""
    echo "=================================================="
    log_success "Test output initialization complete"
    echo "=================================================="
}

# Run if called directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi