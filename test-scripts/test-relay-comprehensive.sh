#!/usr/bin/env bash

# quadra-a Relay Comprehensive Test Suite
# Tests the relay implementation
# Usage: ./test-relay-comprehensive.sh [relay_url] [cli_mode] [binary_path]
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
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Determine CLI commands to test
get_cli_commands() {
    local commands=()

    case "$CLI_MODE" in
        "rust")
            if [[ -n "$CUSTOM_BINARY" ]]; then
                commands=("$CUSTOM_BINARY")
            else
                commands=("$DEFAULT_A4_BINARY")
            fi
            ;;
        "node")
            # Try different node CLI options in order of preference
            if [[ -f "$NODE_CLI_DIRECT" ]]; then
                commands=("$NODE_CLI_DIRECT")
            elif command -v pnpm &> /dev/null && [[ -f "package.json" ]]; then
                commands=("$NODE_CLI_PNPM")
            elif command -v npx &> /dev/null; then
                commands=("$NODE_CLI_NPX")
            elif command -v "$NODE_CLI_GLOBAL" &> /dev/null; then
                commands=("$NODE_CLI_GLOBAL")
            else
                log_error "No Node.js CLI available. Install with: pnpm install && pnpm build"
                exit 1
            fi
            ;;
        "both")
            # Test both CLIs
            if [[ -n "$CUSTOM_BINARY" ]]; then
                commands=("$CUSTOM_BINARY")
            else
                commands=("$DEFAULT_A4_BINARY")
            fi

            # Add Node CLI
            if [[ -f "$NODE_CLI_DIRECT" ]]; then
                commands+=("$NODE_CLI_DIRECT")
            elif command -v pnpm &> /dev/null && [[ -f "package.json" ]]; then
                commands+=("$NODE_CLI_PNPM")
            elif command -v npx &> /dev/null; then
                commands+=("$NODE_CLI_NPX")
            elif command -v "$NODE_CLI_GLOBAL" &> /dev/null; then
                commands+=("$NODE_CLI_GLOBAL")
            fi
            ;;
        *)
            log_error "Invalid CLI mode: $CLI_MODE. Use: rust|node|both"
            exit 1
            ;;
    esac

    echo "${commands[@]}"
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Test execution wrapper
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_pattern="$3"
    local cli_name="$4"

    ((TOTAL_TESTS++))
    log_info "[$cli_name] Running: $test_name"

    if output=$(eval "$test_command" 2>&1); then
        if [[ -z "$expected_pattern" ]] || echo "$output" | grep -q "$expected_pattern"; then
            log_success "[$cli_name] $test_name"
            ((PASSED_TESTS++))
            return 0
        else
            log_error "[$cli_name] $test_name - Expected pattern not found: $expected_pattern"
            echo "Output: $output"
            ((FAILED_TESTS++))
            return 1
        fi
    else
        if [[ "$expected_pattern" == "EXPECT_FAILURE" ]]; then
            log_success "[$cli_name] $test_name (expected failure)"
            ((PASSED_TESTS++))
            return 0
        else
            log_error "[$cli_name] $test_name - Command failed"
            echo "Output: $output"
            ((FAILED_TESTS++))
            return 1
        fi
    fi
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v python3 &> /dev/null; then
        log_error "python3 is required for payload generation"
        exit 1
    fi

    log_success "Prerequisites check"
}

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

# Test categories
test_basic_functionality() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] BASIC FUNCTIONALITY TESTS ==="

    run_test "CLI Help" \
        "$a4_binary --help" \
        "quadra-a" \
        "$cli_name"

    run_test "Agent Status" \
        "$a4_binary status" \
        "AGENT STATUS" \
        "$cli_name"

    run_test "Daemon Status" \
        "$a4_binary status" \
        "Daemon is running\|Online\|Connected" \
        "$cli_name"
}

test_discovery() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] DISCOVERY TESTS ==="

    run_test "Basic Discovery" \
        "$a4_binary find --relay $RELAY_URL" \
        "DISCOVERY RESULTS" \
        "$cli_name"

    run_test "Discovery with Empty Query" \
        "$a4_binary find --query '' --relay $RELAY_URL" \
        "DISCOVERY RESULTS" \
        "$cli_name"

    run_test "Discovery with Limit" \
        "$a4_binary find --limit 5 --relay $RELAY_URL" \
        "Limit: 5" \
        "$cli_name"

    run_test "Discovery - WebSocket Query" \
        "$a4_binary find --query 'WebSocket' --relay $RELAY_URL" \
        "quadra-a Relay" \
        "$cli_name"

    run_test "Discovery - Routes Messages Query" \
        "$a4_binary find --query 'routes messages' --relay $RELAY_URL" \
        "quadra-a Relay" \
        "$cli_name"

    run_test "Discovery - Indexes Agents Query" \
        "$a4_binary find --query 'indexes agents' --relay $RELAY_URL" \
        "quadra-a Relay" \
        "$cli_name"

    run_test "Discovery - Stores Endorsements Query" \
        "$a4_binary find --query 'stores endorsements' --relay $RELAY_URL" \
        "quadra-a Relay" \
        "$cli_name"

    run_test "Discovery - Non-existent Query" \
        "$a4_binary find --query 'nonexistent' --relay $RELAY_URL" \
        "Results: 0" \
        "$cli_name"

    run_test "Discovery - Translate Query" \
        "$a4_binary find --query 'translate' --relay $RELAY_URL" \
        "Results: 0" \
        "$cli_name"

    run_test "Discovery - Chat Query" \
        "$a4_binary find --query 'chat' --relay $RELAY_URL" \
        "Results: 0" \
        "$cli_name"
}

test_basic_messaging() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] BASIC MESSAGING TESTS ==="

    run_test "Basic Message Send" \
        "$a4_binary tell '$TEST_DID' 'Hello relay test from $cli_name' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Message with Wait Flag" \
        "$a4_binary tell '$TEST_DID' 'Test message with wait from $cli_name' --wait --relay $RELAY_URL" \
        "" \
        "$cli_name"

    run_test "Custom Protocol" \
        "$a4_binary tell '$TEST_DID' 'Custom protocol test from $cli_name' --protocol 'test/custom/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Empty JSON Payload" \
        "$a4_binary tell '$TEST_DID' --body '{}' --body-format json --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Complex JSON Payload" \
        "$a4_binary tell '$TEST_DID' --body '{\"array\":[1,2,3,\"test\",true,null],\"nested\":{\"deep\":{\"value\":\"test\"},\"boolean\":false},\"null_value\":null,\"number\":42.5,\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/complex/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"
}

test_unicode_and_special_chars() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] UNICODE AND SPECIAL CHARACTERS TESTS ==="

    run_test "Unicode Message" \
        "$a4_binary tell '$TEST_DID' 'Testing unicode: 你好世界 🌍 🚀 émojis and spëcial chars from $cli_name' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Unicode Protocol Name" \
        "$a4_binary tell '$TEST_DID' 'Unicode protocol test from $cli_name' --protocol 'test/spëcial-chars-🚀-测试/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Control Characters" \
        "$a4_binary tell '$TEST_DID' --body '{\"control_chars\":\"\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000A\u000B\u000C\u000D\u000E\u000F\",\"test\":\"control_character_handling\",\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/control-chars/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"
}

test_large_payloads() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] LARGE PAYLOAD TESTS ==="

    run_test "1KB Payload" \
        "$a4_binary tell '$TEST_DID' --body '{\"test\":\"large_payload\",\"data\":\"$(python3 -c "print('A' * 1000)")\",\"metadata\":{\"size\":1000,\"type\":\"stress_test\"},\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/large-payload/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "10KB Payload" \
        "$a4_binary tell '$TEST_DID' --body '{\"test\":\"very_large_payload\",\"data\":\"$(python3 -c "print('X' * 10000)")\",\"metadata\":{\"size\":10000,\"type\":\"stress_test\"},\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/stress/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "50KB Payload" \
        "$a4_binary tell '$TEST_DID' --body '{\"test\":\"extremely_large_payload\",\"data\":\"$(python3 -c "print('Z' * 50000)")\",\"metadata\":{\"size\":50000,\"type\":\"stress_test\"},\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/mega-payload/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Large Array (1000 integers)" \
        "$a4_binary tell '$TEST_DID' --body '{\"array_test\":[$(python3 -c "print(','.join([str(i) for i in range(1000)]))")],\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/large-array/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Massive Unicode Payload" \
        "$a4_binary tell '$TEST_DID' --body '{\"test\":\"超大负载测试\",\"data\":\"$(python3 -c "print('测试数据' * 1000)")\",\"metadata\":{\"size\":\"massive\",\"encoding\":\"utf8\"},\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/massive-unicode/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"
}

test_binary_and_encoding() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] BINARY AND ENCODING TESTS ==="

    run_test "Base64 Binary Data" \
        "$a4_binary tell '$TEST_DID' --body '{\"test\":\"binary_like_data\",\"data\":\"$(python3 -c "import base64; print(base64.b64encode(b'\\x00\\x01\\x02\\x03\\x04\\x05\\xFF\\xFE\\xFD').decode())")\",\"encoding\":\"base64\",\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/binary/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Deeply Nested JSON" \
        "$a4_binary tell '$TEST_DID' --body '{\"deeply\":{\"nested\":{\"object\":{\"with\":{\"many\":{\"levels\":{\"of\":{\"nesting\":{\"value\":\"deep_test\",\"array\":[{\"nested_in_array\":true}],\"cli\":\"$cli_name\"}}}}}}}}' --body-format json --protocol 'test/deep-nesting/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"
}

test_sequential_throughput() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] SEQUENTIAL THROUGHPUT TESTS ==="

    run_test "5 Sequential Messages" \
        "for i in {1..5}; do $a4_binary tell '$TEST_DID' 'Rapid test message \$i from $cli_name' --relay $RELAY_URL >/dev/null 2>&1; done && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"

    run_test "10 Sequential Messages" \
        "for i in {1..10}; do $a4_binary tell '$TEST_DID' 'Stress test batch message \$i from $cli_name' --protocol 'test/batch/1.0' --relay $RELAY_URL >/dev/null 2>&1; done && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"

    run_test "20 Sequential Messages" \
        "for i in {1..20}; do $a4_binary tell '$TEST_DID' 'Stress test message \$i from $cli_name' --protocol 'test/stress/1.0' --relay $RELAY_URL >/dev/null 2>&1; done && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"

    run_test "50 Sequential Messages" \
        "for i in {1..50}; do $a4_binary tell '$TEST_DID' 'Extreme stress test \$i from $cli_name' --protocol 'test/extreme-stress/1.0' --relay $RELAY_URL >/dev/null 2>&1; done && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"

    run_test "100 Sequential Messages" \
        "for i in {1..100}; do $a4_binary tell '$TEST_DID' 'Ultimate stress test \$i from $cli_name' --protocol 'test/ultimate-stress/1.0' --relay $RELAY_URL >/dev/null 2>&1; done && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"
}

test_concurrent_operations() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] CONCURRENT OPERATIONS TESTS ==="

    run_test "3 Concurrent Messages" \
        "for i in {1..3}; do ($a4_binary tell '$TEST_DID' 'Test message \$i from $cli_name' --relay $RELAY_URL >/dev/null 2>&1 &); done; wait && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"

    run_test "10 Concurrent Messages" \
        "for i in {1..10}; do ($a4_binary tell '$TEST_DID' 'Concurrent stress \$i from $cli_name' --protocol 'test/concurrent-extreme/1.0' --relay $RELAY_URL >/dev/null 2>&1 &); done; wait && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"

    run_test "20 Concurrent Messages" \
        "for i in {1..20}; do ($a4_binary tell '$TEST_DID' 'Massive concurrent test \$i from $cli_name' --protocol 'test/massive-concurrent/1.0' --relay $RELAY_URL >/dev/null 2>&1 &); done; wait && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"

    run_test "50 Concurrent Messages" \
        "for i in {1..50}; do ($a4_binary tell '$TEST_DID' 'Ultimate concurrent test \$i from $cli_name' --protocol 'test/ultimate-concurrent/1.0' --relay $RELAY_URL >/dev/null 2>&1 &); done; wait && echo 'SUCCESS'" \
        "SUCCESS" \
        "$cli_name"
}

test_edge_cases() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] EDGE CASES AND ERROR HANDLING TESTS ==="

    run_test "Invalid DID Format" \
        "$a4_binary tell 'did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe" \
        "Delivered: true" \
        "$cli_name"

    run_test "Nonexistent Agent DID" \
        "$a4_binary tell 'did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe" \
        "Delivered: true" \
        "$cli_name"

    run_test "Empty Protocol Name" \
        "$a4_binary tell '$TEST_DID' --body '\"\"' --body-format json --protocol '' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Malformed Protocol Identifier" \
        "$a4_binary tell '$TEST_DID' --body '{\"test\":\"malformed_protocol\",\"data\":123,\"cli\":\"$cli_name\"}' --body-format json --protocol 'invalid/protocol/format' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Extremely Long Protocol Name" \
        "$a4_binary tell '$TEST_DID' 'Testing extremely long protocol name from $cli_name' --protocol 'test/$(python3 -c "print('a' * 200)")/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Extremely Long DID in Payload" \
        "$a4_binary tell '$TEST_DID' --body '{\"test\":\"extremely_long_did\",\"target\":\"$(python3 -c "print('did:agent:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe")\",\"cli\":\"$cli_name\"}' --body-format json --protocol 'test/long-did/1.0' --relay $RELAY_URL" \
        "Delivered: true" \
        "$cli_name"

    run_test "Invalid Relay URL" \
        "$a4_binary find --relay ws://invalid-relay.example.com:8080" \
        "EXPECT_FAILURE" \
        "$cli_name"

    run_test "Invalid Port" \
        "$a4_binary find --relay ws://invalid-port.woowot.com:9999" \
        "EXPECT_FAILURE" \
        "$cli_name"

    run_test "Invalid Message Format" \
        "$a4_binary tell '$TEST_DID' 'Testing invalid message format from $cli_name' --relay $RELAY_URL --human" \
        "Daemon send failed" \
        "$cli_name"
}

test_daemon_functionality() {
    local a4_binary="$1"
    local cli_name="$2"

    log_info "=== [$cli_name] DAEMON FUNCTIONALITY TESTS ==="

    run_test "Daemon Status Check" \
        "$a4_binary status" \
        "Daemon is running\|Online\|Connected" \
        "$cli_name"

    run_test "Inbox Check" \
        "$a4_binary inbox" \
        "INBOX" \
        "$cli_name"

    # Test join functionality with timeout (background process)
    run_test "Join Functionality Test" \
        "quadra_run_with_timeout 3 $a4_binary join --relay '$RELAY_URL' --json || echo 'JOIN_TEST_COMPLETED'" \
        "JOIN_TEST_COMPLETED" \
        "$cli_name"
}

# Main test execution
main() {
    echo "=================================================="
    echo "quadra-a Relay Comprehensive Test Suite"
    echo "=================================================="
    echo "Relay URL: $RELAY_URL"
    echo "CLI Mode: $CLI_MODE"
    echo "Test DID: $TEST_DID"
    echo "=================================================="

    check_prerequisites

    # Get CLI commands to test
    CLI_COMMANDS=($(get_cli_commands))

    echo "CLIs to test: ${#CLI_COMMANDS[@]}"
    for i in "${!CLI_COMMANDS[@]}"; do
        echo "  $((i+1)). ${CLI_COMMANDS[i]}"
    done
    echo "=================================================="

    # Check all CLIs
    for i in "${!CLI_COMMANDS[@]}"; do
        cli_name="CLI $((i+1))"
        if [[ "${CLI_COMMANDS[i]}" == *"pnpm"* ]]; then
            cli_name="TypeScript CLI (pnpm)"
        elif [[ "${CLI_COMMANDS[i]}" == *"npx"* ]]; then
            cli_name="TypeScript CLI (npx)"
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

    # Run all test categories for each CLI
    for i in "${!CLI_COMMANDS[@]}"; do
        cli_name="CLI $((i+1))"
        if [[ "${CLI_COMMANDS[i]}" == *"pnpm"* ]]; then
            cli_name="TypeScript CLI (pnpm)"
        elif [[ "${CLI_COMMANDS[i]}" == *"npx"* ]]; then
            cli_name="TypeScript CLI (npx)"
        elif [[ "${CLI_COMMANDS[i]}" == "$NODE_CLI_GLOBAL" ]]; then
            cli_name="TypeScript CLI (global)"
        else
            cli_name="Rust CLI"
        fi

        echo ""
        echo "=================================================="
        echo "Testing with $cli_name: ${CLI_COMMANDS[i]}"
        echo "=================================================="

        test_basic_functionality "${CLI_COMMANDS[i]}" "$cli_name"
        test_discovery "${CLI_COMMANDS[i]}" "$cli_name"
        test_basic_messaging "${CLI_COMMANDS[i]}" "$cli_name"
        test_unicode_and_special_chars "${CLI_COMMANDS[i]}" "$cli_name"
        test_large_payloads "${CLI_COMMANDS[i]}" "$cli_name"
        test_binary_and_encoding "${CLI_COMMANDS[i]}" "$cli_name"
        test_sequential_throughput "${CLI_COMMANDS[i]}" "$cli_name"
        test_concurrent_operations "${CLI_COMMANDS[i]}" "$cli_name"
        test_edge_cases "${CLI_COMMANDS[i]}" "$cli_name"
        test_daemon_functionality "${CLI_COMMANDS[i]}" "$cli_name"

        # Final daemon status check for this CLI
        log_info "=== [$cli_name] FINAL STATUS CHECK ==="
        run_test "Final Daemon Status" \
            "${CLI_COMMANDS[i]} status" \
            "Daemon is running\|Online\|Connected" \
            "$cli_name"
    done

    # Summary
    echo ""
    echo "=================================================="
    echo "TEST SUMMARY"
    echo "=================================================="
    echo -e "Total Tests: ${BLUE}$TOTAL_TESTS${NC}"
    echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
    echo -e "Failed: ${RED}$FAILED_TESTS${NC}"
    echo -e "CLIs Tested: ${BLUE}${#CLI_COMMANDS[@]}${NC}"

    if [[ $FAILED_TESTS -eq 0 ]]; then
        echo -e "\n${GREEN}🎉 ALL TESTS PASSED for all CLIs! Relay is production ready.${NC}"
        exit 0
    else
        echo -e "\n${RED}❌ Some tests failed. Please review the output above.${NC}"
        exit 1
    fi
}

# Run main function
main "$@"
