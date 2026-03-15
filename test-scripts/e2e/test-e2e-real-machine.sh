#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$SCRIPT_DIR/../test-config.sh"

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ARTIFACT_ROOT="${A4_ROOT}/test-output/e2e/real-machine"

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1" >&2; }

die() {
  log_error "$1"
  exit 1
}

print_usage() {
  cat <<USAGE
Usage:
  $(basename "$0") list-scenarios
  $(basename "$0") init <scenario-id> [--artifact-dir <path>] [--operator <name>] [--notes <text>]
  $(basename "$0") record-file <run-dir> <kind> <source-path> [--dest-name <name>] [--label <label>]
  $(basename "$0") run-command <run-dir> <kind> <dest-name> -- <command...>
  $(basename "$0") record-version <run-dir> <label> -- <command...>
  $(basename "$0") assert <run-dir> <assertion-id> <pass|fail|skip> <message>
  $(basename "$0") scan-plaintext <run-dir> <scan-id> <patterns-csv> <file...>
  $(basename "$0") validate <run-dir>
  $(basename "$0") finalize <run-dir> [pass|fail|incomplete]

Artifact kinds counted toward completion:
  sender-log, receiver-log, relay-log, queue-inspection, session-inspection

Other accepted kinds:
  version, command-output, notes, extra, scan-report

Examples:
  $(basename "$0") init E2E-RM-001
  $(basename "$0") record-version ./test-output/e2e/real-machine/20260312-foo-E2E-RM-001 sender-js -- ./js/cli/a4 --version
  $(basename "$0") run-command ./test-output/e2e/real-machine/20260312-foo-E2E-RM-001 sender-log sender.log -- ./js/cli/a4 status --format json
  $(basename "$0") scan-plaintext ./test-output/e2e/real-machine/20260312-foo-E2E-RM-006 relay-opacity "translate/japanese,hello world" relay.log queue-before.log queue-after.log
  $(basename "$0") finalize ./test-output/e2e/real-machine/20260312-foo-E2E-RM-001 pass
USAGE
}

now_iso() {
  python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
}

validate_scenario_id() {
  case "$1" in
    E2E-RM-001|E2E-RM-002|E2E-RM-003|E2E-RM-004|E2E-RM-005|E2E-RM-006|E2E-RM-007|E2E-RM-008)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

scenario_topology() {
  case "$1" in
    E2E-RM-001|E2E-RM-002) echo "Environment A — single relay, online peers" ;;
    E2E-RM-003|E2E-RM-004) echo "Environment B — single relay, offline first message" ;;
    E2E-RM-005) echo "Environment C — federated relays" ;;
    E2E-RM-006) echo "Reuse any real-machine environment with retained relay artifacts" ;;
    E2E-RM-007) echo "Environment D — multi-device recipient" ;;
    E2E-RM-008) echo "Environment B or D — low OTK inventory and replenishment" ;;
    *) echo "Unknown topology" ;;
  esac
}

scenario_goal() {
  case "$1" in
    E2E-RM-001) echo "JS -> JS same-relay online delivery with pre-key bootstrap then ratchet reuse" ;;
    E2E-RM-002) echo "Rust -> Rust same-relay online delivery with pre-key bootstrap then ratchet reuse" ;;
    E2E-RM-003) echo "JS -> Rust offline first-message delivery through one relay" ;;
    E2E-RM-004) echo "Rust -> JS offline first-message delivery through one relay" ;;
    E2E-RM-005) echo "JS -> Rust delivery across two federated relays" ;;
    E2E-RM-006) echo "Explicit relay opacity inspection across logs and queued bytes" ;;
    E2E-RM-007) echo "Multi-device recipient fan-out with user-visible dedupe" ;;
    E2E-RM-008) echo "Pre-key depletion, operator visibility, and replenishment continuity" ;;
    *) echo "Unknown goal" ;;
  esac
}

required_sender_logs() {
  echo 1
}

required_receiver_logs() {
  case "$1" in
    E2E-RM-007) echo 2 ;;
    *) echo 1 ;;
  esac
}

required_relay_logs() {
  case "$1" in
    E2E-RM-005) echo 2 ;;
    *) echo 1 ;;
  esac
}

required_queue_inspections() {
  echo 2
}

required_session_inspections() {
  case "$1" in
    E2E-RM-007) echo 3 ;;
    *) echo 2 ;;
  esac
}

required_version_records() {
  local sender_count
  local receiver_count
  local relay_count
  sender_count="$(required_sender_logs "$1")"
  receiver_count="$(required_receiver_logs "$1")"
  relay_count="$(required_relay_logs "$1")"
  echo $((sender_count + receiver_count + relay_count))
}

required_scan_reports() {
  case "$1" in
    E2E-RM-006) echo 1 ;;
    *) echo 0 ;;
  esac
}

kind_is_allowed() {
  case "$1" in
    sender-log|receiver-log|relay-log|queue-inspection|session-inspection|version|command-output|notes|extra|scan-report)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

summary_path_for_run() {
  echo "$1/summary.json"
}

ensure_run_dir() {
  local run_dir="$1"
  local summary_path
  summary_path="$(summary_path_for_run "$run_dir")"
  [[ -d "$run_dir" ]] || die "Run directory does not exist: $run_dir"
  [[ -f "$summary_path" ]] || die "Missing summary file: $summary_path"
}

create_checklist() {
  local run_dir="$1"
  local scenario_id="$2"
  local checklist_path="$run_dir/CHECKLIST.md"
  local sender_count receiver_count relay_count queue_count session_count version_count scan_count
  sender_count="$(required_sender_logs "$scenario_id")"
  receiver_count="$(required_receiver_logs "$scenario_id")"
  relay_count="$(required_relay_logs "$scenario_id")"
  queue_count="$(required_queue_inspections "$scenario_id")"
  session_count="$(required_session_inspections "$scenario_id")"
  version_count="$(required_version_records "$scenario_id")"
  scan_count="$(required_scan_reports "$scenario_id")"

  cat > "$checklist_path" <<EOF_CHECKLIST
# ${scenario_id} real-machine checklist

- Goal: $(scenario_goal "$scenario_id")
- Topology: $(scenario_topology "$scenario_id")
- Full procedure: test-scripts/e2e/REAL_MACHINE_FULL_CHAIN_TEST.md
- Summary file: summary.json

## Minimum retained evidence

- sender logs: ${sender_count}
- receiver logs: ${receiver_count}
- relay logs: ${relay_count}
- queue inspections: ${queue_count}
- session inspections: ${session_count}
- version records: ${version_count}
- plaintext scan reports: ${scan_count}

## Suggested command flow

    bash test-scripts/e2e/test-e2e-real-machine.sh record-version "$run_dir" sender -- <sender-binary> --version
    bash test-scripts/e2e/test-e2e-real-machine.sh record-version "$run_dir" receiver -- <receiver-binary> --version
    bash test-scripts/e2e/test-e2e-real-machine.sh record-version "$run_dir" relay -- <relay-command> --version
    bash test-scripts/e2e/test-e2e-real-machine.sh record-file "$run_dir" sender-log ./sender.log
    bash test-scripts/e2e/test-e2e-real-machine.sh record-file "$run_dir" receiver-log ./receiver.log
    bash test-scripts/e2e/test-e2e-real-machine.sh record-file "$run_dir" relay-log ./relay.log
    bash test-scripts/e2e/test-e2e-real-machine.sh record-file "$run_dir" queue-inspection ./queue-before.log --label before
    bash test-scripts/e2e/test-e2e-real-machine.sh record-file "$run_dir" queue-inspection ./queue-after.log --label after
    bash test-scripts/e2e/test-e2e-real-machine.sh record-file "$run_dir" session-inspection ./sender-session.json --label sender
    bash test-scripts/e2e/test-e2e-real-machine.sh record-file "$run_dir" session-inspection ./receiver-session.json --label receiver
    bash test-scripts/e2e/test-e2e-real-machine.sh assert "$run_dir" delivery pass "delivery succeeded"
    bash test-scripts/e2e/test-e2e-real-machine.sh scan-plaintext "$run_dir" relay-opacity "translate/japanese,hello world" ./relay.log ./queue-before.log ./queue-after.log
    bash test-scripts/e2e/test-e2e-real-machine.sh finalize "$run_dir" pass

Replace the placeholder commands above with the concrete sender / receiver / relay commands for this environment.
EOF_CHECKLIST
}

write_initial_summary() {
  local summary_path="$1"
  local scenario_id="$2"
  local operator_name="$3"
  local notes="$4"
  local created_at="$5"
  local hostname_value
  hostname_value="$(hostname 2>/dev/null || echo unknown-host)"
  python3 - "$summary_path" "$scenario_id" "$operator_name" "$notes" "$created_at" "$hostname_value" \
    "$(scenario_goal "$scenario_id")" "$(scenario_topology "$scenario_id")" \
    "$(required_sender_logs "$scenario_id")" "$(required_receiver_logs "$scenario_id")" \
    "$(required_relay_logs "$scenario_id")" "$(required_queue_inspections "$scenario_id")" \
    "$(required_session_inspections "$scenario_id")" "$(required_version_records "$scenario_id")" \
    "$(required_scan_reports "$scenario_id")" <<'PY'
import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
scenario_id = sys.argv[2]
operator_name = sys.argv[3]
notes = sys.argv[4]
created_at = sys.argv[5]
hostname_value = sys.argv[6]
goal = sys.argv[7]
topology = sys.argv[8]
requirements = {
    "senderLogs": int(sys.argv[9]),
    "receiverLogs": int(sys.argv[10]),
    "relayLogs": int(sys.argv[11]),
    "queueInspections": int(sys.argv[12]),
    "sessionInspections": int(sys.argv[13]),
    "versionRecords": int(sys.argv[14]),
    "scanReports": int(sys.argv[15]),
}
summary = {
    "schemaVersion": 1,
    "scenarioId": scenario_id,
    "goal": goal,
    "topology": topology,
    "status": "running",
    "startedAt": created_at,
    "completedAt": None,
    "operator": operator_name,
    "host": hostname_value,
    "notes": notes,
    "requirements": requirements,
    "artifacts": [],
    "assertions": [],
    "versions": [],
    "scans": [],
}
summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
PY
}

append_artifact() {
  local summary_path="$1"
  local kind="$2"
  local rel_path="$3"
  local source_ref="$4"
  local label="$5"
  local size_bytes="$6"
  local recorded_at="$7"
  local exit_code="${8:-}"
  python3 - "$summary_path" "$kind" "$rel_path" "$source_ref" "$label" "$size_bytes" "$recorded_at" "$exit_code" <<'PY'
import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
kind = sys.argv[2]
rel_path = sys.argv[3]
source_ref = sys.argv[4]
label = sys.argv[5]
size_bytes = int(sys.argv[6])
recorded_at = sys.argv[7]
exit_code = sys.argv[8]
summary = json.loads(summary_path.read_text(encoding="utf-8"))
entry = {
    "kind": kind,
    "path": rel_path,
    "source": source_ref,
    "recordedAt": recorded_at,
    "size": size_bytes,
}
if label:
    entry["label"] = label
if exit_code not in ("", "null"):
    entry["exitCode"] = int(exit_code)
summary.setdefault("artifacts", []).append(entry)
summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
PY
}

upsert_assertion() {
  local summary_path="$1"
  local assertion_id="$2"
  local status_value="$3"
  local message="$4"
  local recorded_at="$5"
  python3 - "$summary_path" "$assertion_id" "$status_value" "$message" "$recorded_at" <<'PY'
import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
assertion_id = sys.argv[2]
status_value = sys.argv[3]
message = sys.argv[4]
recorded_at = sys.argv[5]
summary = json.loads(summary_path.read_text(encoding="utf-8"))
assertions = summary.setdefault("assertions", [])
entry = {
    "id": assertion_id,
    "status": status_value,
    "message": message,
    "recordedAt": recorded_at,
}
for index, existing in enumerate(assertions):
    if existing.get("id") == assertion_id:
        assertions[index] = entry
        break
else:
    assertions.append(entry)
summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
PY
}

append_version_record() {
  local summary_path="$1"
  local label="$2"
  local rel_path="$3"
  local command_string="$4"
  local exit_code="$5"
  local recorded_at="$6"
  python3 - "$summary_path" "$label" "$rel_path" "$command_string" "$exit_code" "$recorded_at" <<'PY'
import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
label = sys.argv[2]
rel_path = sys.argv[3]
command_string = sys.argv[4]
exit_code = int(sys.argv[5])
recorded_at = sys.argv[6]
summary = json.loads(summary_path.read_text(encoding="utf-8"))
summary.setdefault("versions", []).append({
    "label": label,
    "path": rel_path,
    "command": command_string,
    "exitCode": exit_code,
    "recordedAt": recorded_at,
})
summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
PY
}

append_scan_record() {
  local summary_path="$1"
  local scan_id="$2"
  local rel_path="$3"
  local recorded_at="$4"
  python3 - "$summary_path" "$scan_id" "$rel_path" "$recorded_at" <<'PY'
import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
scan_id = sys.argv[2]
rel_path = sys.argv[3]
recorded_at = sys.argv[4]
summary = json.loads(summary_path.read_text(encoding="utf-8"))
summary.setdefault("scans", []).append({
    "id": scan_id,
    "path": rel_path,
    "recordedAt": recorded_at,
})
summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
PY
}

validate_run_dir() {
  local run_dir="$1"
  local summary_path
  summary_path="$(summary_path_for_run "$run_dir")"
  python3 - "$summary_path" <<'PY'
import json
import sys
from collections import Counter
from pathlib import Path

summary_path = Path(sys.argv[1])
summary = json.loads(summary_path.read_text(encoding="utf-8"))
artifacts = summary.get("artifacts", [])
counts = Counter(entry.get("kind") for entry in artifacts)
requirements = summary.get("requirements", {})
versions = summary.get("versions", [])
scans = summary.get("scans", [])
assertions = summary.get("assertions", [])

missing = []
checks = [
    ("sender-log", counts.get("sender-log", 0), requirements.get("senderLogs", 0)),
    ("receiver-log", counts.get("receiver-log", 0), requirements.get("receiverLogs", 0)),
    ("relay-log", counts.get("relay-log", 0), requirements.get("relayLogs", 0)),
    ("queue-inspection", counts.get("queue-inspection", 0), requirements.get("queueInspections", 0)),
    ("session-inspection", counts.get("session-inspection", 0), requirements.get("sessionInspections", 0)),
    ("version-record", len(versions), requirements.get("versionRecords", 0)),
    ("scan-report", len(scans), requirements.get("scanReports", 0)),
]
for label, observed, required in checks:
    if observed < required:
        missing.append(f"{label}: need {required}, have {observed}")
failed_assertions = [entry for entry in assertions if entry.get("status") == "fail"]
print(f"Scenario: {summary.get('scenarioId')}")
print(f"Status: {summary.get('status')}")
for label, observed, required in checks:
    print(f"  {label}: {observed}/{required}")
if assertions:
    print("Assertions:")
    for entry in assertions:
      print(f"  - {entry.get('id')}: {entry.get('status')} - {entry.get('message')}")
if missing:
    print("Missing evidence:")
    for item in missing:
        print(f"  - {item}")
if failed_assertions:
    print("Failed assertions:")
    for entry in failed_assertions:
        print(f"  - {entry.get('id')}: {entry.get('message')}")
if missing or failed_assertions:
    sys.exit(1)
sys.exit(0)
PY
}

finalize_run_dir() {
  local run_dir="$1"
  local requested_status="${2:-pass}"
  local summary_path
  summary_path="$(summary_path_for_run "$run_dir")"
  local completed_at
  completed_at="$(now_iso)"
  python3 - "$summary_path" "$requested_status" "$completed_at" <<'PY'
import json
import sys
from collections import Counter
from pathlib import Path

summary_path = Path(sys.argv[1])
requested_status = sys.argv[2]
completed_at = sys.argv[3]
summary = json.loads(summary_path.read_text(encoding="utf-8"))
artifacts = summary.get("artifacts", [])
counts = Counter(entry.get("kind") for entry in artifacts)
requirements = summary.get("requirements", {})
versions = summary.get("versions", [])
scans = summary.get("scans", [])
assertions = summary.get("assertions", [])
missing = []
checks = [
    ("sender-log", counts.get("sender-log", 0), requirements.get("senderLogs", 0)),
    ("receiver-log", counts.get("receiver-log", 0), requirements.get("receiverLogs", 0)),
    ("relay-log", counts.get("relay-log", 0), requirements.get("relayLogs", 0)),
    ("queue-inspection", counts.get("queue-inspection", 0), requirements.get("queueInspections", 0)),
    ("session-inspection", counts.get("session-inspection", 0), requirements.get("sessionInspections", 0)),
    ("version-record", len(versions), requirements.get("versionRecords", 0)),
    ("scan-report", len(scans), requirements.get("scanReports", 0)),
]
for label, observed, required in checks:
    if observed < required:
        missing.append({"kind": label, "required": required, "observed": observed})
failed_assertions = [entry for entry in assertions if entry.get("status") == "fail"]
if missing:
    final_status = "incomplete"
elif failed_assertions:
    final_status = "fail"
elif requested_status in ("pass", "fail", "incomplete"):
    final_status = requested_status
else:
    final_status = "pass"
summary["status"] = final_status
summary["completedAt"] = completed_at
summary["capturedCounts"] = {
    "senderLogs": counts.get("sender-log", 0),
    "receiverLogs": counts.get("receiver-log", 0),
    "relayLogs": counts.get("relay-log", 0),
    "queueInspections": counts.get("queue-inspection", 0),
    "sessionInspections": counts.get("session-inspection", 0),
    "versionRecords": len(versions),
    "scanReports": len(scans),
}
summary["missingEvidence"] = missing
summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(final_status)
PY
}

list_scenarios() {
  local scenario_id
  for scenario_id in E2E-RM-001 E2E-RM-002 E2E-RM-003 E2E-RM-004 E2E-RM-005 E2E-RM-006 E2E-RM-007 E2E-RM-008; do
    printf '%s\t%s\n' "$scenario_id" "$(scenario_goal "$scenario_id")"
  done
}

command_init() {
  [[ $# -ge 1 ]] || die "init requires a scenario id"
  local scenario_id="$1"
  shift
  validate_scenario_id "$scenario_id" || die "Unknown real-machine scenario id: $scenario_id"

  local artifact_dir=""
  local operator_name="${USER:-unknown}"
  local notes=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --artifact-dir)
        [[ $# -ge 2 ]] || die "--artifact-dir requires a path"
        artifact_dir="$2"
        shift 2
        ;;
      --operator)
        [[ $# -ge 2 ]] || die "--operator requires a value"
        operator_name="$2"
        shift 2
        ;;
      --notes)
        [[ $# -ge 2 ]] || die "--notes requires a value"
        notes="$2"
        shift 2
        ;;
      *)
        die "Unknown init option: $1"
        ;;
    esac
  done

  mkdir -p "$ARTIFACT_ROOT"
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local run_dir="${artifact_dir:-$ARTIFACT_ROOT/${timestamp}-${scenario_id}}"
  [[ ! -e "$run_dir" ]] || die "Artifact directory already exists: $run_dir"
  mkdir -p "$run_dir/artifacts" "$run_dir/scans"
  local summary_path
  summary_path="$(summary_path_for_run "$run_dir")"
  local created_at
  created_at="$(now_iso)"
  write_initial_summary "$summary_path" "$scenario_id" "$operator_name" "$notes" "$created_at"
  create_checklist "$run_dir" "$scenario_id"
  log_success "Initialized real-machine run: $run_dir" >&2
  echo "$run_dir"
}

command_record_file() {
  [[ $# -ge 3 ]] || die "record-file requires <run-dir> <kind> <source-path>"
  local run_dir="$1"
  local kind="$2"
  local source_path="$3"
  shift 3
  ensure_run_dir "$run_dir"
  kind_is_allowed "$kind" || die "Unsupported artifact kind: $kind"
  [[ -f "$source_path" ]] || die "Source artifact does not exist: $source_path"

  local dest_name="$(basename "$source_path")"
  local label=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dest-name)
        [[ $# -ge 2 ]] || die "--dest-name requires a value"
        dest_name="$2"
        shift 2
        ;;
      --label)
        [[ $# -ge 2 ]] || die "--label requires a value"
        label="$2"
        shift 2
        ;;
      *)
        die "Unknown record-file option: $1"
        ;;
    esac
  done

  local dest_dir="$run_dir/artifacts/$kind"
  mkdir -p "$dest_dir"
  local final_name="$dest_name"
  if [[ -n "$label" ]]; then
    final_name="${label}-${dest_name}"
  fi
  local dest_path="$dest_dir/$final_name"
  cp "$source_path" "$dest_path"
  local rel_path="artifacts/$kind/$final_name"
  local size_bytes
  size_bytes="$(wc -c < "$dest_path" | tr -d ' ')"
  append_artifact "$(summary_path_for_run "$run_dir")" "$kind" "$rel_path" "$source_path" "$label" "$size_bytes" "$(now_iso)"
  log_success "Recorded artifact: $rel_path"
}

command_run_command() {
  [[ $# -ge 4 ]] || die "run-command requires <run-dir> <kind> <dest-name> -- <command...>"
  local run_dir="$1"
  local kind="$2"
  local dest_name="$3"
  shift 3
  ensure_run_dir "$run_dir"
  kind_is_allowed "$kind" || die "Unsupported artifact kind: $kind"
  [[ "$1" == "--" ]] || die "run-command expects -- before the command"
  shift
  [[ $# -gt 0 ]] || die "run-command requires a command after --"

  local dest_dir="$run_dir/artifacts/$kind"
  mkdir -p "$dest_dir"
  local dest_path="$dest_dir/$dest_name"
  local rel_path="artifacts/$kind/$dest_name"
  local recorded_at
  recorded_at="$(now_iso)"
  local command_string="$*"
  set +e
  "$@" >"$dest_path" 2>&1
  local exit_code=$?
  set -e
  local size_bytes
  size_bytes="$(wc -c < "$dest_path" | tr -d ' ')"
  append_artifact "$(summary_path_for_run "$run_dir")" "$kind" "$rel_path" "command: $command_string" "" "$size_bytes" "$recorded_at" "$exit_code"
  if [[ $exit_code -ne 0 ]]; then
    log_error "Command failed with exit code $exit_code: $command_string"
    return "$exit_code"
  fi
  log_success "Captured command output: $rel_path"
}

command_record_version() {
  [[ $# -ge 3 ]] || die "record-version requires <run-dir> <label> -- <command...>"
  local run_dir="$1"
  local label="$2"
  shift 2
  ensure_run_dir "$run_dir"
  [[ "$1" == "--" ]] || die "record-version expects -- before the command"
  shift
  [[ $# -gt 0 ]] || die "record-version requires a command after --"

  local dest_dir="$run_dir/artifacts/version"
  mkdir -p "$dest_dir"
  local safe_label="${label// /-}"
  local dest_name="${safe_label}.txt"
  local dest_path="$dest_dir/$dest_name"
  local rel_path="artifacts/version/$dest_name"
  local recorded_at
  recorded_at="$(now_iso)"
  local command_string="$*"
  set +e
  "$@" >"$dest_path" 2>&1
  local exit_code=$?
  set -e
  local size_bytes
  size_bytes="$(wc -c < "$dest_path" | tr -d ' ')"
  append_artifact "$(summary_path_for_run "$run_dir")" "version" "$rel_path" "command: $command_string" "$label" "$size_bytes" "$recorded_at" "$exit_code"
  append_version_record "$(summary_path_for_run "$run_dir")" "$label" "$rel_path" "$command_string" "$exit_code" "$recorded_at"
  if [[ $exit_code -ne 0 ]]; then
    log_error "Version command failed with exit code $exit_code: $command_string"
    return "$exit_code"
  fi
  log_success "Recorded version output: $rel_path"
}

command_assert() {
  [[ $# -ge 4 ]] || die "assert requires <run-dir> <assertion-id> <pass|fail|skip> <message>"
  local run_dir="$1"
  local assertion_id="$2"
  local status_value="$3"
  shift 3
  ensure_run_dir "$run_dir"
  case "$status_value" in
    pass|fail|skip) ;;
    *) die "Assertion status must be pass, fail, or skip" ;;
  esac
  local message="$*"
  upsert_assertion "$(summary_path_for_run "$run_dir")" "$assertion_id" "$status_value" "$message" "$(now_iso)"
  log_success "Recorded assertion $assertion_id=$status_value"
}

command_scan_plaintext() {
  [[ $# -ge 4 ]] || die "scan-plaintext requires <run-dir> <scan-id> <patterns-csv> <file...>"
  local run_dir="$1"
  local scan_id="$2"
  local patterns_csv="$3"
  shift 3
  ensure_run_dir "$run_dir"
  [[ $# -gt 0 ]] || die "scan-plaintext requires at least one file"

  local scan_dir="$run_dir/scans"
  mkdir -p "$scan_dir"
  local scan_path="$scan_dir/${scan_id}.json"
  local rel_path="scans/${scan_id}.json"
  python3 - "$scan_path" "$patterns_csv" "$@" <<'PY'
import json
import sys
from pathlib import Path

scan_path = Path(sys.argv[1])
patterns = [item.strip() for item in sys.argv[2].split(',') if item.strip()]
files = sys.argv[3:]
results = []
for file_name in files:
    path = Path(file_name)
    try:
        content = path.read_text(encoding='utf-8', errors='ignore')
    except FileNotFoundError:
        results.append({"file": file_name, "error": "missing"})
        continue
    matches = []
    for pattern in patterns:
        if pattern in content:
            matches.append(pattern)
    results.append({"file": file_name, "matches": matches})
report = {
    "patterns": patterns,
    "results": results,
    "matched": any(entry.get("matches") for entry in results),
}
scan_path.write_text(json.dumps(report, indent=2) + "\n", encoding='utf-8')
print('matched' if report['matched'] else 'clean')
PY
  local scan_status
  scan_status="$(python3 - "$scan_path" <<'PY'
import json
import sys
from pathlib import Path
report = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
print('fail' if report.get('matched') else 'pass')
PY
)"
  local size_bytes
  size_bytes="$(wc -c < "$scan_path" | tr -d ' ')"
  append_artifact "$(summary_path_for_run "$run_dir")" "scan-report" "$rel_path" "patterns: $patterns_csv" "$scan_id" "$size_bytes" "$(now_iso)"
  append_scan_record "$(summary_path_for_run "$run_dir")" "$scan_id" "$rel_path" "$(now_iso)"
  if [[ "$scan_status" == "fail" ]]; then
    upsert_assertion "$(summary_path_for_run "$run_dir")" "scan:$scan_id" "fail" "forbidden plaintext matched in scan report $rel_path" "$(now_iso)"
    log_error "Plaintext scan found forbidden content: $rel_path"
    return 1
  fi
  upsert_assertion "$(summary_path_for_run "$run_dir")" "scan:$scan_id" "pass" "no forbidden plaintext matched in scan report $rel_path" "$(now_iso)"
  log_success "Plaintext scan is clean: $rel_path"
}

command_validate() {
  [[ $# -eq 1 ]] || die "validate requires <run-dir>"
  ensure_run_dir "$1"
  validate_run_dir "$1"
}

command_finalize() {
  [[ $# -ge 1 ]] || die "finalize requires <run-dir>"
  local run_dir="$1"
  local requested_status="${2:-pass}"
  ensure_run_dir "$run_dir"
  local final_status
  final_status="$(finalize_run_dir "$run_dir" "$requested_status")"
  if [[ "$final_status" == "pass" ]]; then
    log_success "Finalized real-machine run as pass: $run_dir"
    return 0
  fi
  if [[ "$final_status" == "fail" ]]; then
    log_error "Finalized real-machine run as fail: $run_dir"
    return 1
  fi
  log_error "Finalized real-machine run as incomplete: $run_dir"
  return 1
}

main() {
  [[ $# -gt 0 ]] || {
    print_usage
    exit 1
  }

  local command="$1"
  shift

  case "$command" in
    -h|--help|help)
      print_usage
      ;;
    list-scenarios)
      list_scenarios
      ;;
    init)
      command_init "$@"
      ;;
    record-file)
      command_record_file "$@"
      ;;
    run-command)
      command_run_command "$@"
      ;;
    record-version)
      command_record_version "$@"
      ;;
    assert)
      command_assert "$@"
      ;;
    scan-plaintext)
      command_scan_plaintext "$@"
      ;;
    validate)
      command_validate "$@"
      ;;
    finalize)
      command_finalize "$@"
      ;;
    *)
      die "Unknown command: $command"
      ;;
  esac
}

main "$@"
