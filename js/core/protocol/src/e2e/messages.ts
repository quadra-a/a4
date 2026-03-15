import { decode as decodeCBOR, encode as encodeCBOR } from 'cbor-x';
import type { PreKeyMessage, SessionMessage } from './types.js';
import { E2E_PROTOCOL_VERSION } from './types.js';
import { decryptXChaCha20Poly1305, encryptXChaCha20Poly1305 } from './x25519.js';
import { EncryptionError } from '../utils/errors.js';

function asBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return new Uint8Array(value);
  }

  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }

  throw new EncryptionError(`Invalid ${label}: expected byte array`);
}

function validateCommonFields(value: Record<string, unknown>, expectedType: string): void {
  if (value.version !== E2E_PROTOCOL_VERSION) {
    throw new EncryptionError(`Invalid ${expectedType} version`, { version: value.version });
  }

  if (value.type !== expectedType) {
    throw new EncryptionError(`Invalid message type`, { type: value.type, expectedType });
  }
}

export function buildPreKeyMessageAssociatedData(message: Omit<PreKeyMessage, 'ciphertext'>): Uint8Array {
  return encodeCBOR({
    version: message.version,
    type: message.type,
    senderDid: message.senderDid,
    receiverDid: message.receiverDid,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    sessionId: message.sessionId,
    messageId: message.messageId,
    initiatorIdentityKey: message.initiatorIdentityKey,
    initiatorEphemeralKey: message.initiatorEphemeralKey,
    recipientSignedPreKeyId: message.recipientSignedPreKeyId,
    ...(message.recipientOneTimePreKeyId !== undefined ? { recipientOneTimePreKeyId: message.recipientOneTimePreKeyId } : {}),
    nonce: message.nonce,
  });
}

export function buildSessionMessageAssociatedData(message: Omit<SessionMessage, 'ciphertext'>): Uint8Array {
  return encodeCBOR({
    version: message.version,
    type: message.type,
    senderDid: message.senderDid,
    receiverDid: message.receiverDid,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    sessionId: message.sessionId,
    messageId: message.messageId,
    ratchetPublicKey: message.ratchetPublicKey,
    previousChainLength: message.previousChainLength,
    messageNumber: message.messageNumber,
    nonce: message.nonce,
  });
}

export function encryptPreKeyMessage(message: Omit<PreKeyMessage, 'ciphertext'>, key: Uint8Array, plaintext: Uint8Array): PreKeyMessage {
  const associatedData = buildPreKeyMessageAssociatedData(message);
  const ciphertext = encryptXChaCha20Poly1305(key, message.nonce, plaintext, associatedData);
  return {
    ...message,
    ciphertext,
  };
}

export function decryptPreKeyMessage(message: PreKeyMessage, key: Uint8Array): Uint8Array {
  return decryptXChaCha20Poly1305(key, message.nonce, message.ciphertext, buildPreKeyMessageAssociatedData(message));
}

export function encryptSessionMessage(message: Omit<SessionMessage, 'ciphertext'>, key: Uint8Array, plaintext: Uint8Array): SessionMessage {
  const associatedData = buildSessionMessageAssociatedData(message);
  const ciphertext = encryptXChaCha20Poly1305(key, message.nonce, plaintext, associatedData);
  return {
    ...message,
    ciphertext,
  };
}

export function decryptSessionMessage(message: SessionMessage, key: Uint8Array): Uint8Array {
  return decryptXChaCha20Poly1305(key, message.nonce, message.ciphertext, buildSessionMessageAssociatedData(message));
}

export function encodePreKeyMessage(message: PreKeyMessage): Uint8Array {
  return encodeCBOR(message);
}

export function encodeSessionMessage(message: SessionMessage): Uint8Array {
  return encodeCBOR(message);
}

export function decodePreKeyMessage(data: Uint8Array): PreKeyMessage {
  const decoded = decodeCBOR(data) as Record<string, unknown>;
  validateCommonFields(decoded, 'PREKEY_MESSAGE');

  return {
    version: decoded.version as number,
    type: 'PREKEY_MESSAGE',
    senderDid: decoded.senderDid as string,
    receiverDid: decoded.receiverDid as string,
    senderDeviceId: decoded.senderDeviceId as string,
    receiverDeviceId: decoded.receiverDeviceId as string,
    sessionId: decoded.sessionId as string,
    messageId: decoded.messageId as string,
    initiatorIdentityKey: asBytes(decoded.initiatorIdentityKey, 'initiatorIdentityKey'),
    initiatorEphemeralKey: asBytes(decoded.initiatorEphemeralKey, 'initiatorEphemeralKey'),
    recipientSignedPreKeyId: decoded.recipientSignedPreKeyId as number,
    recipientOneTimePreKeyId: typeof decoded.recipientOneTimePreKeyId === 'number' ? decoded.recipientOneTimePreKeyId : undefined,
    nonce: asBytes(decoded.nonce, 'nonce'),
    ciphertext: asBytes(decoded.ciphertext, 'ciphertext'),
  };
}

export function decodeSessionMessage(data: Uint8Array): SessionMessage {
  const decoded = decodeCBOR(data) as Record<string, unknown>;
  validateCommonFields(decoded, 'SESSION_MESSAGE');

  return {
    version: decoded.version as number,
    type: 'SESSION_MESSAGE',
    senderDid: decoded.senderDid as string,
    receiverDid: decoded.receiverDid as string,
    senderDeviceId: decoded.senderDeviceId as string,
    receiverDeviceId: decoded.receiverDeviceId as string,
    sessionId: decoded.sessionId as string,
    messageId: decoded.messageId as string,
    ratchetPublicKey: asBytes(decoded.ratchetPublicKey, 'ratchetPublicKey'),
    previousChainLength: decoded.previousChainLength as number,
    messageNumber: decoded.messageNumber as number,
    nonce: asBytes(decoded.nonce, 'nonce'),
    ciphertext: asBytes(decoded.ciphertext, 'ciphertext'),
  };
}
