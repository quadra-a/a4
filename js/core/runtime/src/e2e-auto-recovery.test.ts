import { describe, expect, it, vi } from 'vitest';
import {
  buildClaimedPreKeyBundle,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  createInitialLocalE2EConfig,
  deriveDID,
  generateKeyPair,
  importKeyPair,
} from '@quadra-a/protocol';
import { prepareEncryptedReceive } from './e2e-receive.js';
import { prepareEncryptedSend } from './e2e-send.js';

describe('E2E auto-recovery', () => {
  it('SESSION_MESSAGE fails when receiver session is cleared', async () => {
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

    // Alice → Bob: PREKEY_MESSAGE (establish session)
    const first = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello' },
      type: 'message',
      threadId: 't1',
    });
    aliceE2E = first.e2eConfig;
    const firstReceived = await prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: first.outerEnvelope,
    });
    bobE2E = firstReceived.e2eConfig;
    expect(firstReceived.transport).toBe('prekey');

    // Clear Bob's sessions (simulate ratchet desync)
    const deviceId = bobE2E.currentDeviceId;
    bobE2E = {
      ...bobE2E,
      devices: {
        ...bobE2E.devices,
        [deviceId]: { ...bobE2E.devices[deviceId], sessions: {} },
      },
    };

    // Alice → Bob: SESSION_MESSAGE → should fail
    const second = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'second' },
      type: 'message',
      threadId: 't2',
    });

    await expect(prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: second.outerEnvelope,
    })).rejects.toThrow();
  });

  it('can re-bootstrap after clearing stale session', async () => {
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
    const bobBundles = buildPublishedPreKeyBundles(bobE2E);
    const claimedBundle1 = buildClaimedPreKeyBundle(bobBundles[0], bobBundles[0].oneTimePreKeys[0]);

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
    const fetchPreKeyBundle = vi.fn(async () => claimedBundle1);
    const keyPair = importKeyPair(aliceIdentity);

    // Round 1: establish session
    const first = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello' },
      type: 'message',
      threadId: 't1',
    });
    aliceE2E = first.e2eConfig;
    const firstReceived = await prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: first.outerEnvelope,
    });
    bobE2E = firstReceived.e2eConfig;

    // Clear Alice's sessions (simulate auto-recovery clearing stale state)
    const aliceDeviceId = aliceE2E.currentDeviceId;
    aliceE2E = {
      ...aliceE2E,
      devices: {
        ...aliceE2E.devices,
        [aliceDeviceId]: { ...aliceE2E.devices[aliceDeviceId], sessions: {} },
      },
    };

    // Re-bootstrap with a new OTK
    const claimedBundle2 = buildClaimedPreKeyBundle(bobBundles[0], bobBundles[0].oneTimePreKeys[1]);
    fetchPreKeyBundle.mockResolvedValueOnce(claimedBundle2);

    const rebooted = await prepareEncryptedSend({
      identity: aliceIdentity,
      keyPair,
      relayClient: { fetchCard, fetchPreKeyBundle },
      e2eConfig: aliceE2E,
      to: bobDid,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'rebooted' },
      type: 'message',
      threadId: 't2',
    });

    // Bob should be able to decrypt the new PREKEY_MESSAGE
    const rebootReceived = await prepareEncryptedReceive({
      receiverDid: bobDid,
      e2eConfig: bobE2E,
      transportEnvelope: rebooted.outerEnvelope,
    });
    expect(rebootReceived.transport).toBe('prekey');
    expect(rebootReceived.applicationEnvelope).toEqual(rebooted.applicationEnvelope);
  });
});
