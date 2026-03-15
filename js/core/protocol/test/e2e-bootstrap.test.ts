import { describe, expect, it } from 'vitest';
import {
  buildClaimedPreKeyBundle,
  buildInitiatorPreKeyMessage,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  consumeResponderPreKeyMessage,
  createInitialLocalE2EConfig,
  generateKeyPair,
  generateX25519KeyPair,
  loadLocalSession,
} from '../src/index.js';

describe('E2E X3DH bootstrap', () => {
  it('constructs and consumes a first pre-key message with an OTK', async () => {
    const aliceIdentity = await generateKeyPair();
    const bobIdentity = await generateKeyPair();
    const aliceE2E = await createInitialLocalE2EConfig(aliceIdentity.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobIdentity.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);
    const plaintext = new TextEncoder().encode(JSON.stringify({ protocol: '/agent/msg/1.0.0', payload: { text: 'hello' } }));
    const ephemeralKeyPair = generateX25519KeyPair();
    const nonce = new Uint8Array(24).fill(7);

    const initiator = buildInitiatorPreKeyMessage({
      e2eConfig: aliceE2E,
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      recipientDevice: bobDevice,
      claimedBundle,
      plaintext,
      sessionId: 'session-otk',
      messageId: 'msg-otk',
      nonce,
      ephemeralKeyPair,
      now: 100,
    });
    const responder = consumeResponderPreKeyMessage({
      e2eConfig: bobE2E,
      receiverDid: 'did:agent:bob',
      message: initiator.message,
      now: 200,
    });

    expect(responder.plaintext).toEqual(plaintext);
    expect(initiator.sharedSecret).toEqual(responder.sharedSecret);
    expect(initiator.session.rootKey).toBe(responder.session.rootKey);
    expect(initiator.message.recipientOneTimePreKeyId).toBe(claimedBundle.oneTimePreKey?.keyId);

    const storedInitiator = loadLocalSession(
      initiator.e2eConfig,
      initiator.e2eConfig.currentDeviceId,
      'did:agent:bob',
      claimedBundle.deviceId,
    );
    const storedResponder = loadLocalSession(
      responder.e2eConfig,
      responder.e2eConfig.currentDeviceId,
      'did:agent:alice',
      initiator.message.senderDeviceId,
    );

    expect(storedInitiator).toEqual(initiator.session);
    expect(storedResponder).toEqual(responder.session);
    expect(
      responder.e2eConfig.devices[responder.e2eConfig.currentDeviceId].oneTimePreKeys.find(
        (key) => key.keyId === claimedBundle.oneTimePreKey?.keyId,
      )?.claimedAt,
    ).toBe(200);
  });

  it('rejects double-consumption of the same one-time pre-key', async () => {
    const aliceIdentity = await generateKeyPair();
    const bobIdentity = await generateKeyPair();
    const aliceE2E = await createInitialLocalE2EConfig(aliceIdentity.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobIdentity.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);
    const plaintext = new TextEncoder().encode('hello-once');

    const initiator = buildInitiatorPreKeyMessage({
      e2eConfig: aliceE2E,
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      recipientDevice: bobDevice,
      claimedBundle,
      plaintext,
      sessionId: 'session-double-otk',
      messageId: 'msg-double-otk',
      now: 500,
    });
    const firstConsume = consumeResponderPreKeyMessage({
      e2eConfig: bobE2E,
      receiverDid: 'did:agent:bob',
      message: initiator.message,
      now: 600,
    });

    expect(() => consumeResponderPreKeyMessage({
      e2eConfig: firstConsume.e2eConfig,
      receiverDid: 'did:agent:bob',
      message: initiator.message,
      now: 700,
    })).toThrow('Claimed one-time pre-key already consumed for PREKEY_MESSAGE');
  });

  it('supports the no-OTK fallback path and leaves local OTK state untouched', async () => {
    const aliceIdentity = await generateKeyPair();
    const bobIdentity = await generateKeyPair();
    const aliceE2E = await createInitialLocalE2EConfig(aliceIdentity.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobIdentity.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle);
    const plaintext = new TextEncoder().encode('hello-without-otk');

    const initiator = buildInitiatorPreKeyMessage({
      e2eConfig: aliceE2E,
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      recipientDevice: bobDevice,
      claimedBundle,
      plaintext,
      sessionId: 'session-no-otk',
      messageId: 'msg-no-otk',
      now: 300,
    });
    const responder = consumeResponderPreKeyMessage({
      e2eConfig: bobE2E,
      receiverDid: 'did:agent:bob',
      message: initiator.message,
      now: 400,
    });

    expect(initiator.message.recipientOneTimePreKeyId).toBeUndefined();
    expect(responder.plaintext).toEqual(plaintext);
    expect(initiator.session.rootKey).toBe(responder.session.rootKey);
    expect(
      responder.e2eConfig.devices[responder.e2eConfig.currentDeviceId].oneTimePreKeys.every(
        (key) => key.claimedAt === undefined,
      ),
    ).toBe(true);
  });
});
