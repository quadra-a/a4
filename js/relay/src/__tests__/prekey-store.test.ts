import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PreKeyStore } from '../prekey-store.js';

describe('PreKeyStore', () => {
  let storagePath: string;
  let store: PreKeyStore;

  beforeEach(async () => {
    storagePath = mkdtempSync(join(tmpdir(), 'quadra-a-prekeys-'));
    store = new PreKeyStore({ storagePath });
    await store.start();
  });

  afterEach(async () => {
    await store.stop();
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('publishes bundles and claims one-time pre-keys in normalized order', async () => {
    await store.publishBundles('did:agent:alice', 'public', [{
      deviceId: 'device-1',
      identityKeyPublic: 'identity-1',
      signedPreKeyPublic: 'signed-1',
      signedPreKeyId: 7,
      signedPreKeySignature: 'signature-1',
      oneTimePreKeyCount: 999,
      lastResupplyAt: 123,
      oneTimePreKeys: [
        { keyId: 2, publicKey: 'otk-2' },
        { keyId: 1, publicKey: 'otk-1' },
        { keyId: 2, publicKey: 'otk-2-duplicate' },
      ],
    }]);

    const denied = await store.claimBundle('did:agent:alice', 'device-1', 'private');
    expect(denied).toBeNull();

    const first = await store.claimBundle('did:agent:alice', 'device-1', 'public');
    expect(first).toMatchObject({
      deviceId: 'device-1',
      oneTimePreKey: { keyId: 1, publicKey: 'otk-1' },
      oneTimePreKeyCount: 1,
      remainingOneTimePreKeyCount: 1,
    });

    const second = await store.claimBundle('did:agent:alice', 'device-1', 'public');
    expect(second).toMatchObject({
      deviceId: 'device-1',
      oneTimePreKey: { keyId: 2, publicKey: 'otk-2' },
      oneTimePreKeyCount: 0,
      remainingOneTimePreKeyCount: 0,
    });

    const exhausted = await store.claimBundle('did:agent:alice', 'device-1', 'public');
    expect(exhausted).toMatchObject({
      deviceId: 'device-1',
      oneTimePreKeyCount: 0,
      remainingOneTimePreKeyCount: 0,
    });
    expect(exhausted?.oneTimePreKey).toBeUndefined();
  });

  it('serializes concurrent claims so each one-time pre-key is consumed once', async () => {
    await store.publishBundles('did:agent:bob', 'public', [{
      deviceId: 'device-1',
      identityKeyPublic: 'identity-1',
      signedPreKeyPublic: 'signed-1',
      signedPreKeyId: 11,
      signedPreKeySignature: 'signature-1',
      oneTimePreKeyCount: 2,
      lastResupplyAt: 456,
      oneTimePreKeys: [
        { keyId: 1, publicKey: 'otk-1' },
        { keyId: 2, publicKey: 'otk-2' },
      ],
    }]);

    const claims = await Promise.all([
      store.claimBundle('did:agent:bob', 'device-1', 'public'),
      store.claimBundle('did:agent:bob', 'device-1', 'public'),
      store.claimBundle('did:agent:bob', 'device-1', 'public'),
    ]);

    const claimedKeyIds = claims
      .map((bundle) => bundle?.oneTimePreKey?.keyId ?? 0)
      .sort((left, right) => left - right);

    expect(claimedKeyIds).toEqual([0, 1, 2]);
    expect(claims.filter((bundle) => bundle?.oneTimePreKey).length).toBe(2);

    const after = await store.claimBundle('did:agent:bob', 'device-1', 'public');
    expect(after?.oneTimePreKey).toBeUndefined();
    expect(after?.remainingOneTimePreKeyCount).toBe(0);
  });
});
