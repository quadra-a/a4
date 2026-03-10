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
});
