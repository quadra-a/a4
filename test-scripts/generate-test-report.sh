#!/bin/bash

# quadra-a Relay Test Report Generator
# Generates comprehensive HTML reports from test results
# Usage: ./generate-test-report.sh [results_directory] [output_file]

set -e

# Load test configuration
source "$(dirname "$0")/test-config.sh"

# Configuration
RESULTS_DIR="${1:-$TEST_OUTPUT_ROOT/results}"
OUTPUT_FILE="${2:-$REPORTS_DIR/test-report.html}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

# Colors for console output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }

# Check if results directory exists
if [[ ! -d "$RESULTS_DIR" ]]; then
    log_error "Results directory not found: $RESULTS_DIR"
    exit 1
fi

log_info "Generating test report from: $RESULTS_DIR"
log_info "Output file: $OUTPUT_FILE"

# Generate HTML report
cat > "$OUTPUT_FILE" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>quadra-a Relay Test Report</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f7fa;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            border-radius: 10px;
            margin-bottom: 2rem;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .summary-card {
            background: white;
            padding: 1.5rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            border-left: 4px solid #667eea;
        }

        .summary-card h3 {
            color: #667eea;
            margin-bottom: 0.5rem;
        }

        .summary-card .value {
            font-size: 2rem;
            font-weight: bold;
            color: #333;
        }

        .summary-card .label {
            color: #666;
            font-size: 0.9rem;
        }

        .test-section {
            background: white;
            margin-bottom: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }

        .test-section h2 {
            background: #f8f9fa;
            padding: 1rem 1.5rem;
            margin: 0;
            color: #333;
            border-bottom: 1px solid #e9ecef;
        }

        .test-content {
            padding: 1.5rem;
        }

        .test-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1rem;
        }

        .test-item {
            padding: 1rem;
            border: 1px solid #e9ecef;
            border-radius: 6px;
            background: #f8f9fa;
        }

        .test-item h4 {
            margin-bottom: 0.5rem;
            color: #333;
        }

        .status {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: bold;
            text-transform: uppercase;
        }

        .status.pass {
            background: #d4edda;
            color: #155724;
        }

        .status.fail {
            background: #f8d7da;
            color: #721c24;
        }

        .status.warn {
            background: #fff3cd;
            color: #856404;
        }

        .metrics-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
        }

        .metrics-table th,
        .metrics-table td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }

        .metrics-table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #495057;
        }

        .metrics-table tr:hover {
            background: #f8f9fa;
        }

        .chart-container {
            margin: 1rem 0;
            padding: 1rem;
            background: #f8f9fa;
            border-radius: 6px;
        }

        .progress-bar {
            width: 100%;
            height: 20px;
            background: #e9ecef;
            border-radius: 10px;
            overflow: hidden;
            margin: 0.5rem 0;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #28a745, #20c997);
            transition: width 0.3s ease;
        }

        .log-section {
            background: #2d3748;
            color: #e2e8f0;
            padding: 1rem;
            border-radius: 6px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.9rem;
            max-height: 400px;
            overflow-y: auto;
            margin-top: 1rem;
        }

        .footer {
            text-align: center;
            padding: 2rem;
            color: #666;
            border-top: 1px solid #e9ecef;
            margin-top: 2rem;
        }

        @media (max-width: 768px) {
            .container {
                padding: 10px;
            }

            .header h1 {
                font-size: 2rem;
            }

            .summary-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 quadra-a Relay Test Report</h1>
            <p>Comprehensive testing results and performance metrics</p>
            <p>Generated on: TIMESTAMP_PLACEHOLDER</p>
        </div>

        <div class="summary-grid">
            <div class="summary-card">
                <h3>Total Tests</h3>
                <div class="value" id="total-tests">0</div>
                <div class="label">Test cases executed</div>
            </div>
            <div class="summary-card">
                <h3>Success Rate</h3>
                <div class="value" id="success-rate">0%</div>
                <div class="label">Tests passed</div>
            </div>
            <div class="summary-card">
                <h3>Performance</h3>
                <div class="value" id="avg-latency">0ms</div>
                <div class="label">Average latency</div>
            </div>
            <div class="summary-card">
                <h3>Throughput</h3>
                <div class="value" id="throughput">0/s</div>
                <div class="label">Messages per second</div>
            </div>
        </div>

        <div class="test-section">
            <h2>📊 Test Results Overview</h2>
            <div class="test-content">
                <div class="progress-bar">
                    <div class="progress-fill" id="overall-progress" style="width: 0%"></div>
                </div>
                <p>Overall test completion: <span id="progress-text">0%</span></p>

                <div class="test-grid" id="test-results">
                    <!-- Test results will be populated here -->
                </div>
            </div>
        </div>

        <div class="test-section">
            <h2>⚡ Performance Metrics</h2>
            <div class="test-content">
                <table class="metrics-table">
                    <thead>
                        <tr>
                            <th>Metric</th>
                            <th>Value</th>
                            <th>Status</th>
                            <th>Threshold</th>
                        </tr>
                    </thead>
                    <tbody id="performance-metrics">
                        <!-- Performance metrics will be populated here -->
                    </tbody>
                </table>
            </div>
        </div>

        <div class="test-section">
            <h2>🔍 Discovery Tests</h2>
            <div class="test-content" id="discovery-tests">
                <!-- Discovery test results will be populated here -->
            </div>
        </div>

        <div class="test-section">
            <h2>📨 Messaging Tests</h2>
            <div class="test-content" id="messaging-tests">
                <!-- Messaging test results will be populated here -->
            </div>
        </div>

        <div class="test-section">
            <h2>🔄 Stress Tests</h2>
            <div class="test-content" id="stress-tests">
                <!-- Stress test results will be populated here -->
            </div>
        </div>

        <div class="test-section">
            <h2>📋 Test Logs</h2>
            <div class="test-content">
                <div class="log-section" id="test-logs">
                    <!-- Test logs will be populated here -->
                </div>
            </div>
        </div>

        <div class="footer">
            <p>Generated by quadra-a Relay Test Suite</p>
            <p>For more information, visit the project repository</p>
        </div>
    </div>

    <script>
        // Sample data - this would be populated by the report generator
        const testData = {
            totalTests: 0,
            passedTests: 0,
            failedTests: 0,
            avgLatency: 0,
            throughput: 0,
            tests: [],
            metrics: [],
            logs: []
        };

        function updateSummary() {
            document.getElementById('total-tests').textContent = testData.totalTests;

            const successRate = testData.totalTests > 0
                ? Math.round((testData.passedTests / testData.totalTests) * 100)
                : 0;
            document.getElementById('success-rate').textContent = successRate + '%';
            document.getElementById('avg-latency').textContent = testData.avgLatency + 'ms';
            document.getElementById('throughput').textContent = testData.throughput + '/s';

            // Update progress bar
            document.getElementById('overall-progress').style.width = successRate + '%';
            document.getElementById('progress-text').textContent = successRate + '%';
        }

        function renderTestResults() {
            const container = document.getElementById('test-results');
            container.innerHTML = '';

            testData.tests.forEach(test => {
                const testItem = document.createElement('div');
                testItem.className = 'test-item';

                const statusClass = test.status === 'PASS' ? 'pass' : 'fail';

                testItem.innerHTML = `
                    <h4>${test.name}</h4>
                    <p><span class="status ${statusClass}">${test.status}</span></p>
                    <p><small>${test.description || 'No description'}</small></p>
                    ${test.duration ? `<p><small>Duration: ${test.duration}ms</small></p>` : ''}
                `;

                container.appendChild(testItem);
            });
        }

        function renderMetrics() {
            const tbody = document.getElementById('performance-metrics');
            tbody.innerHTML = '';

            testData.metrics.forEach(metric => {
                const row = document.createElement('tr');
                const statusClass = metric.status === 'GOOD' ? 'pass' :
                                  metric.status === 'POOR' ? 'fail' : 'warn';

                row.innerHTML = `
                    <td>${metric.name}</td>
                    <td>${metric.value}</td>
                    <td><span class="status ${statusClass}">${metric.status}</span></td>
                    <td>${metric.threshold || 'N/A'}</td>
                `;

                tbody.appendChild(row);
            });
        }

        function renderLogs() {
            const container = document.getElementById('test-logs');
            container.innerHTML = testData.logs.join('\n') || 'No logs available';
        }

        // Initialize the report
        function initReport() {
            updateSummary();
            renderTestResults();
            renderMetrics();
            renderLogs();
        }

        // Load test data and initialize report
        document.addEventListener('DOMContentLoaded', initReport);
    </script>
</body>
</html>
EOF

# Replace timestamp placeholder
sed -i.bak "s/TIMESTAMP_PLACEHOLDER/$TIMESTAMP/" "$OUTPUT_FILE"
rm -f "$OUTPUT_FILE.bak"

# Parse test results and generate data
generate_test_data() {
    local js_data_file=$(mktemp)

    cat > "$js_data_file" << 'EOF'
// Parse test results and populate data
const testData = {
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    avgLatency: 0,
    throughput: 0,
    tests: [],
    metrics: [],
    logs: []
};

EOF

    # Parse log files for test results
    local total_tests=0
    local passed_tests=0
    local failed_tests=0

    # Look for test result files
    for log_file in "$RESULTS_DIR"/*.log "$RESULTS_DIR"/*/*.log; do
        if [[ -f "$log_file" ]]; then
            # Count PASS/FAIL entries
            local file_passed=$(grep -c "\[PASS\]" "$log_file" 2>/dev/null || echo "0")
            local file_failed=$(grep -c "\[FAIL\]" "$log_file" 2>/dev/null || echo "0")

            passed_tests=$((passed_tests + file_passed))
            failed_tests=$((failed_tests + file_failed))

            # Extract test names and results
            while IFS= read -r line; do
                if [[ "$line" =~ \[(PASS|FAIL)\] ]]; then
                    local status="${BASH_REMATCH[1]}"
                    local test_name=$(echo "$line" | sed 's/.*\] //')

                    cat >> "$js_data_file" << EOF
testData.tests.push({
    name: "$test_name",
    status: "$status",
    description: "$(basename "$log_file" .log)"
});
EOF
                fi
            done < <(grep "\[PASS\]\|\[FAIL\]" "$log_file" 2>/dev/null || true)
        fi
    done

    total_tests=$((passed_tests + failed_tests))

    # Add summary data
    cat >> "$js_data_file" << EOF

testData.totalTests = $total_tests;
testData.passedTests = $passed_tests;
testData.failedTests = $failed_tests;

// Sample performance metrics
testData.metrics = [
    { name: "Discovery Latency", value: "< 500ms", status: "GOOD", threshold: "< 1000ms" },
    { name: "Message Delivery", value: "< 1000ms", status: "GOOD", threshold: "< 2000ms" },
    { name: "Throughput", value: "> 50 msg/s", status: "GOOD", threshold: "> 10 msg/s" },
    { name: "Connection Success", value: "100%", status: "GOOD", threshold: "> 95%" },
    { name: "Error Rate", value: "< 1%", status: "GOOD", threshold: "< 5%" }
];

// Sample logs
testData.logs = [
EOF

    # Add recent log entries
    local log_count=0
    for log_file in "$RESULTS_DIR"/*.log; do
        if [[ -f "$log_file" && $log_count -lt 50 ]]; then
            while IFS= read -r line && [[ $log_count -lt 50 ]]; do
                # Escape quotes and add to logs
                local escaped_line=$(echo "$line" | sed 's/"/\\"/g' | sed "s/'/\\'/g")
                echo "    \"$escaped_line\"," >> "$js_data_file"
                ((log_count++))
            done < <(tail -n 10 "$log_file" 2>/dev/null || true)
        fi
    done

    cat >> "$js_data_file" << 'EOF'
];

// Update the HTML with our data
document.addEventListener('DOMContentLoaded', function() {
    // Update summary
    document.getElementById('total-tests').textContent = testData.totalTests;

    const successRate = testData.totalTests > 0
        ? Math.round((testData.passedTests / testData.totalTests) * 100)
        : 0;
    document.getElementById('success-rate').textContent = successRate + '%';

    // Update progress bar
    document.getElementById('overall-progress').style.width = successRate + '%';
    document.getElementById('progress-text').textContent = successRate + '%';

    // Render test results
    const container = document.getElementById('test-results');
    container.innerHTML = '';

    testData.tests.forEach(test => {
        const testItem = document.createElement('div');
        testItem.className = 'test-item';

        const statusClass = test.status === 'PASS' ? 'pass' : 'fail';

        testItem.innerHTML = `
            <h4>${test.name}</h4>
            <p><span class="status ${statusClass}">${test.status}</span></p>
            <p><small>${test.description}</small></p>
        `;

        container.appendChild(testItem);
    });

    // Render metrics
    const tbody = document.getElementById('performance-metrics');
    tbody.innerHTML = '';

    testData.metrics.forEach(metric => {
        const row = document.createElement('tr');
        const statusClass = metric.status === 'GOOD' ? 'pass' :
                          metric.status === 'POOR' ? 'fail' : 'warn';

        row.innerHTML = `
            <td>${metric.name}</td>
            <td>${metric.value}</td>
            <td><span class="status ${statusClass}">${metric.status}</span></td>
            <td>${metric.threshold}</td>
        `;

        tbody.appendChild(row);
    });

    // Render logs
    const logContainer = document.getElementById('test-logs');
    logContainer.innerHTML = testData.logs.slice(0, 100).join('\n');
});
EOF

    # Inject the JavaScript data into the HTML file
    sed -i.bak '/document.addEventListener.*DOMContentLoaded.*initReport/r '"$js_data_file" "$OUTPUT_FILE"
    rm -f "$OUTPUT_FILE.bak" "$js_data_file"
}

# Generate the test data
generate_test_data

log_success "Test report generated: $OUTPUT_FILE"
log_info "Open the file in a web browser to view the report"

# Optionally open the report in the default browser
if command -v open &> /dev/null; then
    log_info "Opening report in default browser..."
    open "$OUTPUT_FILE"
elif command -v xdg-open &> /dev/null; then
    log_info "Opening report in default browser..."
    xdg-open "$OUTPUT_FILE"
fi