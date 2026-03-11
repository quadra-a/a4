import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '@quadra-a/protocol';
import { findMessageOutcome } from './inbox.js';

function makeMessage(overrides: Partial<StoredMessage>): StoredMessage {
  const baseEnvelope: StoredMessage['envelope'] = {
    id: 'msg-default',
    from: 'did:agent:worker',
    to: 'did:agent:sender',
    type: 'message',
    protocol: '/jobs/1.0.0',
    payload: {},
    timestamp: Date.now(),
    signature: 'sig',
  };

  return {
    direction: 'inbound',
    status: 'delivered',
    receivedAt: Date.now(),
    ...overrides,
    envelope: {
      ...baseEnvelope,
      ...(overrides.envelope ?? {}),
    },
  };
}

describe('findMessageOutcome', () => {
  it('resolves a formal reply immediately', () => {
    const reply = makeMessage({
      envelope: {
        id: 'msg-reply',
        type: 'reply',
        replyTo: 'msg-origin',
        payload: { ok: true },
      } as StoredMessage['envelope'],
    });

    const outcome = findMessageOutcome([reply], 'msg-origin');

    expect(outcome).not.toBeNull();
    expect(outcome?.kind).toBe('reply');
    expect(outcome?.terminal).toBe(true);
    expect(outcome?.message.envelope.id).toBe('msg-reply');
  });

  it('tracks async progress via replyTo and finishes on terminal jobId result', () => {
    const running = makeMessage({
      receivedAt: 1,
      envelope: {
        id: 'msg-running',
        replyTo: 'msg-origin',
        payload: { status: 'running', jobId: 'job-1' },
      } as StoredMessage['envelope'],
    });
    const success = makeMessage({
      receivedAt: 2,
      envelope: {
        id: 'msg-success',
        payload: { status: 'success', jobId: 'job-1', tflops: 0.17 },
      } as StoredMessage['envelope'],
    });

    const outcome = findMessageOutcome([success, running], 'msg-origin');

    expect(outcome).not.toBeNull();
    expect(outcome?.kind).toBe('result');
    expect(outcome?.status).toBe('success');
    expect(outcome?.jobId).toBe('job-1');
    expect(outcome?.terminal).toBe(true);
    expect(outcome?.message.envelope.id).toBe('msg-success');
  });

  it('uses message timestamp ordering when arrivals are out of order', () => {
    const running = makeMessage({
      receivedAt: 2,
      envelope: {
        id: 'msg-running',
        timestamp: 100,
        replyTo: 'msg-origin',
        payload: { status: 'running', jobId: 'job-1' },
      } as StoredMessage['envelope'],
    });
    const success = makeMessage({
      receivedAt: 1,
      envelope: {
        id: 'msg-success',
        timestamp: 200,
        payload: { status: 'success', jobId: 'job-1', tflops: 0.17 },
      } as StoredMessage['envelope'],
    });

    const outcome = findMessageOutcome([success, running], 'msg-origin');

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe('success');
    expect(outcome?.message.envelope.id).toBe('msg-success');
  });
});
