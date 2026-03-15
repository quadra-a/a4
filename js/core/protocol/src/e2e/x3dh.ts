import { EncryptionError } from '../utils/errors.js';
import type { X3DHInitiatorInput, X3DHResponderInput } from './types.js';
import { X3DH_INFO, X3DH_SALT } from './types.js';
import { concatBytes, diffieHellmanX25519, hkdfSha256, utf8ToBytes } from './x25519.js';

function deriveX3dhSharedSecret(parts: Uint8Array[]): Uint8Array {
  return hkdfSha256(
    concatBytes(...parts),
    utf8ToBytes(X3DH_SALT),
    utf8ToBytes(X3DH_INFO),
    32,
  );
}

export function deriveX3dhInitiatorSharedSecret(input: X3DHInitiatorInput): Uint8Array {
  try {
    const parts = [
      diffieHellmanX25519(input.initiatorIdentityPrivate, input.recipientSignedPreKeyPublic),
      diffieHellmanX25519(input.initiatorEphemeralPrivate, input.recipientIdentityPublic),
      diffieHellmanX25519(input.initiatorEphemeralPrivate, input.recipientSignedPreKeyPublic),
    ];

    if (input.recipientOneTimePreKeyPublic) {
      parts.push(diffieHellmanX25519(input.initiatorEphemeralPrivate, input.recipientOneTimePreKeyPublic));
    }

    return deriveX3dhSharedSecret(parts);
  } catch (error) {
    throw new EncryptionError('Failed to derive initiator X3DH shared secret', error);
  }
}

export function deriveX3dhResponderSharedSecret(input: X3DHResponderInput): Uint8Array {
  try {
    const parts = [
      diffieHellmanX25519(input.recipientSignedPreKeyPrivate, input.initiatorIdentityPublic),
      diffieHellmanX25519(input.recipientIdentityPrivate, input.initiatorEphemeralPublic),
      diffieHellmanX25519(input.recipientSignedPreKeyPrivate, input.initiatorEphemeralPublic),
    ];

    if (input.recipientOneTimePreKeyPrivate) {
      parts.push(diffieHellmanX25519(input.recipientOneTimePreKeyPrivate, input.initiatorEphemeralPublic));
    }

    return deriveX3dhSharedSecret(parts);
  } catch (error) {
    throw new EncryptionError('Failed to derive responder X3DH shared secret', error);
  }
}
