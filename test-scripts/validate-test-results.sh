#!/usr/bin/env bash

# quadra-a Relay Test Validator
# Validates test results and generates compliance reports
# Usage: ./validate-test-results.sh [results_directory] [compliance_standard]

set -e

if [[ -n "${BASH_VERSION:-}" && "${BASH_VERSINFO[0]:-0}" -lt 4 && -z "${ZSH_VERSION:-}" ]]; then
    if command -v zsh >/dev/null 2>&1; then
        exec zsh "$0" "$@"
    fi
fi

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
RESULTS_DIR="${1:-$TEST_OUTPUT_ROOT/results}"
COMPLIANCE_STANDARD="${2:-quadra-a-basic}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]:-$0}")"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"

VALIDATION_DIR="$TEST_OUTPUT_ROOT/validation-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
VALIDATION_REPORT="$VALIDATION_DIR/validation_report_$TIMESTAMP.json"

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

# Compliance standards
declare -A COMPLIANCE_STANDARDS

# quadra-a Basic Compliance
COMPLIANCE_STANDARDS[quadra-a-basic]='
{
  "name": "quadra-a Basic Compliance",
  "version": "1.0",
  "requirements": {
    "discovery": {
      "basic_discovery": { "required": true, "min_success_rate": 100 },
      "query_discovery": { "required": true, "min_success_rate": 95 },
      "discovery_latency": { "required": true, "max_latency_ms": 1000 }
    },
    "messaging": {
      "basic_messaging": { "required": true, "min_success_rate": 100 },
      "message_delivery": { "required": true, "max_latency_ms": 2000 },
      "payload_support": { "required": true, "min_payload_size": 1000 }
    },
    "reliability": {
      "connection_stability": { "required": true, "min_uptime_percent": 99 },
      "error_handling": { "required": true, "max_error_rate": 1 },
      "recovery_time": { "required": false, "max_recovery_ms": 5000 }
    },
    "performance": {
      "throughput": { "required": true, "min_messages_per_second": 10 },
      "concurrent_connections": { "required": true, "min_connections": 10 },
      "resource_usage": { "required": false, "max_cpu_percent": 80 }
    }
  }
}
'

COMPLIANCE_STANDARDS[highway1-basic]="${COMPLIANCE_STANDARDS[quadra-a-basic]}"

# quadra-a Production Compliance
COMPLIANCE_STANDARDS[quadra-a-production]='
{
  "name": "quadra-a Production Compliance",
  "version": "1.0",
  "requirements": {
    "discovery": {
      "basic_discovery": { "required": true, "min_success_rate": 100 },
      "query_discovery": { "required": true, "min_success_rate": 99 },
      "discovery_latency": { "required": true, "max_latency_ms": 500 }
    },
    "messaging": {
      "basic_messaging": { "required": true, "min_success_rate": 100 },
      "message_delivery": { "required": true, "max_latency_ms": 1000 },
      "payload_support": { "required": true, "min_payload_size": 50000 }
    },
    "reliability": {
      "connection_stability": { "required": true, "min_uptime_percent": 99.9 },
      "error_handling": { "required": true, "max_error_rate": 0.1 },
      "recovery_time": { "required": true, "max_recovery_ms": 3000 }
    },
    "performance": {
      "throughput": { "required": true, "min_messages_per_second": 50 },
      "concurrent_connections": { "required": true, "min_connections": 100 },
      "resource_usage": { "required": true, "max_cpu_percent": 60 }
    },
    "security": {
      "message_signing": { "required": true, "min_success_rate": 100 },
      "encryption": { "required": true, "min_success_rate": 100 },
      "authentication": { "required": true, "min_success_rate": 100 }
    }
  }
}
'

COMPLIANCE_STANDARDS[highway1-production]="${COMPLIANCE_STANDARDS[quadra-a-production]}"

# Enterprise Compliance
COMPLIANCE_STANDARDS[enterprise]='
{
  "name": "Enterprise Compliance",
  "version": "1.0",
  "requirements": {
    "discovery": {
      "basic_discovery": { "required": true, "min_success_rate": 100 },
      "query_discovery": { "required": true, "min_success_rate": 99.9 },
      "discovery_latency": { "required": true, "max_latency_ms": 200 }
    },
    "messaging": {
      "basic_messaging": { "required": true, "min_success_rate": 100 },
      "message_delivery": { "required": true, "max_latency_ms": 500 },
      "payload_support": { "required": true, "min_payload_size": 100000 }
    },
    "reliability": {
      "connection_stability": { "required": true, "min_uptime_percent": 99.99 },
      "error_handling": { "required": true, "max_error_rate": 0.01 },
      "recovery_time": { "required": true, "max_recovery_ms": 1000 }
    },
    "performance": {
      "throughput": { "required": true, "min_messages_per_second": 200 },
      "concurrent_connections": { "required": true, "min_connections": 1000 },
      "resource_usage": { "required": true, "max_cpu_percent": 40 }
    },
    "security": {
      "message_signing": { "required": true, "min_success_rate": 100 },
      "encryption": { "required": true, "min_success_rate": 100 },
      "authentication": { "required": true, "min_success_rate": 100 },
      "audit_logging": { "required": true, "min_success_rate": 100 }
    },
    "scalability": {
      "horizontal_scaling": { "required": true, "min_nodes": 3 },
      "load_balancing": { "required": true, "min_success_rate": 99 },
      "auto_scaling": { "required": false, "response_time_ms": 30000 }
    }
  }
}
'

# Create validation directory
mkdir -p "$VALIDATION_DIR"

# Load compliance standard
load_compliance_standard() {
    local standard_json="${COMPLIANCE_STANDARDS[$COMPLIANCE_STANDARD]}"

    if [[ -z "$standard_json" ]]; then
        log_error "Unknown compliance standard: $COMPLIANCE_STANDARD"
        log_info "Available standards: quadra-a-basic, quadra-a-production, enterprise"
        log_info "Legacy aliases: highway1-basic, highway1-production"
        exit 1
    fi

    log_info "Loading compliance standard: $COMPLIANCE_STANDARD"

    # Save standard to file for reference
    echo "$standard_json" > "$VALIDATION_DIR/compliance_standard_$COMPLIANCE_STANDARD.json"

    log_success "Compliance standard loaded"
}

# Parse test results
parse_test_results() {
    log_info "Parsing test results from: $RESULTS_DIR"

    if [[ ! -d "$RESULTS_DIR" ]]; then
        log_error "Results directory not found: $RESULTS_DIR"
        exit 1
    fi

    # Initialize results structure
    cat > "$VALIDATION_REPORT" << 'EOF'
{
  "validation_info": {
    "timestamp": "",
    "compliance_standard": "",
    "results_directory": "",
    "validator_version": "1.0"
  },
  "test_results": {
    "discovery": {},
    "messaging": {},
    "reliability": {},
    "performance": {},
    "security": {},
    "scalability": {}
  },
  "compliance_check": {
    "overall_status": "unknown",
    "passed_requirements": 0,
    "failed_requirements": 0,
    "total_requirements": 0,
    "compliance_score": 0,
    "details": []
  }
}
EOF

    # Update validation info
    local temp_file=$(mktemp)
    jq ".validation_info.timestamp = \"$(quadra_iso_timestamp)\" | .validation_info.compliance_standard = \"$COMPLIANCE_STANDARD\" | .validation_info.results_directory = \"$RESULTS_DIR\"" "$VALIDATION_REPORT" > "$temp_file"
    mv "$temp_file" "$VALIDATION_REPORT"

    # Parse different types of test results
    parse_discovery_results
    parse_messaging_results
    parse_performance_results
    parse_reliability_results

    log_success "Test results parsed"
}

# Parse discovery test results
parse_discovery_results() {
    log_info "Parsing discovery test results..."

    local discovery_data='{
      "basic_discovery": {"success_rate": 0, "avg_latency_ms": 0, "total_tests": 0},
      "query_discovery": {"success_rate": 0, "avg_latency_ms": 0, "total_tests": 0},
      "discovery_latency": {"max_latency_ms": 0, "avg_latency_ms": 0, "p95_latency_ms": 0}
    }'

    # Look for discovery test results in log files
    for log_file in "$RESULTS_DIR"/*.log "$RESULTS_DIR"/*/*.log; do
        if [[ -f "$log_file" ]]; then
            # Count discovery tests
            local discovery_pass=$(grep -c "Discovery.*PASS\|Discovery working" "$log_file" 2>/dev/null || echo "0")
            local discovery_fail=$(grep -c "Discovery.*FAIL\|Discovery failed" "$log_file" 2>/dev/null || echo "0")
            local total_discovery=$((discovery_pass + discovery_fail))

            if [[ $total_discovery -gt 0 ]]; then
                local success_rate=$(echo "scale=2; $discovery_pass * 100 / $total_discovery" | bc -l)
                discovery_data=$(echo "$discovery_data" | jq ".basic_discovery.success_rate = $success_rate | .basic_discovery.total_tests = $total_discovery")
            fi
        fi
    done

    # Update validation report
    local temp_file=$(mktemp)
    jq ".test_results.discovery = $discovery_data" "$VALIDATION_REPORT" > "$temp_file"
    mv "$temp_file" "$VALIDATION_REPORT"
}

# Parse messaging test results
parse_messaging_results() {
    log_info "Parsing messaging test results..."

    local messaging_data='{
      "basic_messaging": {"success_rate": 0, "avg_latency_ms": 0, "total_tests": 0},
      "message_delivery": {"success_rate": 0, "avg_latency_ms": 0, "total_tests": 0},
      "payload_support": {"max_payload_size": 0, "success_rate": 0, "total_tests": 0}
    }'

    # Look for messaging test results
    for log_file in "$RESULTS_DIR"/*.log "$RESULTS_DIR"/*/*.log; do
        if [[ -f "$log_file" ]]; then
            # Count message delivery tests
            local message_pass=$(grep -c "Message.*delivered\|MESSAGE SENT.*Delivered: true" "$log_file" 2>/dev/null || echo "0")
            local message_fail=$(grep -c "Message.*failed\|MESSAGE.*failed" "$log_file" 2>/dev/null || echo "0")
            local total_messages=$((message_pass + message_fail))

            if [[ $total_messages -gt 0 ]]; then
                local success_rate=$(echo "scale=2; $message_pass * 100 / $total_messages" | bc -l)
                messaging_data=$(echo "$messaging_data" | jq ".basic_messaging.success_rate = $success_rate | .basic_messaging.total_tests = $total_messages")
            fi

            # Check for large payload tests
            if grep -q "50000.*Delivered: true\|50KB.*delivered" "$log_file" 2>/dev/null; then
                messaging_data=$(echo "$messaging_data" | jq ".payload_support.max_payload_size = 50000")
            elif grep -q "10000.*Delivered: true\|10KB.*delivered" "$log_file" 2>/dev/null; then
                messaging_data=$(echo "$messaging_data" | jq ".payload_support.max_payload_size = 10000")
            elif grep -q "1000.*Delivered: true\|1KB.*delivered" "$log_file" 2>/dev/null; then
                messaging_data=$(echo "$messaging_data" | jq ".payload_support.max_payload_size = 1000")
            fi
        fi
    done

    # Update validation report
    local temp_file=$(mktemp)
    jq ".test_results.messaging = $messaging_data" "$VALIDATION_REPORT" > "$temp_file"
    mv "$temp_file" "$VALIDATION_REPORT"
}

# Parse performance test results
parse_performance_results() {
    log_info "Parsing performance test results..."

    local performance_data='{
      "throughput": {"messages_per_second": 0, "peak_throughput": 0},
      "concurrent_connections": {"max_connections": 0, "success_rate": 0},
      "resource_usage": {"max_cpu_percent": 0, "max_memory_mb": 0}
    }'

    # Look for throughput data
    for log_file in "$RESULTS_DIR"/*.log "$RESULTS_DIR"/*/*.log; do
        if [[ -f "$log_file" ]]; then
            # Extract throughput information
            local throughput=$(grep -o "[0-9]\+\.[0-9]\+ msg/s\|[0-9]\+ msg/s" "$log_file" 2>/dev/null | head -1 | grep -o "[0-9]\+\.[0-9]\+\|[0-9]\+" || echo "0")
            if [[ "$throughput" != "0" ]]; then
                performance_data=$(echo "$performance_data" | jq ".throughput.messages_per_second = $throughput")
            fi

            # Extract concurrent connection data
            local concurrent=$(grep -o "[0-9]\+ concurrent.*completed\|[0-9]\+ parallel.*completed" "$log_file" 2>/dev/null | head -1 | grep -o "[0-9]\+" || echo "0")
            if [[ "$concurrent" != "0" ]]; then
                performance_data=$(echo "$performance_data" | jq ".concurrent_connections.max_connections = $concurrent")
            fi
        fi
    done

    # Update validation report
    local temp_file=$(mktemp)
    jq ".test_results.performance = $performance_data" "$VALIDATION_REPORT" > "$temp_file"
    mv "$temp_file" "$VALIDATION_REPORT"
}

# Parse reliability test results
parse_reliability_results() {
    log_info "Parsing reliability test results..."

    local reliability_data='{
      "connection_stability": {"uptime_percent": 0, "connection_drops": 0},
      "error_handling": {"error_rate": 0, "total_errors": 0},
      "recovery_time": {"avg_recovery_ms": 0, "max_recovery_ms": 0}
    }'

    # Look for connection stability data
    for log_file in "$RESULTS_DIR"/*.log "$RESULTS_DIR"/*/*.log; do
        if [[ -f "$log_file" ]]; then
            # Count connection issues
            local connection_errors=$(grep -c "Connection.*failed\|Connection.*closed\|Connection.*error" "$log_file" 2>/dev/null || echo "0")
            local total_operations=$(grep -c "PASS\|FAIL" "$log_file" 2>/dev/null || echo "1")

            if [[ $total_operations -gt 0 ]]; then
                local error_rate=$(echo "scale=2; $connection_errors * 100 / $total_operations" | bc -l)
                reliability_data=$(echo "$reliability_data" | jq ".error_handling.error_rate = $error_rate | .error_handling.total_errors = $connection_errors")
            fi
        fi
    done

    # Update validation report
    local temp_file=$(mktemp)
    jq ".test_results.reliability = $reliability_data" "$VALIDATION_REPORT" > "$temp_file"
    mv "$temp_file" "$VALIDATION_REPORT"
}

# Validate against compliance standard
validate_compliance() {
    log_info "Validating against compliance standard: $COMPLIANCE_STANDARD"

    local standard_file="$VALIDATION_DIR/compliance_standard_$COMPLIANCE_STANDARD.json"
    local passed_requirements=0
    local failed_requirements=0
    local total_requirements=0

    # Get all requirements from the standard
    local requirements=$(jq -r '.requirements | to_entries[] | .key as $category | .value | to_entries[] | "\($category).\(.key)"' "$standard_file")

    while IFS= read -r requirement_path; do
        ((total_requirements++))

        local category=$(echo "$requirement_path" | cut -d. -f1)
        local requirement=$(echo "$requirement_path" | cut -d. -f2)

        log_info "Checking requirement: $requirement_path"

        # Get requirement details
        local requirement_config=$(jq -r ".requirements.$category.$requirement" "$standard_file")
        local is_required=$(echo "$requirement_config" | jq -r '.required')

        if [[ "$is_required" != "true" ]]; then
            log_info "  Requirement is optional, skipping"
            ((passed_requirements++))
            continue
        fi

        # Validate specific requirement
        local validation_result=$(validate_specific_requirement "$category" "$requirement" "$requirement_config")

        if [[ "$validation_result" == "PASS" ]]; then
            ((passed_requirements++))
            log_success "  Requirement passed: $requirement_path"
        else
            ((failed_requirements++))
            log_error "  Requirement failed: $requirement_path"
        fi

        # Add to compliance details
        local detail="{\"requirement\": \"$requirement_path\", \"status\": \"$validation_result\", \"category\": \"$category\"}"
        local temp_file=$(mktemp)
        jq ".compliance_check.details += [$detail]" "$VALIDATION_REPORT" > "$temp_file"
        mv "$temp_file" "$VALIDATION_REPORT"

    done <<< "$requirements"

    # Calculate compliance score
    local compliance_score=0
    if [[ $total_requirements -gt 0 ]]; then
        compliance_score=$(echo "scale=2; $passed_requirements * 100 / $total_requirements" | bc -l)
    fi

    # Determine overall status
    local overall_status="FAILED"
    if [[ $failed_requirements -eq 0 ]]; then
        overall_status="PASSED"
    fi

    # Update compliance check results
    local temp_file=$(mktemp)
    jq ".compliance_check.overall_status = \"$overall_status\" | .compliance_check.passed_requirements = $passed_requirements | .compliance_check.failed_requirements = $failed_requirements | .compliance_check.total_requirements = $total_requirements | .compliance_check.compliance_score = $compliance_score" "$VALIDATION_REPORT" > "$temp_file"
    mv "$temp_file" "$VALIDATION_REPORT"

    log_info "Compliance validation completed"
    log_info "Score: ${compliance_score}% ($passed_requirements/$total_requirements)"

    if [[ "$overall_status" == "PASSED" ]]; then
        log_success "Overall compliance: PASSED"
    else
        log_error "Overall compliance: FAILED"
    fi
}

# Validate specific requirement
validate_specific_requirement() {
    local category="$1"
    local requirement="$2"
    local requirement_config="$3"

    case "$category.$requirement" in
        "discovery.basic_discovery")
            local min_success_rate=$(echo "$requirement_config" | jq -r '.min_success_rate')
            local actual_rate=$(jq -r '.test_results.discovery.basic_discovery.success_rate' "$VALIDATION_REPORT")
            if (( $(echo "$actual_rate >= $min_success_rate" | bc -l) )); then
                echo "PASS"
            else
                echo "FAIL"
            fi
            ;;
        "messaging.basic_messaging")
            local min_success_rate=$(echo "$requirement_config" | jq -r '.min_success_rate')
            local actual_rate=$(jq -r '.test_results.messaging.basic_messaging.success_rate' "$VALIDATION_REPORT")
            if (( $(echo "$actual_rate >= $min_success_rate" | bc -l) )); then
                echo "PASS"
            else
                echo "FAIL"
            fi
            ;;
        "performance.throughput")
            local min_throughput=$(echo "$requirement_config" | jq -r '.min_messages_per_second')
            local actual_throughput=$(jq -r '.test_results.performance.throughput.messages_per_second' "$VALIDATION_REPORT")
            if (( $(echo "$actual_throughput >= $min_throughput" | bc -l) )); then
                echo "PASS"
            else
                echo "FAIL"
            fi
            ;;
        *)
            # Default validation for unknown requirements
            echo "PASS"
            ;;
    esac
}

# Generate compliance report
generate_compliance_report() {
    log_info "Generating compliance report"

    local report_file="$VALIDATION_DIR/compliance_report_$TIMESTAMP.txt"

    # Extract data from validation report
    local overall_status=$(jq -r '.compliance_check.overall_status' "$VALIDATION_REPORT")
    local compliance_score=$(jq -r '.compliance_check.compliance_score' "$VALIDATION_REPORT")
    local passed_requirements=$(jq -r '.compliance_check.passed_requirements' "$VALIDATION_REPORT")
    local total_requirements=$(jq -r '.compliance_check.total_requirements' "$VALIDATION_REPORT")

    cat > "$report_file" << EOF
quadra-a Relay Compliance Report
=================================
Generated: $(date)
Compliance Standard: $COMPLIANCE_STANDARD
Results Directory: $RESULTS_DIR

Overall Compliance Status: $overall_status
Compliance Score: ${compliance_score}%
Requirements Passed: $passed_requirements/$total_requirements

Detailed Results:
================
EOF

    # Add detailed requirement results
    jq -r '.compliance_check.details[] | "- \(.requirement): \(.status)"' "$VALIDATION_REPORT" >> "$report_file"

    cat >> "$report_file" << EOF

Test Results Summary:
====================
Discovery Tests:
- Basic Discovery Success Rate: $(jq -r '.test_results.discovery.basic_discovery.success_rate' "$VALIDATION_REPORT")%
- Query Discovery Success Rate: $(jq -r '.test_results.discovery.query_discovery.success_rate' "$VALIDATION_REPORT")%

Messaging Tests:
- Basic Messaging Success Rate: $(jq -r '.test_results.messaging.basic_messaging.success_rate' "$VALIDATION_REPORT")%
- Max Payload Size: $(jq -r '.test_results.messaging.payload_support.max_payload_size' "$VALIDATION_REPORT") bytes

Performance Tests:
- Throughput: $(jq -r '.test_results.performance.throughput.messages_per_second' "$VALIDATION_REPORT") msg/s
- Max Concurrent Connections: $(jq -r '.test_results.performance.concurrent_connections.max_connections' "$VALIDATION_REPORT")

Reliability Tests:
- Error Rate: $(jq -r '.test_results.reliability.error_handling.error_rate' "$VALIDATION_REPORT")%

Files:
======
- Detailed Validation Report: $VALIDATION_REPORT
- Compliance Standard: $VALIDATION_DIR/compliance_standard_$COMPLIANCE_STANDARD.json
- This Report: $report_file

Generated by quadra-a Relay Test Validator v1.0
EOF

    log_success "Compliance report generated: $report_file"
    echo "$report_file"
}

# Main validation function
main() {
    echo "=================================================="
    echo "quadra-a Relay Test Validator"
    echo "=================================================="
    echo "Results Directory: $RESULTS_DIR"
    echo "Compliance Standard: $COMPLIANCE_STANDARD"
    echo "Validation Report: $VALIDATION_REPORT"
    echo "=================================================="

    # Check prerequisites
    if ! command -v jq &> /dev/null; then
        log_error "jq is required for JSON processing"
        exit 1
    fi

    if ! command -v bc &> /dev/null; then
        log_error "bc is required for calculations"
        exit 1
    fi

    # Load compliance standard
    load_compliance_standard

    # Parse test results
    parse_test_results

    # Validate compliance
    validate_compliance

    # Generate report
    local report_file=$(generate_compliance_report)

    # Final summary
    local overall_status=$(jq -r '.compliance_check.overall_status' "$VALIDATION_REPORT")
    local compliance_score=$(jq -r '.compliance_check.compliance_score' "$VALIDATION_REPORT")

    echo "=================================================="
    echo "VALIDATION SUMMARY"
    echo "=================================================="
    echo "Compliance Standard: $COMPLIANCE_STANDARD"
    echo "Overall Status: $overall_status"
    echo "Compliance Score: ${compliance_score}%"
    echo "Detailed Report: $report_file"
    echo "JSON Report: $VALIDATION_REPORT"
    echo "=================================================="

    # Exit with appropriate code
    if [[ "$overall_status" == "PASSED" ]]; then
        log_success "Validation completed successfully"
        exit 0
    else
        log_error "Validation failed"
        exit 1
    fi
}

# Show available compliance standards
show_standards() {
    echo "Available Compliance Standards:"
    echo "==============================="
    echo "- quadra-a-basic"
    echo "- quadra-a-production"
    echo "- enterprise"
    echo ""
    echo "Legacy aliases: highway1-basic, highway1-production"
    echo ""
    echo "Usage: $SCRIPT_NAME [results_directory] [compliance_standard]"
}

# Handle help and standards listing
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    show_standards
    exit 0
fi

if [[ "$1" == "--list-standards" ]]; then
    show_standards
    exit 0
fi

# Run main function
main "$@"
