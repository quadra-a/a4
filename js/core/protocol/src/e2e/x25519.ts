import {
  createPrivateKey,
  createPublicKey,
  diffieHellman as nodeDiffieHellman,
  generateKeyPairSync,
  randomBytes as cryptoRandomBytes,
} from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { EncryptionError } from '../utils/errors.js';

export interface X25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function hexToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

export function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function validateRawKeyLength(key: Uint8Array, label: string): void {
  if (key.length !== 32) {
    throw new EncryptionError(`${label} must be 32 bytes`, { length: key.length });
  }
}

function validateNonceLength(nonce: Uint8Array): void {
  if (nonce.length !== 24) {
    throw new EncryptionError('XChaCha20-Poly1305 nonce must be 24 bytes', { length: nonce.length });
  }
}

function wrapPkcs8(privateKey: Uint8Array): Buffer {
  validateRawKeyLength(privateKey, 'X25519 private key');
  return Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(privateKey)]);
}

function unwrapPkcs8(privateKeyDer: Buffer): Uint8Array {
  if (!privateKeyDer.subarray(0, X25519_PKCS8_PREFIX.length).equals(X25519_PKCS8_PREFIX)) {
    throw new EncryptionError('Unsupported X25519 PKCS8 prefix');
  }

  return new Uint8Array(privateKeyDer.subarray(X25519_PKCS8_PREFIX.length));
}

function unwrapSpki(publicKeyDer: Buffer): Uint8Array {
  if (!publicKeyDer.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)) {
    throw new EncryptionError('Unsupported X25519 SPKI prefix');
  }

  return new Uint8Array(publicKeyDer.subarray(X25519_SPKI_PREFIX.length));
}

function importPrivateKey(privateKey: Uint8Array) {
  return createPrivateKey({
    key: wrapPkcs8(privateKey),
    format: 'der',
    type: 'pkcs8',
  });
}

function importPublicKey(publicKey: Uint8Array) {
  validateRawKeyLength(publicKey, 'X25519 public key');
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(publicKey)]),
    format: 'der',
    type: 'spki',
  });
}

export function generateX25519KeyPair(): X25519KeyPair {
  try {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');

    return {
      privateKey: unwrapPkcs8(privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer),
      publicKey: unwrapSpki(publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
    };
  } catch (error) {
    throw new EncryptionError('Failed to generate X25519 key pair', error);
  }
}

export function deriveX25519PublicKey(privateKey: Uint8Array): Uint8Array {
  try {
    const publicKey = createPublicKey(importPrivateKey(privateKey));
    return unwrapSpki(publicKey.export({ format: 'der', type: 'spki' }) as Buffer);
  } catch (error) {
    throw new EncryptionError('Failed to derive X25519 public key', error);
  }
}

export function diffieHellmanX25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(nodeDiffieHellman({
      privateKey: importPrivateKey(privateKey),
      publicKey: importPublicKey(publicKey),
    }));
  } catch (error) {
    throw new EncryptionError('Failed to derive X25519 shared secret', error);
  }
}

export function hkdfSha256(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  try {
    return hkdf(sha256, inputKeyMaterial, salt, info, length);
  } catch (error) {
    throw new EncryptionError('Failed to derive HKDF-SHA256 output', error);
  }
}

export function encryptXChaCha20Poly1305(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  try {
    validateRawKeyLength(key, 'XChaCha20-Poly1305 key');
    validateNonceLength(nonce);
    return xchacha20poly1305(key, nonce, associatedData).encrypt(plaintext);
  } catch (error) {
    throw new EncryptionError('Failed to encrypt with XChaCha20-Poly1305', error);
  }
}

export function decryptXChaCha20Poly1305(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  try {
    validateRawKeyLength(key, 'XChaCha20-Poly1305 key');
    validateNonceLength(nonce);
    return xchacha20poly1305(key, nonce, associatedData).decrypt(ciphertext);
  } catch (error) {
    throw new EncryptionError('Failed to decrypt with XChaCha20-Poly1305', error);
  }
}

export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(cryptoRandomBytes(length));
}
