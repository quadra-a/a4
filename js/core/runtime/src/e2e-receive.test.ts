import { describe, expect, it, vi } from 'vitest';
import {
  buildClaimedPreKeyBundle,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  createEnvelope,
  createInitialLocalE2EConfig,
  deriveDID,
  rotateLocalDeviceSignedPreKey,
  generateKeyPair,
  importKeyPair,
  sign,
  signEnvelope,
} from '@quadra-a/protocol';
import { prepareEncryptedReceive } from './e2e-receive.js';
import { prepareEncryptedSend } from './e2e-send.js';

describe('runtime encrypted receive path', () => {
  it('decrypts a bootstrap PREKEY_MESSAGE and then a follow-up SESSION_MESSAGE', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceIdentity = {
      did: aliceDid,
      publicKey: Buffer.from(aliceKeys.publicKey).toString('hex'),
      privateKey: Buffer.from(aliceKeys.privateKey).toString('hex'),
    };
    let aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    let bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const fetchCard = vi.fn(async () => ({
      did: bobDid,
      name: 'Bob',
      description: 'Receiver',
      version: '1.0.0',
      capabilities: [],
      endpoints: [],
      devices: [bobDevice],
      timestamp: 1,
      signature: 'sig',
    }));
    const fetchPreKeyBundle = vi.fn(async () => claimedBundle);
    const keyPair = importKeyPair(aliceIdentity);

    const first = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello bob' },
      type: 'message',
      threadId: 'thread-bootstrap',
    });
    aliceE2E = first.e2eConfig;

    const firstReceived = await prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: first.outerEnvelope,
    });
    bobE2E = firstReceived.e2eConfig;

    expect(firstReceived.transport).toBe('prekey');
    expect(firstReceived.applicationEnvelope).toEqual(first.applicationEnvelope);
    expect(fetchCard).toHaveBeenCalledTimes(1);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(1);

    const second = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello again' },
      type: 'message',
      threadId: 'thread-ratchet',
    });

    const secondReceived = await prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: second.outerEnvelope,
    });

    expect(secondReceived.transport).toBe('session');
    expect(secondReceived.applicationEnvelope).toEqual(second.applicationEnvelope);
    expect(fetchCard).toHaveBeenCalledTimes(2);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(1);
  });


  it('rejects a replayed PREKEY_MESSAGE after initial consumption', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceIdentity = {
      did: aliceDid,
      publicKey: Buffer.from(aliceKeys.publicKey).toString('hex'),
      privateKey: Buffer.from(aliceKeys.privateKey).toString('hex'),
    };
    let aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const fetchCard = vi.fn(async () => ({
      did: bobDid,
      name: 'Bob',
      description: 'Receiver',
      version: '1.0.0',
      capabilities: [],
      endpoints: [],
      devices: [bobDevice],
      timestamp: 1,
      signature: 'sig',
    }));
    const fetchPreKeyBundle = vi.fn(async () => claimedBundle);
    const keyPair = importKeyPair(aliceIdentity);

    const first = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello bob' },
      type: 'message',
      threadId: 'thread-bootstrap-replay',
    });
    aliceE2E = first.e2eConfig;

    const firstReceived = await prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: first.outerEnvelope,
    });

    await expect(prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: firstReceived.e2eConfig,
      transportEnvelope: first.outerEnvelope,
    })).rejects.toThrow('Claimed one-time pre-key already consumed for PREKEY_MESSAGE');

    expect(fetchCard).toHaveBeenCalledTimes(1);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(1);
    expect(aliceE2E).toBeTruthy();
  });

  it('rejects a PREKEY_MESSAGE addressed to a rotated-out signed pre-key', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceIdentity = {
      did: aliceDid,
      publicKey: Buffer.from(aliceKeys.publicKey).toString('hex'),
      privateKey: Buffer.from(aliceKeys.privateKey).toString('hex'),
    };
    const aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const fetchCard = vi.fn(async () => ({
      did: bobDid,
      name: 'Bob',
      description: 'Receiver',
      version: '1.0.0',
      capabilities: [],
      endpoints: [],
      devices: [bobDevice],
      timestamp: 1,
      signature: 'sig',
    }));
    const fetchPreKeyBundle = vi.fn(async () => claimedBundle);
    const keyPair = importKeyPair(aliceIdentity);

    const first = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello bob' },
      type: 'message',
      threadId: 'thread-rotated-signed-prekey',
    });

    const rotatedBobE2E = await rotateLocalDeviceSignedPreKey(
      bobKeys.privateKey,
      bobE2E,
      bobDevice.deviceId,
      { now: 200 },
    );

    await expect(prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: rotatedBobE2E,
      transportEnvelope: first.outerEnvelope,
    })).rejects.toThrow('PREKEY_MESSAGE signed pre-key id does not match current receiver device state');

    expect(fetchCard).toHaveBeenCalledTimes(1);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(1);
  });

  it('rejects a legacy plaintext application envelope', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);

    const legacyEnvelope = await signEnvelope(
      createEnvelope(
        aliceDid,
        bobDid,
        'message',
        '/agent/msg/1.0.0',
        { text: 'legacy plaintext should be rejected' },
        undefined,
        'thread-legacy-plaintext',
      ),
      (data) => sign(data, aliceKeys.privateKey),
    );

    await expect(prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: legacyEnvelope,
    })).rejects.toThrow('Transport envelope protocol is not the E2E application protocol');
  });

});
