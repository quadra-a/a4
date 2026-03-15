import { describe, expect, it, vi } from 'vitest';
import {
  buildClaimedPreKeyBundle,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  createInitialLocalE2EConfig,
  createLocalDeviceState,
  decodeEncryptedApplicationEnvelopePayload,
  deriveDID,
  E2E_APPLICATION_ENVELOPE_PROTOCOL,
  generateKeyPair,
  importKeyPair,
} from '@quadra-a/protocol';
import { prepareEncryptedSend, prepareEncryptedSends } from './e2e-send.js';

describe('runtime encrypted send path', () => {
  it('fetches a pre-key bundle for first send and reuses the ratchet session afterward', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceIdentity = {
      did: aliceDid,
      publicKey: Buffer.from(aliceKeys.publicKey).toString('hex'),
      privateKey: Buffer.from(aliceKeys.privateKey).toString('hex'),
    };
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
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

    expect(first.outerEnvelope.id).toBe(first.applicationEnvelope.id);
    expect(first.outerEnvelope.protocol).toBe(E2E_APPLICATION_ENVELOPE_PROTOCOL);
    expect(first.outerEnvelope.threadId).toBeUndefined();
    expect(first.outerEnvelope.replyTo).toBeUndefined();
    expect(first.applicationEnvelope.protocol).toBe('/agent/msg/1.0.0');
    expect(first.applicationEnvelope.threadId).toBe('thread-bootstrap');
    expect((first.outerEnvelope.payload as { messageType: string }).messageType).toBe('PREKEY_MESSAGE');
    expect(fetchCard).toHaveBeenCalledTimes(1);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(1);

    const decodedFirst = decodeEncryptedApplicationEnvelopePayload(first.outerEnvelope.payload);
    expect(decodedFirst.type).toBe('PREKEY_MESSAGE');
    expect(decodedFirst.receiverDeviceId).toBe(bobDevice.deviceId);

    const second = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: first.e2eConfig,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello again' },
      type: 'message',
      threadId: 'thread-ratchet',
    });

    expect((second.outerEnvelope.payload as { messageType: string }).messageType).toBe('SESSION_MESSAGE');
    expect(fetchCard).toHaveBeenCalledTimes(2);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(1);

    const decodedSecond = decodeEncryptedApplicationEnvelopePayload(second.outerEnvelope.payload);
    expect(decodedSecond.type).toBe('SESSION_MESSAGE');
    expect(decodedSecond.receiverDeviceId).toBe(bobDevice.deviceId);
  });


  it('rejects a claimed bundle with an invalid signed pre-key signature', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceIdentity = {
      did: aliceDid,
      publicKey: Buffer.from(aliceKeys.publicKey).toString('hex'),
      privateKey: Buffer.from(aliceKeys.privateKey).toString('hex'),
    };
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const tamperedSignature = '00'.repeat(64);
    const tamperedDevice = {
      ...bobDevice,
      signedPreKeySignature: tamperedSignature,
    };
    const tamperedBundle = {
      ...buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]),
      signedPreKeySignature: tamperedSignature,
    };

    const fetchCard = vi.fn(async () => ({
      did: bobDid,
      name: 'Bob',
      description: 'Receiver',
      version: '1.0.0',
      capabilities: [],
      endpoints: [],
      devices: [tamperedDevice],
      timestamp: 1,
      signature: 'sig',
    }));
    const fetchPreKeyBundle = vi.fn(async () => tamperedBundle);
    const keyPair = importKeyPair(aliceIdentity);

    await expect(prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello bob' },
      type: 'message',
      threadId: 'thread-invalid-signed-prekey',
    })).rejects.toThrow(`Target ${bobDid}:${bobDevice.deviceId} publishes invalid signed pre-key signature`);

    expect(fetchCard).toHaveBeenCalledTimes(1);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(1);
  });

  it('fans out first contact to all recipient devices and reuses each device session independently', async () => {
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
    const secondBobDevice = await createLocalDeviceState(bobKeys.privateKey, {
      deviceId: 'device-bob-secondary',
      signedPreKeyId: 2,
      now: 2,
    });
    bobE2E.devices[secondBobDevice.deviceId] = secondBobDevice;

    const bobDevices = buildPublishedDeviceDirectory(bobE2E);
    const bobBundles = buildPublishedPreKeyBundles(bobE2E);
    const claimedBundles = new Map(
      bobBundles.map((bundle) => [
        bundle.deviceId,
        buildClaimedPreKeyBundle(bundle, bundle.oneTimePreKeys[0]),
      ]),
    );

    const fetchCard = vi.fn(async () => ({
      did: bobDid,
      name: 'Bob',
      description: 'Receiver',
      version: '1.0.0',
      capabilities: [],
      endpoints: [],
      devices: bobDevices,
      timestamp: 1,
      signature: 'sig',
    }));
    const fetchPreKeyBundle = vi.fn(async (_did: string, deviceId: string) => claimedBundles.get(deviceId) ?? null);
    const keyPair = importKeyPair(aliceIdentity);

    const first = await prepareEncryptedSends({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello all devices' },
      type: 'message',
      threadId: 'thread-multi-bootstrap',
    });

    expect(first.targets).toHaveLength(2);
    expect(fetchCard).toHaveBeenCalledTimes(1);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(2);
    expect(first.applicationEnvelope.id).toBe(first.targets[0].outerEnvelope.id);
    expect(first.applicationEnvelope.id).toBe(first.targets[1].outerEnvelope.id);
    expect(new Set(first.targets.map((target) => target.recipientDeviceId))).toEqual(
      new Set(bobDevices.map((device) => device.deviceId)),
    );

    for (const target of first.targets) {
      const decoded = decodeEncryptedApplicationEnvelopePayload(target.outerEnvelope.payload);
      expect(decoded.type).toBe('PREKEY_MESSAGE');
      expect(decoded.receiverDeviceId).toBe(target.recipientDeviceId);
    }

    const second = await prepareEncryptedSends({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: first.e2eConfig,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello again all devices' },
      type: 'message',
      threadId: 'thread-multi-ratchet',
    });

    expect(second.targets).toHaveLength(2);
    expect(fetchCard).toHaveBeenCalledTimes(2);
    expect(fetchPreKeyBundle).toHaveBeenCalledTimes(2);

    for (const target of second.targets) {
      const decoded = decodeEncryptedApplicationEnvelopePayload(target.outerEnvelope.payload);
      expect(decoded.type).toBe('SESSION_MESSAGE');
      expect(decoded.receiverDeviceId).toBe(target.recipientDeviceId);
      expect(target.outerEnvelope.protocol).toBe(E2E_APPLICATION_ENVELOPE_PROTOCOL);
    }
  });
});
