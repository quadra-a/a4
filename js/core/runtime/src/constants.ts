import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const QUADRA_A_HOME =
  process.env.QUADRA_A_HOME ||
  join(homedir(), '.quadra-a');

// Generate a unique socket/pid path based on QUADRA_A_HOME to allow multiple isolated agents
function getIsolatedPath(baseName: string): string {
  // If custom path is provided via env var, use it directly
  const envVar = baseName === 'sock' ? 'QUADRA_A_SOCKET_PATH' : 'QUADRA_A_PID_FILE';
  if (process.env[envVar]) {
    return process.env[envVar];
  }

  // For default home (~/.quadra-a), use simple path
  const defaultHome = join(homedir(), '.quadra-a');
  if (QUADRA_A_HOME === defaultHome) {
    return `/tmp/quadra-a.${baseName}`;
  }

  // For custom QUADRA_A_HOME, create unique path based on hash
  const hash = createHash('sha256').update(QUADRA_A_HOME).digest('hex').slice(0, 8);
  return `/tmp/quadra-a-${hash}.${baseName}`;
}

export const DAEMON_SOCKET_PATH = getIsolatedPath('sock');
export const DAEMON_PID_FILE = getIsolatedPath('pid');
export const DAEMON_REQUEST_TIMEOUT_MS = 30_000;
export const DAEMON_START_TIMEOUT_MS = 10_000;
