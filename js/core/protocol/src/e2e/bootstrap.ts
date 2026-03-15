import { EncryptionError } from '../utils/errors.js';
import { getCurrentDeviceState } from './device-state.js';
import { decryptPreKeyMessage, encryptPreKeyMessage } from './messages.js';
import {
  createInitiatorRatchetSession,
  createResponderRatchetSession,
  type LocalSessionState,
} from './ratchet.js';
import type {
  ClaimedPreKeyBundle,
  LocalDeviceState,
  LocalE2EConfig,
  PreKeyMessage,
  PublishedDeviceDirectoryEntry,
} from './types.js';
import { E2E_PROTOCOL_VERSION } from './types.js';
import {
  bytesToHex,
  generateX25519KeyPair,
  hexToBytes,
  randomBytes,
  type X25519KeyPair,
} from './x25519.js';
import { deriveX3dhInitiatorSharedSecret, deriveX3dhResponderSharedSecret } from './x3dh.js';

export interface LocalSessionBootstrapState {
  selfIdentityKey: string;
  peerIdentityKey: string;
  initiatorEphemeralKey: string;
  recipientSignedPreKeyId: number;
  recipientSignedPreKeyPublic: string;
  recipientOneTimePreKeyId?: number;
}

export interface BuildInitiatorPreKeyMessageInput {
  e2eConfig: LocalE2EConfig;
  senderDid: string;
  receiverDid: string;
  recipientDevice: PublishedDeviceDirectoryEntry;
  claimedBundle: ClaimedPreKeyBundle;
  plaintext: Uint8Array;
  sessionId?: string;
  messageId?: string;
  nonce?: Uint8Array;
  ephemeralKeyPair?: X25519KeyPair;
  now?: number;
}

export interface BuildInitiatorPreKeyMessageResult {
  message: PreKeyMessage;
  session: LocalSessionState;
  e2eConfig: LocalE2EConfig;
  sharedSecret: Uint8Array;
}

export interface ConsumeResponderPreKeyMessageInput {
  e2eConfig: LocalE2EConfig;
  receiverDid: string;
  message: PreKeyMessage;
  now?: number;
}

export interface ConsumeResponderPreKeyMessageResult {
  plaintext: Uint8Array;
  session: LocalSessionState;
  e2eConfig: LocalE2EConfig;
  sharedSecret: Uint8Array;
}

function nowMs(): number {
  return Date.now();
}

function generateSessionId(): string {
  return `e2e-session-${bytesToHex(randomBytes(12))}`;
}

function generateMessageId(): string {
  return `e2e-msg-${bytesToHex(randomBytes(12))}`;
}

function cloneDeviceState(device: LocalDeviceState): LocalDeviceState {
  return {
    ...device,
    identityKey: { ...device.identityKey },
    signedPreKey: { ...device.signedPreKey },
    oneTimePreKeys: device.oneTimePreKeys.map((key) => ({ ...key })),
    sessions: { ...device.sessions },
  };
}

function cloneE2EConfig(config: LocalE2EConfig): LocalE2EConfig {
  return {
    currentDeviceId: config.currentDeviceId,
    devices: Object.fromEntries(
      Object.entries(config.devices).map(([deviceId, device]) => [deviceId, cloneDeviceState(device)]),
    ),
  };
}

function getDeviceState(config: LocalE2EConfig, deviceId: string): LocalDeviceState {
  const device = config.devices[deviceId];
  if (!device) {
    throw new EncryptionError(`Missing local E2E device ${deviceId}`);
  }
  return device;
}

function assertBundleMatchesDirectory(
  recipientDevice: PublishedDeviceDirectoryEntry,
  claimedBundle: ClaimedPreKeyBundle,
): void {
  const fields: Array<keyof PublishedDeviceDirectoryEntry> = [
    'deviceId',
    'identityKeyPublic',
    'signedPreKeyPublic',
    'signedPreKeyId',
    'signedPreKeySignature',
    'lastResupplyAt',
  ];

  for (const field of fields) {
    if (recipientDevice[field] !== claimedBundle[field]) {
      throw new EncryptionError('Claimed pre-key bundle does not match trusted device directory entry', {
        field,
        recipientDevice: recipientDevice[field],
        claimedBundle: claimedBundle[field],
      });
    }
  }
}

function buildBootstrapState(input: {
  selfIdentityKey: string;
  peerIdentityKey: string;
  initiatorEphemeralKey: string;
  recipientSignedPreKeyId: number;
  recipientSignedPreKeyPublic: string;
  recipientOneTimePreKeyId?: number;
}): LocalSessionBootstrapState {
  return {
    selfIdentityKey: input.selfIdentityKey,
    peerIdentityKey: input.peerIdentityKey,
    initiatorEphemeralKey: input.initiatorEphemeralKey,
    recipientSignedPreKeyId: input.recipientSignedPreKeyId,
    recipientSignedPreKeyPublic: input.recipientSignedPreKeyPublic,
    ...(input.recipientOneTimePreKeyId !== undefined ? { recipientOneTimePreKeyId: input.recipientOneTimePreKeyId } : {}),
  };
}

export function buildLocalSessionKey(peerDid: string, peerDeviceId: string): string {
  return `${peerDid}:${peerDeviceId}`;
}

export function loadLocalSession(
  config: LocalE2EConfig,
  deviceId: string,
  peerDid: string,
  peerDeviceId: string,
): LocalSessionState | undefined {
  return config.devices[deviceId]?.sessions[buildLocalSessionKey(peerDid, peerDeviceId)] as LocalSessionState | undefined;
}

export function storeLocalSession(
  config: LocalE2EConfig,
  deviceId: string,
  session: LocalSessionState,
): LocalE2EConfig {
  const nextConfig = cloneE2EConfig(config);
  const device = getDeviceState(nextConfig, deviceId);
  device.sessions[buildLocalSessionKey(session.peerDid, session.peerDeviceId)] = session;
  return nextConfig;
}

export function buildInitiatorPreKeyMessage(
  input: BuildInitiatorPreKeyMessageInput,
): BuildInitiatorPreKeyMessageResult {
  assertBundleMatchesDirectory(input.recipientDevice, input.claimedBundle);

  const now = input.now ?? nowMs();
  const device = getCurrentDeviceState(input.e2eConfig);
  const ephemeralKeyPair = input.ephemeralKeyPair ?? generateX25519KeyPair();
  const sharedSecret = deriveX3dhInitiatorSharedSecret({
    initiatorIdentityPrivate: hexToBytes(device.identityKey.privateKey),
    initiatorEphemeralPrivate: ephemeralKeyPair.privateKey,
    recipientIdentityPublic: hexToBytes(input.claimedBundle.identityKeyPublic),
    recipientSignedPreKeyPublic: hexToBytes(input.claimedBundle.signedPreKeyPublic),
    recipientOneTimePreKeyPublic: input.claimedBundle.oneTimePreKey
      ? hexToBytes(input.claimedBundle.oneTimePreKey.publicKey)
      : undefined,
  });

  const sessionId = input.sessionId ?? generateSessionId();
  const messageId = input.messageId ?? generateMessageId();
  const nonce = input.nonce ?? randomBytes(24);
  const message = encryptPreKeyMessage({
    version: E2E_PROTOCOL_VERSION,
    type: 'PREKEY_MESSAGE',
    senderDid: input.senderDid,
    receiverDid: input.receiverDid,
    senderDeviceId: device.deviceId,
    receiverDeviceId: input.claimedBundle.deviceId,
    sessionId,
    messageId,
    initiatorIdentityKey: hexToBytes(device.identityKey.publicKey),
    initiatorEphemeralKey: ephemeralKeyPair.publicKey,
    recipientSignedPreKeyId: input.claimedBundle.signedPreKeyId,
    ...(input.claimedBundle.oneTimePreKey ? { recipientOneTimePreKeyId: input.claimedBundle.oneTimePreKey.keyId } : {}),
    nonce,
  }, sharedSecret, input.plaintext);

  const bootstrap = buildBootstrapState({
    selfIdentityKey: device.identityKey.publicKey,
    peerIdentityKey: input.claimedBundle.identityKeyPublic,
    initiatorEphemeralKey: bytesToHex(ephemeralKeyPair.publicKey),
    recipientSignedPreKeyId: input.claimedBundle.signedPreKeyId,
    recipientSignedPreKeyPublic: input.claimedBundle.signedPreKeyPublic,
    recipientOneTimePreKeyId: input.claimedBundle.oneTimePreKey?.keyId,
  });
  const session = createInitiatorRatchetSession({
    sessionId,
    peerDid: input.receiverDid,
    peerDeviceId: input.claimedBundle.deviceId,
    selfDeviceId: device.deviceId,
    role: 'initiator',
    rootKey: sharedSecret,
    currentRatchetKey: ephemeralKeyPair,
    remoteRatchetPublicKey: hexToBytes(input.claimedBundle.signedPreKeyPublic),
    bootstrap,
    createdAt: now,
  });

  return {
    message,
    session,
    e2eConfig: storeLocalSession(input.e2eConfig, device.deviceId, session),
    sharedSecret,
  };
}

export function consumeResponderPreKeyMessage(
  input: ConsumeResponderPreKeyMessageInput,
): ConsumeResponderPreKeyMessageResult {
  if (input.message.receiverDid !== input.receiverDid) {
    throw new EncryptionError('PREKEY_MESSAGE receiver DID mismatch', {
      expected: input.receiverDid,
      actual: input.message.receiverDid,
    });
  }

  const now = input.now ?? nowMs();
  const nextConfig = cloneE2EConfig(input.e2eConfig);
  const device = getDeviceState(nextConfig, input.message.receiverDeviceId);
  const oneTimePreKey = input.message.recipientOneTimePreKeyId === undefined
    ? undefined
    : device.oneTimePreKeys.find((key) => key.keyId === input.message.recipientOneTimePreKeyId);

  if (input.message.recipientOneTimePreKeyId !== undefined && !oneTimePreKey) {
    throw new EncryptionError('Missing claimed one-time pre-key for PREKEY_MESSAGE', {
      receiverDeviceId: input.message.receiverDeviceId,
      recipientOneTimePreKeyId: input.message.recipientOneTimePreKeyId,
    });
  }

  if (oneTimePreKey?.claimedAt !== undefined) {
    throw new EncryptionError('Claimed one-time pre-key already consumed for PREKEY_MESSAGE', {
      receiverDeviceId: input.message.receiverDeviceId,
      recipientOneTimePreKeyId: input.message.recipientOneTimePreKeyId,
      claimedAt: oneTimePreKey.claimedAt,
    });
  }

  if (input.message.recipientSignedPreKeyId !== device.signedPreKey.signedPreKeyId) {
    throw new EncryptionError('PREKEY_MESSAGE signed pre-key id does not match current receiver device state', {
      receiverDeviceId: input.message.receiverDeviceId,
      expectedSignedPreKeyId: device.signedPreKey.signedPreKeyId,
      actualSignedPreKeyId: input.message.recipientSignedPreKeyId,
    });
  }

  const sharedSecret = deriveX3dhResponderSharedSecret({
    recipientIdentityPrivate: hexToBytes(device.identityKey.privateKey),
    recipientSignedPreKeyPrivate: hexToBytes(device.signedPreKey.privateKey),
    initiatorIdentityPublic: input.message.initiatorIdentityKey,
    initiatorEphemeralPublic: input.message.initiatorEphemeralKey,
    recipientOneTimePreKeyPrivate: oneTimePreKey ? hexToBytes(oneTimePreKey.privateKey) : undefined,
  });
  const plaintext = decryptPreKeyMessage(input.message, sharedSecret);

  if (oneTimePreKey) {
    oneTimePreKey.claimedAt = now;
  }

  const bootstrap = buildBootstrapState({
    selfIdentityKey: device.identityKey.publicKey,
    peerIdentityKey: bytesToHex(input.message.initiatorIdentityKey),
    initiatorEphemeralKey: bytesToHex(input.message.initiatorEphemeralKey),
    recipientSignedPreKeyId: input.message.recipientSignedPreKeyId,
    recipientSignedPreKeyPublic: device.signedPreKey.publicKey,
    recipientOneTimePreKeyId: input.message.recipientOneTimePreKeyId,
  });
  const session = createResponderRatchetSession({
    sessionId: input.message.sessionId,
    peerDid: input.message.senderDid,
    peerDeviceId: input.message.senderDeviceId,
    selfDeviceId: device.deviceId,
    role: 'responder',
    rootKey: sharedSecret,
    currentRatchetKey: {
      publicKey: hexToBytes(device.signedPreKey.publicKey),
      privateKey: hexToBytes(device.signedPreKey.privateKey),
    },
    remoteRatchetPublicKey: input.message.initiatorEphemeralKey,
    bootstrap,
    createdAt: now,
  });

  return {
    plaintext,
    session,
    e2eConfig: storeLocalSession(nextConfig, device.deviceId, session),
    sharedSecret,
  };
}
