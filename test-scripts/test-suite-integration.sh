#!/usr/bin/env bash

# quadra-a Relay Test Suite - Final Integration Test
# Validates the complete test suite installation and functionality
# Usage: ./test-suite-integration.sh [install_dir]

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
INSTALL_DIR="${1:-$HOME/.quadra-a-test-suite}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]:-$0}")"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"

INTEGRATION_RESULTS="$TEST_OUTPUT_ROOT/integration-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

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

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Create results directory
mkdir -p "$INTEGRATION_RESULTS"

# Test execution wrapper
run_integration_test() {
    local test_name="$1"
    local test_command="$2"

    ((TOTAL_TESTS++))
    log_info "Running integration test: $test_name"

    if eval "$test_command" >/dev/null 2>&1; then
        log_success "$test_name"
        ((PASSED_TESTS++))
        return 0
    else
        log_error "$test_name"
        ((FAILED_TESTS++))
        return 1
    fi
}

# Test 1: Installation validation
test_installation() {
    log_info "=== INSTALLATION VALIDATION ==="

    run_integration_test "Installation directory exists" \
        "test -d '$INSTALL_DIR'"

    run_integration_test "Scripts directory exists" \
        "test -d '$INSTALL_DIR/scripts'"

    run_integration_test "Configuration directory exists" \
        "test -d '$INSTALL_DIR/config'"

    run_integration_test "Documentation directory exists" \
        "test -d '$INSTALL_DIR/docs'"

    run_integration_test "Examples directory exists" \
        "test -d '$INSTALL_DIR/examples'"

    # Check key scripts
    local key_scripts=(
        "test-relay-quick.sh"
        "test-relay-comprehensive.sh"
        "benchmark-relay.sh"
        "load-test-relay.sh"
        "monitor-relay.sh"
        "ci-test-relay.sh"
        "automate-tests.sh"
        "validate-test-results.sh"
        "generate-test-report.sh"
    )

    for script in "${key_scripts[@]}"; do
        run_integration_test "Script exists: $script" \
            "test -f '$INSTALL_DIR/scripts/$script'"

        run_integration_test "Script is executable: $script" \
            "test -x '$INSTALL_DIR/scripts/$script'"
    done
}

# Test 2: Script functionality
test_script_functionality() {
    log_info "=== SCRIPT FUNCTIONALITY ==="

    # Test help options
    local scripts_with_help=(
        "test-relay-quick.sh"
        "test-relay-comprehensive.sh"
        "benchmark-relay.sh"
        "load-test-relay.sh"
        "stress-test-relay.sh"
        "automate-tests.sh"
        "validate-test-results.sh"
    )

    for script in "${scripts_with_help[@]}"; do
        if [[ -f "$INSTALL_DIR/scripts/$script" ]]; then
            run_integration_test "Help option works: $script" \
                "$INSTALL_DIR/scripts/$script --help"
        fi
    done

    # Test configuration loading
    run_integration_test "Test configuration loads" \
        "source '$INSTALL_DIR/config/test-config.sh'"

    # Test environment setup
    if [[ -f "$INSTALL_DIR/environment.sh" ]]; then
        run_integration_test "Environment configuration loads" \
            "source '$INSTALL_DIR/environment.sh'"
    fi

    # Test aliases setup
    if [[ -f "$INSTALL_DIR/aliases.sh" ]]; then
        run_integration_test "Aliases configuration loads" \
            "source '$INSTALL_DIR/aliases.sh'"
    fi
}

# Test 3: Dependencies validation
test_dependencies() {
    log_info "=== DEPENDENCIES VALIDATION ==="

    local required_deps=("bash" "python3" "bc" "curl")
    local optional_deps=("jq" "nc" "timeout")

    for dep in "${required_deps[@]}"; do
        run_integration_test "Required dependency: $dep" \
            "command -v $dep"
    done

    for dep in "${optional_deps[@]}"; do
        if command -v "$dep" &> /dev/null; then
            log_success "Optional dependency available: $dep"
        else
            log_warning "Optional dependency missing: $dep"
        fi
    done

    # Test Python functionality
    run_integration_test "Python can generate test data" \
        "python3 -c \"print('A' * 1000)\" | wc -c | grep -q 1000"

    # Test bc calculations
    run_integration_test "bc can perform calculations" \
        "echo 'scale=2; 100 * 95 / 100' | bc | grep -q 95"

    # Test jq if available
    if command -v jq &> /dev/null; then
        run_integration_test "jq can parse JSON" \
            "echo '{\"test\": true}' | jq -r '.test' | grep -q true"
    fi
}

# Test 4: Configuration validation
test_configuration() {
    log_info "=== CONFIGURATION VALIDATION ==="

    # Test default configuration values
    if [[ -f "$INSTALL_DIR/config/test-config.sh" ]]; then
        run_integration_test "Test config has relay URLs" \
            "grep -q 'RELAY_URL' '$INSTALL_DIR/config/test-config.sh'"

        run_integration_test "Test config has binary paths" \
            "grep -q 'A4_BINARY' '$INSTALL_DIR/config/test-config.sh'"
    fi

    # Test example configurations
    if [[ -f "$INSTALL_DIR/examples/automation-config-example.json" ]]; then
        run_integration_test "Example automation config is valid JSON" \
            "python3 -m json.tool '$INSTALL_DIR/examples/automation-config-example.json'"
    fi

    # Test environment variables
    if [[ -f "$INSTALL_DIR/environment.sh" ]]; then
        source "$INSTALL_DIR/environment.sh"

        run_integration_test "Environment sets A4_TEST_SUITE_DIR" \
            "test -n '$A4_TEST_SUITE_DIR'"

        run_integration_test "Environment sets default relay" \
            "test -n '$A4_DEFAULT_RELAY'"
    fi
}

# Test 5: Documentation validation
test_documentation() {
    log_info "=== DOCUMENTATION VALIDATION ==="

    local doc_files=(
        "README.md"
        "TESTING_GUIDE.md"
    )

    for doc in "${doc_files[@]}"; do
        if [[ -f "$INSTALL_DIR/docs/$doc" ]]; then
            run_integration_test "Documentation exists: $doc" \
                "test -s '$INSTALL_DIR/docs/$doc'"

            run_integration_test "Documentation has content: $doc" \
                "wc -l '$INSTALL_DIR/docs/$doc' | awk '{print \$1}' | grep -v '^0$'"
        fi
    done

    # Test installation summary
    if [[ -f "$INSTALL_DIR/INSTALLATION_SUMMARY.md" ]]; then
        run_integration_test "Installation summary exists" \
            "test -s '$INSTALL_DIR/INSTALLATION_SUMMARY.md'"
    fi

    # Test version information
    if [[ -f "$INSTALL_DIR/VERSION" ]]; then
        run_integration_test "Version file exists" \
            "test -s '$INSTALL_DIR/VERSION'"

        run_integration_test "Version format is valid" \
            "grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' '$INSTALL_DIR/VERSION'"
    fi
}

# Test 6: Example configurations
test_examples() {
    log_info "=== EXAMPLE CONFIGURATIONS ==="

    local example_files=(
        "automation-config-example.json"
        "test-config-example.sh"
        "docker-compose.yml"
        "github-actions.yml"
    )

    for example in "${example_files[@]}"; do
        if [[ -f "$INSTALL_DIR/examples/$example" ]]; then
            run_integration_test "Example exists: $example" \
                "test -s '$INSTALL_DIR/examples/$example'"

            case "$example" in
                *.json)
                    run_integration_test "JSON example is valid: $example" \
                        "python3 -m json.tool '$INSTALL_DIR/examples/$example'"
                    ;;
                *.sh)
                    run_integration_test "Shell example has valid syntax: $example" \
                        "bash -n '$INSTALL_DIR/examples/$example'"
                    ;;
                *.yml)
                    run_integration_test "YAML example has basic structure: $example" \
                        "grep -q 'version:' '$INSTALL_DIR/examples/$example'"
                    ;;
            esac
        fi
    done
}

# Test 7: Symlinks and aliases (if created)
test_symlinks_aliases() {
    log_info "=== SYMLINKS AND ALIASES ==="

    # Check for symlinks in /usr/local/bin
    local symlinks=(
        "a4-test-quick"
        "a4-test-full"
        "a4-benchmark"
        "a4-load-test"
        "a4-monitor"
        "a4-ci-test"
        "a4-automate"
        "a4-validate"
        "a4-report"
    )

    local symlink_count=0
    for symlink in "${symlinks[@]}"; do
        if [[ -L "/usr/local/bin/$symlink" ]]; then
            ((symlink_count++))
            run_integration_test "Symlink exists: $symlink" \
                "test -L '/usr/local/bin/$symlink'"

            run_integration_test "Symlink target exists: $symlink" \
                "test -f '/usr/local/bin/$symlink'"
        fi
    done

    if [[ $symlink_count -gt 0 ]]; then
        log_success "Found $symlink_count symlinks in /usr/local/bin"
    else
        log_info "No symlinks found in /usr/local/bin (may be intentional)"
    fi

    # Test aliases if file exists
    if [[ -f "$INSTALL_DIR/aliases.sh" ]]; then
        run_integration_test "Aliases file is valid shell script" \
            "bash -n '$INSTALL_DIR/aliases.sh'"

        run_integration_test "Aliases file defines a4-help function" \
            "grep -q 'a4-help()' '$INSTALL_DIR/aliases.sh'"
    fi
}

# Test 8: Integration with actual relay (if available)
test_relay_integration() {
    log_info "=== RELAY INTEGRATION TEST ==="

    # Check if a4 binary is available
    local a4_binary=""
    local possible_paths=(
        "./rust/cli-rs/target/release/a4"
        "./target/release/a4"
        "/usr/local/bin/a4"
        "a4"
    )

    for path in "${possible_paths[@]}"; do
        if command -v "$path" &> /dev/null || [[ -f "$path" ]]; then
            a4_binary="$path"
            break
        fi
    done

    if [[ -n "$a4_binary" ]]; then
        log_success "Found a4 binary: $a4_binary"

        # Test basic connectivity
        run_integration_test "a4 binary is executable" \
            "$a4_binary --help"

        # Test relay connectivity (if relay is available)
        local relay_url="$DEFAULT_RELAY_URL"
        if quadra_run_with_timeout 10 "$a4_binary" find --relay "$relay_url" >/dev/null 2>&1; then
            log_success "Relay connectivity test passed"

            # Run a quick integration test
            run_integration_test "Quick integration test with real relay" \
                "$INSTALL_DIR/scripts/test-relay-quick.sh '$relay_url' '$a4_binary'"
        else
            log_warning "Relay not available for integration testing"
        fi
    else
        log_warning "a4 binary not found - skipping relay integration tests"
    fi
}

# Generate integration test report
generate_integration_report() {
    log_info "=== GENERATING INTEGRATION REPORT ==="

    local report_file="$INTEGRATION_RESULTS/integration_report_$TIMESTAMP.txt"

    cat > "$report_file" << EOF
quadra-a Relay Test Suite Integration Report
============================================
Generated: $(date)
Installation Directory: $INSTALL_DIR
Test Suite Version: $(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
System: $(uname -a)

Integration Test Results:
========================
Total Tests: $TOTAL_TESTS
Passed: $PASSED_TESTS
Failed: $FAILED_TESTS
Success Rate: $(quadra_divide "$PASSED_TESTS" "$TOTAL_TESTS" 1 100)%

Test Categories:
===============
1. Installation Validation - Core installation structure
2. Script Functionality - Script execution and help options
3. Dependencies Validation - Required and optional dependencies
4. Configuration Validation - Configuration files and settings
5. Documentation Validation - Documentation completeness
6. Example Configurations - Example files and templates
7. Symlinks and Aliases - Convenience features
8. Relay Integration - Live relay testing (if available)

Installation Status:
===================
Installation Directory: $(if [[ -d "$INSTALL_DIR" ]]; then echo "✓ EXISTS"; else echo "✗ MISSING"; fi)
Scripts: $(ls "$INSTALL_DIR/scripts"/*.sh 2>/dev/null | wc -l) files
Configuration: $(ls "$INSTALL_DIR/config"/* 2>/dev/null | wc -l) files
Documentation: $(ls "$INSTALL_DIR/docs"/* 2>/dev/null | wc -l) files
Examples: $(ls "$INSTALL_DIR/examples"/* 2>/dev/null | wc -l) files

Dependencies Status:
===================
bash: $(if command -v bash &>/dev/null; then echo "✓"; else echo "✗"; fi)
python3: $(if command -v python3 &>/dev/null; then echo "✓"; else echo "✗"; fi)
bc: $(if command -v bc &>/dev/null; then echo "✓"; else echo "✗"; fi)
curl: $(if command -v curl &>/dev/null; then echo "✓"; else echo "✗"; fi)
jq: $(if command -v jq &>/dev/null; then echo "✓ (optional)"; else echo "- (optional)"; fi)
nc: $(if command -v nc &>/dev/null; then echo "✓ (optional)"; else echo "- (optional)"; fi)
timeout: $(if quadra_timeout_command >/dev/null 2>&1; then echo "✓ (optional)"; else echo "- (optional, python fallback supported)"; fi)

Quick Start Commands:
====================
# Load environment
source $INSTALL_DIR/aliases.sh
source $INSTALL_DIR/environment.sh

# Run quick test
a4-quick
# or
$INSTALL_DIR/scripts/test-relay-quick.sh

# Run comprehensive tests
a4-full
# or
$INSTALL_DIR/scripts/test-relay-comprehensive.sh

# Performance benchmarking
a4-bench
# or
$INSTALL_DIR/scripts/benchmark-relay.sh

# Get help
a4-help
# or
$INSTALL_DIR/scripts/test-relay-quick.sh --help

Troubleshooting:
===============
If tests failed, check:
1. Installation directory permissions
2. Missing dependencies
3. Script execution permissions
4. Configuration file syntax

For support:
- Check documentation: $INSTALL_DIR/docs/
- View examples: $INSTALL_DIR/examples/
- Installation summary: $INSTALL_DIR/INSTALLATION_SUMMARY.md

Integration test completed at: $(date)
EOF

    log_success "Integration report generated: $report_file"
    echo "$report_file"
}

# Main integration test function
main() {
    echo "=================================================="
    echo "quadra-a Relay Test Suite Integration Test"
    echo "=================================================="
    echo "Installation Directory: $INSTALL_DIR"
    echo "Integration Results: $INTEGRATION_RESULTS"
    echo "=================================================="

    # Check if installation directory exists
    if [[ ! -d "$INSTALL_DIR" ]]; then
        log_error "Installation directory not found: $INSTALL_DIR"
        log_info "Please run the installer first: ./scripts/install-test-suite.sh"
        exit 1
    fi

    # Run integration tests
    test_installation
    test_script_functionality
    test_dependencies
    test_configuration
    test_documentation
    test_examples
    test_symlinks_aliases
    test_relay_integration

    # Generate report
    local report_file=$(generate_integration_report)

    # Final summary
    echo "=================================================="
    echo "INTEGRATION TEST SUMMARY"
    echo "=================================================="
    echo -e "Total Tests: ${BLUE}$TOTAL_TESTS${NC}"
    echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
    echo -e "Failed: ${RED}$FAILED_TESTS${NC}"

    local success_rate
    success_rate="$(quadra_divide "$PASSED_TESTS" "$TOTAL_TESTS" 1 100)"
    echo -e "Success Rate: ${BLUE}${success_rate}%${NC}"
    echo ""
    echo "Integration Report: $report_file"
    echo "=================================================="

    if [[ $FAILED_TESTS -eq 0 ]]; then
        echo -e "\n${GREEN}🎉 All integration tests passed!${NC}"
        echo -e "${GREEN}The test suite is ready for use.${NC}"
        echo ""
        echo "Quick start:"
        echo "  source $INSTALL_DIR/aliases.sh"
        echo "  a4-quick"
        exit 0
    else
        echo -e "\n${RED}❌ Some integration tests failed.${NC}"
        echo -e "${YELLOW}Please review the report and fix any issues.${NC}"
        exit 1
    fi
}

# Handle help
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "quadra-a Relay Test Suite Integration Test"
    echo "Usage: $SCRIPT_NAME [install_dir]"
    echo ""
    echo "This script validates the test suite installation and functionality."
    echo ""
    echo "Parameters:"
    echo "  install_dir    Installation directory to test (default: ~/.highway1-test-suite)"
    echo ""
    echo "The integration test validates:"
    echo "- Installation structure and files"
    echo "- Script functionality and help options"
    echo "- Dependencies and configuration"
    echo "- Documentation and examples"
    echo "- Symlinks and aliases (if created)"
    echo "- Live relay integration (if available)"
    exit 0
fi

# Run main function
main "$@"
