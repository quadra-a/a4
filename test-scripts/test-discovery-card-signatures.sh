#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-config.sh"

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

RUN_JS=true
RUN_RUST=true

print_usage() {
  cat <<USAGE
Usage: $(basename "$0") [--js-only | --rust-only]

Runs the discovery/card signature verification regression tests.

Options:
  --js-only      Run only the JavaScript relay-client tests
  --rust-only    Run only the Rust runtime tests
  -h, --help     Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --js-only)
      RUN_RUST=false
      shift
      ;;
    --rust-only)
      RUN_JS=false
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo -e "${RED}[FAIL]${NC} Unknown argument: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

if [[ "$RUN_JS" == false && "$RUN_RUST" == false ]]; then
  echo -e "${RED}[FAIL]${NC} Nothing to run" >&2
  exit 1
fi

echo -e "${BLUE}[INFO]${NC} Running discovery card signature regression tests"

if [[ "$RUN_JS" == true ]]; then
  echo -e "${BLUE}[INFO]${NC} JavaScript relay client tests"
  (
    cd "$A4_ROOT/js/core/protocol"
    pnpm exec vitest run test/relay-client-card-verification.test.ts
  )
fi

if [[ "$RUN_RUST" == true ]]; then
  echo -e "${BLUE}[INFO]${NC} Rust runtime tests"
  (
    cd "$A4_ROOT/rust"
    cargo test -p quadra-a-runtime card_signature_verification -- --nocapture
  )
fi

echo -e "${GREEN}[PASS]${NC} Discovery card signature regression tests passed"
