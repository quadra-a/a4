import { deriveDID } from './did.js';

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  keyAgreement?: string[];
  service?: ServiceEndpoint[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

/**
 * Create a DID Document for a did:clawiverse identity
 */
export function createDIDDocument(
  publicKey: Uint8Array,
  services?: ServiceEndpoint[]
): DIDDocument {
  const did = deriveDID(publicKey);
  const keyId = `${did}#key-1`;
  // Use base58btc encoding for multibase format
  const publicKeyMultibase = `z${Buffer.from(publicKey).toString('hex')}`;

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase,
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
    service: services,
  };
}

/**
 * Validate a DID Document structure
 */
export function validateDIDDocument(doc: unknown): doc is DIDDocument {
  if (typeof doc !== 'object' || doc === null) {
    return false;
  }

  const d = doc as Partial<DIDDocument>;

  return (
    Array.isArray(d['@context']) &&
    typeof d.id === 'string' &&
    d.id.startsWith('did:agent:') &&
    Array.isArray(d.verificationMethod) &&
    d.verificationMethod.length > 0 &&
    Array.isArray(d.authentication) &&
    Array.isArray(d.assertionMethod)
  );
}
