import { describe, expect, it } from 'vitest';

import {
  createAgentCard,
  deriveDID,
  generateKeyPair,
  sign,
  signAgentCard,
  verify,
  verifyAgentCard,
} from '../src/index.js';

describe('agent card signatures', () => {
  it('produces the same signature for semantically identical cards with different key order', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);

    const baseCard = createAgentCard(
      did,
      'Canonical Card',
      'Card used for canonical signature tests',
      [{ id: 'agent/test', name: 'Test', description: 'Test capability' }],
      [],
    );
    const first = {
      ...baseCard,
      metadata: {
        zeta: true,
        alpha: { gamma: 2, beta: 1 },
      },
      devices: [{
        deviceId: 'device-1',
        identityKeyPublic: 'aa',
        signedPreKeyPublic: 'bb',
        signedPreKeyId: 1,
        signedPreKeySignature: 'cc',
        oneTimePreKeyCount: 8,
        lastResupplyAt: 123,
      }],
    };
    const second = {
      metadata: {
        alpha: { beta: 1, gamma: 2 },
        zeta: true,
      },
      devices: [{
        lastResupplyAt: 123,
        oneTimePreKeyCount: 8,
        signedPreKeySignature: 'cc',
        signedPreKeyId: 1,
        signedPreKeyPublic: 'bb',
        identityKeyPublic: 'aa',
        deviceId: 'device-1',
      }],
      timestamp: baseCard.timestamp,
      endpoints: baseCard.endpoints,
      capabilities: baseCard.capabilities,
      version: baseCard.version,
      description: baseCard.description,
      name: baseCard.name,
      did: baseCard.did,
    };

    const signedFirst = await signAgentCard(first as any, (data) => sign(data, keyPair.privateKey));
    const signedSecond = await signAgentCard(second as any, (data) => sign(data, keyPair.privateKey));

    expect(signedFirst.signature).toBe(signedSecond.signature);
    expect(await verifyAgentCard(signedSecond, (signature, data) => verify(signature, data, keyPair.publicKey))).toBe(true);
  });

  it('verifies cards signed with the legacy insertion-order payload', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const legacyCard = {
      metadata: { note: 'legacy' },
      endpoints: [],
      version: '1.0.0',
      description: 'Legacy card ordering',
      did,
      name: 'Legacy Card',
      capabilities: [{ id: 'agent/test', name: 'Test', description: 'Test capability' }],
      timestamp: 789,
    };
    const legacyBytes = new TextEncoder().encode(JSON.stringify(legacyCard));
    const signature = Buffer.from(await sign(legacyBytes, keyPair.privateKey)).toString('hex');

    expect(await verifyAgentCard(
      {
        ...legacyCard,
        signature,
      } as any,
      (sig, data) => verify(sig, data, keyPair.publicKey),
    )).toBe(true);
  });
});
