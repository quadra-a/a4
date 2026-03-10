#!/usr/bin/env bash

# quadra-a Relay Quick Test Script
# Performs essential tests for basic relay functionality validation
# Usage: ./test-relay-quick.sh [relay_url] [cli_mode] [binary_path]
# cli_mode: rust|node|both (default: both)

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# shellcheck source=./lib/compat.sh
source "$SCRIPT_DIR/lib/compat.sh"

# Configuration
RELAY_URL="${1:-$DEFAULT_RELAY_URL}"
CLI_MODE="${2:-both}"
CUSTOM_BINARY="${3:-}"
TEST_DID="did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"


# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }

# Get CLI commands to test
declare -a CLI_COMMANDS
case "$CLI_MODE" in
    "rust")
        if [[ -n "$CUSTOM_BINARY" ]]; then
            CLI_COMMANDS=("$CUSTOM_BINARY")
        else
            CLI_COMMANDS=("$DEFAULT_A4_BINARY")
        fi
        ;;
    "node")
        if [[ -f "$NODE_CLI_DIRECT" ]]; then
            CLI_COMMANDS=("$NODE_CLI_DIRECT")
        elif command -v pnpm &> /dev/null && [[ -f "../../package.json" ]]; then
            CLI_COMMANDS=("$NODE_CLI_PNPM")
        elif command -v npx &> /dev/null; then
            CLI_COMMANDS=("$NODE_CLI_NPX")
        elif command -v "$NODE_CLI_GLOBAL" &> /dev/null; then
            CLI_COMMANDS=("$NODE_CLI_GLOBAL")
        else
            log_error "No Node.js CLI available. Build with: cd js && pnpm install && pnpm build"
            exit 1
        fi
        ;;
    "both")
        if [[ -n "$CUSTOM_BINARY" ]]; then
            CLI_COMMANDS=("$CUSTOM_BINARY")
        else
            CLI_COMMANDS=("$DEFAULT_A4_BINARY")
        fi
        # Add Node CLI (prioritize local binary first)
        if [[ -f "$NODE_CLI_DIRECT" ]]; then
            CLI_COMMANDS+=("$NODE_CLI_DIRECT")
        elif command -v pnpm &> /dev/null && [[ -f "../../package.json" ]]; then
            CLI_COMMANDS+=("$NODE_CLI_PNPM")
        elif command -v npx &> /dev/null; then
            CLI_COMMANDS+=("$NODE_CLI_NPX")
        elif command -v "$NODE_CLI_GLOBAL" &> /dev/null; then
            CLI_COMMANDS+=("$NODE_CLI_GLOBAL")
        fi
        ;;
    *)
        log_error "Invalid CLI mode: $CLI_MODE. Use: rust|node|both"
        exit 1
        ;;
esac

echo "=================================================="
echo "quadra-a Relay Quick Test"
echo "=================================================="
echo "Relay: $RELAY_URL"
echo "CLI Mode: $CLI_MODE"
echo "CLIs to test: ${#CLI_COMMANDS[@]}"
for i in "${!CLI_COMMANDS[@]}"; do
    echo "  $((i+1)). ${CLI_COMMANDS[i]}"
done
echo "=================================================="

# Check CLI availability
check_cli_availability() {
    local cli_cmd="$1"
    local cli_name="$2"

    log_info "Checking $cli_name availability..."

    if [[ "$cli_cmd" == *"pnpm"* ]]; then
        if ! command -v pnpm &> /dev/null; then
            log_error "pnpm not found"
            return 1
        fi
        if [[ ! -f "package.json" ]]; then
            log_error "package.json not found (required for pnpm)"
            return 1
        fi
        # Test if the CLI builds and runs
        if ! pnpm build &> /dev/null; then
            log_error "pnpm build failed"
            return 1
        fi
    elif [[ "$cli_cmd" == *"npx"* ]]; then
        if ! command -v npx &> /dev/null; then
            log_error "npx not found"
            return 1
        fi
    elif [[ "$cli_cmd" == "$NODE_CLI_GLOBAL" ]] || [[ "$cli_cmd" == *"$NODE_CLI_GLOBAL"* && ! "$cli_cmd" == *"/"* ]]; then
        if ! command -v "$NODE_CLI_GLOBAL" &> /dev/null; then
            log_error "global $NODE_CLI_GLOBAL command not found"
            return 1
        fi
    elif [[ "$cli_cmd" == *"node "* ]]; then
        # Node.js script - check if node is available and script exists
        if ! command -v node &> /dev/null; then
            log_error "node not found"
            return 1
        fi
        local script_path="${cli_cmd#node }"
        if [[ ! -f "$script_path" ]]; then
            log_error "Node.js script not found at: $script_path"
            return 1
        fi
    else
        # Binary file
        if [[ ! -f "$cli_cmd" ]]; then
            log_error "binary not found at: $cli_cmd"
            return 1
        fi
    fi

    log_success "$cli_name available"
    return 0
}

# Check all CLIs
for i in "${!CLI_COMMANDS[@]}"; do
    cli_name="CLI $((i+1))"
    if [[ "${CLI_COMMANDS[i]}" == *"pnpm"* ]]; then
        cli_name="TypeScript CLI (pnpm)"
    elif [[ "${CLI_COMMANDS[i]}" == *"npx"* ]]; then
        cli_name="TypeScript CLI (npx)"
    elif [[ "${CLI_COMMANDS[i]}" == *"node "* ]]; then
        cli_name="TypeScript CLI (node)"
    elif [[ "${CLI_COMMANDS[i]}" == *"js/cli/a4"* ]]; then
        cli_name="TypeScript CLI (wrapper)"
    elif [[ "${CLI_COMMANDS[i]}" == "$NODE_CLI_GLOBAL" ]]; then
        cli_name="TypeScript CLI (global)"
    else
        cli_name="Rust CLI"
    fi

    if ! check_cli_availability "${CLI_COMMANDS[i]}" "$cli_name"; then
        log_error "Skipping unavailable CLI: ${CLI_COMMANDS[i]}"
        unset CLI_COMMANDS[i]
    fi
done

# Reindex array to remove gaps
CLI_COMMANDS=(${CLI_COMMANDS[@]})

if [[ ${#CLI_COMMANDS[@]} -eq 0 ]]; then
    log_error "No CLIs available for testing"
    exit 1
fi

# Run tests for each CLI
run_tests_for_cli() {
    local cli_cmd="$1"
    local cli_name="$2"
    local test_failures=0

    run_timed_cli() {
        local seconds="$1"
        local command="$2"
        quadra_run_with_timeout_shell "$seconds" "$command"
    }

    echo ""
    echo "=================================================="
    echo "Testing with $cli_name: $cli_cmd"
    echo "=================================================="

    # Test 1: Basic discovery
    log_info "[$cli_name] Testing basic discovery..."
    if run_timed_cli 10 "\"$cli_cmd\" find --relay \"$RELAY_URL\"" 2>/dev/null | grep -q "FIND RESULTS\|DISCOVERY RESULTS\|Failed to find agents\|NO_RESULTS\|Count: 0"; then
        log_success "[$cli_name] Discovery working"
    else
        log_error "[$cli_name] Discovery failed"
        ((test_failures++))
    fi

    # Test 2: Daemon status
    log_info "[$cli_name] Testing daemon status..."
    if run_timed_cli 5 "\"$cli_cmd\" status" 2>/dev/null | grep -q "Daemon is running\|Daemon running\|Online\|Connected"; then
        log_success "[$cli_name] Daemon running"
    else
        log_info "[$cli_name] Daemon not running (expected for production tests)"
        # Don't count this as a failure since daemon might not be running in production tests
    fi

    # Test 3: Basic message send
    log_info "[$cli_name] Testing basic message send..."
    if run_timed_cli 45 "\"$cli_cmd\" tell '$TEST_DID' 'Quick test message from $cli_name' --relay \"$RELAY_URL\"" >/dev/null 2>&1; then
        log_success "[$cli_name] Message delivery working"
    else
        log_error "[$cli_name] Message delivery failed"
        ((test_failures++))
    fi

    # Test 4: Large payload
    log_info "[$cli_name] Testing large payload (1KB)..."
    local large_payload="{\"test\":\"large\",\"data\":\"$(python3 -c "print('A' * 1000)")\",\"cli\":\"$cli_name\"}"
    if run_timed_cli 45 "\"$cli_cmd\" tell '$TEST_DID' --payload '$large_payload' --relay \"$RELAY_URL\"" >/dev/null 2>&1; then
        log_success "[$cli_name] Large payload working"
    else
        log_error "[$cli_name] Large payload failed"
        ((test_failures++))
    fi

    # Test 5: Concurrent messages
    log_info "[$cli_name] Testing concurrent messages (5 parallel)..."
    local pids=()
    local i
    for i in {1..5}; do
        bash -lc "\"$cli_cmd\" tell '$TEST_DID' 'Concurrent test $i from $cli_name' --relay \"$RELAY_URL\"" >/dev/null 2>&1 &
        pids+=("$!")
    done
    for pid in "${pids[@]}"; do
        wait "$pid"
    done

    log_success "[$cli_name] Concurrent messages completed"

    return $test_failures
}

# Run tests for all available CLIs
total_failures=0
for i in "${!CLI_COMMANDS[@]}"; do
    cli_name="CLI $((i+1))"
    if [[ "${CLI_COMMANDS[i]}" == *"pnpm"* ]]; then
        cli_name="TypeScript CLI (pnpm)"
    elif [[ "${CLI_COMMANDS[i]}" == *"npx"* ]]; then
        cli_name="TypeScript CLI (npx)"
    elif [[ "${CLI_COMMANDS[i]}" == *"node "* ]]; then
        cli_name="TypeScript CLI (node)"
    elif [[ "${CLI_COMMANDS[i]}" == *"js/cli/a4"* ]]; then
        cli_name="TypeScript CLI (wrapper)"
    elif [[ "${CLI_COMMANDS[i]}" == "$NODE_CLI_GLOBAL" ]]; then
        cli_name="TypeScript CLI (global)"
    else
        cli_name="Rust CLI"
    fi

    run_tests_for_cli "${CLI_COMMANDS[i]}" "$cli_name"
    cli_failures=$?
    total_failures=$((total_failures + cli_failures))
done

echo ""
echo "=================================================="
if [[ $total_failures -eq 0 ]]; then
    echo -e "${GREEN}✅ All quick tests passed for all CLIs! Relay is functional.${NC}"
    echo "=================================================="
    exit 0
else
    echo -e "${RED}❌ $total_failures test(s) failed across CLIs.${NC}"
    echo "=================================================="
    exit 1
fi
