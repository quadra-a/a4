# quadra-a Relay Testing Suite - Dual CLI Support

This directory contains comprehensive testing scripts for the quadra-a relay implementation with support for both Rust and TypeScript CLIs.

## Test Scripts Overview

### 🔐 E2E Encryption Assets
- **`e2e/README.md`** - Current E2E harness surface, artifact layout, and remaining gaps
- **`e2e/TEST_MATRIX.yaml`** - Shared JS/Rust/relay/real-machine scenario catalog
- **`e2e/test-e2e-cross-lang.sh`** - Executable JS↔Rust artifact interoperability harness for `E2E-CROSS-001`, `E2E-CROSS-002`, `E2E-CROSS-006`, federated delivery `E2E-FED-001`, and relay-backed offline delivery `E2E-CROSS-005`
- **`e2e/test-e2e-negative.sh`** - Live local-relay negative-security harness for `E2E-NEG-001` through `E2E-NEG-008`, covering forged sender-device binding rejection, sender-side invalid signed-prekey rejection, replay/tamper/plaintext rejection, and stale signed-prekey bootstrap rejection across JS and Rust paths
- **`e2e/REAL_MACHINE_FULL_CHAIN_TEST.md`** - Full live-environment chain validation plan
- **`e2e/test-e2e-real-machine.sh`** - Real-machine artifact harness for retained run directories, version capture, plaintext scans, and completeness checks
- **`e2e/vectors/README.md`** - Shared vector fixture contract
- **`e2e/vectors/schema.json`** - Schema for fixture manifests

### 🚀 Quick Tests
- **`test-relay-quick.sh`** - Essential functionality validation (5 tests per CLI, ~30 seconds)
- **`test-discovery-card-signatures.sh`** - Regression suite for client-side `DISCOVERED` / `CARD` signature verification
- **`test-quick-agent-groups.sh`** - Overlay smoke test for Quick Agent Groups on a local public relay
- **`test-relay-deployment.sh`** - Real local deployment validation for startup, federation admission, and quarantine behavior
- **`run-core-tests.sh`** - Core test suite (quick, comprehensive, benchmark, load tests)
- **`run-all-tests.sh`** - Complete test suite, including local deployment validation when supported
- **`test-dual-cli.sh`** - Side-by-side compatibility testing between CLIs (removed)

### 🔍 Comprehensive Tests
- **`test-relay-comprehensive.sh`** - Full functionality test suite (60+ tests per CLI, ~5 minutes)
- **`benchmark-relay.sh`** - Performance benchmarking and metrics
- **`load-test-relay.sh`** - Stress testing and load scenarios

### ⚙️ Configuration
- **`test-config.sh`** - Shared configuration with CLI selection and path management

## CLI Support

All test scripts now support both implementations:
- **Rust CLI** (`rust/cli-rs`) - Static binary, fast startup
- **TypeScript CLI** (`js/cli`) - Node.js based, full feature parity

### CLI Mode Selection

```bash
# Test only Rust CLI
./test-relay-quick.sh ws://relay-sg-1.quadra-a.com:8080 rust

# Test only TypeScript CLI
./test-relay-quick.sh ws://relay-sg-1.quadra-a.com:8080 node

# Test both CLIs (default)
./test-relay-quick.sh ws://relay-sg-1.quadra-a.com:8080 both
```

## Usage

### Quick Validation
```bash
# Test basic relay functionality with both CLIs
./test-relay-quick.sh

# Validate Quick Agent Groups overlay behavior on a local public relay
./test-quick-agent-groups.sh

# Validate client-side discovery card signature verification
./test-discovery-card-signatures.sh

# With custom relay URL
./test-relay-quick.sh ws://your-relay.com:8080

# Test specific CLI only
./test-relay-quick.sh ws://relay-sg-1.quadra-a.com:8080 rust
```

### Comprehensive Testing
```bash
# Full test suite, including system-level deployment validation when supported (recommended)
./run-all-tests.sh

# Core tests only (quick, comprehensive, benchmark, load)
./run-core-tests.sh

# All test categories with master runner
./run-master-tests.sh both

# Test only one CLI implementation
./run-all-tests.sh node
```

### JavaScript Workspace Validation
```bash
# Run the non-watch JS package suite with per-step logs
./run-js-workspace-tests.sh

# Stop on the first failure
./run-js-workspace-tests.sh --fail-fast
```

When local socket binds are blocked by the environment, the runner skips `relay tests` outside CI and still records the skip in the summary.

### Dual CLI Compatibility
```bash
# Cross-CLI compatibility is now integrated into run-all-tests.sh
./run-all-tests.sh both

# Force the full suite to include local deployment validation
DEPLOYMENT_TEST_MODE=always ./run-all-tests.sh both

# Generates compatibility matrix showing:
# - Command output comparison across CLIs
# - Feature parity verification
# - Performance differences between implementations
```

`run-all-tests.sh` now includes `test-relay-deployment.sh` as a system-level stage. By default, `DEPLOYMENT_TEST_MODE=auto` runs it when local port binds are available and skips it otherwise. Use `DEPLOYMENT_TEST_MODE=never` to disable it explicitly.

### Performance Testing
```bash
# Performance benchmarks (both CLIs)
./benchmark-relay.sh

# Load testing with CLI selection
./load-test-relay.sh ws://relay-sg-1.quadra-a.com:8080 both 120
```

### Deployment Validation
```bash
# Build js/relay and run smoke + federation + quarantine deployment checks
./test-relay-deployment.sh

# Reuse current dist/ and run only the two-relay federation check
./test-relay-deployment.sh federation --skip-build --base-port 9500
```

### Quick Agent Groups Overlay Validation
```bash
# Build protocol/runtime/relay dist and validate overlay discovery + messaging filters
./test-quick-agent-groups.sh

# Reuse current dist/ and emit JSON only
./test-quick-agent-groups.sh --skip-build --json
```

- `test-quick-agent-groups.sh` validates the client-side Quick Agent Groups overlay described alongside CVP-0015.
- It runs on a normal public relay and checks joined-member discovery, joined-member delivery, and non-member message filtering.

### Deployment Harness Components
- `test-relay-deployment.sh` orchestrates local relay startup, teardown, and scenario selection.
- `lib/relay-deployment.sh` provides reusable logging, process cleanup, log-waiting, and JSON summary helpers.
- `tools/relay-deployment-probe.mjs` provides reusable `federation`, `quarantine`, and `summary` probes for local relay deployments.

```bash
# Run the reusable federation probe directly against two live relays
node --experimental-strip-types ./tools/relay-deployment-probe.mjs federation \
  --relay-dir ../js/relay \
  --endpoint-a ws://127.0.0.1:9500 \
  --endpoint-b ws://127.0.0.1:9501
```

## CLI Detection & Auto-Configuration

The scripts automatically detect available CLIs in this priority order:

### TypeScript CLI Detection
1. **`./js/cli/a4`** (direct built binary)
2. **`pnpm --filter -a/cli exec a4`** (if pnpm + package.json available)
3. **`npx -a/cli`** (if npx available)
4. **`a4`** (if globally installed)

### Rust CLI Detection
1. **Custom binary path** (if provided as parameter)
2. **`./rust/target/release/a4`** (release build)
3. **`./rust/target/debug/a4`** (debug build)

### Build Requirements

```bash
# Rust CLI
cd rust/cli-rs
cargo build --release

# TypeScript CLI
cd js
pnpm install
pnpm build
```

## Test Categories

### 🔍 Discovery Tests (10 tests per CLI)
- Basic discovery functionality
- Query-based search (WebSocket, relay, routes messages, etc.)
- Empty and non-existent queries
- Discovery with limits
- Client-side filtering of invalid or tampered Agent Card signatures
- **NEW**: Cross-CLI result consistency verification

### 📨 Messaging Tests (25+ tests per CLI)
- Basic message sending with CLI identification
- Custom protocols and payloads
- JSON payload handling
- Message delivery confirmation
- **NEW**: CLI-specific message tagging for traceability

### 🌐 Unicode & Special Characters (5 tests per CLI)
- Unicode messages (Chinese, emoji, special chars)
- Unicode protocol names
- Control character handling
- **NEW**: Cross-CLI encoding consistency

### 📊 Payload Size Tests (8 tests per CLI)
- Small payloads (1KB) with CLI metadata
- Medium payloads (10KB)
- Large payloads (50KB)
- Massive payloads (100KB+)
- Large arrays (1000+ elements)
- Binary data (base64 encoded)
- **NEW**: Performance comparison between CLIs

### ⚡ Performance Tests (15 tests per CLI)
- Sequential throughput (5, 10, 20, 50, 100 messages)
- Concurrent operations (3, 5, 10, 20, 50 parallel)
- Message latency measurements
- Discovery performance
- **NEW**: CLI startup time comparison

### 🔧 Edge Cases & Error Handling (12 tests per CLI)
- Invalid DIDs and relay URLs
- Malformed protocols and payloads
- Empty/null values
- Connection error scenarios
- Invalid message types
- **NEW**: Error message consistency verification

### 🔄 Daemon Management (5 tests per CLI)
- Status monitoring
- Connection persistence
- Inbox functionality
- Join operations
- **NEW**: Cross-CLI daemon compatibility

### 🤝 Compatibility Tests (NEW)
- Side-by-side command execution
- Output format comparison
- Feature parity verification
- Performance benchmarking
- Error handling consistency

## Test Results

### Output Formats
- **Console**: Colored output with CLI identification and pass/fail indicators
- **Log Files**: Detailed execution logs in `./test-output/logs/` with CLI mode timestamps
- **Reports**: Structured performance and compatibility reports in `./test-output/reports/`
- **Compatibility Matrix**: Side-by-side CLI comparison tables

### Success Criteria
- ✅ **Discovery**: All queries return expected results (both CLIs)
- ✅ **Messaging**: 100% delivery success rate (both CLIs)
- ✅ **Performance**: <1s discovery, <5s message delivery (both CLIs)
- ✅ **Throughput**: >10 msg/s sequential, concurrent operations successful
- ✅ **Stability**: No crashes or connection failures
- ✅ **Edge Cases**: Graceful error handling
- ✅ **Compatibility**: Consistent behavior between Rust and TypeScript CLIs

## Example Test Runs

### Quick Test with Both CLIs
```bash
$ ./scripts/test-relay-quick.sh ws://hw1.woowot.com:8080 both
==================================================
Highway 1 Relay Quick Test
==================================================
Relay: ws://hw1.woowot.com:8080
CLI Mode: both
CLIs to test: 2
  1. ./target/release/a4
  2. pnpm --filter -a/cli exec a4
==================================================

==================================================
Testing with Rust CLI: ./target/release/a4
==================================================
[INFO] [Rust CLI] Testing basic discovery...
[PASS] [Rust CLI] Discovery working
[INFO] [Rust CLI] Testing daemon status...
[PASS] [Rust CLI] Daemon running
[INFO] [Rust CLI] Testing basic message send...
[PASS] [Rust CLI] Message delivery working
[INFO] [Rust CLI] Testing large payload (1KB)...
[PASS] [Rust CLI] Large payload working
[INFO] [Rust CLI] Testing concurrent messages (5 parallel)...
[PASS] [Rust CLI] Concurrent messages completed

==================================================
Testing with TypeScript CLI (pnpm): pnpm --filter -a/cli exec a4
==================================================
[INFO] [TypeScript CLI (pnpm)] Testing basic discovery...
[PASS] [TypeScript CLI (pnpm)] Discovery working
[INFO] [TypeScript CLI (pnpm)] Testing daemon status...
[PASS] [TypeScript CLI (pnpm)] Daemon running
[INFO] [TypeScript CLI (pnpm)] Testing basic message send...
[PASS] [TypeScript CLI (pnpm)] Message delivery working
[INFO] [TypeScript CLI (pnpm)] Testing large payload (1KB)...
[PASS] [TypeScript CLI (pnpm)] Large payload working
[INFO] [TypeScript CLI (pnpm)] Testing concurrent messages (5 parallel)...
[PASS] [TypeScript CLI (pnpm)] Concurrent messages completed

==================================================
✅ All quick tests passed for all CLIs! Relay is functional.
==================================================
```

### Dual CLI Compatibility Test
```bash
$ ./scripts/test-dual-cli.sh
==================================================
Highway 1 Dual CLI Compatibility Test
==================================================
Relay: ws://hw1.woowot.com:8080
Test DID: did:clawiverse:zEdBLpMmRs194XSNKbJou31fwpvTzRz37HuDm6VpXQLkK
==================================================

Running compatibility tests...
==================================================
  Test                           | Rust CLI             | TypeScript CLI
==================================================
  Help Command                   | ✓                    | ✓
[PASS] Compatible: both CLIs passed
  Version Command                | ✓                    | ✓
[PASS] Compatible: both CLIs passed
  Status Command                 | ✓                    | ✓
[PASS] Compatible: both CLIs passed
  Basic Discovery                | ✓                    | ✓
[PASS] Compatible: both CLIs passed
  Basic Message Send             | ✓                    | ✓
[PASS] Compatible: both CLIs passed
  Unicode Message                | ✓                    | ✓
[PASS] Compatible: both CLIs passed
==================================================

Compatibility Test Summary:
==================================================
✓ Rust CLI available: ./target/release/a4
✓ TypeScript CLI available: pnpm --filter -a/cli exec a4
ℹ Both CLIs available - compatibility testing completed

Key compatibility notes:
• Both CLIs should produce similar output formats
• Message delivery should work identically
• Discovery results should be consistent
• Error handling should be similar
==================================================
✅ Dual CLI compatibility test completed
==================================================
```

## Performance Benchmarks

The benchmark script measures both CLIs:
- **Discovery latency** (typical: <200ms, both CLIs)
- **Message delivery time** (typical: <1000ms, both CLIs)
- **Throughput rates** (typical: >50 msg/s, Rust CLI ~10% faster)
- **Payload size limits** (tested up to 100KB+, both CLIs)
- **Concurrent connection capacity** (tested up to 50 parallel, both CLIs)
- **Startup time** (Rust CLI: <100ms, TypeScript CLI: <2000ms)

## Load Testing

The load test script simulates with both CLIs:
- **Sustained messaging** (5-50 msg/s for extended periods)
- **Burst scenarios** (10-50 messages in rapid succession)
- **Connection stress** (up to 100 concurrent connections)
- **Discovery load** (rapid query sequences)
- **CLI switching** (alternating between implementations)

## Prerequisites

### For Rust CLI Testing
- **Rust 1.93+** and **Cargo**
- **Built binary**: `cd packages/cli-rs && cargo build --release`

### For TypeScript CLI Testing
- **Node.js 22+** and **pnpm 9+**
- **Built package**: `pnpm install && pnpm build`

### System Requirements
- **python3** (for payload generation)
- **bc** (calculator, for throughput calculations)
- **timeout** command (for connection tests)
- **bash 4.0+** (for array operations)

## Configuration

Edit `test-config.sh` to customize:

```bash
# CLI selection (rust|node|both)
CLI_MODE="${CLI_MODE:-both}"

# Binary paths - Rust CLI
DEFAULT_A4_BINARY="./target/release/a4"
DEBUG_A4_BINARY="./target/debug/a4"

# TypeScript CLI paths
NODE_CLI_PNPM="pnpm --filter -a/cli exec a4"
NODE_CLI_NPX="npx -a/cli"
NODE_CLI_GLOBAL="a4"

# Test parameters
SMALL_PAYLOAD_SIZE=1000      # 1KB
MEDIUM_PAYLOAD_SIZE=10000    # 10KB
LARGE_PAYLOAD_SIZE=50000     # 50KB

# Performance thresholds
MAX_DISCOVERY_TIME_MS=1000
MAX_MESSAGE_TIME_MS=5000
MIN_THROUGHPUT_MSG_PER_SEC=10
```

## Environment Variables

Set these in your environment:

```bash
# CLI mode selection
export CLI_MODE=both  # rust|node|both

# Custom binary paths
export DEFAULT_A4_BINARY="./target/release/a4"
export NODE_CLI_PNPM="pnpm --filter -a/cli exec a4"

# Test parameters
export RELAY_URL="ws://hw1.woowot.com:8080"
export TEST_DID="did:clawiverse:zEdBLpMmRs194XSNKbJou31fwpvTzRz37HuDm6VpXQLkK"
```

## Troubleshooting

### Common Issues

1. **CLI Not Found**
   ```bash
   # Build Rust CLI
   cd packages/cli-rs && cargo build --release

   # Build TypeScript CLI
   pnpm install && pnpm build

   # Check CLI availability
   ./scripts/test-config.sh  # Shows detected CLIs
   ```

2. **Permission Denied**
   ```bash
   chmod +x scripts/*.sh
   ```

3. **Python Not Found**
   ```bash
   # Install Python 3
   brew install python3  # macOS
   apt-get install python3  # Ubuntu
   yum install python3  # CentOS/RHEL
   ```

4. **Relay Connection Failed**
   - Check relay URL is accessible: `curl -I ws://hw1.woowot.com:8080`
   - Verify relay server is running
   - Test with WebSocket client: `wscat -c ws://hw1.woowot.com:8080`
   - Check firewall/proxy settings

5. **CLI Build Issues**
   ```bash
   # Rust CLI build problems
   cd packages/cli-rs
   cargo clean && cargo build --release

   # TypeScript CLI build problems
   pnpm clean && pnpm install && pnpm build
   ```

6. **Compatibility Test Failures**
   - Ensure both CLIs are built and up-to-date
   - Check for version mismatches between implementations
   - Review individual CLI logs for specific errors

### Debug Mode

Run individual tests with verbose output:
```bash
# Enable bash debug mode
bash -x ./test-relay-quick.sh ws://hw1.woowot.com:8080 both

# Check CLI detection
CLI_MODE=both ./scripts/test-config.sh

# Test specific CLI only
./scripts/test-relay-quick.sh ws://hw1.woowot.com:8080 rust
```

### Log Analysis

Test results are saved with detailed logging:
```bash
# View recent test logs
ls -la ./test-output/logs/

# Check specific CLI test results
grep -r "FAIL\|ERROR" ./test-output/results/

# Compare CLI outputs
diff ./test-output/results/test-relay-quick_rust_*.log ./test-output/results/test-relay-quick_node_*.log
```

## Integration with CI/CD

The test scripts are designed for automation with dual CLI support:

### GitHub Actions Example
```yaml
name: Highway 1 Relay Tests

on: [push, pull_request]

jobs:
  test-rust-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - name: Build Rust CLI
        run: |
          cd packages/cli-rs
          cargo build --release
      - name: Test Rust CLI
        run: ./scripts/run-all-tests.sh rust

  test-typescript-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - name: Build TypeScript CLI
        run: |
          pnpm install
          pnpm build
      - name: Test TypeScript CLI
        run: ./scripts/run-all-tests.sh node

  test-compatibility:
    runs-on: ubuntu-latest
    needs: [test-rust-cli, test-typescript-cli]
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - name: Build Both CLIs
        run: |
          cd packages/cli-rs && cargo build --release && cd ../..
          pnpm install && pnpm build
      - name: Test CLI Compatibility
        run: ./scripts/test-dual-cli.sh
      - name: Run Full Test Suite
        run: ./scripts/run-all-tests.sh both
      - name: Upload Test Results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: ./test-output/
```

### Docker Integration
```dockerfile
# Multi-stage build for both CLIs
FROM rust:1.93 as rust-builder
WORKDIR /app
COPY packages/cli-rs ./packages/cli-rs
RUN cd packages/cli-rs && cargo build --release

FROM node:22 as node-builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY packages/cli ./packages/cli
COPY packages/core ./packages/core
COPY packages/runtime ./packages/runtime
RUN corepack enable pnpm && pnpm install && pnpm build

FROM ubuntu:22.04
RUN apt-get update && apt-get install -y python3 bc timeout curl
WORKDIR /app
COPY --from=rust-builder /app/packages/cli-rs/target/release/a4 ./target/release/a4
COPY --from=node-builder /app ./
COPY scripts ./scripts
RUN chmod +x scripts/*.sh
CMD ["./scripts/run-all-tests.sh", "both"]
```

## Performance Comparison

Based on benchmark results, here are typical performance characteristics:

| Metric | Rust CLI | TypeScript CLI | Notes |
|--------|----------|----------------|-------|
| **Startup Time** | ~50ms | ~1500ms | Rust has faster cold start |
| **Discovery Latency** | ~150ms | ~180ms | Similar network performance |
| **Message Send** | ~200ms | ~220ms | Comparable delivery times |
| **Memory Usage** | ~5MB | ~25MB | Rust more memory efficient |
| **Binary Size** | ~8MB | ~50MB (with node_modules) | Rust more compact |
| **Throughput** | ~60 msg/s | ~55 msg/s | Similar sustained performance |

## CLI Feature Parity

Both CLIs implement identical functionality:

| Feature | Rust CLI | TypeScript CLI | Status |
|---------|----------|----------------|--------|
| **Core Commands** | ✅ | ✅ | Full parity |
| **Discovery** | ✅ | ✅ | Identical results |
| **Messaging** | ✅ | ✅ | Same protocols |
| **Daemon Mode** | ✅ | ✅ | Compatible |
| **Unicode Support** | ✅ | ✅ | Full UTF-8 |
| **Large Payloads** | ✅ | ✅ | Same limits |
| **Error Handling** | ✅ | ✅ | Consistent messages |
| **Output Formats** | ✅ | ✅ | JSON/Human modes |

## Contributing

When adding new tests:

1. **Update Both CLI Test Functions**
   ```bash
   # Add test to both CLI modes
   test_new_feature() {
       local a4_binary="$1"
       local cli_name="$2"

       run_test "New Feature Test" \
           "$a4_binary new-command --option" \
           "Expected Output" \
           "$cli_name"
   }
   ```

2. **Add CLI Identification**
   ```bash
   # Include CLI name in test messages
   "$a4_binary tell '$TEST_DID' 'Test from $cli_name' --relay $RELAY_URL"
   ```

3. **Include Compatibility Verification**
   ```bash
   # Add to test-dual-cli.sh
   test_compatibility "New Feature" \
       "$RUST_CLI new-command" \
       "$NODE_CLI new-command" \
       "Expected Pattern"
   ```

4. **Update Documentation**
   - Add test description to this README
   - Update test count in overview
   - Document any CLI-specific behavior

5. **Test Categories**
   - Ensure tests are idempotent
   - Can run in any order
   - Handle both CLI success and failure cases
   - Include performance considerations

## Roadmap

Future enhancements planned:

- **Cross-Platform Testing**: Windows, macOS, Linux compatibility
- **Performance Regression Detection**: Automated benchmarking with alerts
- **Load Testing Automation**: Continuous stress testing in CI
- **CLI Version Compatibility**: Testing across different CLI versions
- **Integration Testing**: End-to-end scenarios with multiple agents
- **Security Testing**: Authentication and encryption validation
- **Network Resilience**: Connection failure and recovery testing

## Support

For issues with the test suite:

1. **Check Prerequisites**: Ensure all dependencies are installed
2. **Review Logs**: Check `./test-output/logs/` for detailed error information
3. **Test Individual CLIs**: Isolate issues to specific implementations
4. **Run Compatibility Tests**: Verify both CLIs behave consistently
5. **Report Issues**: Include test logs and system information

The test suite is designed to be comprehensive, reliable, and maintainable while ensuring both CLI implementations provide identical functionality to users.
