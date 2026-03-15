import { EncryptionError } from '../utils/errors.js';
import { decryptSessionMessage, encryptSessionMessage } from './messages.js';
import type { LocalDeviceKeyPair, SessionMessage } from './types.js';
import { E2E_PROTOCOL_VERSION } from './types.js';
import {
  bytesToHex,
  diffieHellmanX25519,
  generateX25519KeyPair,
  hexToBytes,
  hkdfSha256,
  randomBytes,
  type X25519KeyPair,
} from './x25519.js';
import type { LocalSessionBootstrapState } from './bootstrap.js';

export const DOUBLE_RATCHET_ROOT_INFO = 'quadra-a/e2e/double-ratchet/root/v1';
export const DOUBLE_RATCHET_CHAIN_INFO = 'quadra-a/e2e/double-ratchet/chain/v1';
export const DOUBLE_RATCHET_CHAIN_SALT = 'quadra-a/e2e/double-ratchet/chain-salt/v1';
export const MAX_SKIPPED_MESSAGE_KEYS = 64;

export interface SkippedMessageKeyState {
  ratchetPublicKey: string;
  messageNumber: number;
  messageKey: string;
}

export interface LocalSessionState {
  sessionId: string;
  peerDid: string;
  peerDeviceId: string;
  selfDeviceId: string;
  role: 'initiator' | 'responder';
  establishedBy: 'prekey';
  phase: 'ratchet-active';
  rootKey: string;
  currentRatchetKey: LocalDeviceKeyPair;
  remoteRatchetPublicKey: string;
  sendingChainKey?: string;
  receivingChainKey?: string;
  createdAt: number;
  updatedAt: number;
  nextSendMessageNumber: number;
  nextReceiveMessageNumber: number;
  previousSendChainLength: number;
  skippedMessageKeys: SkippedMessageKeyState[];
  bootstrap: LocalSessionBootstrapState;
}

export interface CreateRatchetSessionInput {
  sessionId: string;
  peerDid: string;
  peerDeviceId: string;
  selfDeviceId: string;
  role: 'initiator' | 'responder';
  rootKey: Uint8Array;
  currentRatchetKey: X25519KeyPair;
  remoteRatchetPublicKey: Uint8Array;
  bootstrap: LocalSessionBootstrapState;
  createdAt: number;
}

export interface RatchetEncryptInput {
  session: LocalSessionState;
  plaintext: Uint8Array;
  senderDid: string;
  receiverDid: string;
  messageId?: string;
  nonce?: Uint8Array;
  ratchetKeyPair?: X25519KeyPair;
  now?: number;
}

export interface RatchetEncryptResult {
  message: SessionMessage;
  session: LocalSessionState;
  messageKey: Uint8Array;
}

export interface RatchetDecryptInput {
  session: LocalSessionState;
  message: SessionMessage;
  now?: number;
}

export interface RatchetDecryptResult {
  plaintext: Uint8Array;
  session: LocalSessionState;
  messageKey: Uint8Array;
  usedSkippedMessageKey: boolean;
}

function deriveRootAndChainKeys(rootKey: Uint8Array, dhOutput: Uint8Array): {
  rootKey: Uint8Array;
  chainKey: Uint8Array;
} {
  const material = hkdfSha256(dhOutput, rootKey, new TextEncoder().encode(DOUBLE_RATCHET_ROOT_INFO), 64);
  return {
    rootKey: material.slice(0, 32),
    chainKey: material.slice(32, 64),
  };
}

function deriveChainStep(chainKey: Uint8Array): {
  chainKey: Uint8Array;
  messageKey: Uint8Array;
} {
  const material = hkdfSha256(
    chainKey,
    new TextEncoder().encode(DOUBLE_RATCHET_CHAIN_SALT),
    new TextEncoder().encode(DOUBLE_RATCHET_CHAIN_INFO),
    64,
  );
  return {
    chainKey: material.slice(0, 32),
    messageKey: material.slice(32, 64),
  };
}

function cloneSession(session: LocalSessionState): LocalSessionState {
  return {
    ...session,
    currentRatchetKey: { ...session.currentRatchetKey },
    skippedMessageKeys: session.skippedMessageKeys.map((entry) => ({ ...entry })),
  };
}

function generateMessageId(): string {
  return `e2e-msg-${bytesToHex(randomBytes(12))}`;
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== 24) {
    throw new EncryptionError('Double Ratchet nonce must be 24 bytes', { length: nonce.length });
  }
}

function storeSkippedMessageKey(session: LocalSessionState, ratchetPublicKey: string, messageNumber: number, messageKey: Uint8Array): void {
  session.skippedMessageKeys.push({
    ratchetPublicKey,
    messageNumber,
    messageKey: bytesToHex(messageKey),
  });
  if (session.skippedMessageKeys.length > MAX_SKIPPED_MESSAGE_KEYS) {
    session.skippedMessageKeys.splice(0, session.skippedMessageKeys.length - MAX_SKIPPED_MESSAGE_KEYS);
  }
}

function takeSkippedMessageKey(session: LocalSessionState, ratchetPublicKey: string, messageNumber: number): Uint8Array | null {
  const index = session.skippedMessageKeys.findIndex(
    (entry) => entry.ratchetPublicKey === ratchetPublicKey && entry.messageNumber === messageNumber,
  );
  if (index < 0) {
    return null;
  }
  const [entry] = session.skippedMessageKeys.splice(index, 1);
  return hexToBytes(entry.messageKey);
}

function skipMessageKeys(session: LocalSessionState, untilMessageNumber: number): void {
  if (untilMessageNumber < session.nextReceiveMessageNumber) {
    return;
  }

  if (!session.receivingChainKey) {
    if (untilMessageNumber === session.nextReceiveMessageNumber) {
      return;
    }
    throw new EncryptionError('Missing receiving chain key while skipping messages', {
      untilMessageNumber,
      nextReceiveMessageNumber: session.nextReceiveMessageNumber,
    });
  }

  const gap = untilMessageNumber - session.nextReceiveMessageNumber;
  if (gap > MAX_SKIPPED_MESSAGE_KEYS) {
    throw new EncryptionError('Skipped-message window exceeded', {
      gap,
      maxSkippedMessageKeys: MAX_SKIPPED_MESSAGE_KEYS,
    });
  }

  let chainKey = hexToBytes(session.receivingChainKey);
  while (session.nextReceiveMessageNumber < untilMessageNumber) {
    const step = deriveChainStep(chainKey);
    storeSkippedMessageKey(session, session.remoteRatchetPublicKey, session.nextReceiveMessageNumber, step.messageKey);
    session.nextReceiveMessageNumber += 1;
    chainKey = step.chainKey;
  }
  session.receivingChainKey = bytesToHex(chainKey);
}

function ensureSendingChain(session: LocalSessionState, nextRatchetKeyPair?: X25519KeyPair): void {
  if (session.sendingChainKey) {
    return;
  }

  const ratchetKeyPair = nextRatchetKeyPair ?? generateX25519KeyPair();
  const dhOutput = diffieHellmanX25519(ratchetKeyPair.privateKey, hexToBytes(session.remoteRatchetPublicKey));
  const derived = deriveRootAndChainKeys(hexToBytes(session.rootKey), dhOutput);
  session.rootKey = bytesToHex(derived.rootKey);
  session.currentRatchetKey = {
    publicKey: bytesToHex(ratchetKeyPair.publicKey),
    privateKey: bytesToHex(ratchetKeyPair.privateKey),
  };
  session.sendingChainKey = bytesToHex(derived.chainKey);
  session.previousSendChainLength = session.nextSendMessageNumber;
  session.nextSendMessageNumber = 0;
}

function advanceReceivingRatchet(session: LocalSessionState, remoteRatchetPublicKey: Uint8Array): void {
  const dhOutput = diffieHellmanX25519(
    hexToBytes(session.currentRatchetKey.privateKey),
    remoteRatchetPublicKey,
  );
  const derived = deriveRootAndChainKeys(hexToBytes(session.rootKey), dhOutput);
  session.rootKey = bytesToHex(derived.rootKey);
  session.remoteRatchetPublicKey = bytesToHex(remoteRatchetPublicKey);
  session.receivingChainKey = bytesToHex(derived.chainKey);
  session.nextReceiveMessageNumber = 0;
  session.sendingChainKey = undefined;
}

export function createInitiatorRatchetSession(input: CreateRatchetSessionInput): LocalSessionState {
  const dhOutput = diffieHellmanX25519(input.currentRatchetKey.privateKey, input.remoteRatchetPublicKey);
  const derived = deriveRootAndChainKeys(input.rootKey, dhOutput);
  return {
    sessionId: input.sessionId,
    peerDid: input.peerDid,
    peerDeviceId: input.peerDeviceId,
    selfDeviceId: input.selfDeviceId,
    role: input.role,
    establishedBy: 'prekey',
    phase: 'ratchet-active',
    rootKey: bytesToHex(derived.rootKey),
    currentRatchetKey: {
      publicKey: bytesToHex(input.currentRatchetKey.publicKey),
      privateKey: bytesToHex(input.currentRatchetKey.privateKey),
    },
    remoteRatchetPublicKey: bytesToHex(input.remoteRatchetPublicKey),
    sendingChainKey: bytesToHex(derived.chainKey),
    receivingChainKey: undefined,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    nextSendMessageNumber: 0,
    nextReceiveMessageNumber: 0,
    previousSendChainLength: 0,
    skippedMessageKeys: [],
    bootstrap: input.bootstrap,
  };
}

export function createResponderRatchetSession(input: CreateRatchetSessionInput): LocalSessionState {
  const dhOutput = diffieHellmanX25519(input.currentRatchetKey.privateKey, input.remoteRatchetPublicKey);
  const derived = deriveRootAndChainKeys(input.rootKey, dhOutput);
  return {
    sessionId: input.sessionId,
    peerDid: input.peerDid,
    peerDeviceId: input.peerDeviceId,
    selfDeviceId: input.selfDeviceId,
    role: input.role,
    establishedBy: 'prekey',
    phase: 'ratchet-active',
    rootKey: bytesToHex(derived.rootKey),
    currentRatchetKey: {
      publicKey: bytesToHex(input.currentRatchetKey.publicKey),
      privateKey: bytesToHex(input.currentRatchetKey.privateKey),
    },
    remoteRatchetPublicKey: bytesToHex(input.remoteRatchetPublicKey),
    sendingChainKey: undefined,
    receivingChainKey: bytesToHex(derived.chainKey),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    nextSendMessageNumber: 0,
    nextReceiveMessageNumber: 0,
    previousSendChainLength: 0,
    skippedMessageKeys: [],
    bootstrap: input.bootstrap,
  };
}

export function encryptRatchetMessage(input: RatchetEncryptInput): RatchetEncryptResult {
  const session = cloneSession(input.session);
  ensureSendingChain(session, input.ratchetKeyPair);
  if (!session.sendingChainKey) {
    throw new EncryptionError('Missing sending chain key after ratchet initialization');
  }

  const chainStep = deriveChainStep(hexToBytes(session.sendingChainKey));
  const nonce = input.nonce ?? randomBytes(24);
  assertNonce(nonce);
  const message = encryptSessionMessage({
    version: E2E_PROTOCOL_VERSION,
    type: 'SESSION_MESSAGE',
    senderDid: input.senderDid,
    receiverDid: input.receiverDid,
    senderDeviceId: session.selfDeviceId,
    receiverDeviceId: session.peerDeviceId,
    sessionId: session.sessionId,
    messageId: input.messageId ?? generateMessageId(),
    ratchetPublicKey: hexToBytes(session.currentRatchetKey.publicKey),
    previousChainLength: session.previousSendChainLength,
    messageNumber: session.nextSendMessageNumber,
    nonce,
  }, chainStep.messageKey, input.plaintext);

  session.sendingChainKey = bytesToHex(chainStep.chainKey);
  session.nextSendMessageNumber += 1;
  session.updatedAt = input.now ?? Date.now();

  return {
    message,
    session,
    messageKey: chainStep.messageKey,
  };
}

export function decryptRatchetMessage(input: RatchetDecryptInput): RatchetDecryptResult {
  const session = cloneSession(input.session);
  const skippedMessageKey = takeSkippedMessageKey(
    session,
    bytesToHex(input.message.ratchetPublicKey),
    input.message.messageNumber,
  );
  if (skippedMessageKey) {
    const plaintext = decryptSessionMessage(input.message, skippedMessageKey);
    session.updatedAt = input.now ?? Date.now();
    return {
      plaintext,
      session,
      messageKey: skippedMessageKey,
      usedSkippedMessageKey: true,
    };
  }

  if (bytesToHex(input.message.ratchetPublicKey) !== session.remoteRatchetPublicKey) {
    skipMessageKeys(session, input.message.previousChainLength);
    advanceReceivingRatchet(session, input.message.ratchetPublicKey);
  }

  skipMessageKeys(session, input.message.messageNumber);
  if (!session.receivingChainKey) {
    throw new EncryptionError('Missing receiving chain key for session message decryption');
  }

  const chainStep = deriveChainStep(hexToBytes(session.receivingChainKey));
  const plaintext = decryptSessionMessage(input.message, chainStep.messageKey);
  session.receivingChainKey = bytesToHex(chainStep.chainKey);
  session.nextReceiveMessageNumber = input.message.messageNumber + 1;
  session.updatedAt = input.now ?? Date.now();

  return {
    plaintext,
    session,
    messageKey: chainStep.messageKey,
    usedSkippedMessageKey: false,
  };
}
