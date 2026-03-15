import { encode as encodeCBOR } from 'cbor-x';
import type { SignedPreKeyRecord } from './types.js';
import { E2E_PROTOCOL_VERSION, SIGNED_PRE_KEY_TYPE } from './types.js';
import { sign, verify } from '../identity/keys.js';
import { EncryptionError } from '../utils/errors.js';

export function buildSignedPreKeyPayload(deviceId: string, signedPreKeyId: number, signedPreKeyPublic: Uint8Array): Uint8Array {
  try {
    return encodeCBOR({
      type: SIGNED_PRE_KEY_TYPE,
      version: E2E_PROTOCOL_VERSION,
      deviceId,
      signedPreKeyId,
      signedPreKeyPublic,
    });
  } catch (error) {
    throw new EncryptionError('Failed to build signed pre-key payload', error);
  }
}

export async function signSignedPreKeyRecord(
  deviceId: string,
  signedPreKeyId: number,
  signedPreKeyPublic: Uint8Array,
  signingPrivateKey: Uint8Array,
): Promise<SignedPreKeyRecord> {
  const payload = buildSignedPreKeyPayload(deviceId, signedPreKeyId, signedPreKeyPublic);
  const signature = await sign(payload, signingPrivateKey);

  return {
    deviceId,
    signedPreKeyId,
    signedPreKeyPublic,
    signature,
  };
}

export async function verifySignedPreKeyRecord(record: SignedPreKeyRecord, signingPublicKey: Uint8Array): Promise<boolean> {
  const payload = buildSignedPreKeyPayload(record.deviceId, record.signedPreKeyId, record.signedPreKeyPublic);
  return verify(record.signature, payload, signingPublicKey);
}
