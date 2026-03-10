from __future__ import annotations
#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AGENT_BIN = ROOT / 'repos' / 'cli-rs' / 'target' / 'debug' / 'agent'
RELAY_ENTRY = ROOT / 'repos' / 'relay' / 'dist' / 'index.js'
NODE_BIN = os.environ.get('NODE_BINARY', 'node')

if not AGENT_BIN.exists():
    raise SystemExit(f'agent binary not found: {AGENT_BIN}')
if not RELAY_ENTRY.exists():
    raise SystemExit(f'relay entry not found: {RELAY_ENTRY}')


class ManagedProcess:
    def __init__(self, name: str, proc: subprocess.Popen[str]):
        self.name = name
        self.proc = proc
        self.lines: list[str] = []
        self._reader_thread = threading.Thread(target=self._reader, daemon=True)
        self._reader_thread.start()

    def _reader(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.lines.append(line.rstrip())

    def wait_for_log(self, needle: str, timeout: float) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(needle in line for line in self.lines):
                return
            if self.proc.poll() is not None:
                tail = '\n'.join(self.lines[-120:])
                raise RuntimeError(f'{self.name} exited early with code {self.proc.returncode}\n{tail}')
            time.sleep(0.2)
        tail = '\n'.join(self.lines[-120:])
        raise RuntimeError(f'Timed out waiting for {self.name} log: {needle}\n{tail}')

    def terminate(self) -> None:
        if self.proc.poll() is not None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


def run_cmd(args: list[str], env: dict[str, str], cwd: Path, timeout: float = 60) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        env=env,
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(args)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def agent_env(home: Path, socket_name: str) -> dict[str, str]:
    env = os.environ.copy()
    env['QUADRA_A_HOME'] = str(home)
    env['QUADRA_A_RS_SOCKET_PATH'] = str(home / socket_name)
    env['QUADRA_A_SOCKET_PATH'] = str(home / socket_name)
    return env


def relay_proc(
    name: str,
    port: int,
    data_dir: Path,
    public_endpoint: str,
    network_id: str,
    *,
    genesis: bool,
    seed: str | None,
) -> ManagedProcess:
    args = [
        NODE_BIN,
        str(RELAY_ENTRY),
        '--port', str(port),
        '--landing-port', 'false',
        '--data-dir', str(data_dir),
        '--public-endpoint', public_endpoint,
        '--network-id', network_id,
    ]
    if genesis:
        args.append('--genesis-mode')
    if seed:
        args.extend(['--seed-relay', seed])

    proc = subprocess.Popen(
        args,
        cwd=ROOT / 'repos' / 'relay',
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    managed = ManagedProcess(name, proc)
    managed.wait_for_log('Relay agent started', timeout=25)
    return managed


def wait_for_condition(label: str, timeout: float, predicate):
    deadline = time.time() + timeout
    last_value = None
    while time.time() < deadline:
        last_value = predicate()
        if last_value:
            return last_value
        time.sleep(1)
    raise RuntimeError(f'Timed out waiting for {label}: {last_value}')


def reachability_status(env: dict[str, str]) -> dict:
    result = run_cmd(
        [str(AGENT_BIN), 'reachability', 'show', '--json'],
        env=env,
        cwd=ROOT / 'repos' / 'cli-rs',
        timeout=30,
    )
    return json.loads(result.stdout)


def daemon_status(env: dict[str, str]) -> dict:
    daemon = reachability_status(env).get('daemon')
    return daemon if isinstance(daemon, dict) else {}


def stop_agent(env: dict[str, str]) -> None:
    try:
        run_cmd([str(AGENT_BIN), 'stop'], env=env, cwd=ROOT / 'repos' / 'cli-rs', timeout=20)
    except Exception:
        pass


def configure_agent(env: dict[str, str], mode: str, bootstrap: str, target: int) -> None:
    run_cmd([str(AGENT_BIN), 'reachability', 'mode', mode], env=env, cwd=ROOT / 'repos' / 'cli-rs')
    run_cmd([str(AGENT_BIN), 'reachability', 'set-bootstrap', bootstrap], env=env, cwd=ROOT / 'repos' / 'cli-rs')
    run_cmd([str(AGENT_BIN), 'reachability', 'set-target', str(target)], env=env, cwd=ROOT / 'repos' / 'cli-rs')


def start_listener(env: dict[str, str], name: str) -> ManagedProcess:
    proc = subprocess.Popen(
        [
            str(AGENT_BIN),
            'listen',
            '--discoverable',
            '--name',
            name,
            '--description',
            f'{name} e2e reachability test',
        ],
        env=env,
        cwd=ROOT / 'repos' / 'cli-rs',
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    return ManagedProcess(f'listener-{name}', proc)


def run_adaptive_scenario(base_dir: Path) -> dict:
    network_id = 'reachability-adaptive-e2e'
    relay_a_url = 'ws://127.0.0.1:9211'
    relay_b_url = 'ws://127.0.0.1:9212'
    relay_a = None
    relay_b = None
    listener = None
    env = agent_env(base_dir / 'agent-adaptive-home', 'adaptive.sock')

    try:
        relay_a = relay_proc('relay-a', 9211, base_dir / 'relay-a', relay_a_url, network_id, genesis=True, seed=None)
        relay_b = relay_proc('relay-b', 9212, base_dir / 'relay-b', relay_b_url, network_id, genesis=False, seed=relay_a_url)
        time.sleep(5)

        os.makedirs(env['QUADRA_A_HOME'], exist_ok=True)
        configure_agent(env, 'adaptive', relay_a_url, 2)
        listener = start_listener(env, 'adaptive-agent')

        connected = wait_for_condition(
            'adaptive daemon connect',
            30,
            lambda: (daemon if (daemon := daemon_status(env)).get('connected') else None),
        )

        supplemented = wait_for_condition(
            'adaptive relay supplement',
            90,
            lambda: (daemon if relay_b_url in (daemon := daemon_status(env)).get('knownRelays', []) else None),
        )

        relay_a.terminate()
        failed_over = wait_for_condition(
            'adaptive relay failover',
            40,
            lambda: (daemon if (daemon := daemon_status(env)).get('connected') and daemon.get('relay') == relay_b_url else None),
        )

        return {
            'initialRelay': connected.get('relay'),
            'knownRelaysAfterSupplement': supplemented.get('knownRelays'),
            'lastDiscoveryAt': supplemented.get('reachabilityStatus', {}).get('lastDiscoveryAt'),
            'relayAfterFailover': failed_over.get('relay'),
            'providerFailures': failed_over.get('reachabilityStatus', {}).get('providerFailures'),
        }
    finally:
        stop_agent(env)
        if listener is not None:
            listener.terminate()
        if relay_a is not None:
            relay_a.terminate()
        if relay_b is not None:
            relay_b.terminate()


def run_fixed_scenario(base_dir: Path) -> dict:
    network_id = 'reachability-fixed-e2e'
    relay_a_url = 'ws://127.0.0.1:9311'
    relay_b_url = 'ws://127.0.0.1:9312'
    relay_a = None
    relay_b = None
    listener = None
    env = agent_env(base_dir / 'agent-fixed-home', 'fixed.sock')

    try:
        relay_a = relay_proc('relay-fixed-a', 9311, base_dir / 'relay-fixed-a', relay_a_url, network_id, genesis=True, seed=None)
        relay_b = relay_proc('relay-fixed-b', 9312, base_dir / 'relay-fixed-b', relay_b_url, network_id, genesis=False, seed=relay_a_url)
        time.sleep(5)

        os.makedirs(env['QUADRA_A_HOME'], exist_ok=True)
        configure_agent(env, 'fixed', relay_a_url, 1)
        listener = start_listener(env, 'fixed-agent')

        connected = wait_for_condition(
            'fixed daemon connect',
            30,
            lambda: (daemon if (daemon := daemon_status(env)).get('connected') else None),
        )

        time.sleep(10)
        fixed_status = reachability_status(env).get('daemon', {})
        if relay_b_url in fixed_status.get('knownRelays', []):
            raise RuntimeError(f'fixed mode unexpectedly learned backup relay: {fixed_status}')

        relay_a.terminate()
        disconnected = wait_for_condition(
            'fixed daemon disconnect',
            25,
            lambda: (daemon if not (daemon := daemon_status(env)).get('connected') else None),
        )

        return {
            'initialRelay': connected.get('relay'),
            'knownRelaysBeforeFailure': fixed_status.get('knownRelays'),
            'connectedAfterPrimaryFailure': disconnected.get('connected'),
            'relayAfterPrimaryFailure': disconnected.get('relay'),
        }
    finally:
        stop_agent(env)
        if listener is not None:
            listener.terminate()
        if relay_a is not None:
            relay_a.terminate()
        if relay_b is not None:
            relay_b.terminate()


def main() -> None:
    base_dir = Path(tempfile.mkdtemp(prefix='reachability-e2e-'))
    result = {'baseDir': str(base_dir)}
    result['adaptive'] = run_adaptive_scenario(base_dir)
    result['fixed'] = run_fixed_scenario(base_dir)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
