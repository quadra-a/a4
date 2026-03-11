# quadra-a Test Suite Documentation

This directory contains comprehensive test scripts for the quadra-a relay system, covering all aspects of functionality, performance, and edge cases.

## Test Categories

### Core Functionality Tests
- **test-relay-quick.sh** - Essential functionality validation
- **test-relay-comprehensive.sh** - Complete feature testing
- **benchmark-relay.sh** - Performance benchmarking
- **load-test-relay.sh** - Load testing with configurable duration
- **stress-test-relay.sh** - Stress testing with various scenarios
- **ci-test-relay.sh** - CI/CD integration testing

### Advanced Edge Case Tests
- **test-error-handling.sh** - Error scenarios and recovery mechanisms
- **test-network-connectivity.sh** - Network connectivity issues and failures
- **test-malformed-messages.sh** - Malformed messages and security edge cases

### System Integration Tests
- **test-suite-integration.sh** - Complete system integration validation
- **validate-test-results.sh** - Results validation and compliance checking

### Orchestration Scripts
- **run-all-tests.sh** - Master test runner for complete validation
- **run-core-tests.sh** - Core functionality test runner
- **run-master-tests.sh** - Legacy master test runner

## New Comprehensive Test Coverage

### Error Handling Tests (test-error-handling.sh)
Tests various error scenarios to ensure robust error handling:

- **Binary Path Issues**: Invalid binary paths, missing executables
- **Command Validation**: Invalid commands, missing arguments
- **Permission Scenarios**: Read-only configs, permission denied cases
- **Timeout Handling**: Command timeouts, process hanging
- **Input Validation**: Invalid DIDs, malformed URLs, empty messages
- **Resource Limits**: Oversized messages, memory constraints
- **Process Management**: Daemon conflicts, concurrent access
- **System Integration**: Disk space, file system issues

**Key Features**:
- 15+ comprehensive error scenarios
- Validates actual CLI exit codes vs. expected behavior
- Graceful error handling verification
- Recovery mechanism testing

### Network Connectivity Tests (test-network-connectivity.sh)
Tests network-related failure modes and connectivity issues:

- **DNS Issues**: Invalid hostnames, DNS resolution failures
- **Port Problems**: Invalid ports, blocked/filtered ports
- **Protocol Mismatches**: HTTP vs WebSocket, HTTPS vs WS
- **URL Validation**: Malformed URLs, empty URLs, special characters
- **Connection Failures**: Timeouts, unreachable hosts
- **Network Configurations**: Proxy settings, IPv6 addresses
- **Resilience Testing**: Multiple invalid URLs, mixed valid/invalid
- **Concurrent Connections**: Multiple simultaneous connections
- **Connection Patterns**: Rapid connect/disconnect cycles

**Key Features**:
- 20+ network failure scenarios
- Timeout-based testing with configurable durations
- Real-world network condition simulation
- Connection resilience validation

### Malformed Messages Tests (test-malformed-messages.sh)
Tests edge cases with corrupted, malformed, and malicious message content:

- **Binary Content**: Null bytes, control characters, invalid UTF-8
- **Size Limits**: 1MB messages, 10MB messages, buffer overflow attempts
- **Data Corruption**: Random binary data, simulated corruption
- **JSON Edge Cases**: Malformed JSON, deeply nested structures
- **Unicode Handling**: Edge cases, combining characters, RTL text
- **Security Patterns**: SQL injection, XSS, path traversal, command injection
- **Protocol Validation**: Invalid DIDs, malformed protocol identifiers
- **Message Formats**: Whitespace-only, mixed line endings, repeated characters
- **Concurrent Malformed**: Multiple simultaneous malformed messages

**Key Features**:
- 35+ malformed message scenarios
- Security vulnerability testing
- Unicode and encoding edge cases
- Protocol compliance validation
- Concurrent malformed message handling

## Test Execution

### Quick Testing
```bash
# Run basic functionality tests
./test-relay-quick.sh

# Run specific test category
./test-error-handling.sh
./test-network-connectivity.sh
./test-malformed-messages.sh
```

### Comprehensive Testing
```bash
# Run complete test suite (all CLI modes)
./run-all-tests.sh

# Run tests for specific CLI mode
./run-all-tests.sh rust
./run-all-tests.sh node
```

### Test Configuration
Tests can be configured via environment variables and command-line parameters:

```bash
# Custom relay URL
./run-all-tests.sh both ws://custom-relay.example.com:8080

# Custom binary path
./run-all-tests.sh rust ws://relay.com:8080 /path/to/custom/a4

# Environment variables
A4_RELAY_URLS="ws://relay1.com:8080,ws://relay2.com:8080" ./run-all-tests.sh
```

## Test Results and Reporting

### Output Structure
```
test-output/
├── results/                    # Individual test logs
├── error-handling-results/     # Error handling test results
├── network-connectivity-results/ # Network test results
├── malformed-messages-results/ # Malformed message test results
├── integration-results/        # Integration test results
└── validation-results/         # Validation results
```

### Test Reports
Each test run generates:
- Individual test logs with detailed output
- Consolidated test suite report
- Performance metrics and timing data
- Success/failure statistics
- Error analysis and debugging information

## Test Coverage Summary

The comprehensive test suite now covers:

### ✅ Functional Testing
- Core relay functionality
- Message routing and delivery
- Agent discovery and registration
- Protocol compliance
- CLI command validation

### ✅ Performance Testing
- Load testing with configurable parameters
- Stress testing with various scenarios
- Benchmark testing with metrics
- Concurrent connection handling
- Throughput and latency measurement

### ✅ Error Handling Testing
- Invalid input handling
- Network failure scenarios
- Resource constraint handling
- Permission and security issues
- Process management edge cases

### ✅ Security Testing
- Malformed message handling
- Injection attack prevention
- Buffer overflow protection
- Input validation and sanitization
- Protocol security compliance

### ✅ Integration Testing
- End-to-end system validation
- Multi-component interaction testing
- Configuration validation
- Deployment verification
- Results compliance checking

## Best Practices

### Running Tests
1. **Start with quick tests** to validate basic functionality
2. **Run comprehensive tests** before major releases
3. **Use specific test categories** for focused debugging
4. **Monitor test results** for performance regressions
5. **Review error logs** for detailed failure analysis

### Test Development
1. **Follow existing patterns** for consistency
2. **Use proper exit codes** based on actual CLI behavior
3. **Include timeout handling** for network operations
4. **Provide detailed descriptions** for each test case
5. **Generate comprehensive reports** with metrics

### Debugging Failed Tests
1. **Check individual test logs** for detailed error information
2. **Verify binary paths** and CLI availability
3. **Confirm network connectivity** to relay servers
4. **Review timeout settings** for slow operations
5. **Use cleanup scripts** to reset test environment

## Configuration Files

- **test-config.sh** - Central configuration for all tests
- **lib/compat.sh** - Cross-platform compatibility utilities
- **cleanup-connections.sh** - Environment cleanup utilities

## Integration with CI/CD

The test suite is designed for both local development and CI/CD integration:

- **Automated test execution** with configurable parameters
- **JUnit XML output** for CI/CD integration
- **Performance regression detection** with baseline comparison
- **Parallel test execution** for faster feedback
- **Environment-specific configuration** for different deployment targets

This comprehensive test suite ensures the quadra-a relay system is robust, secure, and performant across all supported scenarios and edge cases.