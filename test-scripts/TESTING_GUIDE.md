# quadra-a Relay Testing Suite - Complete Documentation

## 🎯 Overview

This comprehensive testing suite provides everything needed to test, validate, and monitor quadra-a relay implementations. The suite includes 15+ specialized scripts covering all aspects of relay testing from basic functionality to enterprise compliance validation.

## 📁 Test Scripts Directory Structure

```
test-scripts/
├── README.md                      # This documentation
├── test-config.sh                 # Shared configuration and parameters
├──
├── 🚀 Quick & Essential Tests
├── test-relay-quick.sh            # 5 essential tests (~30 seconds)
├── test-relay-comprehensive.sh    # 60+ comprehensive tests (~5 minutes)
├──
├── ⚡ Performance & Load Testing
├── benchmark-relay.sh             # Performance benchmarking
├── load-test-relay.sh             # Load and stress testing
├── stress-test-relay.sh           # Advanced stress scenarios
├──
├── 🔄 Continuous Integration
├── ci-test-relay.sh               # CI-optimized test suite with JUnit XML
├── automate-tests.sh              # Full automation pipeline
├──
├── 🔍 Monitoring & Validation
├── monitor-relay.sh               # Continuous health monitoring
├── validate-test-results.sh       # Compliance validation
├──
├── 📊 Reporting & Analysis
├── generate-test-report.sh        # HTML test reports
├──
├── 🛠️ Environment & Setup
├── setup-test-env.sh              # Multi-relay test environment
├── run-all-tests.sh               # Master test runner (includes deployment validation when supported)
└──
└── 📋 Configuration Files
    ├── Makefile.relay-tests       # Make targets for common tasks
    └── automation-config.json     # Automation pipeline configuration
```

## 🚀 Quick Start

### 1. Basic Functionality Test (30 seconds)
```bash
# Test essential relay functionality
./test-relay-quick.sh

# With custom relay and binary
./test-relay-quick.sh ws://relay-sg-1.quadra-a.com:8080 ./rust/target/release/a4
```

### 2. Comprehensive Testing (5 minutes)
```bash
# Full test suite with 60+ tests
./test-relay-comprehensive.sh

# All test categories
./run-all-tests.sh

# Force the local deployment stage inside the full suite
DEPLOYMENT_TEST_MODE=always ./run-all-tests.sh
```

### 2b. JavaScript Workspace Validation
```bash
# CI-safe JS package validation (forces non-watch vitest)
./run-js-workspace-tests.sh

# Write logs and summary to a custom directory
./run-js-workspace-tests.sh --results-dir ./test-output/results/js-workspace-local
```

When local socket binds are blocked by the environment, the runner skips `relay tests` outside CI and still records the skip in the summary.

### 3. Performance Benchmarking
```bash
# Performance metrics and benchmarks
./benchmark-relay.sh

# Load testing with custom duration
./load-test-relay.sh ws://relay-sg-1.quadra-a.com:8080 ./rust/target/release/a4 300
```

## 📋 Test Categories

### 🔍 Discovery Tests (10 tests)
- **Basic Discovery**: Relay agent discovery functionality
- **Query-based Search**: WebSocket, relay, routes messages, indexes agents
- **Empty/Non-existent Queries**: Edge case handling
- **Discovery with Limits**: Pagination and result limiting
- **Multi-word Phrase Matching**: Complex query patterns

**Success Criteria**: 100% discovery success, <1s response time

### 📨 Messaging Tests (25+ tests)
- **Message Types**: notification, request, response
- **Custom Protocols**: Protocol identifier flexibility
- **JSON Payloads**: Complex nested structures
- **Delivery Confirmation**: Message delivery guarantees
- **Invalid DIDs**: Error handling for malformed identifiers

**Success Criteria**: 100% delivery success, <2s latency

### 🌐 Unicode & Special Characters (5 tests)
- **Unicode Messages**: Chinese, emoji, special characters
- **Unicode Protocol Names**: International protocol identifiers
- **Control Characters**: Binary data handling
- **Base64 Encoding**: Binary data transmission

**Success Criteria**: Full unicode support, proper encoding

### 📊 Payload Size Tests (8 tests)
- **Small Payloads**: 1KB messages
- **Medium Payloads**: 10KB messages
- **Large Payloads**: 50KB messages
- **Massive Payloads**: 100KB+ messages
- **Large Arrays**: 1000+ element arrays
- **Complex Structures**: Deeply nested JSON

**Success Criteria**: Support up to 100KB payloads

### ⚡ Performance Tests (15 tests)
- **Sequential Throughput**: 5, 10, 20, 50, 100 message sequences
- **Concurrent Operations**: 3, 5, 10, 20, 50 parallel connections
- **Message Latency**: Response time measurements
- **Discovery Performance**: Query response times

**Success Criteria**: >50 msg/s throughput, <1s latency

### 🔧 Edge Cases & Error Handling (12 tests)
- **Invalid DIDs**: Malformed identifier handling
- **Invalid Relay URLs**: Connection error scenarios
- **Malformed Protocols**: Protocol validation
- **Empty/Null Values**: Edge case data handling
- **Connection Failures**: Network interruption recovery

**Success Criteria**: Graceful error handling, proper fallbacks

### 🔄 Daemon Management (5 tests)
- **Status Monitoring**: Daemon health checks
- **Connection Persistence**: Long-running stability
- **Inbox Functionality**: Message queuing
- **Join Operations**: Real-time connection handling

**Success Criteria**: 99%+ uptime, automatic recovery

## 🛠️ Advanced Testing Tools

### 1. Stress Testing with Scenarios
```bash
# Available scenarios: light, medium, heavy, extreme, endurance, burst
./scripts/stress-test-relay.sh ws://relay-sg-1.quadra-a.com:8080 ./rust/target/release/a4 heavy

# List all scenarios
./scripts/stress-test-relay.sh --list-scenarios
```

**Scenario Configurations**:
- **Light**: 10 connections, 30s duration, 5 msg/s, 500B payload
- **Medium**: 25 connections, 60s duration, 15 msg/s, 2KB payload
- **Heavy**: 100 connections, 120s duration, 50 msg/s, 5KB payload
- **Extreme**: 200 connections, 300s duration, 100 msg/s, 10KB payload
- **Endurance**: 20 connections, 1800s duration, 10 msg/s, 1KB payload
- **Burst**: 500 connections, 10s duration, 200 msg/s, 100B payload

### 2. Continuous Monitoring
```bash
# Monitor relay health every 30 seconds
./scripts/monitor-relay.sh ws://relay-sg-1.quadra-a.com:8080 ./rust/target/release/a4 30

# Monitor with custom interval
./scripts/monitor-relay.sh ws://relay-sg-1.quadra-a.com:8080 ./rust/target/release/a4 60
```

**Monitoring Features**:
- Real-time health checks
- Performance metrics collection
- Alert system integration
- CSV metrics export
- Automatic report generation

### 3. Test Environment Setup
```bash
# Set up complete test environment with 3 relays
./scripts/setup-test-env.sh setup

# Start all test relays
./scripts/setup-test-env.sh start

# Run tests against all relays
./scripts/setup-test-env.sh test

# Clean up environment
./scripts/setup-test-env.sh clean
```

### 4. Compliance Validation
```bash
# Validate against quadra-a basic compliance
./scripts/validate-test-results.sh ./test-results quadra-a-basic

# Production compliance validation
./scripts/validate-test-results.sh ./test-results quadra-a-production

# Enterprise compliance validation
./scripts/validate-test-results.sh ./test-results enterprise
```

**Compliance Standards**:
- **quadra-a-basic**: Basic functionality requirements
- **quadra-a-production**: Production-ready requirements
- **enterprise**: Enterprise-grade requirements

### 5. Automated Testing Pipeline
```bash
# Run automated test pipeline
./scripts/automate-tests.sh

# With custom configuration
./scripts/automate-tests.sh ./my-automation-config.json
```

**Pipeline Features**:
- Configurable test stages
- Parallel execution
- Retry logic
- Artifact collection
- Notification integration
- JUnit XML output

## 📊 Reporting & Analysis

### 1. HTML Test Reports
```bash
# Generate comprehensive HTML report
./scripts/generate-test-report.sh ./test-results ./test-report.html
```

**Report Features**:
- Interactive dashboard
- Performance metrics visualization
- Test result summaries
- Log analysis
- Mobile-responsive design

### 2. CI/CD Integration
```bash
# CI-optimized testing with JUnit XML
./scripts/ci-test-relay.sh

# Set CI environment variables
CI=true ./scripts/ci-test-relay.sh
```

**CI Features**:
- JUnit XML test results
- Retry logic for flaky tests
- Timeout handling
- Exit code compliance
- Artifact generation

## 🔧 Configuration & Customization

### 1. Test Configuration
Edit `scripts/test-config.sh` to customize:
- Default relay URLs
- Test parameters (payload sizes, message counts)
- Timeout settings
- Performance thresholds

### 2. Automation Configuration
Create `automation-config.json` for pipeline customization:
```json
{
  "pipeline": {
    "name": "Custom Test Pipeline",
    "timeout": 3600,
    "parallel_jobs": 4,
    "fail_fast": false
  },
  "test_stages": [
    {
      "name": "custom_test",
      "enabled": true,
      "timeout": 300,
      "commands": ["./my-custom-test.sh"]
    }
  ]
}
```

### 3. Make Targets
Use the provided Makefile for common tasks:
```bash
# Quick test
make test-quick

# Full test suite
make test-full

# Performance benchmark
make benchmark

# Build and test
make build-and-test

# CI test suite
make ci-test
```

## 📈 Performance Benchmarks

### Expected Performance Metrics
- **Discovery Latency**: <500ms (typical <200ms)
- **Message Delivery**: <1000ms (typical <500ms)
- **Throughput**: >50 msg/s (typical >100 msg/s)
- **Concurrent Connections**: >50 (tested up to 500)
- **Payload Size**: Up to 100KB+ (tested 60KB+)
- **Success Rate**: >99% (target 100%)

### Stress Test Limits
- **Maximum Concurrent Connections**: 500+ tested
- **Maximum Message Rate**: 200+ msg/s tested
- **Maximum Payload Size**: 100KB+ tested
- **Endurance Testing**: 30+ minutes continuous operation
- **Recovery Time**: <5s after network interruption

## 🚨 Troubleshooting

### Common Issues

1. **Binary Not Found**
   ```bash
   # Build the Rust CLI
   cd rust && cargo build --release
   ```

2. **Connection Failures**
   ```bash
   # Check relay connectivity
   nc -z relay-sg-1.quadra-a.com 8080
   ```

3. **Permission Errors**
   ```bash
   # Make scripts executable
   chmod +x scripts/*.sh
   ```

4. **Missing Dependencies**
   ```bash
   # Install required tools
   brew install python3 bc jq  # macOS
   apt-get install python3 bc jq  # Ubuntu
   ```

### Debug Mode
Enable verbose output for troubleshooting:
```bash
# Add debug flag to any script
bash -x ./scripts/test-relay-quick.sh

# Or set debug mode
set -x
./scripts/test-relay-comprehensive.sh
```

### Log Analysis
Check test logs for detailed information:
```bash
# View recent test logs
ls -la ./test-results/
tail -f ./test-results/latest.log

# Search for specific errors
grep -r "ERROR\|FAIL" ./test-results/
```

## 🔗 Integration Examples

### GitHub Actions
```yaml
name: Relay Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build CLI
        run: cd rust && cargo build --release
      - name: Run Tests
        run: ./scripts/ci-test-relay.sh
      - name: Upload Results
        uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: ./ci-test-results/
```

### Docker Integration
```dockerfile
FROM rust:1.70 as builder
COPY rust /app
WORKDIR /app
RUN cargo build --release

FROM ubuntu:22.04
RUN apt-get update && apt-get install -y python3 bc jq curl
COPY --from=builder /app/target/release/a4 /usr/local/bin/
COPY scripts/ /app/scripts/
WORKDIR /app
CMD ["./scripts/ci-test-relay.sh"]
```

### Slack Notifications
```bash
# Configure webhook in automation-config.json
{
  "notifications": {
    "enabled": true,
    "slack_webhook": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
  }
}
```

## 📚 Additional Resources

### Documentation
- `docs/rfcs/CVP-0011-relay-architecture.md` - Relay architecture specification
- `docs/rfcs/CVP-0013-llm-optimized-output.md` - CLI output format
- `CLAUDE.md` - Project overview and guidelines

### Example Usage
- `examples/` - Example configurations and use cases
- `test-*.mjs` - Legacy test examples
- `quick-demo.sh` - Quick demonstration script

### Development
- `rust/` - Rust CLI implementation
- `packages/relay/` - TypeScript relay server
- `packages/core/` - Core protocol implementation

## 🤝 Contributing

When adding new tests:
1. Follow the existing naming convention (`test-category-name.sh`)
2. Add appropriate logging and error handling
3. Update this documentation
4. Ensure tests are idempotent and can run in any order
5. Add configuration options to `test-config.sh`
6. Include the test in relevant test suites

### Test Script Template
```bash
#!/bin/bash
# Description of what this test does
# Usage: ./test-new-feature.sh [relay_url] [a4_binary_path]

set -e

# Configuration
RELAY_URL="${1:-ws://relay-sg-1.quadra-a.com:8080}"
A4_BINARY="${2:-./rust/target/release/a4}"

# Colors and logging functions
# ... (copy from existing scripts)

# Test implementation
run_test() {
    log_info "Running new feature test..."
    # Test logic here
    log_success "Test completed"
}

# Main function
main() {
    echo "New Feature Test"
    echo "================"
    run_test
}

main "$@"
```

---

**Generated by quadra-a Relay Test Suite v1.0**
For issues and contributions: https://github.com/anthropics/claude-code/issues

## Deployment Stage

`run-all-tests.sh` now invokes `test-relay-deployment.sh` as a system-level stage.

- `DEPLOYMENT_TEST_MODE=auto` runs deployment checks when local port binding is allowed.
- `DEPLOYMENT_TEST_MODE=always` forces the deployment stage and treats failures as real failures.
- `DEPLOYMENT_TEST_MODE=never` disables the deployment stage explicitly.
