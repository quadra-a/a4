import {
  bytesToHex,
  concatBytes,
  createInitialLocalE2EConfig,
  hexToBytes,
  randomBytes,
  type LocalE2EConfig,
} from '@quadra-a/protocol';
import { sha256 } from '@noble/hashes/sha256';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig, type QuadraAConfig } from './config.js';
import { QUADRA_A_HOME } from './constants.js';

interface IdentityLike {
  did: string;
  privateKey: string;
}

export interface DeviceIdentity {
  seed: string;
  deviceId: string;
}

export interface LocalE2EStateTransactionContext {
  config: QuadraAConfig;
  e2eConfig: LocalE2EConfig;
  deviceIdentity: DeviceIdentity;
  created: boolean;
  setE2EConfig(next: LocalE2EConfig): void;
}

interface LockOwnerMetadata {
  holderId: string;
  runtime: 'js';
  pid: number;
  acquiredAt: number;
  leaseUntil: number;
}

const DEVICE_ID_DERIVATION_DOMAIN = new TextEncoder().encode('quadra-a/device-id/v1');
const LOCK_LEASE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 3_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_BASE_MS = 50;
const LOCK_RETRY_JITTER_MS = 200;

const LOCAL_E2E_STATE_LOCK_PATH = join(QUADRA_A_HOME, 'locks', 'e2e-state.lock');
const LOCAL_E2E_STATE_LOCK_OWNER_PATH = join(LOCAL_E2E_STATE_LOCK_PATH, 'owner.json');

let processLockHolderId: string | null = null;
let processLockRefCount = 0;
let processLockHeartbeat: NodeJS.Timeout | null = null;

function configPath(): string {
  return (getConfig() as ReturnType<typeof getConfig> & { path: string }).path;
}

function isValidLocalE2EConfig(config: LocalE2EConfig | undefined): config is LocalE2EConfig {
  return Boolean(config?.currentDeviceId && config.devices?.[config.currentDeviceId]);
}

function isValidDeviceIdentity(deviceIdentity: QuadraAConfig['deviceIdentity']): deviceIdentity is DeviceIdentity {
  return Boolean(
    deviceIdentity
    && typeof deviceIdentity.seed === 'string'
    && deviceIdentity.seed.length > 0
    && typeof deviceIdentity.deviceId === 'string'
    && deviceIdentity.deviceId.length > 0,
  );
}

function deriveDeviceId(seedHex: string): string {
  const digest = sha256(concatBytes(DEVICE_ID_DERIVATION_DOMAIN, hexToBytes(seedHex)));
  return `device-${bytesToHex(digest.slice(0, 8))}`;
}

function createDeviceIdentity(existingDeviceId?: string): DeviceIdentity {
  const seed = bytesToHex(randomBytes(32));
  return {
    seed,
    deviceId: existingDeviceId ?? deriveDeviceId(seed),
  };
}

async function readStoredConfigSnapshot(): Promise<QuadraAConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    return JSON.parse(raw) as QuadraAConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeStoredConfigSnapshot(config: QuadraAConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

async function writeLockOwnerFile(holderId: string): Promise<void> {
  const now = Date.now();
  const owner: LockOwnerMetadata = {
    holderId,
    runtime: 'js',
    pid: process.pid,
    acquiredAt: now,
    leaseUntil: now + LOCK_LEASE_MS,
  };
  await writeFile(LOCAL_E2E_STATE_LOCK_OWNER_PATH, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
}

async function readLockOwnerFile(): Promise<LockOwnerMetadata | null> {
  try {
    const raw = await readFile(LOCAL_E2E_STATE_LOCK_OWNER_PATH, 'utf8');
    return JSON.parse(raw) as LockOwnerMetadata;
  } catch {
    return null;
  }
}

async function removeLockDir(): Promise<void> {
  await rm(LOCAL_E2E_STATE_LOCK_PATH, { recursive: true, force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireProcessLock(): Promise<void> {
  if (processLockRefCount > 0) {
    processLockRefCount += 1;
    return;
  }

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const holderId = randomUUID();
  await mkdir(dirname(LOCAL_E2E_STATE_LOCK_PATH), { recursive: true });

  while (true) {
    try {
      await mkdir(LOCAL_E2E_STATE_LOCK_PATH);
      await writeLockOwnerFile(holderId);
      processLockHolderId = holderId;
      processLockRefCount = 1;
      processLockHeartbeat = setInterval(() => {
        if (!processLockHolderId) {
          return;
        }
        void writeLockOwnerFile(processLockHolderId).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS);
      return;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== 'EEXIST') {
        throw error;
      }

      const owner = await readLockOwnerFile();
      if (!owner || owner.leaseUntil < Date.now()) {
        await removeLockDir();
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring local E2E state lock at ${LOCAL_E2E_STATE_LOCK_PATH}`);
      }

      const delay = LOCK_RETRY_BASE_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS);
      await sleep(delay);
    }
  }
}

async function releaseProcessLock(): Promise<void> {
  if (processLockRefCount === 0) {
    return;
  }

  processLockRefCount -= 1;
  if (processLockRefCount > 0) {
    return;
  }

  if (processLockHeartbeat) {
    clearInterval(processLockHeartbeat);
    processLockHeartbeat = null;
  }

  processLockHolderId = null;
  await removeLockDir();
}

async function ensureTransactionState(
  config: QuadraAConfig,
  identity: IdentityLike,
): Promise<{ config: QuadraAConfig; e2eConfig: LocalE2EConfig; deviceIdentity: DeviceIdentity; created: boolean; dirty: boolean }> {
  const nextConfig: QuadraAConfig = {
    ...config,
    aliases: config.aliases ? { ...config.aliases } : undefined,
    identity: config.identity ? { ...config.identity } : undefined,
    deviceIdentity: config.deviceIdentity ? { ...config.deviceIdentity } : undefined,
    agentCard: config.agentCard ? { ...config.agentCard } : undefined,
    e2e: config.e2e ? structuredClone(config.e2e) : undefined,
  };

  let dirty = false;
  if (!isValidDeviceIdentity(nextConfig.deviceIdentity)) {
    const existingDeviceId = isValidLocalE2EConfig(nextConfig.e2e)
      ? nextConfig.e2e.currentDeviceId
      : undefined;
    nextConfig.deviceIdentity = createDeviceIdentity(existingDeviceId);
    dirty = true;
  }

  let created = false;
  if (!isValidLocalE2EConfig(nextConfig.e2e)) {
    nextConfig.e2e = await createInitialLocalE2EConfig(hexToBytes(identity.privateKey), {
      deviceId: nextConfig.deviceIdentity.deviceId,
    });
    dirty = true;
    created = true;
  }

  return {
    config: nextConfig,
    e2eConfig: nextConfig.e2e,
    deviceIdentity: nextConfig.deviceIdentity,
    created,
    dirty,
  };
}

export async function withLocalE2EStateTransaction<T>(
  identity: IdentityLike,
  callback: (context: LocalE2EStateTransactionContext) => Promise<T>,
): Promise<T> {
  await acquireProcessLock();
  try {
    const snapshot = await readStoredConfigSnapshot();
    const ensured = await ensureTransactionState(snapshot, identity);
    let dirty = ensured.dirty;
    const context: LocalE2EStateTransactionContext = {
      config: ensured.config,
      e2eConfig: ensured.e2eConfig,
      deviceIdentity: ensured.deviceIdentity,
      created: ensured.created,
      setE2EConfig(next) {
        context.e2eConfig = next;
        context.config.e2e = next;
        dirty = true;
      },
    };

    const result = await callback(context);
    if (dirty) {
      await writeStoredConfigSnapshot(context.config);
    }
    return result;
  } finally {
    await releaseProcessLock();
  }
}

export {
  LOCAL_E2E_STATE_LOCK_PATH,
  LOCAL_E2E_STATE_LOCK_OWNER_PATH,
};
