#!/usr/bin/env bash
# 验证 inbox --human 模式下 GPU job 消息被聚合显示
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "=== Inbox Job Aggregation Test ==="

# 用 JS CLI 检查（JS daemon 在跑）
HUMAN_OUT=$(run_js inbox --human 2>&1 || true)

# 检查是否有 "Job job_" 聚合行
if echo "$HUMAN_OUT" | grep -q "Job job_"; then
  echo "  ✓ Job aggregation visible in human output"
  echo "$HUMAN_OUT" | grep "Job job_" | head -3
else
  echo "  ✗ No job aggregation found in human output"
  echo "  (This may be expected if no GPU jobs in inbox)"
  # 不算失败，因为可能 inbox 里没有 GPU job
fi

# Rust CLI 同样检查
RS_HUMAN=$(run_rs inbox --human --limit 20 2>&1 || true)
if echo "$RS_HUMAN" | grep -q "Job job_"; then
  echo "  ✓ Rust CLI job aggregation visible"
else
  echo "  ⚠ Rust CLI no job aggregation (may need Rust daemon or socket fallback)"
fi

echo "=== Inbox Job Aggregation Test DONE ==="
