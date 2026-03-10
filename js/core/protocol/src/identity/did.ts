import { base58btc } from 'multiformats/bases/base58';
import { IdentityError } from '../utils/errors.js';

/**
 * Derive a did:agent DID from a public key.
 * Format: did:agent:<base58btc-encoded-pubkey>
 */
export function deriveDID(publicKey: Uint8Array): string {
  try {
    const encoded = base58btc.encode(publicKey);
    return `did:agent:${encoded}`;
  } catch (error) {
    throw new IdentityError('Failed to derive DID', error);
  }
}

/**
 * Extract public key from a did:agent DID.
 */
export function extractPublicKey(did: string): Uint8Array {
  if (!did.startsWith('did:agent:')) {
    throw new IdentityError('Invalid DID format: must start with did:agent:');
  }

  try {
    const encoded = did.replace('did:agent:', '');
    return base58btc.decode(encoded);
  } catch (error) {
    throw new IdentityError('Failed to extract public key from DID', error);
  }
}

/**
 * Validate a did:agent DID format.
 */
export function validateDID(did: string): boolean {
  if (!did.startsWith('did:agent:')) {
    return false;
  }

  try {
    const encoded = did.replace('did:agent:', '');
    base58btc.decode(encoded);
    return true;
  } catch {
    return false;
  }
}
