import { homedir } from 'node:os';
import { join } from 'node:path';

export const QUADRA_A_HOME =
  process.env.QUADRA_A_HOME ||
  join(homedir(), '.quadra-a');
export const DAEMON_SOCKET_PATH =
  process.env.QUADRA_A_SOCKET_PATH ||
  '/tmp/quadra-a.sock';
export const DAEMON_PID_FILE =
  process.env.QUADRA_A_PID_FILE ||
  '/tmp/quadra-a.pid';
export const DAEMON_REQUEST_TIMEOUT_MS = 30_000;
export const DAEMON_START_TIMEOUT_MS = 10_000;
