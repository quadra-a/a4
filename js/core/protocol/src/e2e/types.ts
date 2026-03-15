export const E2E_PROTOCOL_VERSION = 1 as const;
export const X3DH_INFO = 'quadra-a/e2e/x3dh/v1';
export const X3DH_SALT = 'quadra-a/e2e/x3dh/salt/v1';
export const SIGNED_PRE_KEY_TYPE = 'SIGNED_PRE_KEY';

export type E2EMessageType = 'PREKEY_MESSAGE' | 'SESSION_MESSAGE';
export type VectorSuite = 'x3dh' | 'double-ratchet' | 'prekey-message' | 'session-message' | 'agent-card-devices';

export interface DeviceDirectoryEntry {
  deviceId: string;
  identityKeyPublic: Uint8Array;
  signedPreKeyPublic: Uint8Array;
  signedPreKeyId: number;
  signedPreKeySignature: Uint8Array;
  oneTimePreKeyCount: number;
  lastResupplyAt: number;
}

export interface PublishedDeviceDirectoryEntry {
  deviceId: string;
  identityKeyPublic: string;
  signedPreKeyPublic: string;
  signedPreKeyId: number;
  signedPreKeySignature: string;
  oneTimePreKeyCount: number;
  lastResupplyAt: number;
}

export interface PublishedOneTimePreKey {
  keyId: number;
  publicKey: string;
}

export interface PublishedPreKeyBundle extends PublishedDeviceDirectoryEntry {
  oneTimePreKeys: PublishedOneTimePreKey[];
}

export interface ClaimedPreKeyBundle extends PublishedDeviceDirectoryEntry {
  oneTimePreKey?: PublishedOneTimePreKey;
  remainingOneTimePreKeyCount: number;
}

export interface LocalDeviceKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface LocalSignedPreKeyState extends LocalDeviceKeyPair {
  signedPreKeyId: number;
  signature: string;
  createdAt: number;
}

export interface LocalOneTimePreKeyState extends LocalDeviceKeyPair {
  keyId: number;
  createdAt: number;
  claimedAt?: number;
}

export interface LocalDeviceState {
  deviceId: string;
  createdAt: number;
  identityKey: LocalDeviceKeyPair;
  signedPreKey: LocalSignedPreKeyState;
  oneTimePreKeys: LocalOneTimePreKeyState[];
  lastResupplyAt: number;
  sessions: Record<string, unknown>;
}

export interface LocalE2EConfig {
  currentDeviceId: string;
  devices: Record<string, LocalDeviceState>;
}

export interface SignedPreKeyRecord {
  deviceId: string;
  signedPreKeyId: number;
  signedPreKeyPublic: Uint8Array;
  signature: Uint8Array;
}

export interface X3DHInitiatorInput {
  initiatorIdentityPrivate: Uint8Array;
  initiatorEphemeralPrivate: Uint8Array;
  recipientIdentityPublic: Uint8Array;
  recipientSignedPreKeyPublic: Uint8Array;
  recipientOneTimePreKeyPublic?: Uint8Array;
}

export interface X3DHResponderInput {
  recipientIdentityPrivate: Uint8Array;
  recipientSignedPreKeyPrivate: Uint8Array;
  initiatorIdentityPublic: Uint8Array;
  initiatorEphemeralPublic: Uint8Array;
  recipientOneTimePreKeyPrivate?: Uint8Array;
}

export interface PreKeyMessage {
  version: number;
  type: 'PREKEY_MESSAGE';
  senderDid: string;
  receiverDid: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  sessionId: string;
  messageId: string;
  initiatorIdentityKey: Uint8Array;
  initiatorEphemeralKey: Uint8Array;
  recipientSignedPreKeyId: number;
  recipientOneTimePreKeyId?: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface SessionMessage {
  version: number;
  type: 'SESSION_MESSAGE';
  senderDid: string;
  receiverDid: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  sessionId: string;
  messageId: string;
  ratchetPublicKey: Uint8Array;
  previousChainLength: number;
  messageNumber: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface VectorCase {
  id: string;
  description: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
  negativeVariants?: Array<{
    id: string;
    mutation: Record<string, unknown>;
    expectedError: string;
  }>;
}

export interface VectorManifest {
  suite: VectorSuite;
  version: number;
  encoding: 'hex' | 'base58btc' | 'utf8' | 'json';
  notes?: string;
  cases: VectorCase[];
}
