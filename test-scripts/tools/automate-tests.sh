#!/bin/bash

# quadra-a Relay Test Automation Script
# Automated testing pipeline for CI/CD integration
# Usage: ./automate-tests.sh [config_file]

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
CONFIG_FILE="${1:-$PWD/test-scripts/automation-config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTOMATION_DIR="$TEST_OUTPUT_ROOT/automation-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
PIPELINE_ID="pipeline_$TIMESTAMP"

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

# Create automation directory
mkdir -p "$AUTOMATION_DIR"

# Default configuration
create_default_config() {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "pipeline": {
    "name": "quadra-a Relay Test Pipeline",
    "version": "1.0.0",
    "timeout": 3600,
    "parallel_jobs": 4,
    "retry_attempts": 3,
    "fail_fast": false
  },
  "environment": {
    "relay_url": "ws://relay-sg-1.quadra-a.com:8080",
    "a4_binary": "./rust/cli-rs/target/release/a4",
    "build_required": true,
    "cleanup_after": true
  },
  "test_stages": [
    {
      "name": "build",
      "description": "Build and prepare binaries",
      "enabled": true,
      "timeout": 300,
      "commands": [
        "cd rust/cli-rs && cargo build --release"
      ]
    },
    {
      "name": "health_check",
      "description": "Basic health and connectivity check",
      "enabled": true,
      "timeout": 60,
      "commands": [
        "./scripts/test-relay-quick.sh"
      ]
    },
    {
      "name": "comprehensive_tests",
      "description": "Full functionality test suite",
      "enabled": true,
      "timeout": 600,
      "commands": [
        "./scripts/test-relay-comprehensive.sh"
      ]
    },
    {
      "name": "performance_tests",
      "description": "Performance benchmarking",
      "enabled": true,
      "timeout": 300,
      "commands": [
        "./scripts/benchmark-relay.sh"
      ]
    },
    {
      "name": "load_tests",
      "description": "Load and stress testing",
      "enabled": false,
      "timeout": 900,
      "commands": [
        "./scripts/load-test-relay.sh ws://relay-sg-1.quadra-a.com:8080 ./rust/cli-rs/target/release/a4 300"
      ]
    },
    {
      "name": "ci_tests",
      "description": "CI-optimized test suite",
      "enabled": true,
      "timeout": 180,
      "commands": [
        "./scripts/ci-test-relay.sh"
      ]
    }
  ],
  "notifications": {
    "enabled": false,
    "slack_webhook": "",
    "email_recipients": [],
    "discord_webhook": ""
  },
  "artifacts": {
    "collect_logs": true,
    "generate_report": true,
    "archive_results": true,
    "retention_days": 30
  }
}
EOF
}

# Load configuration
load_config() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        log_info "Creating default configuration: $CONFIG_FILE"
        create_default_config
    fi

    log_info "Loading configuration from: $CONFIG_FILE"

    # Parse JSON configuration (requires jq)
    if ! command -v jq &> /dev/null; then
        log_error "jq is required for configuration parsing"
        exit 1
    fi

    # Extract configuration values
    PIPELINE_NAME=$(jq -r '.pipeline.name' "$CONFIG_FILE")
    PIPELINE_TIMEOUT=$(jq -r '.pipeline.timeout' "$CONFIG_FILE")
    PARALLEL_JOBS=$(jq -r '.pipeline.parallel_jobs' "$CONFIG_FILE")
    RETRY_ATTEMPTS=$(jq -r '.pipeline.retry_attempts' "$CONFIG_FILE")
    FAIL_FAST=$(jq -r '.pipeline.fail_fast' "$CONFIG_FILE")

    RELAY_URL=$(jq -r '.environment.relay_url' "$CONFIG_FILE")
    A4_BINARY=$(jq -r '.environment.a4_binary' "$CONFIG_FILE")
    BUILD_REQUIRED=$(jq -r '.environment.build_required' "$CONFIG_FILE")
    CLEANUP_AFTER=$(jq -r '.environment.cleanup_after' "$CONFIG_FILE")

    COLLECT_LOGS=$(jq -r '.artifacts.collect_logs' "$CONFIG_FILE")
    GENERATE_REPORT=$(jq -r '.artifacts.generate_report' "$CONFIG_FILE")
    ARCHIVE_RESULTS=$(jq -r '.artifacts.archive_results' "$CONFIG_FILE")

    log_success "Configuration loaded successfully"
}

# Initialize pipeline
init_pipeline() {
    log_info "Initializing test pipeline: $PIPELINE_ID"

    # Create pipeline directory
    PIPELINE_DIR="$AUTOMATION_DIR/$PIPELINE_ID"
    mkdir -p "$PIPELINE_DIR"/{logs,reports,artifacts}

    # Create pipeline metadata
    cat > "$PIPELINE_DIR/metadata.json" << EOF
{
  "pipeline_id": "$PIPELINE_ID",
  "name": "$PIPELINE_NAME",
  "start_time": "$(date -Iseconds)",
  "config_file": "$CONFIG_FILE",
  "environment": {
    "relay_url": "$RELAY_URL",
    "a4_binary": "$A4_BINARY",
    "system": "$(uname -a)",
    "user": "$(whoami)",
    "pwd": "$PWD"
  },
  "stages": [],
  "status": "running"
}
EOF

    log_success "Pipeline initialized: $PIPELINE_DIR"
}

# Execute test stage
execute_stage() {
    local stage_name="$1"
    local stage_config="$2"

    log_info "Executing stage: $stage_name"

    # Extract stage configuration
    local description=$(echo "$stage_config" | jq -r '.description')
    local enabled=$(echo "$stage_config" | jq -r '.enabled')
    local timeout=$(echo "$stage_config" | jq -r '.timeout')
    local commands=$(echo "$stage_config" | jq -r '.commands[]')

    # Skip if disabled
    if [[ "$enabled" != "true" ]]; then
        log_warning "Stage '$stage_name' is disabled, skipping"
        return 0
    fi

    # Create stage directory
    local stage_dir="$PIPELINE_DIR/logs/$stage_name"
    mkdir -p "$stage_dir"

    local stage_start=$(date +%s)
    local stage_status="success"
    local stage_output=""

    # Execute commands
    local cmd_index=0
    while IFS= read -r command; do
        ((cmd_index++))
        log_info "  Command $cmd_index: $command"

        local cmd_log="$stage_dir/command_$cmd_index.log"
        local cmd_start=$(date +%s)

        # Execute with timeout
        if timeout "$timeout" bash -c "cd '$PROJECT_ROOT' && $command" > "$cmd_log" 2>&1; then
            local cmd_end=$(date +%s)
            local cmd_duration=$((cmd_end - cmd_start))
            log_success "  Command $cmd_index completed in ${cmd_duration}s"
        else
            local cmd_end=$(date +%s)
            local cmd_duration=$((cmd_end - cmd_start))
            log_error "  Command $cmd_index failed after ${cmd_duration}s"
            stage_status="failed"

            # Check fail_fast setting
            if [[ "$FAIL_FAST" == "true" ]]; then
                log_error "Fail-fast enabled, stopping pipeline"
                return 1
            fi
        fi
    done <<< "$commands"

    local stage_end=$(date +%s)
    local stage_duration=$((stage_end - stage_start))

    # Update pipeline metadata
    local stage_metadata=$(cat << EOF
{
  "name": "$stage_name",
  "description": "$description",
  "status": "$stage_status",
  "start_time": "$(date -d @$stage_start -Iseconds)",
  "end_time": "$(date -d @$stage_end -Iseconds)",
  "duration": $stage_duration,
  "commands_executed": $cmd_index
}
EOF
)

    # Add stage to pipeline metadata
    local temp_file=$(mktemp)
    jq ".stages += [$stage_metadata]" "$PIPELINE_DIR/metadata.json" > "$temp_file"
    mv "$temp_file" "$PIPELINE_DIR/metadata.json"

    if [[ "$stage_status" == "success" ]]; then
        log_success "Stage '$stage_name' completed successfully in ${stage_duration}s"
        return 0
    else
        log_error "Stage '$stage_name' failed after ${stage_duration}s"
        return 1
    fi
}

# Run test pipeline
run_pipeline() {
    log_info "Starting test pipeline execution"

    local pipeline_start=$(date +%s)
    local total_stages=0
    local successful_stages=0
    local failed_stages=0

    # Get enabled stages
    local stages=$(jq -c '.test_stages[] | select(.enabled == true)' "$CONFIG_FILE")

    # Count total stages
    total_stages=$(echo "$stages" | wc -l)
    log_info "Total stages to execute: $total_stages"

    # Execute stages
    while IFS= read -r stage_config; do
        local stage_name=$(echo "$stage_config" | jq -r '.name')

        if execute_stage "$stage_name" "$stage_config"; then
            ((successful_stages++))
        else
            ((failed_stages++))

            # Check if we should continue or fail fast
            if [[ "$FAIL_FAST" == "true" ]]; then
                log_error "Pipeline failed at stage '$stage_name' (fail-fast enabled)"
                break
            fi
        fi
    done <<< "$stages"

    local pipeline_end=$(date +%s)
    local pipeline_duration=$((pipeline_end - pipeline_start))

    # Update final pipeline metadata
    local temp_file=$(mktemp)
    jq ".end_time = \"$(date -d @$pipeline_end -Iseconds)\" | .duration = $pipeline_duration | .total_stages = $total_stages | .successful_stages = $successful_stages | .failed_stages = $failed_stages | .status = \"$(if [[ $failed_stages -eq 0 ]]; then echo "success"; else echo "failed"; fi)\"" "$PIPELINE_DIR/metadata.json" > "$temp_file"
    mv "$temp_file" "$PIPELINE_DIR/metadata.json"

    # Pipeline summary
    log_info "Pipeline execution completed"
    log_info "Duration: ${pipeline_duration}s"
    log_info "Stages: $successful_stages/$total_stages successful"

    if [[ $failed_stages -eq 0 ]]; then
        log_success "All stages completed successfully!"
        return 0
    else
        log_error "$failed_stages stages failed"
        return 1
    fi
}

# Collect artifacts
collect_artifacts() {
    if [[ "$COLLECT_LOGS" != "true" ]]; then
        return 0
    fi

    log_info "Collecting test artifacts"

    # Copy test results
    if [[ -d "$PROJECT_ROOT/test-results" ]]; then
        cp -r "$PROJECT_ROOT/test-results" "$PIPELINE_DIR/artifacts/"
    fi

    if [[ -d "$PROJECT_ROOT/benchmark-results" ]]; then
        cp -r "$PROJECT_ROOT/benchmark-results" "$PIPELINE_DIR/artifacts/"
    fi

    if [[ -d "$PROJECT_ROOT/load-test-results" ]]; then
        cp -r "$PROJECT_ROOT/load-test-results" "$PIPELINE_DIR/artifacts/"
    fi

    # Generate consolidated report
    if [[ "$GENERATE_REPORT" == "true" ]]; then
        log_info "Generating test report"
        "$SCRIPT_DIR/generate-test-report.sh" "$PIPELINE_DIR/artifacts" "$PIPELINE_DIR/reports/test-report.html"
    fi

    log_success "Artifacts collected"
}

# Send notifications
send_notifications() {
    local pipeline_status="$1"

    if [[ "$(jq -r '.notifications.enabled' "$CONFIG_FILE")" != "true" ]]; then
        return 0
    fi

    log_info "Sending notifications"

    local success_rate=$(jq -r '.successful_stages / .total_stages * 100' "$PIPELINE_DIR/metadata.json")
    local duration=$(jq -r '.duration' "$PIPELINE_DIR/metadata.json")

    local message="quadra-a Relay Test Pipeline: $pipeline_status
Pipeline ID: $PIPELINE_ID
Success Rate: ${success_rate}%
Duration: ${duration}s
Report: $PIPELINE_DIR/reports/test-report.html"

    # Slack notification
    local slack_webhook=$(jq -r '.notifications.slack_webhook' "$CONFIG_FILE")
    if [[ -n "$slack_webhook" && "$slack_webhook" != "null" ]]; then
        curl -X POST -H 'Content-type: application/json' \
            --data "{\"text\":\"$message\"}" \
            "$slack_webhook" 2>/dev/null || log_warning "Failed to send Slack notification"
    fi

    # Discord notification
    local discord_webhook=$(jq -r '.notifications.discord_webhook' "$CONFIG_FILE")
    if [[ -n "$discord_webhook" && "$discord_webhook" != "null" ]]; then
        curl -X POST -H 'Content-type: application/json' \
            --data "{\"content\":\"$message\"}" \
            "$discord_webhook" 2>/dev/null || log_warning "Failed to send Discord notification"
    fi

    log_success "Notifications sent"
}

# Archive results
archive_results() {
    if [[ "$ARCHIVE_RESULTS" != "true" ]]; then
        return 0
    fi

    log_info "Archiving results"

    local archive_file="$AUTOMATION_DIR/${PIPELINE_ID}.tar.gz"
    tar -czf "$archive_file" -C "$AUTOMATION_DIR" "$PIPELINE_ID"

    log_success "Results archived: $archive_file"
}

# Cleanup
cleanup() {
    if [[ "$CLEANUP_AFTER" != "true" ]]; then
        return 0
    fi

    log_info "Cleaning up temporary files"

    # Clean up test result directories
    rm -rf "$PROJECT_ROOT/test-results" "$PROJECT_ROOT/benchmark-results" "$PROJECT_ROOT/load-test-results"

    log_success "Cleanup completed"
}

# Main automation function
main() {
    echo "=================================================="
    echo "quadra-a Relay Test Automation"
    echo "=================================================="
    echo "Pipeline ID: $PIPELINE_ID"
    echo "Config File: $CONFIG_FILE"
    echo "=================================================="

    # Load configuration
    load_config

    # Initialize pipeline
    init_pipeline

    # Run pipeline
    local pipeline_status="SUCCESS"
    if ! run_pipeline; then
        pipeline_status="FAILED"
    fi

    # Collect artifacts
    collect_artifacts

    # Send notifications
    send_notifications "$pipeline_status"

    # Archive results
    archive_results

    # Cleanup
    cleanup

    # Final summary
    echo "=================================================="
    echo "AUTOMATION SUMMARY"
    echo "=================================================="
    echo "Pipeline ID: $PIPELINE_ID"
    echo "Status: $pipeline_status"
    echo "Results: $PIPELINE_DIR"
    echo "Metadata: $PIPELINE_DIR/metadata.json"
    if [[ "$GENERATE_REPORT" == "true" ]]; then
        echo "Report: $PIPELINE_DIR/reports/test-report.html"
    fi
    echo "=================================================="

    # Exit with appropriate code
    if [[ "$pipeline_status" == "SUCCESS" ]]; then
        exit 0
    else
        exit 1
    fi
}

# Handle help
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "quadra-a Relay Test Automation"
    echo "Usage: $0 [config_file]"
    echo ""
    echo "Options:"
    echo "  config_file    Path to automation configuration JSON file"
    echo "  --help, -h     Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  HW1_RELAY_URL  Override relay URL"
    echo "  A4_BINARY   Override a4 binary path"
    echo "  CI             Set to 'true' for CI mode"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Use default config"
    echo "  $0 ./my-config.json                  # Use custom config"
    echo "  HW1_RELAY_URL=ws://localhost:8080 $0 # Override relay URL"
    exit 0
fi

# Run main function
main "$@"