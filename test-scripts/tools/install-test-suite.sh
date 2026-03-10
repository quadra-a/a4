#!/bin/bash

# quadra-a Relay Test Suite Installer
# Installs and configures the complete testing environment
# Usage: ./install-test-suite.sh [options]

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.quadra-a-test-suite}"
VERSION="1.0.0"

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

# Installation options
INSTALL_DEPENDENCIES=true
CREATE_SYMLINKS=true
SETUP_ALIASES=true
INSTALL_COMPLETIONS=true
CONFIGURE_ENVIRONMENT=true

# Parse command line options
parse_options() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --no-deps)
                INSTALL_DEPENDENCIES=false
                shift
                ;;
            --no-symlinks)
                CREATE_SYMLINKS=false
                shift
                ;;
            --no-aliases)
                SETUP_ALIASES=false
                shift
                ;;
            --no-completions)
                INSTALL_COMPLETIONS=false
                shift
                ;;
            --install-dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

# Show help
show_help() {
    cat << EOF
quadra-a Relay Test Suite Installer v$VERSION

Usage: $0 [options]

Options:
  --no-deps           Skip dependency installation
  --no-symlinks       Skip creating symlinks in /usr/local/bin
  --no-aliases        Skip setting up shell aliases
  --no-completions    Skip installing shell completions
  --install-dir DIR   Custom installation directory (default: ~/.highway1-test-suite)
  --help, -h          Show this help message

Examples:
  $0                                    # Full installation
  $0 --no-deps --no-symlinks          # Minimal installation
  $0 --install-dir /opt/hw1-tests     # Custom directory

The installer will:
1. Check system requirements
2. Install dependencies (if enabled)
3. Copy test scripts to installation directory
4. Create convenient symlinks and aliases
5. Set up shell completions
6. Configure environment variables

EOF
}

# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."

    local missing_deps=()

    # Check for required commands
    local required_commands=("bash" "python3" "bc" "curl" "git")
    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            missing_deps+=("$cmd")
        fi
    done

    # Check for optional but recommended commands
    local optional_commands=("jq" "nc" "timeout")
    for cmd in "${optional_commands[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            log_warning "Optional dependency missing: $cmd"
        fi
    done

    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Missing required dependencies: ${missing_deps[*]}"

        if [[ "$INSTALL_DEPENDENCIES" == "true" ]]; then
            log_info "Attempting to install missing dependencies..."
            install_dependencies "${missing_deps[@]}"
        else
            log_error "Please install missing dependencies manually"
            exit 1
        fi
    else
        log_success "All required dependencies found"
    fi

    # Check Rust and Cargo for building a4
    if command -v cargo &> /dev/null; then
        log_success "Rust/Cargo found for building a4 binary"
    else
        log_warning "Rust/Cargo not found - a4 binary must be built separately"
    fi

    # Check Node.js for relay server
    if command -v node &> /dev/null; then
        log_success "Node.js found for relay server"
    else
        log_warning "Node.js not found - relay server features may be limited"
    fi
}

# Install dependencies
install_dependencies() {
    local deps=("$@")

    log_info "Installing dependencies: ${deps[*]}"

    # Detect package manager and install
    if command -v brew &> /dev/null; then
        # macOS with Homebrew
        log_info "Using Homebrew to install dependencies..."
        for dep in "${deps[@]}"; do
            case "$dep" in
                "timeout")
                    brew install coreutils
                    ;;
                *)
                    brew install "$dep"
                    ;;
            esac
        done
    elif command -v apt-get &> /dev/null; then
        # Ubuntu/Debian
        log_info "Using apt-get to install dependencies..."
        sudo apt-get update
        for dep in "${deps[@]}"; do
            case "$dep" in
                "bc")
                    sudo apt-get install -y bc
                    ;;
                "python3")
                    sudo apt-get install -y python3
                    ;;
                "curl")
                    sudo apt-get install -y curl
                    ;;
                "git")
                    sudo apt-get install -y git
                    ;;
                "jq")
                    sudo apt-get install -y jq
                    ;;
                "nc")
                    sudo apt-get install -y netcat-openbsd
                    ;;
                "timeout")
                    sudo apt-get install -y coreutils
                    ;;
            esac
        done
    elif command -v yum &> /dev/null; then
        # CentOS/RHEL
        log_info "Using yum to install dependencies..."
        for dep in "${deps[@]}"; do
            sudo yum install -y "$dep"
        done
    else
        log_error "No supported package manager found"
        log_info "Please install dependencies manually: ${deps[*]}"
        exit 1
    fi

    log_success "Dependencies installed"
}

# Create installation directory
create_install_directory() {
    log_info "Creating installation directory: $INSTALL_DIR"

    mkdir -p "$INSTALL_DIR"/{bin,scripts,config,docs,examples}

    # Copy version information
    echo "$VERSION" > "$INSTALL_DIR/VERSION"

    log_success "Installation directory created"
}

# Copy test scripts
copy_scripts() {
    log_info "Copying test scripts..."

    # Copy all shell scripts
    cp "$SCRIPT_DIR"/*.sh "$INSTALL_DIR/scripts/"

    # Copy configuration files
    cp "$SCRIPT_DIR"/*.json "$INSTALL_DIR/config/" 2>/dev/null || true
    cp "$SCRIPT_DIR"/test-config.sh "$INSTALL_DIR/config/"

    # Copy documentation
    cp "$SCRIPT_DIR"/*.md "$INSTALL_DIR/docs/"
    cp "$SCRIPT_DIR"/Makefile.relay-tests "$INSTALL_DIR/Makefile"

    # Make scripts executable
    chmod +x "$INSTALL_DIR/scripts"/*.sh

    log_success "Scripts copied to $INSTALL_DIR"
}

# Create convenience symlinks
create_symlinks() {
    if [[ "$CREATE_SYMLINKS" != "true" ]]; then
        return 0
    fi

    log_info "Creating convenience symlinks..."

    local bin_dir="/usr/local/bin"

    # Check if we can write to /usr/local/bin
    if [[ ! -w "$bin_dir" ]]; then
        log_warning "Cannot write to $bin_dir, skipping symlinks"
        log_info "You can create symlinks manually or add $INSTALL_DIR/scripts to your PATH"
        return 0
    fi

    # Create symlinks for main test scripts
    local main_scripts=(
        "test-relay-quick.sh:a4-test-quick"
        "test-relay-comprehensive.sh:a4-test-full"
        "benchmark-relay.sh:a4-benchmark"
        "load-test-relay.sh:a4-load-test"
        "monitor-relay.sh:a4-monitor"
        "ci-test-relay.sh:a4-ci-test"
        "automate-tests.sh:a4-automate"
        "validate-test-results.sh:a4-validate"
        "generate-test-report.sh:a4-report"
    )

    for script_mapping in "${main_scripts[@]}"; do
        local script_name="${script_mapping%:*}"
        local symlink_name="${script_mapping#*:}"

        if [[ -f "$INSTALL_DIR/scripts/$script_name" ]]; then
            ln -sf "$INSTALL_DIR/scripts/$script_name" "$bin_dir/$symlink_name"
            log_success "Created symlink: $symlink_name -> $script_name"
        fi
    done

    log_success "Symlinks created in $bin_dir"
}

# Setup shell aliases
setup_aliases() {
    if [[ "$SETUP_ALIASES" != "true" ]]; then
        return 0
    fi

    log_info "Setting up shell aliases..."

    local alias_file="$INSTALL_DIR/aliases.sh"

    cat > "$alias_file" << EOF
#!/bin/bash
# quadra-a Relay Test Suite Aliases
# Source this file in your shell profile: source $alias_file

# Quick aliases for common test operations
alias a4-quick='$INSTALL_DIR/scripts/test-relay-quick.sh'
alias a4-full='$INSTALL_DIR/scripts/test-relay-comprehensive.sh'
alias a4-bench='$INSTALL_DIR/scripts/benchmark-relay.sh'
alias a4-load='$INSTALL_DIR/scripts/load-test-relay.sh'
alias a4-monitor='$INSTALL_DIR/scripts/monitor-relay.sh'
alias a4-ci='$INSTALL_DIR/scripts/ci-test-relay.sh'
alias a4-validate='$INSTALL_DIR/scripts/validate-test-results.sh'
alias a4-report='$INSTALL_DIR/scripts/generate-test-report.sh'

# Environment shortcuts
alias a4-env-setup='$INSTALL_DIR/scripts/setup-test-env.sh'
alias a4-env-start='$INSTALL_DIR/scripts/setup-test-env.sh start'
alias a4-env-stop='$INSTALL_DIR/scripts/setup-test-env.sh stop'
alias a4-env-status='$INSTALL_DIR/scripts/setup-test-env.sh status'

# Utility functions
a4-test() {
    local relay_url="\${1:-ws://relay-sg-1.quadra-a.com:8080}"
    local binary="\${2:-./rust/cli-rs/target/release/a4}"
    echo "Testing relay: \$relay_url"
    $INSTALL_DIR/scripts/test-relay-quick.sh "\$relay_url" "\$binary"
}

a4-stress() {
    local scenario="\${1:-default}"
    local relay_url="\${2:-ws://relay-sg-1.quadra-a.com:8080}"
    local binary="\${3:-./rust/cli-rs/target/release/a4}"
    echo "Running stress test scenario: \$scenario"
    $INSTALL_DIR/scripts/stress-test-relay.sh "\$relay_url" "\$binary" "\$scenario"
}

a4-help() {
    echo "quadra-a Relay Test Suite Commands:"
    echo "===================================="
    echo "a4-quick          - Quick functionality test"
    echo "a4-full           - Comprehensive test suite"
    echo "a4-bench          - Performance benchmarking"
    echo "a4-load           - Load testing"
    echo "a4-monitor        - Continuous monitoring"
    echo "a4-ci             - CI-optimized tests"
    echo "a4-validate       - Compliance validation"
    echo "a4-report         - Generate HTML report"
    echo ""
    echo "Environment Management:"
    echo "a4-env-setup      - Setup test environment"
    echo "a4-env-start      - Start test relays"
    echo "a4-env-stop       - Stop test relays"
    echo "a4-env-status     - Show environment status"
    echo ""
    echo "Utility Functions:"
    echo "a4-test [relay] [binary]           - Quick test with custom params"
    echo "a4-stress [scenario] [relay] [bin] - Stress test with scenario"
    echo ""
    echo "For detailed help: a4-quick --help"
}

# Export environment variables
export HW1_TEST_SUITE_DIR="$INSTALL_DIR"
export HW1_TEST_SUITE_VERSION="$VERSION"

echo "quadra-a Relay Test Suite v$VERSION loaded"
echo "Type 'a4-help' for available commands"
EOF

    chmod +x "$alias_file"

    # Try to add to shell profile
    local shell_profile=""
    if [[ -n "$BASH_VERSION" ]]; then
        shell_profile="$HOME/.bashrc"
    elif [[ -n "$ZSH_VERSION" ]]; then
        shell_profile="$HOME/.zshrc"
    fi

    if [[ -n "$shell_profile" && -f "$shell_profile" ]]; then
        if ! grep -q "a4-test-suite" "$shell_profile"; then
            echo "" >> "$shell_profile"
            echo "# quadra-a Relay Test Suite" >> "$shell_profile"
            echo "source $alias_file" >> "$shell_profile"
            log_success "Added aliases to $shell_profile"
        else
            log_info "Aliases already present in $shell_profile"
        fi
    else
        log_warning "Could not detect shell profile"
        log_info "Add this line to your shell profile: source $alias_file"
    fi

    log_success "Shell aliases configured"
}

# Install shell completions
install_completions() {
    if [[ "$INSTALL_COMPLETIONS" != "true" ]]; then
        return 0
    fi

    log_info "Installing shell completions..."

    local completion_file="$INSTALL_DIR/completions.sh"

    cat > "$completion_file" << 'EOF'
#!/bin/bash
# quadra-a Relay Test Suite Shell Completions

_hw1_test_complete() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    # Common relay URLs
    local relay_urls="ws://relay-sg-1.quadra-a.com:8080 ws://localhost:8080 ws://relay.highway1.dev:8080"

    # Common binary paths
    local binary_paths="./rust/cli-rs/target/release/a4 ./target/release/a4 ./a4"

    case ${prev} in
        a4-quick|a4-full|a4-bench|a4-load|a4-monitor|a4-ci)
            COMPREPLY=( $(compgen -W "${relay_urls}" -- ${cur}) )
            return 0
            ;;
        a4-stress)
            local scenarios="light medium heavy extreme endurance burst default"
            COMPREPLY=( $(compgen -W "${scenarios}" -- ${cur}) )
            return 0
            ;;
        a4-validate)
            local standards="highway1-basic highway1-production enterprise"
            COMPREPLY=( $(compgen -W "${standards}" -- ${cur}) )
            return 0
            ;;
    esac

    # Default completion for files and directories
    COMPREPLY=( $(compgen -f -- ${cur}) )
}

# Register completions
complete -F _hw1_test_complete a4-quick
complete -F _hw1_test_complete a4-full
complete -F _hw1_test_complete a4-bench
complete -F _hw1_test_complete a4-load
complete -F _hw1_test_complete a4-monitor
complete -F _hw1_test_complete a4-ci
complete -F _hw1_test_complete a4-stress
complete -F _hw1_test_complete a4-validate
complete -F _hw1_test_complete a4-test
EOF

    chmod +x "$completion_file"

    # Add to bash completion directory if available
    local completion_dir="/usr/local/etc/bash_completion.d"
    if [[ -d "$completion_dir" && -w "$completion_dir" ]]; then
        cp "$completion_file" "$completion_dir/a4-test-suite"
        log_success "Installed system-wide bash completions"
    else
        log_info "Add this to your shell profile for completions: source $completion_file"
    fi

    log_success "Shell completions configured"
}

# Configure environment
configure_environment() {
    if [[ "$CONFIGURE_ENVIRONMENT" != "true" ]]; then
        return 0
    fi

    log_info "Configuring environment..."

    # Create environment configuration
    local env_file="$INSTALL_DIR/environment.sh"

    cat > "$env_file" << EOF
#!/bin/bash
# quadra-a Relay Test Suite Environment Configuration

# Installation paths
export A4_TEST_SUITE_DIR="$INSTALL_DIR"
export A4_TEST_SUITE_VERSION="$VERSION"

# Default configuration
export A4_DEFAULT_RELAY="ws://relay-sg-1.quadra-a.com:8080"
export A4_DEFAULT_BINARY="./rust/cli-rs/target/release/a4"
export A4_TEST_TIMEOUT="300"
export A4_TEST_RETRIES="3"

# Result directories
export A4_TEST_RESULTS_DIR="./test-results"
export A4_BENCHMARK_RESULTS_DIR="./benchmark-results"
export A4_LOAD_TEST_RESULTS_DIR="./load-test-results"

# Add scripts to PATH
export PATH="$INSTALL_DIR/scripts:\$PATH"

# Logging configuration
export A4_LOG_LEVEL="INFO"
export A4_LOG_COLOR="true"

# Performance thresholds
export A4_MAX_DISCOVERY_TIME="1000"
export A4_MAX_MESSAGE_TIME="2000"
export A4_MIN_THROUGHPUT="10"

echo "quadra-a Test Suite environment configured"
EOF

    chmod +x "$env_file"

    log_success "Environment configuration created: $env_file"
}

# Create example configurations
create_examples() {
    log_info "Creating example configurations..."

    # Example automation config
    cat > "$INSTALL_DIR/examples/automation-config-example.json" << 'EOF'
{
  "pipeline": {
    "name": "Example Test Pipeline",
    "version": "1.0.0",
    "timeout": 1800,
    "parallel_jobs": 2,
    "retry_attempts": 2,
    "fail_fast": false
  },
  "environment": {
    "relay_url": "ws://localhost:8080",
    "a4_binary": "./a4",
    "build_required": true,
    "cleanup_after": true
  },
  "test_stages": [
    {
      "name": "quick_test",
      "description": "Quick functionality validation",
      "enabled": true,
      "timeout": 120,
      "commands": [
        "./scripts/test-relay-quick.sh"
      ]
    },
    {
      "name": "performance_test",
      "description": "Performance benchmarking",
      "enabled": true,
      "timeout": 300,
      "commands": [
        "./scripts/benchmark-relay.sh"
      ]
    }
  ],
  "notifications": {
    "enabled": false,
    "slack_webhook": "",
    "discord_webhook": ""
  },
  "artifacts": {
    "collect_logs": true,
    "generate_report": true,
    "archive_results": true,
    "retention_days": 7
  }
}
EOF

    # Example test configuration
    cat > "$INSTALL_DIR/examples/test-config-example.sh" << 'EOF'
#!/bin/bash
# Example Test Configuration

# Relay endpoints
PRODUCTION_RELAY="ws://relay-sg-1.quadra-a.com:8080"
STAGING_RELAY="ws://staging.relay-sg-1.quadra-a.com:8080"
LOCAL_RELAY="ws://localhost:8080"

# Binary paths
RELEASE_BINARY="./rust/cli-rs/target/release/a4"
DEBUG_BINARY="./rust/cli-rs/target/debug/a4"

# Test parameters
QUICK_TEST_TIMEOUT=60
COMPREHENSIVE_TEST_TIMEOUT=600
LOAD_TEST_DURATION=300

# Performance thresholds
MAX_DISCOVERY_LATENCY=500
MAX_MESSAGE_LATENCY=1000
MIN_THROUGHPUT=50

# Stress test scenarios
declare -A CUSTOM_SCENARIOS
CUSTOM_SCENARIOS[light]="connections:5,duration:30,rate:2,payload:100"
CUSTOM_SCENARIOS[production]="connections:50,duration:300,rate:25,payload:2000"
EOF

    # Example Docker compose for test environment
    cat > "$INSTALL_DIR/examples/docker-compose.yml" << 'EOF'
version: '3.8'

services:
  relay-primary:
    image: highway1/relay:latest
    ports:
      - "8080:8080"
    environment:
      - RELAY_PORT=8080
      - RELAY_NAME=Primary Test Relay
    volumes:
      - ./relay-data:/data

  relay-backup:
    image: highway1/relay:latest
    ports:
      - "8081:8080"
    environment:
      - RELAY_PORT=8080
      - RELAY_NAME=Backup Test Relay
    volumes:
      - ./relay-backup-data:/data

  test-runner:
    image: highway1/test-suite:latest
    depends_on:
      - relay-primary
      - relay-backup
    environment:
      - HW1_RELAY_URL=ws://relay-primary:8080
      - HW1_BACKUP_RELAY=ws://relay-backup:8080
      - A4_BINARY=./a4
    volumes:
      - ./test-results:/app/test-results
    command: ["./scripts/run-all-tests.sh"]
EOF

    # Example GitHub Actions workflow
    cat > "$INSTALL_DIR/examples/github-actions.yml" << 'EOF'
name: quadra-a Relay Tests

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        test-type: [quick, comprehensive, performance]

    steps:
    - uses: actions/checkout@v3

    - name: Setup Rust
      uses: actions-rs/toolchain@v1
      with:
        toolchain: stable
        override: true

    - name: Build a4 binary
      run: |
        cd rust/cli-rs
        cargo build --release

    - name: Install test dependencies
      run: |
        sudo apt-get update
        sudo apt-get install -y python3 bc jq netcat-openbsd

    - name: Run tests
      run: |
        case "${{ matrix.test-type }}" in
          quick)
            ./scripts/test-relay-quick.sh
            ;;
          comprehensive)
            ./scripts/test-relay-comprehensive.sh
            ;;
          performance)
            ./scripts/benchmark-relay.sh
            ;;
        esac

    - name: Upload test results
      uses: actions/upload-artifact@v3
      if: always()
      with:
        name: test-results-${{ matrix.test-type }}
        path: |
          ./test-results/
          ./benchmark-results/
          ./ci-test-results/

    - name: Generate test report
      if: matrix.test-type == 'comprehensive'
      run: ./scripts/generate-test-report.sh

    - name: Upload test report
      uses: actions/upload-artifact@v3
      if: matrix.test-type == 'comprehensive'
      with:
        name: test-report
        path: ./test-report.html
EOF

    log_success "Example configurations created in $INSTALL_DIR/examples/"
}

# Generate installation summary
generate_summary() {
    local summary_file="$INSTALL_DIR/INSTALLATION_SUMMARY.md"

    cat > "$summary_file" << EOF
# quadra-a Relay Test Suite Installation Summary

## Installation Details
- **Version**: $VERSION
- **Installation Date**: $(date)
- **Installation Directory**: $INSTALL_DIR
- **System**: $(uname -a)

## Installed Components

### Scripts
- All test scripts installed in: \`$INSTALL_DIR/scripts/\`
- Main test scripts:
  - \`test-relay-quick.sh\` - Quick functionality tests
  - \`test-relay-comprehensive.sh\` - Full test suite
  - \`benchmark-relay.sh\` - Performance benchmarking
  - \`load-test-relay.sh\` - Load testing
  - \`monitor-relay.sh\` - Continuous monitoring
  - \`ci-test-relay.sh\` - CI-optimized tests
  - \`automate-tests.sh\` - Automation pipeline
  - \`validate-test-results.sh\` - Compliance validation
  - \`generate-test-report.sh\` - HTML report generation

### Configuration
- Configuration files: \`$INSTALL_DIR/config/\`
- Environment setup: \`$INSTALL_DIR/environment.sh\`
- Shell aliases: \`$INSTALL_DIR/aliases.sh\`
- Shell completions: \`$INSTALL_DIR/completions.sh\`

### Documentation
- Complete documentation: \`$INSTALL_DIR/docs/\`
- Testing guide: \`$INSTALL_DIR/docs/TESTING_GUIDE.md\`
- Examples: \`$INSTALL_DIR/examples/\`

## Quick Start

### 1. Load Environment
\`\`\`bash
source $INSTALL_DIR/aliases.sh
source $INSTALL_DIR/environment.sh
\`\`\`

### 2. Run Quick Test
\`\`\`bash
hw1-quick
# or
$INSTALL_DIR/scripts/test-relay-quick.sh
\`\`\`

### 3. Run Full Test Suite
\`\`\`bash
hw1-full
# or
$INSTALL_DIR/scripts/test-relay-comprehensive.sh
\`\`\`

### 4. Performance Benchmarking
\`\`\`bash
hw1-bench
# or
$INSTALL_DIR/scripts/benchmark-relay.sh
\`\`\`

## Available Commands
$(if [[ "$SETUP_ALIASES" == "true" ]]; then
cat << 'ALIASES'

### Shell Aliases (if configured)
- \`a4-quick\` - Quick functionality test
- \`a4-full\` - Comprehensive test suite
- \`a4-bench\` - Performance benchmarking
- \`a4-load\` - Load testing
- \`a4-monitor\` - Continuous monitoring
- \`a4-ci\` - CI-optimized tests
- \`a4-validate\` - Compliance validation
- \`a4-report\` - Generate HTML report
- \`a4-help\` - Show available commands

### Utility Functions
- \`a4-test [relay] [binary]\` - Quick test with custom parameters
- \`a4-stress [scenario] [relay] [binary]\` - Stress test with scenario

ALIASES
fi)

$(if [[ "$CREATE_SYMLINKS" == "true" ]]; then
cat << 'SYMLINKS'

### System Symlinks (if created)
- \`a4-test-quick\` - Quick functionality test
- \`a4-test-full\` - Comprehensive test suite
- \`a4-benchmark\` - Performance benchmarking
- \`a4-load-test\` - Load testing
- \`a4-monitor\` - Continuous monitoring
- \`a4-ci-test\` - CI-optimized tests
- \`a4-automate\` - Automation pipeline
- \`a4-validate\` - Compliance validation
- \`a4-report\` - Generate HTML report

SYMLINKS
fi)

## Configuration

### Environment Variables
- \`A4_TEST_SUITE_DIR\`: $INSTALL_DIR
- \`A4_TEST_SUITE_VERSION\`: $VERSION
- \`A4_DEFAULT_RELAY\`: ws://relay-sg-1.quadra-a.com:8080
- \`A4_DEFAULT_BINARY\`: ./rust/cli-rs/target/release/a4

### Customization
Edit configuration files in \`$INSTALL_DIR/config/\` to customize:
- Default relay URLs
- Test parameters
- Timeout settings
- Performance thresholds

## Examples
See \`$INSTALL_DIR/examples/\` for:
- Automation pipeline configurations
- Docker Compose setups
- GitHub Actions workflows
- Custom test configurations

## Troubleshooting

### Common Issues
1. **Scripts not executable**: Run \`chmod +x $INSTALL_DIR/scripts/*.sh\`
2. **Missing dependencies**: Run the installer with \`--no-deps\` flag and install manually
3. **Permission errors**: Check write permissions for installation directory

### Getting Help
- Run \`a4-help\` for available commands
- Check \`$INSTALL_DIR/docs/TESTING_GUIDE.md\` for detailed documentation
- View script help: \`$INSTALL_DIR/scripts/test-relay-quick.sh --help\`

## Uninstallation
To remove the test suite:
\`\`\`bash
rm -rf $INSTALL_DIR
# Remove symlinks if created
sudo rm -f /usr/local/bin/a4-*
# Remove aliases from shell profile manually
\`\`\`

---
Generated by quadra-a Relay Test Suite Installer v$VERSION
EOF

    log_success "Installation summary created: $summary_file"
}

# Main installation function
main() {
    echo "=================================================="
    echo "quadra-a Relay Test Suite Installer v$VERSION"
    echo "=================================================="
    echo "Installation Directory: $INSTALL_DIR"
    echo "=================================================="

    # Parse options
    parse_options "$@"

    # Check requirements
    check_requirements

    # Create installation directory
    create_install_directory

    # Copy scripts and files
    copy_scripts

    # Create symlinks
    create_symlinks

    # Setup aliases
    setup_aliases

    # Install completions
    install_completions

    # Configure environment
    configure_environment

    # Create examples
    create_examples

    # Generate summary
    generate_summary

    echo "=================================================="
    echo "INSTALLATION COMPLETE"
    echo "=================================================="
    log_success "quadra-a Relay Test Suite v$VERSION installed successfully!"
    echo ""
    echo "Installation Directory: $INSTALL_DIR"
    echo "Documentation: $INSTALL_DIR/docs/"
    echo "Examples: $INSTALL_DIR/examples/"
    echo "Summary: $INSTALL_DIR/INSTALLATION_SUMMARY.md"
    echo ""

    if [[ "$SETUP_ALIASES" == "true" ]]; then
        echo "To use shell aliases, run:"
        echo "  source $INSTALL_DIR/aliases.sh"
        echo ""
    fi

    echo "Quick start:"
    echo "  $INSTALL_DIR/scripts/test-relay-quick.sh"
    echo ""
    echo "For help:"
    echo "  $INSTALL_DIR/scripts/test-relay-quick.sh --help"
    echo "=================================================="
}

# Run main function
main "$@"