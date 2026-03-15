import { describe, expect, it } from 'vitest';
import {
  assertPublishedSenderDeviceMatchesPreKeyMessage,
  buildClaimedPreKeyBundle,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  createEnvelope,
  createInitialLocalE2EConfig,
  decodeEncryptedApplicationEnvelopePayload,
  decodeSessionMessage,
  decryptApplicationEnvelope,
  deriveDID,
  encodeSessionMessage,
  encryptApplicationEnvelope,
  generateKeyPair,
  hexToBytes,
  loadLocalSession,
  sign,
  signEncryptedTransportEnvelope,
  signEnvelope,
} from '../src/index.js';

describe('E2E application envelope', () => {
  it('encrypts and decrypts the signed inner envelope across pre-key bootstrap and ratchet continuation', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    let aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    let bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const firstApplicationEnvelope = await signEnvelope(
      createEnvelope(
        aliceDid,
        bobDid,
        'message',
        '/agent/msg/1.0.0',
        { text: 'hello bob' },
        undefined,
        'thread-prekey',
      ),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const firstEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: firstApplicationEnvelope,
      recipientDevice: bobDevice,
      claimedBundle,
    });
    aliceE2E = firstEncrypted.e2eConfig;

    const firstTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: firstApplicationEnvelope,
      payload: firstEncrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });
    const firstDecrypted = await decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: firstTransportEnvelope,
      now: 100,
    });
    bobE2E = firstDecrypted.e2eConfig;

    expect(firstDecrypted.transport).toBe('prekey');
    expect(firstDecrypted.applicationEnvelope).toEqual(firstApplicationEnvelope);
    expect(firstDecrypted.applicationEnvelope.threadId).toBe('thread-prekey');

    const storedAliceSession = loadLocalSession(
      aliceE2E,
      aliceE2E.currentDeviceId,
      bobDid,
      bobDevice.deviceId,
    );
    const storedBobSession = loadLocalSession(
      bobE2E,
      bobE2E.currentDeviceId,
      aliceDid,
      firstEncrypted.payload.senderDeviceId,
    );
    expect(storedAliceSession?.sessionId).toBe(firstEncrypted.payload.sessionId);
    expect(storedBobSession?.sessionId).toBe(firstEncrypted.payload.sessionId);

    const secondApplicationEnvelope = await signEnvelope(
      createEnvelope(
        aliceDid,
        bobDid,
        'message',
        '/agent/msg/1.0.0',
        { text: 'hello again' },
        undefined,
        'thread-session',
      ),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const secondEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: secondApplicationEnvelope,
      recipientDevice: bobDevice,
    });
    const secondTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: secondApplicationEnvelope,
      payload: secondEncrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });
    const secondDecrypted = await decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: secondTransportEnvelope,
      now: 200,
    });

    expect(secondDecrypted.transport).toBe('session');
    expect(secondDecrypted.applicationEnvelope).toEqual(secondApplicationEnvelope);
    expect(secondDecrypted.applicationEnvelope.threadId).toBe('thread-session');
    expect(secondDecrypted.usedSkippedMessageKey).toBe(false);
  });

  it('rejects a PREKEY_MESSAGE whose sender device identity key no longer matches the published card', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const aliceDevice = buildPublishedDeviceDirectory(aliceE2E)[0];
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const applicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello bob' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const encrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope,
      recipientDevice: bobDevice,
      claimedBundle,
    });
    const decodedMessage = decodeEncryptedApplicationEnvelopePayload(encrypted.payload);
    expect(decodedMessage.type).toBe('PREKEY_MESSAGE');

    expect(() => assertPublishedSenderDeviceMatchesPreKeyMessage({
      did: aliceDid,
      devices: [{
        ...aliceDevice,
        identityKeyPublic: '00'.repeat(32),
      }],
    }, decodedMessage)).toThrow(
      `Sender ${aliceDid}:${aliceDevice.deviceId} published identity key does not match PREKEY_MESSAGE`,
    );
  });

  it('rejects a tampered encrypted transport envelope signature', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const applicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello bob' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const encrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope,
      recipientDevice: bobDevice,
      claimedBundle,
    });
    const transportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope,
      payload: encrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });
    const tamperedTransportEnvelope = {
      ...transportEnvelope,
      payload: {
        ...transportEnvelope.payload,
        sessionId: `${encrypted.payload.sessionId}-tampered`,
      },
    };

    await expect(decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: tamperedTransportEnvelope,
      now: 100,
    })).rejects.toThrow('Encrypted transport envelope signature verification failed');
  });

  it('rejects an impersonated decrypted application envelope signature', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const malloryKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    const aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const impersonatedApplicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'mallory says hi' }),
      (data) => sign(data, malloryKeys.privateKey),
    );
    const encrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: impersonatedApplicationEnvelope,
      recipientDevice: bobDevice,
      claimedBundle,
    });
    const transportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: impersonatedApplicationEnvelope,
      payload: encrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });

    await expect(decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope,
      now: 100,
    })).rejects.toThrow('Decrypted application envelope signature verification failed');
  });


  it('rejects a SESSION_MESSAGE with tampered ciphertext before application delivery', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    let aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    let bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const firstApplicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello bob' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const firstEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: firstApplicationEnvelope,
      recipientDevice: bobDevice,
      claimedBundle,
    });
    aliceE2E = firstEncrypted.e2eConfig;
    const firstTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: firstApplicationEnvelope,
      payload: firstEncrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });
    const firstDecrypted = await decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: firstTransportEnvelope,
      now: 100,
    });
    bobE2E = firstDecrypted.e2eConfig;

    const secondApplicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello again' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const secondEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: secondApplicationEnvelope,
      recipientDevice: bobDevice,
    });
    const tamperedSessionMessage = decodeSessionMessage(hexToBytes(secondEncrypted.payload.wireMessage));
    const ciphertext = new Uint8Array(tamperedSessionMessage.ciphertext);
    ciphertext[ciphertext.length - 1] ^= 0x01;
    tamperedSessionMessage.ciphertext = ciphertext;
    const tamperedPayload = {
      ...secondEncrypted.payload,
      wireMessage: Buffer.from(encodeSessionMessage(tamperedSessionMessage)).toString('hex'),
    };
    const tamperedTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: secondApplicationEnvelope,
      payload: tamperedPayload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });

    await expect(decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: tamperedTransportEnvelope,
      now: 200,
    })).rejects.toThrow('Failed to decrypt with XChaCha20-Poly1305');
  });

  it('rejects a SESSION_MESSAGE with a tampered ratchet header before application delivery', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    let aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    let bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const firstApplicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello bob' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const firstEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: firstApplicationEnvelope,
      recipientDevice: bobDevice,
      claimedBundle,
    });
    aliceE2E = firstEncrypted.e2eConfig;
    const firstTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: firstApplicationEnvelope,
      payload: firstEncrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });
    const firstDecrypted = await decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: firstTransportEnvelope,
      now: 100,
    });
    bobE2E = firstDecrypted.e2eConfig;

    const secondApplicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello again' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const secondEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: secondApplicationEnvelope,
      recipientDevice: bobDevice,
    });
    const tamperedSessionMessage = decodeSessionMessage(hexToBytes(secondEncrypted.payload.wireMessage));
    tamperedSessionMessage.messageNumber += 1;
    const tamperedPayload = {
      ...secondEncrypted.payload,
      wireMessage: Buffer.from(encodeSessionMessage(tamperedSessionMessage)).toString('hex'),
    };
    const tamperedTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: secondApplicationEnvelope,
      payload: tamperedPayload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });

    await expect(decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: tamperedTransportEnvelope,
      now: 200,
    })).rejects.toThrow('Failed to decrypt with XChaCha20-Poly1305');
  });

  it('rejects a replayed SESSION_MESSAGE after ratchet state advances', async () => {
    const aliceKeys = await generateKeyPair();
    const bobKeys = await generateKeyPair();
    const aliceDid = deriveDID(aliceKeys.publicKey);
    const bobDid = deriveDID(bobKeys.publicKey);
    let aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
    let bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
    const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
    const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
    const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

    const firstApplicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello bob' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const firstEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: firstApplicationEnvelope,
      recipientDevice: bobDevice,
      claimedBundle,
    });
    aliceE2E = firstEncrypted.e2eConfig;
    const firstTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: firstApplicationEnvelope,
      payload: firstEncrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });
    const firstDecrypted = await decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: firstTransportEnvelope,
      now: 100,
    });
    bobE2E = firstDecrypted.e2eConfig;

    const secondApplicationEnvelope = await signEnvelope(
      createEnvelope(aliceDid, bobDid, 'message', '/agent/msg/1.0.0', { text: 'hello again' }),
      (data) => sign(data, aliceKeys.privateKey),
    );
    const secondEncrypted = encryptApplicationEnvelope({
      e2eConfig: aliceE2E,
      applicationEnvelope: secondApplicationEnvelope,
      recipientDevice: bobDevice,
    });
    const secondTransportEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope: secondApplicationEnvelope,
      payload: secondEncrypted.payload,
      signFn: (data) => sign(data, aliceKeys.privateKey),
    });
    const secondDecrypted = await decryptApplicationEnvelope({
      e2eConfig: bobE2E,
      receiverDid: bobDid,
      transportEnvelope: secondTransportEnvelope,
      now: 200,
    });

    await expect(decryptApplicationEnvelope({
      e2eConfig: secondDecrypted.e2eConfig,
      receiverDid: bobDid,
      transportEnvelope: secondTransportEnvelope,
      now: 300,
    })).rejects.toThrow('Failed to decrypt with XChaCha20-Poly1305');
  });
});
