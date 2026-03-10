import * as ed25519 from '@noble/ed25519';
import { IdentityError } from '../utils/errors.js';

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Generate a new Ed25519 key pair
 */
export async function generateKeyPair(): Promise<KeyPair> {
  try {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);

    return {
      publicKey,
      privateKey,
    };
  } catch (error) {
    throw new IdentityError('Failed to generate key pair', error);
  }
}

/**
 * Sign a message with a private key
 */
export async function sign(
  message: Uint8Array,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  try {
    return await ed25519.signAsync(message, privateKey);
  } catch (error) {
    throw new IdentityError('Failed to sign message', error);
  }
}

/**
 * Verify a signature
 */
export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    return await ed25519.verifyAsync(signature, message, publicKey);
  } catch (error) {
    throw new IdentityError('Failed to verify signature', error);
  }
}

/**
 * Export key pair to JSON format
 */
export function exportKeyPair(keyPair: KeyPair): {
  publicKey: string;
  privateKey: string;
} {
  return {
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    privateKey: Buffer.from(keyPair.privateKey).toString('hex'),
  };
}

/**
 * Import key pair from JSON format
 */
export function importKeyPair(exported: {
  publicKey: string;
  privateKey: string;
}): KeyPair {
  return {
    publicKey: new Uint8Array(Buffer.from(exported.publicKey, 'hex')),
    privateKey: new Uint8Array(Buffer.from(exported.privateKey, 'hex')),
  };
}
