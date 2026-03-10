#!/bin/bash

# quadra-a Relay Test Environment Setup Script
# Sets up a complete testing environment with multiple relay instances
# Usage: ./setup-test-env.sh [action] [options]

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ENV_DIR="$TEST_OUTPUT_ROOT/test-environment"
RELAY_BINARY="$PROJECT_ROOT/js/relay/dist/server.js"
A4_BINARY="$PROJECT_ROOT/rust/target/release/a4"

# Test environment configuration
LOCAL_RELAY_PORT=8080
BACKUP_RELAY_PORT=8081
TEST_RELAY_PORT=8082

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

# Create test environment directory
setup_directories() {
    log_info "Setting up test environment directories..."

    mkdir -p "$TEST_ENV_DIR"/{relays,agents,logs,configs,results}
    mkdir -p "$TEST_ENV_DIR/relays"/{local,backup,test}
    mkdir -p "$TEST_ENV_DIR/agents"/{agent1,agent2,agent3}

    log_success "Directories created"
}

# Generate relay configurations
generate_relay_configs() {
    log_info "Generating relay configurations..."

    # Local relay config
    cat > "$TEST_ENV_DIR/configs/local-relay.json" << EOF
{
  "port": $LOCAL_RELAY_PORT,
  "host": "localhost",
  "name": "Local Test Relay",
  "description": "Local relay for testing",
  "logLevel": "info",
  "maxConnections": 1000,
  "heartbeatInterval": 30000,
  "connectionTimeout": 90000,
  "rateLimit": {
    "enabled": true,
    "maxRequests": 100,
    "windowMs": 60000
  },
  "storage": {
    "type": "memory",
    "path": "$TEST_ENV_DIR/relays/local/data"
  }
}
EOF

    # Backup relay config
    cat > "$TEST_ENV_DIR/configs/backup-relay.json" << EOF
{
  "port": $BACKUP_RELAY_PORT,
  "host": "localhost",
  "name": "Backup Test Relay",
  "description": "Backup relay for testing",
  "logLevel": "info",
  "maxConnections": 500,
  "heartbeatInterval": 30000,
  "connectionTimeout": 90000,
  "rateLimit": {
    "enabled": true,
    "maxRequests": 50,
    "windowMs": 60000
  },
  "storage": {
    "type": "memory",
    "path": "$TEST_ENV_DIR/relays/backup/data"
  }
}
EOF

    # Test relay config (for stress testing)
    cat > "$TEST_ENV_DIR/configs/test-relay.json" << EOF
{
  "port": $TEST_RELAY_PORT,
  "host": "localhost",
  "name": "Stress Test Relay",
  "description": "High-capacity relay for stress testing",
  "logLevel": "warn",
  "maxConnections": 2000,
  "heartbeatInterval": 15000,
  "connectionTimeout": 45000,
  "rateLimit": {
    "enabled": false
  },
  "storage": {
    "type": "memory",
    "path": "$TEST_ENV_DIR/relays/test/data"
  }
}
EOF

    log_success "Relay configurations generated"
}

# Generate test agent configurations
generate_agent_configs() {
    log_info "Generating test agent configurations..."

    # Agent 1 - Basic test agent
    cat > "$TEST_ENV_DIR/configs/agent1.json" << EOF
{
  "name": "Test Agent 1",
  "description": "Basic test agent for functionality testing",
  "capabilities": ["test", "echo", "ping"],
  "protocols": ["highway1/test/1.0", "highway1/echo/1.0"],
  "relays": [
    "ws://localhost:$LOCAL_RELAY_PORT",
    "ws://localhost:$BACKUP_RELAY_PORT"
  ],
  "autoConnect": true,
  "reconnectInterval": 5000,
  "maxReconnectAttempts": 10
}
EOF

    # Agent 2 - Performance test agent
    cat > "$TEST_ENV_DIR/configs/agent2.json" << EOF
{
  "name": "Performance Test Agent",
  "description": "Agent optimized for performance testing",
  "capabilities": ["performance", "throughput", "latency"],
  "protocols": ["highway1/perf/1.0", "highway1/benchmark/1.0"],
  "relays": [
    "ws://localhost:$LOCAL_RELAY_PORT",
    "ws://localhost:$TEST_RELAY_PORT"
  ],
  "autoConnect": true,
  "reconnectInterval": 1000,
  "maxReconnectAttempts": 20
}
EOF

    # Agent 3 - Stress test agent
    cat > "$TEST_ENV_DIR/configs/agent3.json" << EOF
{
  "name": "Stress Test Agent",
  "description": "Agent for stress and load testing",
  "capabilities": ["stress", "load", "concurrent"],
  "protocols": ["highway1/stress/1.0", "highway1/load/1.0"],
  "relays": [
    "ws://localhost:$TEST_RELAY_PORT"
  ],
  "autoConnect": true,
  "reconnectInterval": 500,
  "maxReconnectAttempts": 50
}
EOF

    log_success "Agent configurations generated"
}

# Start relay instances
start_relays() {
    log_info "Starting relay instances..."

    # Check if Node.js relay is available
    if [[ ! -f "$RELAY_BINARY" ]]; then
        log_warning "Node.js relay not found at $RELAY_BINARY"
        log_info "Building relay..."
        cd "$PROJECT_ROOT" && pnpm build
    fi

    # Start local relay
    log_info "Starting local relay on port $LOCAL_RELAY_PORT..."
    cd "$TEST_ENV_DIR/relays/local"
    node "$RELAY_BINARY" --config "$TEST_ENV_DIR/configs/local-relay.json" \
        > "$TEST_ENV_DIR/logs/local-relay.log" 2>&1 &
    echo $! > "$TEST_ENV_DIR/relays/local/pid"

    # Start backup relay
    log_info "Starting backup relay on port $BACKUP_RELAY_PORT..."
    cd "$TEST_ENV_DIR/relays/backup"
    node "$RELAY_BINARY" --config "$TEST_ENV_DIR/configs/backup-relay.json" \
        > "$TEST_ENV_DIR/logs/backup-relay.log" 2>&1 &
    echo $! > "$TEST_ENV_DIR/relays/backup/pid"

    # Start test relay
    log_info "Starting test relay on port $TEST_RELAY_PORT..."
    cd "$TEST_ENV_DIR/relays/test"
    node "$RELAY_BINARY" --config "$TEST_ENV_DIR/configs/test-relay.json" \
        > "$TEST_ENV_DIR/logs/test-relay.log" 2>&1 &
    echo $! > "$TEST_ENV_DIR/relays/test/pid"

    # Wait for relays to start
    sleep 5

    # Verify relays are running
    local running_relays=0
    for port in $LOCAL_RELAY_PORT $BACKUP_RELAY_PORT $TEST_RELAY_PORT; do
        if nc -z localhost $port 2>/dev/null; then
            ((running_relays++))
            log_success "Relay on port $port is running"
        else
            log_error "Relay on port $port failed to start"
        fi
    done

    if [[ $running_relays -eq 3 ]]; then
        log_success "All relays started successfully"
    else
        log_error "Some relays failed to start"
        return 1
    fi
}

# Stop relay instances
stop_relays() {
    log_info "Stopping relay instances..."

    for relay_dir in "$TEST_ENV_DIR/relays"/{local,backup,test}; do
        if [[ -f "$relay_dir/pid" ]]; then
            local pid=$(cat "$relay_dir/pid")
            if kill -0 $pid 2>/dev/null; then
                log_info "Stopping relay (PID: $pid)..."
                kill $pid
                rm -f "$relay_dir/pid"
            fi
        fi
    done

    # Wait for processes to stop
    sleep 2

    log_success "Relays stopped"
}

# Initialize test agents
init_test_agents() {
    log_info "Initializing test agents..."

    # Build a4 binary if needed
    if [[ ! -f "$A4_BINARY" ]]; then
        log_info "Building a4 CLI binary..."
        cd "$PROJECT_ROOT/rust/cli-rs"
        cargo build --release
    fi

    # Initialize agents
    for i in {1..3}; do
        local agent_dir="$TEST_ENV_DIR/agents/agent$i"
        cd "$agent_dir"

        # Initialize agent identity
        AGENT_CONFIG_DIR="$agent_dir" "$A4_BINARY" init --name "Test Agent $i" \
            > "$TEST_ENV_DIR/logs/agent$i-init.log" 2>&1

        log_success "Agent $i initialized"
    done
}

# Run comprehensive test suite
run_test_suite() {
    log_info "Running comprehensive test suite..."

    local test_results_dir="$TEST_ENV_DIR/results/$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$test_results_dir"

    # Test against each relay
    for port in $LOCAL_RELAY_PORT $BACKUP_RELAY_PORT $TEST_RELAY_PORT; do
        local relay_url="ws://localhost:$port"
        log_info "Testing relay at $relay_url..."

        # Quick test
        "$SCRIPT_DIR/test-relay-quick.sh" "$relay_url" "$A4_BINARY" \
            > "$test_results_dir/quick-test-$port.log" 2>&1 &

        # Comprehensive test
        "$SCRIPT_DIR/test-relay-comprehensive.sh" "$relay_url" "$A4_BINARY" \
            > "$test_results_dir/comprehensive-test-$port.log" 2>&1 &
    done

    # Wait for tests to complete
    wait

    # Generate summary
    local summary_file="$test_results_dir/test-summary.txt"
    cat > "$summary_file" << EOF
Test Environment Summary
========================
Date: $(date)
Relays Tested: 3
- Local Relay: ws://localhost:$LOCAL_RELAY_PORT
- Backup Relay: ws://localhost:$BACKUP_RELAY_PORT
- Test Relay: ws://localhost:$TEST_RELAY_PORT

Test Results:
=============
EOF

    for port in $LOCAL_RELAY_PORT $BACKUP_RELAY_PORT $TEST_RELAY_PORT; do
        echo "Port $port:" >> "$summary_file"
        if grep -q "All.*tests passed" "$test_results_dir/quick-test-$port.log" 2>/dev/null; then
            echo "  Quick Test: PASSED" >> "$summary_file"
        else
            echo "  Quick Test: FAILED" >> "$summary_file"
        fi

        if grep -q "ALL TESTS PASSED" "$test_results_dir/comprehensive-test-$port.log" 2>/dev/null; then
            echo "  Comprehensive Test: PASSED" >> "$summary_file"
        else
            echo "  Comprehensive Test: FAILED" >> "$summary_file"
        fi
        echo "" >> "$summary_file"
    done

    log_success "Test suite completed"
    log_info "Results: $test_results_dir"
    log_info "Summary: $summary_file"
}

# Show environment status
show_status() {
    echo "=================================================="
    echo "quadra-a Test Environment Status"
    echo "=================================================="

    # Check relay status
    echo "Relay Status:"
    for port in $LOCAL_RELAY_PORT $BACKUP_RELAY_PORT $TEST_RELAY_PORT; do
        if nc -z localhost $port 2>/dev/null; then
            echo -e "  Port $port: ${GREEN}RUNNING${NC}"
        else
            echo -e "  Port $port: ${RED}STOPPED${NC}"
        fi
    done

    echo ""
    echo "Environment Directories:"
    echo "  Root: $TEST_ENV_DIR"
    echo "  Configs: $TEST_ENV_DIR/configs"
    echo "  Logs: $TEST_ENV_DIR/logs"
    echo "  Results: $TEST_ENV_DIR/results"

    echo ""
    echo "Available Commands:"
    echo "  $0 setup    - Set up test environment"
    echo "  $0 start    - Start all relays"
    echo "  $0 stop     - Stop all relays"
    echo "  $0 test     - Run test suite"
    echo "  $0 status   - Show this status"
    echo "  $0 clean    - Clean up environment"
    echo "=================================================="
}

# Clean up test environment
cleanup_environment() {
    log_info "Cleaning up test environment..."

    # Stop relays first
    stop_relays

    # Remove test environment directory
    if [[ -d "$TEST_ENV_DIR" ]]; then
        rm -rf "$TEST_ENV_DIR"
        log_success "Test environment cleaned up"
    else
        log_info "Test environment already clean"
    fi
}

# Main function
main() {
    local action="${1:-status}"

    case "$action" in
        setup)
            log_info "Setting up quadra-a test environment..."
            setup_directories
            generate_relay_configs
            generate_agent_configs
            init_test_agents
            log_success "Test environment setup complete"
            ;;
        start)
            start_relays
            ;;
        stop)
            stop_relays
            ;;
        restart)
            stop_relays
            sleep 2
            start_relays
            ;;
        test)
            run_test_suite
            ;;
        status)
            show_status
            ;;
        clean)
            cleanup_environment
            ;;
        --help|-h)
            show_status
            ;;
        *)
            log_error "Unknown action: $action"
            show_status
            exit 1
            ;;
    esac
}

# Run main function
main "$@"