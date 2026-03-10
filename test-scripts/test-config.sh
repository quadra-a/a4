# quadra-a Relay Test Configuration
# Configuration file for relay testing scripts

TEST_SCRIPTS_DIR="${TEST_SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
A4_ROOT="${A4_ROOT:-$(cd "$TEST_SCRIPTS_DIR/.." && pwd)}"

# Default relay endpoints
DEFAULT_RELAY_URL="ws://relay-sg-1.quadra-a.com:8080"
BACKUP_RELAY_URL="ws://localhost:8080"
LOCAL_RELAY_URL="ws://localhost:8080"

# Test target DID (relay a4)
TEST_DID="did:a4:z5m2k4p3QiDQbGc9oi4oKvK2gaDCvcxti8E9aRG7mAFJe"

# Binary paths - absolute paths rooted at repos/a4
DEFAULT_A4_BINARY="$A4_ROOT/rust/target/release/a4"
DEBUG_A4_BINARY="$A4_ROOT/rust/target/debug/a4"
MUSL_A4_BINARY="$A4_ROOT/rust/target/x86_64-unknown-linux-musl/release/a4"

# TypeScript CLI paths (absolute paths rooted at repos/a4)
NODE_CLI_DIRECT="$A4_ROOT/js/cli/a4"
NODE_CLI_PNPM="pnpm --filter @quadra-a/cli exec a4"
NODE_CLI_NPX="npx -a/cli"
NODE_CLI_GLOBAL="a4"

# CLI command arrays (properly quoted to avoid word splitting)
declare -a RUST_CLI_COMMANDS=("$DEFAULT_A4_BINARY")
declare -a NODE_CLI_COMMANDS=("$NODE_CLI_DIRECT")

# CLI selection (rust|node|both)
CLI_MODE="${CLI_MODE:-both}"

# Test parameters
SMALL_PAYLOAD_SIZE=1000      # 1KB
MEDIUM_PAYLOAD_SIZE=10000    # 10KB
LARGE_PAYLOAD_SIZE=50000     # 50KB
MASSIVE_PAYLOAD_SIZE=100000  # 100KB

# Stress test parameters
SEQUENTIAL_TEST_COUNTS=(5 10 20 50 100)
CONCURRENT_TEST_COUNTS=(3 5 10 20 50)

# Timeout settings (seconds) - increased to accommodate Rust CLI performance
DISCOVERY_TIMEOUT=15
MESSAGE_TIMEOUT=45
JOIN_TIMEOUT=10
DAEMON_TIMEOUT=10

# Test categories (enable/disable)
ENABLE_BASIC_TESTS=true
ENABLE_DISCOVERY_TESTS=true
ENABLE_MESSAGING_TESTS=true
ENABLE_UNICODE_TESTS=true
ENABLE_PAYLOAD_TESTS=true
ENABLE_THROUGHPUT_TESTS=true
ENABLE_CONCURRENT_TESTS=true
ENABLE_EDGE_CASE_TESTS=true
ENABLE_DAEMON_TESTS=true

# Performance thresholds
MAX_DISCOVERY_TIME_MS=1000
MAX_MESSAGE_TIME_MS=5000
MIN_THROUGHPUT_MSG_PER_SEC=10

# Error handling
CONTINUE_ON_FAILURE=false
VERBOSE_OUTPUT=false
SAVE_LOGS=true

# Centralized output directories
TEST_OUTPUT_ROOT="./test-output"
RESULTS_DIR="$TEST_OUTPUT_ROOT/results"
LOG_DIRECTORY="$TEST_OUTPUT_ROOT/logs"
REPORTS_DIR="$TEST_OUTPUT_ROOT/reports"
ARTIFACTS_DIR="$TEST_OUTPUT_ROOT/artifacts"

# Legacy directory mappings (for backward compatibility)
LEGACY_TEST_RESULTS="./test-results"
LEGACY_CI_RESULTS="./ci-test-results"
LEGACY_INTEGRATION_RESULTS="./integration-test-results"
LEGACY_LOAD_RESULTS="./load-test-results"
LEGACY_STRESS_RESULTS="./stress-test-results"
LEGACY_MASTER_RESULTS="./master-test-results"

# Test data
UNICODE_TEST_STRING="Testing unicode: 你好世界 🌍 🚀 émojis and spëcial chars"
CONTROL_CHARS_TEST="\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000A\u000B\u000C\u000D\u000E\u000F"

# Protocol identifiers for testing
TEST_PROTOCOLS=(
    "quadra-a/chat/1.0"
    "test/custom/1.0"
    "test/stress/1.0"
    "test/unicode-🚀-测试/1.0"
    "test/$(python3 -c "print('a' * 100)")/1.0"
    ""
    "invalid/protocol/format"
)

# Message types for testing (updated for CVP-0020)
TEST_MESSAGE_TYPES=(
    "message"
    "reply"
)

# Discovery queries for testing
DISCOVERY_QUERIES=(
    ""
    "relay"
    "WebSocket"
    "routes messages"
    "indexes agents"
    "stores endorsements"
    "nonexistent"
    "translate"
    "chat"
    "network"
    "quadra-a"
)

# Invalid test cases
INVALID_RELAY_URLS=(
    "ws://invalid-relay.example.com:8080"
    "ws://invalid-port.woowot.com:9999"
    "http://wrong-protocol.com:8080"
    "ws://localhost:99999"
)

INVALID_DIDS=(
    "did:a4:invalid-did-format"
    "did:a4:nonexistent-a4-did"
    "invalid-did-completely"
    ""
    "did:a4:z$(python3 -c "print('A' * 200)")"
)
