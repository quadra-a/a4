import { describe, expect, it } from 'vitest';
import type { StoredMessage } from './types.js';
import { storedMessageStatus } from './status.js';

function buildMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    envelope: {
      id: 'msg-1',
      from: 'did:agent:alice',
      to: 'did:agent:bob',
      type: 'message',
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello' },
      timestamp: 1,
      signature: 'sig',
    },
    direction: 'inbound',
    status: 'pending',
    receivedAt: 1,
    ...overrides,
  };
}

describe('storedMessageStatus', () => {
  it('keeps unread inbound messages pending even when E2E received exists', () => {
    expect(storedMessageStatus(buildMessage({
      e2e: {
        deliveries: [{
          transport: 'session',
          senderDeviceId: 'sender-1',
          receiverDeviceId: 'receiver-1',
          sessionId: 'session-1',
          state: 'received',
          recordedAt: 1,
        }],
      },
    }))).toBe('pending');
  });

  it('marks read inbound messages as delivered', () => {
    expect(storedMessageStatus(buildMessage({
      readAt: 10,
      e2e: {
        deliveries: [{
          transport: 'session',
          senderDeviceId: 'sender-1',
          receiverDeviceId: 'receiver-1',
          sessionId: 'session-1',
          state: 'received',
          recordedAt: 1,
        }],
      },
    }))).toBe('delivered');
  });

  it('marks outbound received deliveries as delivered', () => {
    expect(storedMessageStatus(buildMessage({
      direction: 'outbound',
      status: 'pending',
      sentAt: 1,
      receivedAt: undefined,
      e2e: {
        deliveries: [{
          transport: 'session',
          senderDeviceId: 'sender-1',
          receiverDeviceId: 'receiver-1',
          sessionId: 'session-1',
          state: 'received',
          recordedAt: 1,
        }],
      },
    }))).toBe('delivered');
  });
});
