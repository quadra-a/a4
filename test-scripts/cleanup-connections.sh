#!/usr/bin/env bash

# quadra-a Connection Cleanup Utility
# Cleans up hanging daemon processes and test connections
# Usage: ./cleanup-connections.sh [--force]

set -e

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

FORCE_MODE=false
if [[ "${1:-}" == "--force" ]]; then
    FORCE_MODE=true
fi

cleanup_connections() {
    log_info "Starting connection cleanup..."

    # Clean up daemon processes
    local daemon_pids=$(ps aux | grep "daemon-entry.js" | grep -v grep | awk '{print $2}' 2>/dev/null || true)
    if [[ -n "$daemon_pids" ]]; then
        log_info "Found daemon processes: $daemon_pids"
        if [[ "$FORCE_MODE" == "true" ]]; then
            echo "$daemon_pids" | xargs kill -9 2>/dev/null || true
            log_warning "Force killed daemon processes"
        else
            echo "$daemon_pids" | xargs kill 2>/dev/null || true
            log_info "Terminated daemon processes"
        fi
    else
        log_info "No daemon processes found"
    fi

    # Clean up hanging a4 processes
    local a4_pids=$(ps aux | grep -E "a4 (listen|tell|find)" | grep -v grep | awk '{print $2}' 2>/dev/null || true)
    if [[ -n "$a4_pids" ]]; then
        log_info "Found hanging a4 processes: $a4_pids"
        if [[ "$FORCE_MODE" == "true" ]]; then
            echo "$a4_pids" | xargs kill -9 2>/dev/null || true
            log_warning "Force killed a4 processes"
        else
            echo "$a4_pids" | xargs kill 2>/dev/null || true
            log_info "Terminated a4 processes"
        fi
    else
        log_info "No hanging a4 processes found"
    fi

    # Clean up test script processes
    local test_pids=$(ps aux | grep -E "(test-relay|benchmark-relay)" | grep -v grep | grep -v "$$" | awk '{print $2}' 2>/dev/null || true)
    if [[ -n "$test_pids" ]]; then
        log_info "Found hanging test processes: $test_pids"
        if [[ "$FORCE_MODE" == "true" ]]; then
            echo "$test_pids" | xargs kill -9 2>/dev/null || true
            log_warning "Force killed test processes"
        else
            echo "$test_pids" | xargs kill 2>/dev/null || true
            log_info "Terminated test processes"
        fi
    else
        log_info "No hanging test processes found"
    fi

    # Wait for graceful termination
    if [[ "$FORCE_MODE" != "true" ]]; then
        log_info "Waiting for processes to terminate gracefully..."
        sleep 2

        # Check for remaining processes and force kill if necessary
        local remaining_pids=$(ps aux | grep -E "(daemon-entry.js|a4 (listen|tell|find)|test-relay|benchmark-relay)" | grep -v grep | grep -v "$$" | awk '{print $2}' 2>/dev/null || true)
        if [[ -n "$remaining_pids" ]]; then
            log_warning "Force killing remaining processes: $remaining_pids"
            echo "$remaining_pids" | xargs kill -9 2>/dev/null || true
            sleep 1
        fi
    fi

    # Show network connections to relay servers
    log_info "Checking relay connections..."
    local relay_connections=$(netstat -an 2>/dev/null | grep ":8080" | wc -l || echo "0")
    if [[ "$relay_connections" -gt 0 ]]; then
        log_info "Found $relay_connections active relay connections"
        if [[ "$relay_connections" -gt 10 ]]; then
            log_warning "High number of relay connections detected - may indicate connection leaks"
        fi
    else
        log_info "No active relay connections found"
    fi

    log_success "Connection cleanup completed"
}

show_help() {
    cat <<EOF
Usage: $0 [--force]

Clean up hanging daemon processes and test connections.

Options:
  --force    Use SIGKILL instead of SIGTERM for immediate termination
  --help     Show this help message

Examples:
  $0                # Graceful cleanup
  $0 --force        # Force cleanup with SIGKILL
EOF
}

case "${1:-}" in
    --help|-h)
        show_help
        exit 0
        ;;
    *)
        cleanup_connections
        ;;
esac