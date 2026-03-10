export * from './keys.js';
export * from './did.js';
export * from './document.js';
export * from './signer.js';

import { generateKeyPair, exportKeyPair } from './keys.js';
import { deriveDID } from './did.js';

export interface AnonymousIdentity {
  did: string;
  publicKey: string;
  privateKey: string;
  agentCard: {
    name: string;
    description: string;
    capabilities: string[];
  };
}

/**
 * Generate an anonymous identity for frictionless onboarding
 * Creates identity with pattern "Agent-{last8chars_of_DID}" and generic description
 */
export async function generateAnonymousIdentity(): Promise<AnonymousIdentity> {
  const keyPair = await generateKeyPair();
  const exported = exportKeyPair(keyPair);
  const did = deriveDID(keyPair.publicKey);

  // Extract last 8 characters from DID (after the 'z' multibase prefix)
  const didSuffix = did.split(':').pop()!.slice(-8);

  return {
    did,
    publicKey: exported.publicKey,
    privateKey: exported.privateKey,
    agentCard: {
      name: `Agent-${didSuffix}`,
      description: `Anonymous agent ${didSuffix}`,
      capabilities: []
    }
  };
}
