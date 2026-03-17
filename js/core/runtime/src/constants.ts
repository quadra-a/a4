import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const QUADRA_A_HOME =
  process.env.QUADRA_A_HOME ||
  join(homedir(), '.quadra-a');

const HOME_HASH = createHash('sha256')
  .update(QUADRA_A_HOME)
  .digest('hex')
  .slice(0, 8);

function buildDerivedPath(kind: 'sock' | 'pid', runtime: 'js' | 'rs'): string {
  const suffix = runtime === 'js' ? '' : '-rs';
  return `/tmp/quadra-a-${HOME_HASH}${suffix}.${kind}`;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function getLegacyDaemonSocketPath(runtime: 'js' | 'rs'): string {
  return runtime === 'js' ? '/tmp/quadra-a.sock' : '/tmp/quadra-a-rs.sock';
}

export function getLegacyDaemonPidPath(runtime: 'js' | 'rs'): string {
  return runtime === 'js' ? '/tmp/quadra-a.pid' : '/tmp/quadra-a-rs.pid';
}

export function getDaemonSocketPath(runtime: 'js' | 'rs' = 'js'): string {
  if (process.env.QUADRA_A_SOCKET_PATH) {
    return process.env.QUADRA_A_SOCKET_PATH;
  }

  return buildDerivedPath('sock', runtime);
}

export function getDaemonPidPath(runtime: 'js' | 'rs' = 'js'): string {
  if (process.env.QUADRA_A_PID_FILE) {
    return process.env.QUADRA_A_PID_FILE;
  }

  return buildDerivedPath('pid', runtime);
}

export function getDaemonSocketClientCandidates(runtime: 'js' | 'rs' = 'js'): string[] {
  if (process.env.QUADRA_A_SOCKET_PATH) {
    return [process.env.QUADRA_A_SOCKET_PATH];
  }

  const peerRuntime = runtime === 'js' ? 'rs' : 'js';

  return uniquePaths([
    getDaemonSocketPath(runtime),
    getDaemonSocketPath(peerRuntime),
    getLegacyDaemonSocketPath(runtime),
    getLegacyDaemonSocketPath(peerRuntime),
  ]);
}

export function getPeerDaemonSocketPath(runtime: 'js' | 'rs' = 'js'): string {
  return getDaemonSocketPath(runtime === 'js' ? 'rs' : 'js');
}

export const DAEMON_SOCKET_PATH = getDaemonSocketPath('js');
export const DAEMON_PID_FILE = getDaemonPidPath('js');
export const PEER_DAEMON_SOCKET_PATH = getPeerDaemonSocketPath('js');
export const DAEMON_REQUEST_TIMEOUT_MS = 30_000;
export const DAEMON_START_TIMEOUT_MS = 10_000;
