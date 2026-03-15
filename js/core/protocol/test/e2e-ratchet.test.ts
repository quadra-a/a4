import { describe, expect, it } from 'vitest';
import {
  buildClaimedPreKeyBundle,
  buildInitiatorPreKeyMessage,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  consumeResponderPreKeyMessage,
  createInitialLocalE2EConfig,
  decryptRatchetMessage,
  deriveX25519PublicKey,
  encryptRatchetMessage,
  generateKeyPair,
  hexToBytes,
} from '../src/index.js';

describe('Double Ratchet engine', () => {
  it('continues a session and handles a responder DH ratchet reply', async () => {
    const aliceIdentity = await generateKeyPair();
    const bobIdentity = await generateKeyPair();
    const aliceE2E = await createInitialLocalE2EConfig(aliceIdentity.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobIdentity.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const bootstrap = buildInitiatorPreKeyMessage({
      e2eConfig: aliceE2E,
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      recipientDevice: bobDevice,
      claimedBundle: buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]),
      plaintext: new TextEncoder().encode('bootstrap'),
      sessionId: 'session-ratchet',
      messageId: 'msg-bootstrap',
      now: 100,
    });
    const bootstrapReceive = consumeResponderPreKeyMessage({
      e2eConfig: bobE2E,
      receiverDid: 'did:agent:bob',
      message: bootstrap.message,
      now: 110,
    });

    const aliceSend = encryptRatchetMessage({
      session: bootstrap.session,
      plaintext: new TextEncoder().encode('alice-1'),
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      messageId: 'msg-alice-1',
      nonce: new Uint8Array(24).fill(1),
      now: 120,
    });
    const bobReceive = decryptRatchetMessage({
      session: bootstrapReceive.session,
      message: aliceSend.message,
      now: 130,
    });

    expect(new TextDecoder().decode(bobReceive.plaintext)).toBe('alice-1');
    expect(bobReceive.messageKey).toEqual(aliceSend.messageKey);
    expect(bobReceive.session.nextReceiveMessageNumber).toBe(1);

    const responderRatchetPrivate = hexToBytes('c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf');
    const bobReply = encryptRatchetMessage({
      session: bobReceive.session,
      plaintext: new TextEncoder().encode('bob-1'),
      senderDid: 'did:agent:bob',
      receiverDid: 'did:agent:alice',
      messageId: 'msg-bob-1',
      nonce: new Uint8Array(24).fill(2),
      ratchetKeyPair: {
        privateKey: responderRatchetPrivate,
        publicKey: deriveX25519PublicKey(responderRatchetPrivate),
      },
      now: 140,
    });
    const aliceReceive = decryptRatchetMessage({
      session: aliceSend.session,
      message: bobReply.message,
      now: 150,
    });

    expect(new TextDecoder().decode(aliceReceive.plaintext)).toBe('bob-1');
    expect(aliceReceive.messageKey).toEqual(bobReply.messageKey);
    expect(aliceReceive.session.remoteRatchetPublicKey).toBe(Buffer.from(bobReply.message.ratchetPublicKey).toString('hex'));
    expect(aliceReceive.session.nextReceiveMessageNumber).toBe(1);
  });

  it('recovers out-of-order messages from skipped message keys', async () => {
    const aliceIdentity = await generateKeyPair();
    const bobIdentity = await generateKeyPair();
    const aliceE2E = await createInitialLocalE2EConfig(aliceIdentity.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobIdentity.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const bootstrap = buildInitiatorPreKeyMessage({
      e2eConfig: aliceE2E,
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      recipientDevice: bobDevice,
      claimedBundle: buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]),
      plaintext: new TextEncoder().encode('bootstrap'),
      sessionId: 'session-skipped',
      messageId: 'msg-bootstrap-skipped',
      now: 200,
    });
    const bootstrapReceive = consumeResponderPreKeyMessage({
      e2eConfig: bobE2E,
      receiverDid: 'did:agent:bob',
      message: bootstrap.message,
      now: 210,
    });

    const aliceMsg1 = encryptRatchetMessage({
      session: bootstrap.session,
      plaintext: new TextEncoder().encode('alice-1'),
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      messageId: 'msg-alice-1',
      nonce: new Uint8Array(24).fill(3),
      now: 220,
    });
    const aliceMsg2 = encryptRatchetMessage({
      session: aliceMsg1.session,
      plaintext: new TextEncoder().encode('alice-2'),
      senderDid: 'did:agent:alice',
      receiverDid: 'did:agent:bob',
      messageId: 'msg-alice-2',
      nonce: new Uint8Array(24).fill(4),
      now: 230,
    });

    const bobReceiveSecond = decryptRatchetMessage({
      session: bootstrapReceive.session,
      message: aliceMsg2.message,
      now: 240,
    });
    expect(new TextDecoder().decode(bobReceiveSecond.plaintext)).toBe('alice-2');
    expect(bobReceiveSecond.session.skippedMessageKeys).toHaveLength(1);

    const bobReceiveFirst = decryptRatchetMessage({
      session: bobReceiveSecond.session,
      message: aliceMsg1.message,
      now: 250,
    });
    expect(new TextDecoder().decode(bobReceiveFirst.plaintext)).toBe('alice-1');
    expect(bobReceiveFirst.usedSkippedMessageKey).toBe(true);
    expect(bobReceiveFirst.session.skippedMessageKeys).toHaveLength(0);
  });
});
