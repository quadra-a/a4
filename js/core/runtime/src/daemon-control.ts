import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DAEMON_PID_FILE,
  DAEMON_SOCKET_PATH,
  DAEMON_START_TIMEOUT_MS,
} from './constants.js';
import { DaemonClient } from './daemon-client.js';
import { QuadraADaemon } from './daemon-server.js';
import type {
  ReachabilityPolicyResponse,
  SetReachabilityPolicyParams,
} from './daemon-types.js';
import type { ReachabilityStatus } from './reachability.js';

export interface DaemonStatus {
  did: string;
  connectedRelays?: string[];
  knownRelays?: string[];
  reachabilityPolicy?: ReachabilityPolicyResponse['policy'];
  reachabilityStatus?: ReachabilityStatus;
  peerCount?: number;
}

export interface DaemonStartResult {
  status: 'started' | 'already_running';
  did: string;
  socketPath: string;
}

export const PID_FILE = DAEMON_PID_FILE;
export const SOCKET_PATH = DAEMON_SOCKET_PATH;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDaemonEntryPath(): string {
  return fileURLToPath(new URL('./daemon-entry.js', import.meta.url));
}

async function waitForDaemonReady(client: DaemonClient): Promise<DaemonStatus> {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await client.isDaemonRunning()) {
      return getDaemonStatus();
    }
    await wait(250);
  }

  throw new Error('Failed to start daemon (timeout)');
}

export async function isDaemonRunning(): Promise<boolean> {
  const client = new DaemonClient(SOCKET_PATH);
  return client.isDaemonRunning();
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const client = new DaemonClient(SOCKET_PATH);
  return client.send<DaemonStatus>('status', {});
}

export async function getDaemonReachabilityPolicy(): Promise<ReachabilityPolicyResponse> {
  const client = new DaemonClient(SOCKET_PATH);
  return client.send<ReachabilityPolicyResponse>('get_reachability_policy', {});
}

export async function getDaemonReachabilityStatus(): Promise<ReachabilityStatus> {
  const client = new DaemonClient(SOCKET_PATH);
  return client.send<ReachabilityStatus>('get_reachability_status', {});
}

export async function setDaemonReachabilityPolicy(
  policy: SetReachabilityPolicyParams['policy'],
): Promise<ReachabilityPolicyResponse> {
  const client = new DaemonClient(SOCKET_PATH);
  return client.send<ReachabilityPolicyResponse, SetReachabilityPolicyParams>('set_reachability_policy', { policy });
}

export async function resetDaemonReachabilityPolicy(): Promise<ReachabilityPolicyResponse> {
  const client = new DaemonClient(SOCKET_PATH);
  return client.send<ReachabilityPolicyResponse>('reset_reachability_policy', {});
}

export async function startDaemonInBackground(_entryHint?: string): Promise<DaemonStartResult> {
  const client = new DaemonClient(SOCKET_PATH);

  if (await client.isDaemonRunning()) {
    const status = await getDaemonStatus();
    return {
      status: 'already_running',
      did: status.did,
      socketPath: SOCKET_PATH,
    };
  }

  const child = spawn(process.execPath, [resolveDaemonEntryPath()], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  if (child.pid) {
    try {
      writeFileSync(PID_FILE, child.pid.toString());
    } catch {
      // Ignore PID file write errors
    }
  }

  const status = await waitForDaemonReady(client);
  return {
    status: 'started',
    did: status.did,
    socketPath: SOCKET_PATH,
  };
}

export async function ensureDaemonRunning(entryHint?: string): Promise<DaemonStartResult> {
  return startDaemonInBackground(entryHint);
}

export async function runDaemonForeground(): Promise<never> {
  const daemon = new QuadraADaemon(SOCKET_PATH);
  await daemon.start();

  const shutdown = async () => {
    await daemon.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  return new Promise(() => undefined);
}

export function cleanupDaemonArtifacts(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  } catch {
    void 0;
  }

  try {
    if (existsSync(SOCKET_PATH)) {
      unlinkSync(SOCKET_PATH);
    }
  } catch {
    void 0;
  }
}

export async function stopDaemon(): Promise<boolean> {
  const client = new DaemonClient(SOCKET_PATH);

  if (!(await client.isDaemonRunning())) {
    cleanupDaemonArtifacts();
    return false;
  }

  await client.send('shutdown', {});
  cleanupDaemonArtifacts();
  return true;
}

export async function restartDaemon(entryHint?: string): Promise<{ did: string }> {
  const client = new DaemonClient(SOCKET_PATH);

  if (await client.isDaemonRunning()) {
    await client.send('shutdown', {});
    await wait(1_000);
  }

  cleanupDaemonArtifacts();
  const result = await startDaemonInBackground(entryHint);

  return { did: result.did };
}
