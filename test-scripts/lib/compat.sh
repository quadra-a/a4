quadra_now_ns() {
    if command -v python3 >/dev/null 2>&1; then
        python3 - <<'PY'
import time
print(time.time_ns())
PY
        return
    fi

    date +%s%N
}

quadra_iso_timestamp() {
    if command -v python3 >/dev/null 2>&1; then
        python3 - <<'PY'
from datetime import datetime
print(datetime.now().astimezone().isoformat(timespec="seconds"))
PY
        return
    fi

    date
}

quadra_epoch_to_iso() {
    local epoch="$1"

    if command -v python3 >/dev/null 2>&1; then
        python3 - "$epoch" <<'PY'
from datetime import datetime
import sys

print(datetime.fromtimestamp(int(sys.argv[1])).astimezone().isoformat(timespec="seconds"))
PY
        return
    fi

    date
}

quadra_divide() {
    local numerator="$1"
    local denominator="$2"
    local decimals="${3:-2}"
    local scale="${4:-1}"

    if [[ "$denominator" == "0" || -z "$denominator" ]]; then
        printf "%.*f\n" "$decimals" 0
        return
    fi

    python3 - "$numerator" "$denominator" "$decimals" "$scale" <<'PY'
import sys

numerator = float(sys.argv[1])
denominator = float(sys.argv[2])
decimals = int(sys.argv[3])
scale = float(sys.argv[4])

value = (numerator * scale) / denominator
print(f"{value:.{decimals}f}")
PY
}

quadra_timeout_command() {
    if command -v timeout >/dev/null 2>&1; then
        echo "timeout"
        return 0
    fi

    if command -v gtimeout >/dev/null 2>&1; then
        echo "gtimeout"
        return 0
    fi

    return 1
}

quadra_timeout_label() {
    local timeout_cmd

    if timeout_cmd="$(quadra_timeout_command 2>/dev/null)"; then
        echo "$timeout_cmd"
        return
    fi

    if command -v python3 >/dev/null 2>&1; then
        echo "python3"
        return
    fi

    echo "none"
}

quadra_run_with_timeout() {
    local seconds="$1"
    shift

    local timeout_cmd
    if timeout_cmd="$(quadra_timeout_command 2>/dev/null)"; then
        "$timeout_cmd" "$seconds" "$@"
        return $?
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

timeout_seconds = float(sys.argv[1])
command = sys.argv[2:]

try:
    completed = subprocess.run(command, check=False, timeout=timeout_seconds)
    sys.exit(completed.returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
PY
        return $?
    fi

    "$@"
}

quadra_run_with_timeout_shell() {
    local seconds="$1"
    shift
    local command="$1"

    local timeout_cmd
    if timeout_cmd="$(quadra_timeout_command 2>/dev/null)"; then
        "$timeout_cmd" "$seconds" bash -lc "$command"
        return $?
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 - "$seconds" "$command" <<'PY'
import subprocess
import sys

timeout_seconds = float(sys.argv[1])
command = sys.argv[2]

try:
    completed = subprocess.run(command, shell=True, check=False, timeout=timeout_seconds)
    sys.exit(completed.returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
PY
        return $?
    fi

    bash -lc "$command"
}
