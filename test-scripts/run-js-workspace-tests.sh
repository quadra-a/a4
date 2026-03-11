#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./test-config.sh
source "$SCRIPT_DIR/test-config.sh"

JS_ROOT="$A4_ROOT/js"
TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"
CONTINUE_ON_FAILURE=true
RESULTS_BASE_DIR="${RESULTS_BASE_DIR:-$TEST_OUTPUT_ROOT/results/js-workspace}"
RUN_DIR="${RESULTS_BASE_DIR%/}/$TIMESTAMP"
SUMMARY_FILE="$RUN_DIR/summary.txt"

if [[ "${CI:-false}" == "true" || ! -t 1 ]]; then
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

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }

declare -i TOTAL_STEPS=0
DECLARE_FAILED=false
FAILED_STEPS=()
PASSED_STEPS=()
SKIPPED_STEPS=()

usage() {
    cat <<USAGE
Usage: ./run-js-workspace-tests.sh [options]

Runs the production JavaScript validation suite for repos/a4/js without watch mode.

Options:
  --results-dir <dir>       Override output directory for logs and summary
  --fail-fast               Stop on the first failing step
  --help                    Show this help message
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --results-dir)
            if [[ $# -lt 2 ]]; then
                log_error "--results-dir requires a directory path"
                exit 1
            fi
            RESULTS_BASE_DIR="$2"
            RUN_DIR="${RESULTS_BASE_DIR%/}/$TIMESTAMP"
            SUMMARY_FILE="$RUN_DIR/summary.txt"
            shift 2
            ;;
        --fail-fast)
            CONTINUE_ON_FAILURE=false
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            usage
            exit 1
            ;;
    esac
done

require_command() {
    local command_name="$1"
    local install_hint="$2"

    if ! command -v "$command_name" >/dev/null 2>&1; then
        log_error "$command_name is required. $install_hint"
        exit 1
    fi
}

sanitize_name() {
    echo "$1" | tr ' /:' '---' | tr -cd '[:alnum:]_.-'
}

can_bind_local_port() {
    node -e "const net=require('net'); const server=net.createServer(); server.listen(0, '127.0.0.1', () => { server.close(() => process.exit(0)); }); server.on('error', () => process.exit(1));" >/dev/null 2>&1
}

skip_step() {
    local step_name="$1"
    local reason="$2"

    TOTAL_STEPS+=1
    SKIPPED_STEPS+=("$step_name [$reason]")
    log_warning "Skipping $step_name: $reason"
}

write_summary() {
    mkdir -p "$RUN_DIR"

    {
        echo "quadra-a JS workspace test summary"
        echo "================================"
        echo "Timestamp: $TIMESTAMP"
        echo "JS Root: $JS_ROOT"
        echo "Run Directory: $RUN_DIR"
        echo "Total Steps: $TOTAL_STEPS"
        echo "Passed Steps: ${#PASSED_STEPS[@]}"
        echo "Failed Steps: ${#FAILED_STEPS[@]}"
        echo "Skipped Steps: ${#SKIPPED_STEPS[@]}"
        echo

        if [[ ${#PASSED_STEPS[@]} -gt 0 ]]; then
            echo "Passed:"
            for item in "${PASSED_STEPS[@]}"; do
                echo "- $item"
            done
            echo
        fi

        if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
            echo "Failed:"
            for item in "${FAILED_STEPS[@]}"; do
                echo "- $item"
            done
            echo
        fi

        if [[ ${#SKIPPED_STEPS[@]} -gt 0 ]]; then
            echo "Skipped:"
            for item in "${SKIPPED_STEPS[@]}"; do
                echo "- $item"
            done
            echo
        fi

        echo "Logs:"
        find "$RUN_DIR" -maxdepth 1 -type f -name '*.log' | sort | sed 's#^#- #' || true
    } > "$SUMMARY_FILE"
}

run_step() {
    local step_name="$1"
    shift

    TOTAL_STEPS+=1
    local safe_name
    safe_name="$(sanitize_name "$step_name")"
    local log_file="$RUN_DIR/${safe_name}.log"

    mkdir -p "$RUN_DIR"

    log_info "Running: $step_name"
    printf 'Command:' > "$log_file"
    for arg in "$@"; do
        printf ' %q' "$arg" >> "$log_file"
    done
    printf '\n\n' >> "$log_file"

    if "$@" >> "$log_file" 2>&1; then
        PASSED_STEPS+=("$step_name [$log_file]")
        log_success "$step_name"
        return 0
    fi

    FAILED_STEPS+=("$step_name [$log_file]")
    DECLARE_FAILED=true
    log_error "$step_name"
    log_error "Log: $log_file"

    if [[ "$CONTINUE_ON_FAILURE" == false ]]; then
        write_summary
        exit 1
    fi

    return 0
}

main() {
    require_command pnpm "Install pnpm and run pnpm install in repos/a4/js."
    require_command node "Install Node.js 22+ to run the JavaScript workspace suite."

    if [[ ! -d "$JS_ROOT" ]]; then
        log_error "JavaScript workspace not found: $JS_ROOT"
        exit 1
    fi

    mkdir -p "$RUN_DIR"

    echo "=================================================="
    echo "quadra-a JS Workspace Test Runner"
    echo "=================================================="
    echo "JS Root: $JS_ROOT"
    echo "Run Directory: $RUN_DIR"
    echo "Fail Fast: $([[ "$CONTINUE_ON_FAILURE" == false ]] && echo yes || echo no)"
    echo "=================================================="

    run_step "protocol tests" env CI=1 pnpm --dir "$JS_ROOT/core/protocol" exec vitest run
    run_step "protocol build" env CI=1 pnpm --dir "$JS_ROOT/core/protocol" build

    run_step "runtime tests" env CI=1 pnpm --dir "$JS_ROOT/core/runtime" exec vitest run
    run_step "runtime build" env CI=1 pnpm --dir "$JS_ROOT/core/runtime" build

    if can_bind_local_port; then
        run_step "relay tests" env CI=1 pnpm --dir "$JS_ROOT/relay" exec vitest run
    elif [[ "${CI:-false}" == "true" ]]; then
        run_step "relay tests" env CI=1 pnpm --dir "$JS_ROOT/relay" exec vitest run
    else
        skip_step "relay tests" "local socket listen is not permitted in this environment"
    fi
    run_step "relay build" env CI=1 pnpm --dir "$JS_ROOT/relay" build

    run_step "cli build" env CI=1 pnpm --dir "$JS_ROOT/cli" build
    run_step "mcp-server build" env CI=1 pnpm --dir "$JS_ROOT/mcp-server" build

    write_summary

    echo "=================================================="
    echo "Summary: $SUMMARY_FILE"
    echo "=================================================="

    if [[ "$DECLARE_FAILED" == true ]]; then
        log_error "JS workspace suite completed with failures"
        exit 1
    fi

    log_success "JS workspace suite completed successfully"
}

main "$@"
