import type {
  ClaimedPreKeyBundle,
  LocalDeviceState,
  LocalE2EConfig,
  LocalOneTimePreKeyState,
  PublishedDeviceDirectoryEntry,
  PublishedOneTimePreKey,
  PublishedPreKeyBundle,
} from './types.js';
import { bytesToHex, generateX25519KeyPair, hexToBytes, randomBytes } from './x25519.js';
import { signSignedPreKeyRecord } from './signed-pre-key.js';

const DEFAULT_ONE_TIME_PRE_KEY_COUNT = 16;

function nowMs(): number {
  return Date.now();
}

function generateDeviceId(): string {
  return `device-${bytesToHex(randomBytes(8))}`;
}

function buildOneTimePreKeys(count: number, createdAt: number): LocalOneTimePreKeyState[] {
  return Array.from({ length: count }, (_, index) => {
    const keyPair = generateX25519KeyPair();
    return {
      keyId: index + 1,
      publicKey: bytesToHex(keyPair.publicKey),
      privateKey: bytesToHex(keyPair.privateKey),
      createdAt,
    };
  });
}

function buildPublishedOneTimePreKeys(device: LocalDeviceState): PublishedOneTimePreKey[] {
  return device.oneTimePreKeys
    .filter((key) => !key.claimedAt)
    .sort((left, right) => left.keyId - right.keyId)
    .map((key) => ({
      keyId: key.keyId,
      publicKey: key.publicKey,
    }));
}

function cloneLocalDeviceState(device: LocalDeviceState): LocalDeviceState {
  return {
    ...device,
    identityKey: { ...device.identityKey },
    signedPreKey: { ...device.signedPreKey },
    oneTimePreKeys: device.oneTimePreKeys.map((key) => ({ ...key })),
    sessions: { ...device.sessions },
  };
}

function cloneLocalE2EConfig(config: LocalE2EConfig): LocalE2EConfig {
  return {
    currentDeviceId: config.currentDeviceId,
    devices: Object.fromEntries(
      Object.entries(config.devices).map(([deviceId, device]) => [deviceId, cloneLocalDeviceState(device)]),
    ),
  };
}

function nextSignedPreKeyId(config: LocalE2EConfig, explicitSignedPreKeyId?: number): number {
  if (explicitSignedPreKeyId !== undefined) {
    return explicitSignedPreKeyId;
  }

  const currentMax = Object.values(config.devices)
    .map((device) => device.signedPreKey.signedPreKeyId)
    .reduce((max, value) => Math.max(max, value), 0);
  return currentMax + 1;
}

export async function createLocalDeviceState(
  signingPrivateKey: Uint8Array,
  options: {
    deviceId?: string;
    signedPreKeyId?: number;
    oneTimePreKeyCount?: number;
    now?: number;
  } = {},
): Promise<LocalDeviceState> {
  const createdAt = options.now ?? nowMs();
  const deviceId = options.deviceId ?? generateDeviceId();
  const signedPreKeyId = options.signedPreKeyId ?? 1;
  const oneTimePreKeyCount = options.oneTimePreKeyCount ?? DEFAULT_ONE_TIME_PRE_KEY_COUNT;

  const identityKeyPair = generateX25519KeyPair();
  const signedPreKeyPair = generateX25519KeyPair();
  const signedPreKeyRecord = await signSignedPreKeyRecord(
    deviceId,
    signedPreKeyId,
    signedPreKeyPair.publicKey,
    signingPrivateKey,
  );

  return {
    deviceId,
    createdAt,
    identityKey: {
      publicKey: bytesToHex(identityKeyPair.publicKey),
      privateKey: bytesToHex(identityKeyPair.privateKey),
    },
    signedPreKey: {
      signedPreKeyId,
      publicKey: bytesToHex(signedPreKeyPair.publicKey),
      privateKey: bytesToHex(signedPreKeyPair.privateKey),
      signature: bytesToHex(signedPreKeyRecord.signature),
      createdAt,
    },
    oneTimePreKeys: buildOneTimePreKeys(oneTimePreKeyCount, createdAt),
    lastResupplyAt: createdAt,
    sessions: {},
  };
}

export async function createInitialLocalE2EConfig(
  signingPrivateKey: Uint8Array,
  options: {
    deviceId?: string;
    signedPreKeyId?: number;
    oneTimePreKeyCount?: number;
    now?: number;
  } = {},
): Promise<LocalE2EConfig> {
  const device = await createLocalDeviceState(signingPrivateKey, options);
  return {
    currentDeviceId: device.deviceId,
    devices: {
      [device.deviceId]: device,
    },
  };
}

export function buildPublishedDeviceDirectoryEntry(
  device: LocalDeviceState,
): PublishedDeviceDirectoryEntry {
  return {
    deviceId: device.deviceId,
    identityKeyPublic: device.identityKey.publicKey,
    signedPreKeyPublic: device.signedPreKey.publicKey,
    signedPreKeyId: device.signedPreKey.signedPreKeyId,
    signedPreKeySignature: device.signedPreKey.signature,
    oneTimePreKeyCount: device.oneTimePreKeys.filter((key) => !key.claimedAt).length,
    lastResupplyAt: device.lastResupplyAt,
  };
}

export function buildPublishedDeviceDirectory(
  config: LocalE2EConfig,
): PublishedDeviceDirectoryEntry[] {
  return Object.values(config.devices)
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map(buildPublishedDeviceDirectoryEntry);
}

export function buildPublishedPreKeyBundle(
  device: LocalDeviceState,
): PublishedPreKeyBundle {
  return {
    ...buildPublishedDeviceDirectoryEntry(device),
    oneTimePreKeys: buildPublishedOneTimePreKeys(device),
  };
}

export function buildPublishedPreKeyBundles(
  config: LocalE2EConfig,
): PublishedPreKeyBundle[] {
  return Object.values(config.devices)
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map(buildPublishedPreKeyBundle);
}

export function buildClaimedPreKeyBundle(
  bundle: PublishedPreKeyBundle,
  oneTimePreKey?: PublishedOneTimePreKey,
): ClaimedPreKeyBundle {
  return {
    deviceId: bundle.deviceId,
    identityKeyPublic: bundle.identityKeyPublic,
    signedPreKeyPublic: bundle.signedPreKeyPublic,
    signedPreKeyId: bundle.signedPreKeyId,
    signedPreKeySignature: bundle.signedPreKeySignature,
    oneTimePreKey,
    remainingOneTimePreKeyCount: oneTimePreKey
      ? Math.max(bundle.oneTimePreKeys.length - 1, 0)
      : bundle.oneTimePreKeys.length,
    lastResupplyAt: bundle.lastResupplyAt,
    oneTimePreKeyCount: oneTimePreKey
      ? Math.max(bundle.oneTimePreKeys.length - 1, 0)
      : bundle.oneTimePreKeys.length,
  };
}

export async function rotateLocalDeviceSignedPreKey(
  signingPrivateKey: Uint8Array,
  config: LocalE2EConfig,
  deviceId: string,
  options: {
    signedPreKeyId?: number;
    oneTimePreKeyCount?: number;
    now?: number;
  } = {},
): Promise<LocalE2EConfig> {
  const existingDevice = config.devices[deviceId];
  if (!existingDevice) {
    throw new Error(`Missing local E2E device state for ${deviceId}`);
  }

  const createdAt = options.now ?? nowMs();
  const signedPreKeyId = nextSignedPreKeyId(config, options.signedPreKeyId);
  const oneTimePreKeyCount = options.oneTimePreKeyCount
    ?? Math.max(existingDevice.oneTimePreKeys.filter((key) => !key.claimedAt).length, DEFAULT_ONE_TIME_PRE_KEY_COUNT);
  const signedPreKeyPair = generateX25519KeyPair();
  const signedPreKeyRecord = await signSignedPreKeyRecord(
    deviceId,
    signedPreKeyId,
    signedPreKeyPair.publicKey,
    signingPrivateKey,
  );

  const nextConfig = cloneLocalE2EConfig(config);
  const nextDevice = nextConfig.devices[deviceId];
  nextDevice.signedPreKey = {
    signedPreKeyId,
    publicKey: bytesToHex(signedPreKeyPair.publicKey),
    privateKey: bytesToHex(signedPreKeyPair.privateKey),
    signature: bytesToHex(signedPreKeyRecord.signature),
    createdAt,
  };
  nextDevice.oneTimePreKeys = buildOneTimePreKeys(oneTimePreKeyCount, createdAt);
  nextDevice.lastResupplyAt = createdAt;

  return nextConfig;
}

export function getCurrentDeviceState(config: LocalE2EConfig): LocalDeviceState {
  const device = config.devices[config.currentDeviceId];
  if (!device) {
    throw new Error(`Missing current E2E device state for ${config.currentDeviceId}`);
  }
  return device;
}

export function decodeDevicePublicKeyHex(value: string): Uint8Array {
  return hexToBytes(value);
}
