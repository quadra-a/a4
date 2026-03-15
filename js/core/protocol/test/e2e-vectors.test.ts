import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  buildPreKeyMessageAssociatedData,
  buildSessionMessageAssociatedData,
  buildSignedPreKeyPayload,
  bytesToHex,
  createInitiatorRatchetSession,
  createResponderRatchetSession,
  decodePreKeyMessage,
  decodeSessionMessage,
  decryptPreKeyMessage,
  decryptRatchetMessage,
  decryptSessionMessage,
  deriveX25519PublicKey,
  deriveX3dhInitiatorSharedSecret,
  deriveX3dhResponderSharedSecret,
  encodePreKeyMessage,
  encodeSessionMessage,
  encryptPreKeyMessage,
  encryptRatchetMessage,
  encryptSessionMessage,
  hexToBytes,
  loadVectorManifest,
  verifySignedPreKeyRecord,
} from '../src/index.js';

const schemaPath = fileURLToPath(new URL('../../../../test-scripts/e2e/vectors/schema.json', import.meta.url));
const x3dhPath = fileURLToPath(new URL('../../../../test-scripts/e2e/vectors/x3dh/basic.json', import.meta.url));
const signedPreKeyPath = fileURLToPath(new URL('../../../../test-scripts/e2e/vectors/agent-card-devices/basic.json', import.meta.url));
const preKeyMessagePath = fileURLToPath(new URL('../../../../test-scripts/e2e/vectors/prekey-message/basic.json', import.meta.url));
const sessionMessagePath = fileURLToPath(new URL('../../../../test-scripts/e2e/vectors/session-message/basic.json', import.meta.url));
const doubleRatchetPath = fileURLToPath(new URL('../../../../test-scripts/e2e/vectors/double-ratchet/basic.json', import.meta.url));

describe('E2E shared vectors', () => {
  it('loads manifests against the shared schema', async () => {
    const manifests = await Promise.all([
      loadVectorManifest(x3dhPath, schemaPath),
      loadVectorManifest(signedPreKeyPath, schemaPath),
      loadVectorManifest(preKeyMessagePath, schemaPath),
      loadVectorManifest(sessionMessagePath, schemaPath),
      loadVectorManifest(doubleRatchetPath, schemaPath),
    ]);

    expect(manifests.map((manifest) => manifest.suite)).toEqual([
      'x3dh',
      'agent-card-devices',
      'prekey-message',
      'session-message',
      'double-ratchet',
    ]);
  });

  it('verifies the signed pre-key fixture', async () => {
    const manifest = await loadVectorManifest(signedPreKeyPath, schemaPath);
    const fixture = manifest.cases[0];
    const signedPreKeyPublic = hexToBytes(fixture.inputs.signedPreKeyPublic as string);
    const payload = buildSignedPreKeyPayload(
      fixture.inputs.deviceId as string,
      fixture.inputs.signedPreKeyId as number,
      signedPreKeyPublic,
    );

    expect(bytesToHex(payload)).toBe(fixture.expected.signaturePayload as string);
    await expect(
      verifySignedPreKeyRecord(
        {
          deviceId: fixture.inputs.deviceId as string,
          signedPreKeyId: fixture.inputs.signedPreKeyId as number,
          signedPreKeyPublic,
          signature: hexToBytes(fixture.expected.signedPreKeySignature as string),
        },
        hexToBytes(fixture.expected.didSigningPublic as string),
      ),
    ).resolves.toBe(true);
  });

  it('derives the X3DH shared secret from fixture inputs', async () => {
    const manifest = await loadVectorManifest(x3dhPath, schemaPath);
    const fixture = manifest.cases[0];

    const initiatorIdentityPrivate = hexToBytes(fixture.inputs.initiatorIdentityPrivate as string);
    const initiatorEphemeralPrivate = hexToBytes(fixture.inputs.initiatorEphemeralPrivate as string);
    const recipientIdentityPrivate = hexToBytes(fixture.inputs.recipientIdentityPrivate as string);
    const recipientSignedPreKeyPrivate = hexToBytes(fixture.inputs.recipientSignedPreKeyPrivate as string);
    const recipientOneTimePreKeyPrivate = hexToBytes(fixture.inputs.recipientOneTimePreKeyPrivate as string);

    expect(bytesToHex(deriveX25519PublicKey(initiatorIdentityPrivate))).toBe(fixture.expected.initiatorIdentityPublic as string);
    expect(bytesToHex(deriveX25519PublicKey(initiatorEphemeralPrivate))).toBe(fixture.expected.initiatorEphemeralPublic as string);
    expect(bytesToHex(deriveX25519PublicKey(recipientIdentityPrivate))).toBe(fixture.expected.recipientIdentityPublic as string);
    expect(bytesToHex(deriveX25519PublicKey(recipientSignedPreKeyPrivate))).toBe(fixture.expected.recipientSignedPreKeyPublic as string);
    expect(bytesToHex(deriveX25519PublicKey(recipientOneTimePreKeyPrivate))).toBe(fixture.expected.recipientOneTimePreKeyPublic as string);

    const initiatorSecret = deriveX3dhInitiatorSharedSecret({
      initiatorIdentityPrivate,
      initiatorEphemeralPrivate,
      recipientIdentityPublic: hexToBytes(fixture.expected.recipientIdentityPublic as string),
      recipientSignedPreKeyPublic: hexToBytes(fixture.expected.recipientSignedPreKeyPublic as string),
      recipientOneTimePreKeyPublic: hexToBytes(fixture.expected.recipientOneTimePreKeyPublic as string),
    });
    const responderSecret = deriveX3dhResponderSharedSecret({
      recipientIdentityPrivate,
      recipientSignedPreKeyPrivate,
      initiatorIdentityPublic: hexToBytes(fixture.expected.initiatorIdentityPublic as string),
      initiatorEphemeralPublic: hexToBytes(fixture.expected.initiatorEphemeralPublic as string),
      recipientOneTimePreKeyPrivate,
    });

    expect(bytesToHex(initiatorSecret)).toBe(fixture.expected.sharedSecret as string);
    expect(bytesToHex(responderSecret)).toBe(fixture.expected.sharedSecret as string);
  });

  it('matches the PREKEY_MESSAGE fixture ciphertext and wire bytes', async () => {
    const manifest = await loadVectorManifest(preKeyMessagePath, schemaPath);
    const fixture = manifest.cases[0];

    const baseMessage = {
      version: fixture.inputs.version as number,
      type: 'PREKEY_MESSAGE' as const,
      senderDid: fixture.inputs.senderDid as string,
      receiverDid: fixture.inputs.receiverDid as string,
      senderDeviceId: fixture.inputs.senderDeviceId as string,
      receiverDeviceId: fixture.inputs.receiverDeviceId as string,
      sessionId: fixture.inputs.sessionId as string,
      messageId: fixture.inputs.messageId as string,
      initiatorIdentityKey: hexToBytes(fixture.inputs.initiatorIdentityKey as string),
      initiatorEphemeralKey: hexToBytes(fixture.inputs.initiatorEphemeralKey as string),
      recipientSignedPreKeyId: fixture.inputs.recipientSignedPreKeyId as number,
      recipientOneTimePreKeyId: fixture.inputs.recipientOneTimePreKeyId as number,
      nonce: hexToBytes(fixture.inputs.nonce as string),
    };
    const key = hexToBytes(fixture.inputs.contentKey as string);
    const plaintext = hexToBytes(fixture.inputs.plaintext as string);
    const encrypted = encryptPreKeyMessage(baseMessage, key, plaintext);
    const encoded = encodePreKeyMessage(encrypted);
    const decoded = decodePreKeyMessage(encoded);

    expect(bytesToHex(buildPreKeyMessageAssociatedData(encrypted))).toBe(fixture.expected.associatedData as string);
    expect(bytesToHex(encrypted.ciphertext)).toBe(fixture.expected.ciphertext as string);
    expect(bytesToHex(encoded)).toBe(fixture.expected.encoded as string);
    expect(decryptPreKeyMessage(decoded, key)).toEqual(plaintext);
  });

  it('matches the SESSION_MESSAGE fixture ciphertext and wire bytes', async () => {
    const manifest = await loadVectorManifest(sessionMessagePath, schemaPath);
    const fixture = manifest.cases[0];

    const baseMessage = {
      version: fixture.inputs.version as number,
      type: 'SESSION_MESSAGE' as const,
      senderDid: fixture.inputs.senderDid as string,
      receiverDid: fixture.inputs.receiverDid as string,
      senderDeviceId: fixture.inputs.senderDeviceId as string,
      receiverDeviceId: fixture.inputs.receiverDeviceId as string,
      sessionId: fixture.inputs.sessionId as string,
      messageId: fixture.inputs.messageId as string,
      ratchetPublicKey: hexToBytes(fixture.inputs.ratchetPublicKey as string),
      previousChainLength: fixture.inputs.previousChainLength as number,
      messageNumber: fixture.inputs.messageNumber as number,
      nonce: hexToBytes(fixture.inputs.nonce as string),
    };
    const key = hexToBytes(fixture.inputs.contentKey as string);
    const plaintext = hexToBytes(fixture.inputs.plaintext as string);
    const encrypted = encryptSessionMessage(baseMessage, key, plaintext);
    const encoded = encodeSessionMessage(encrypted);
    const decoded = decodeSessionMessage(encoded);

    expect(bytesToHex(buildSessionMessageAssociatedData(encrypted))).toBe(fixture.expected.associatedData as string);
    expect(bytesToHex(encrypted.ciphertext)).toBe(fixture.expected.ciphertext as string);
    expect(bytesToHex(encoded)).toBe(fixture.expected.encoded as string);
    expect(decryptSessionMessage(decoded, key)).toEqual(plaintext);
  });

  it('matches the DOUBLE_RATCHET bootstrap and DH-reply fixture', async () => {
    const manifest = await loadVectorManifest(doubleRatchetPath, schemaPath);
    const fixture = manifest.cases[0];

    const sharedSecret = hexToBytes(fixture.inputs.sharedSecret as string);
    const initiatorRatchetPrivate = hexToBytes(fixture.inputs.initiatorRatchetPrivate as string);
    const responderRatchetPrivate = hexToBytes(fixture.inputs.responderRatchetPrivate as string);
    const responderReplyRatchetPrivate = hexToBytes(fixture.inputs.responderReplyRatchetPrivate as string);
    const initiatorRatchetPublic = deriveX25519PublicKey(initiatorRatchetPrivate);
    const responderRatchetPublic = deriveX25519PublicKey(responderRatchetPrivate);
    const responderReplyRatchetPublic = deriveX25519PublicKey(responderReplyRatchetPrivate);
    const createdAt = fixture.inputs.createdAt as number;

    expect(bytesToHex(initiatorRatchetPublic)).toBe(fixture.expected.initiatorRatchetPublic as string);
    expect(bytesToHex(responderRatchetPublic)).toBe(fixture.expected.responderRatchetPublic as string);
    expect(bytesToHex(responderReplyRatchetPublic)).toBe(fixture.expected.responderReplyRatchetPublic as string);

    const initiatorSession = createInitiatorRatchetSession({
      sessionId: fixture.inputs.sessionId as string,
      peerDid: fixture.inputs.responderDid as string,
      peerDeviceId: fixture.inputs.responderDeviceId as string,
      selfDeviceId: fixture.inputs.initiatorDeviceId as string,
      role: 'initiator',
      rootKey: sharedSecret,
      currentRatchetKey: {
        publicKey: initiatorRatchetPublic,
        privateKey: initiatorRatchetPrivate,
      },
      remoteRatchetPublicKey: responderRatchetPublic,
      bootstrap: {
        selfIdentityKey: fixture.inputs.initiatorIdentityPublic as string,
        peerIdentityKey: fixture.inputs.responderIdentityPublic as string,
        initiatorEphemeralKey: bytesToHex(initiatorRatchetPublic),
        recipientSignedPreKeyId: fixture.inputs.responderSignedPreKeyId as number,
        recipientSignedPreKeyPublic: bytesToHex(responderRatchetPublic),
        recipientOneTimePreKeyId: fixture.inputs.responderOneTimePreKeyId as number,
      },
      createdAt,
    });
    const responderSession = createResponderRatchetSession({
      sessionId: fixture.inputs.sessionId as string,
      peerDid: fixture.inputs.initiatorDid as string,
      peerDeviceId: fixture.inputs.initiatorDeviceId as string,
      selfDeviceId: fixture.inputs.responderDeviceId as string,
      role: 'responder',
      rootKey: sharedSecret,
      currentRatchetKey: {
        publicKey: responderRatchetPublic,
        privateKey: responderRatchetPrivate,
      },
      remoteRatchetPublicKey: initiatorRatchetPublic,
      bootstrap: {
        selfIdentityKey: fixture.inputs.responderIdentityPublic as string,
        peerIdentityKey: fixture.inputs.initiatorIdentityPublic as string,
        initiatorEphemeralKey: bytesToHex(initiatorRatchetPublic),
        recipientSignedPreKeyId: fixture.inputs.responderSignedPreKeyId as number,
        recipientSignedPreKeyPublic: bytesToHex(responderRatchetPublic),
        recipientOneTimePreKeyId: fixture.inputs.responderOneTimePreKeyId as number,
      },
      createdAt,
    });

    expect(initiatorSession.rootKey).toBe(fixture.expected.initiatorInitialRootKey as string);
    expect(initiatorSession.sendingChainKey).toBe(fixture.expected.initiatorInitialSendingChainKey as string);
    expect(responderSession.rootKey).toBe(fixture.expected.responderInitialRootKey as string);
    expect(responderSession.receivingChainKey).toBe(fixture.expected.responderInitialReceivingChainKey as string);

    const initiatorFirst = encryptRatchetMessage({
      session: initiatorSession,
      plaintext: hexToBytes(fixture.inputs.initiatorFirstPlaintext as string),
      senderDid: fixture.inputs.initiatorDid as string,
      receiverDid: fixture.inputs.responderDid as string,
      messageId: fixture.inputs.initiatorFirstMessageId as string,
      nonce: hexToBytes(fixture.inputs.initiatorFirstNonce as string),
      now: createdAt + 10,
    });

    expect(bytesToHex(initiatorFirst.message.ratchetPublicKey)).toBe(fixture.expected.initiatorRatchetPublic as string);
    expect(initiatorFirst.message.messageNumber).toBe(fixture.expected.initiatorFirstMessageNumber as number);
    expect(initiatorFirst.message.previousChainLength).toBe(fixture.expected.initiatorFirstPreviousChainLength as number);
    expect(bytesToHex(initiatorFirst.messageKey)).toBe(fixture.expected.initiatorFirstMessageKey as string);
    expect(bytesToHex(initiatorFirst.message.ciphertext)).toBe(fixture.expected.initiatorFirstCiphertext as string);
    expect(initiatorFirst.session.sendingChainKey).toBe(fixture.expected.initiatorAfterFirstSendingChainKey as string);

    const responderAfterFirst = decryptRatchetMessage({
      session: responderSession,
      message: initiatorFirst.message,
      now: createdAt + 20,
    });

    expect(bytesToHex(responderAfterFirst.plaintext)).toBe(fixture.inputs.initiatorFirstPlaintext as string);
    expect(bytesToHex(responderAfterFirst.messageKey)).toBe(fixture.expected.initiatorFirstMessageKey as string);
    expect(responderAfterFirst.session.receivingChainKey).toBe(fixture.expected.responderAfterFirstReceivingChainKey as string);
    expect(responderAfterFirst.session.nextReceiveMessageNumber).toBe(
      fixture.expected.responderAfterFirstNextReceiveMessageNumber as number,
    );

    const responderReply = encryptRatchetMessage({
      session: responderAfterFirst.session,
      plaintext: hexToBytes(fixture.inputs.responderReplyPlaintext as string),
      senderDid: fixture.inputs.responderDid as string,
      receiverDid: fixture.inputs.initiatorDid as string,
      messageId: fixture.inputs.responderReplyMessageId as string,
      nonce: hexToBytes(fixture.inputs.responderReplyNonce as string),
      ratchetKeyPair: {
        publicKey: responderReplyRatchetPublic,
        privateKey: responderReplyRatchetPrivate,
      },
      now: createdAt + 30,
    });

    expect(bytesToHex(responderReply.message.ratchetPublicKey)).toBe(fixture.expected.responderReplyRatchetPublic as string);
    expect(responderReply.message.messageNumber).toBe(fixture.expected.responderReplyMessageNumber as number);
    expect(responderReply.message.previousChainLength).toBe(fixture.expected.responderReplyPreviousChainLength as number);
    expect(responderReply.session.rootKey).toBe(fixture.expected.responderReplyRootKey as string);
    expect(responderReply.session.sendingChainKey).toBe(fixture.expected.responderReplySendingChainKeyAfter as string);
    expect(bytesToHex(responderReply.messageKey)).toBe(fixture.expected.responderReplyMessageKey as string);
    expect(bytesToHex(responderReply.message.ciphertext)).toBe(fixture.expected.responderReplyCiphertext as string);

    const initiatorAfterReply = decryptRatchetMessage({
      session: initiatorFirst.session,
      message: responderReply.message,
      now: createdAt + 40,
    });

    expect(bytesToHex(initiatorAfterReply.plaintext)).toBe(fixture.inputs.responderReplyPlaintext as string);
    expect(bytesToHex(initiatorAfterReply.messageKey)).toBe(fixture.expected.responderReplyMessageKey as string);
    expect(initiatorAfterReply.session.rootKey).toBe(fixture.expected.initiatorAfterReplyRootKey as string);
    expect(initiatorAfterReply.session.receivingChainKey).toBe(fixture.expected.initiatorAfterReplyReceivingChainKey as string);
    expect(initiatorAfterReply.session.nextReceiveMessageNumber).toBe(
      fixture.expected.initiatorAfterReplyNextReceiveMessageNumber as number,
    );
    expect(initiatorAfterReply.session.remoteRatchetPublicKey).toBe(
      fixture.expected.initiatorAfterReplyRemoteRatchetPublicKey as string,
    );
  });
});
