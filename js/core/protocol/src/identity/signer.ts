import { sign, verify } from './keys.js';
import { deriveDID } from './did.js';
import { IdentityError } from '../utils/errors.js';

export interface SignedMessage {
  payload: Uint8Array;
  signature: Uint8Array;
  signer: string; // DID
}

/**
 * Sign a message and return a signed message object
 */
export async function signMessage(
  payload: Uint8Array,
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<SignedMessage> {
  try {
    const signature = await sign(payload, privateKey);
    const signer = deriveDID(publicKey);

    return {
      payload,
      signature,
      signer,
    };
  } catch (error) {
    throw new IdentityError('Failed to sign message', error);
  }
}

/**
 * Verify a signed message
 */
export async function verifyMessage(
  signedMessage: SignedMessage,
  expectedPublicKey: Uint8Array
): Promise<boolean> {
  try {
    const expectedDID = deriveDID(expectedPublicKey);

    if (signedMessage.signer !== expectedDID) {
      return false;
    }

    return await verify(
      signedMessage.signature,
      signedMessage.payload,
      expectedPublicKey
    );
  } catch (error) {
    throw new IdentityError('Failed to verify message', error);
  }
}
