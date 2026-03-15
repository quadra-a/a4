import { describe, expect, it } from 'vitest';
import {
  buildPublishedDeviceDirectory,
  createInitialLocalE2EConfig,
  exportKeyPair,
  generateKeyPair,
  hexToBytes,
  rotateLocalDeviceSignedPreKey,
  verifySignedPreKeyRecord,
} from '../src/index.js';

describe('E2E local device state', () => {
  it('creates one persisted device and publishes a verifiable directory entry', async () => {
    const keyPair = await generateKeyPair();
    const exported = exportKeyPair(keyPair);
    const e2eConfig = await createInitialLocalE2EConfig(hexToBytes(exported.privateKey));
    const currentDevice = e2eConfig.devices[e2eConfig.currentDeviceId];
    const published = buildPublishedDeviceDirectory(e2eConfig);

    expect(currentDevice).toBeDefined();
    expect(currentDevice.oneTimePreKeys).toHaveLength(16);
    expect(published).toHaveLength(1);
    expect(published[0].deviceId).toBe(e2eConfig.currentDeviceId);
    expect(published[0].oneTimePreKeyCount).toBe(16);

    await expect(
      verifySignedPreKeyRecord(
        {
          deviceId: published[0].deviceId,
          signedPreKeyId: published[0].signedPreKeyId,
          signedPreKeyPublic: hexToBytes(published[0].signedPreKeyPublic),
          signature: hexToBytes(published[0].signedPreKeySignature),
        },
        hexToBytes(exported.publicKey),
      ),
    ).resolves.toBe(true);
  });

  it('rotates one device signed pre-key without disturbing its sessions', async () => {
    const keyPair = await generateKeyPair();
    const exported = exportKeyPair(keyPair);
    const e2eConfig = await createInitialLocalE2EConfig(hexToBytes(exported.privateKey));
    const deviceId = e2eConfig.currentDeviceId;
    const original = e2eConfig.devices[deviceId];
    original.sessions['did:agent:zpeer:device-peer'] = { sessionId: 'session-existing' };

    const rotated = await rotateLocalDeviceSignedPreKey(
      hexToBytes(exported.privateKey),
      e2eConfig,
      deviceId,
      { now: 123456 },
    );
    const rotatedDevice = rotated.devices[deviceId];
    const published = buildPublishedDeviceDirectory(rotated);

    expect(rotatedDevice.identityKey).toEqual(original.identityKey);
    expect(rotatedDevice.sessions).toEqual(original.sessions);
    expect(rotatedDevice.signedPreKey.signedPreKeyId).toBeGreaterThan(original.signedPreKey.signedPreKeyId);
    expect(rotatedDevice.signedPreKey.publicKey).not.toBe(original.signedPreKey.publicKey);
    expect(rotatedDevice.lastResupplyAt).toBe(123456);
    expect(rotatedDevice.oneTimePreKeys).toHaveLength(16);
    expect(published[0].signedPreKeyId).toBe(rotatedDevice.signedPreKey.signedPreKeyId);

    await expect(
      verifySignedPreKeyRecord(
        {
          deviceId: published[0].deviceId,
          signedPreKeyId: published[0].signedPreKeyId,
          signedPreKeyPublic: hexToBytes(published[0].signedPreKeyPublic),
          signature: hexToBytes(published[0].signedPreKeySignature),
        },
        hexToBytes(exported.publicKey),
      ),
    ).resolves.toBe(true);
  });
});
