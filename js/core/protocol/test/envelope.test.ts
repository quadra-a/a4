import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  deriveDID,
  generateKeyPair,
  normalizeEnvelope,
  sign,
  signEnvelope,
  verify,
  verifyEnvelope,
} from '../src/index.js';

describe('message envelope async correlation', () => {
  it('normalizes message envelopes that include replyTo', () => {
    const normalized = normalizeEnvelope({
      id: 'msg-1',
      from: 'did:agent:zSender',
      to: 'did:agent:zTarget',
      type: 'message',
      protocol: '/jobs/1.0.0',
      payload: { status: 'running', jobId: 'job-1' },
      timestamp: Date.now(),
      signature: 'deadbeef',
      replyTo: 'msg-origin',
    });

    expect(normalized).toMatchObject({
      type: 'message',
      replyTo: 'msg-origin',
    });
  });

  it('creates message envelopes with replyTo preserved', () => {
    const envelope = createEnvelope(
      'did:agent:zSender',
      'did:agent:zTarget',
      'message',
      '/jobs/1.0.0',
      { status: 'running', jobId: 'job-1' },
      'msg-origin',
    );

    expect(envelope).toMatchObject({
      type: 'message',
      replyTo: 'msg-origin',
    });
  });

  it('preserves quick agent group metadata on envelopes', () => {
    const envelope = createEnvelope(
      'did:agent:zSender',
      'did:agent:zTarget',
      'message',
      '/jobs/1.0.0',
      { status: 'running', jobId: 'job-1' },
      undefined,
      undefined,
      'grp_overlay',
    );

    const normalized = normalizeEnvelope({
      ...envelope,
      signature: 'deadbeef',
    });

    expect(envelope.groupId).toBe('grp_overlay');
    expect(normalized?.groupId).toBe('grp_overlay');
  });

  it('signs and verifies message envelopes with replyTo', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const envelope = createEnvelope(
      did,
      did,
      'message',
      '/jobs/1.0.0',
      { status: 'success', jobId: 'job-1', value: 42 },
      'msg-origin',
    );

    const signedEnvelope = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
    const verified = await verifyEnvelope(signedEnvelope, (signature, data) => verify(signature, data, keyPair.publicKey));

    expect(verified).toBe(true);
    expect(signedEnvelope.replyTo).toBe('msg-origin');
  });

  it('produces the same signature for semantically identical envelopes with different key order', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);

    const first = {
      id: 'msg-canonical-1',
      from: did,
      to: did,
      type: 'message' as const,
      protocol: '/agent/msg/1.0.0',
      payload: {
        zeta: true,
        alpha: { beta: 1, gamma: 2 },
      },
      timestamp: 123,
      threadId: 'thread-canonical',
      groupId: 'grp_overlay',
    };
    const second = {
      groupId: 'grp_overlay',
      threadId: 'thread-canonical',
      timestamp: 123,
      payload: {
        alpha: { gamma: 2, beta: 1 },
        zeta: true,
      },
      protocol: '/agent/msg/1.0.0',
      type: 'message' as const,
      to: did,
      from: did,
      id: 'msg-canonical-1',
    };

    const signedFirst = await signEnvelope(first, (data) => sign(data, keyPair.privateKey));
    const signedSecond = await signEnvelope(second, (data) => sign(data, keyPair.privateKey));

    expect(signedFirst.signature).toBe(signedSecond.signature);
    expect(await verifyEnvelope(signedSecond, (signature, data) => verify(signature, data, keyPair.publicKey))).toBe(true);
  });

  it('verifies envelopes signed with the legacy insertion-order payload', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const legacyEnvelope = createEnvelope(
      did,
      did,
      'message',
      '/agent/msg/1.0.0',
      {
        nested: {
          zeta: true,
          alpha: 1,
        },
      },
      'msg-origin',
      undefined,
      'grp_legacy',
    );
    const legacyBytes = new TextEncoder().encode(JSON.stringify(legacyEnvelope));
    const signature = Buffer.from(await sign(legacyBytes, keyPair.privateKey)).toString('hex');

    expect(await verifyEnvelope(
      {
        ...legacyEnvelope,
        signature,
      },
      (sig, data) => verify(sig, data, keyPair.publicKey),
    )).toBe(true);
  });
});
