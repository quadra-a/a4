import {
  bytesToHex,
  concatBytes,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  createInitialLocalE2EConfig,
  hexToBytes,
  randomBytes,
  type LocalE2EConfig,
  type PublishedDeviceDirectoryEntry,
  type PublishedPreKeyBundle,
} from '@quadra-a/protocol';
import { sha256 } from '@noble/hashes/sha256';
import {
  getDeviceIdentity,
  getE2EConfig,
  getIdentity,
  setDeviceIdentity,
  setE2EConfig,
  type QuadraAConfig,
} from './config.js';

interface IdentityLike {
  did: string;
  privateKey: string;
}

export type DeviceIdentity = NonNullable<QuadraAConfig['deviceIdentity']>;

const DEVICE_ID_DERIVATION_DOMAIN = new TextEncoder().encode('quadra-a/device-id/v1');

function matchesPersistedIdentity(identity: IdentityLike): boolean {
  const persisted = getIdentity();
  return persisted?.did === identity.did && persisted.privateKey === identity.privateKey;
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

export function deriveDeviceId(seedHex: string): string {
  const digest = sha256(concatBytes(DEVICE_ID_DERIVATION_DOMAIN, hexToBytes(seedHex)));
  return `device-${bytesToHex(digest.slice(0, 8))}`;
}

export function createDeviceIdentity(seed = randomBytes(32)): DeviceIdentity {
  const seedHex = bytesToHex(seed);
  return {
    seed: seedHex,
    deviceId: deriveDeviceId(seedHex),
  };
}

export function ensurePersistedDeviceIdentity(): { deviceIdentity: DeviceIdentity; created: boolean } {
  const existing = getDeviceIdentity();
  if (isValidDeviceIdentity(existing)) {
    return {
      deviceIdentity: existing,
      created: false,
    };
  }

  const persistedE2E = getE2EConfig();
  const deviceIdentity = isValidLocalE2EConfig(persistedE2E)
    ? {
        seed: bytesToHex(randomBytes(32)),
        deviceId: persistedE2E.currentDeviceId,
      }
    : createDeviceIdentity();

  setDeviceIdentity(deviceIdentity);
  return {
    deviceIdentity,
    created: true,
  };
}

export async function ensurePersistedE2EConfig(
  identity: IdentityLike,
): Promise<{ e2eConfig: LocalE2EConfig; created: boolean }> {
  const existing = getE2EConfig();
  if (isValidLocalE2EConfig(existing)) {
    ensurePersistedDeviceIdentity();
    return {
      e2eConfig: existing,
      created: false,
    };
  }

  const { deviceIdentity } = ensurePersistedDeviceIdentity();
  const e2eConfig = await createInitialLocalE2EConfig(hexToBytes(identity.privateKey), {
    deviceId: deviceIdentity.deviceId,
  });
  setE2EConfig(e2eConfig);
  return {
    e2eConfig,
    created: true,
  };
}

export async function resolveE2EConfig(identity: IdentityLike): Promise<LocalE2EConfig> {
  if (matchesPersistedIdentity(identity)) {
    return (await ensurePersistedE2EConfig(identity)).e2eConfig;
  }

  return createInitialLocalE2EConfig(hexToBytes(identity.privateKey), {
    deviceId: createDeviceIdentity().deviceId,
  });
}

export async function resolvePublishedDevices(
  identity: IdentityLike,
): Promise<PublishedDeviceDirectoryEntry[]> {
  if (!matchesPersistedIdentity(identity)) {
    return [];
  }

  const e2eConfig = await resolveE2EConfig(identity);
  return buildPublishedDeviceDirectory(e2eConfig);
}

export async function resolvePublishedPreKeyBundles(
  identity: IdentityLike,
): Promise<PublishedPreKeyBundle[]> {
  if (!matchesPersistedIdentity(identity)) {
    return [];
  }

  const e2eConfig = await resolveE2EConfig(identity);
  return buildPublishedPreKeyBundles(e2eConfig);
}
