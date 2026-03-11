import { describe, expect, it } from 'vitest';
import { compareMessagesBySortTimestamp, getMessageSortTimestamp, MAX_MESSAGE_SORT_SKEW_MS } from './timestamp.js';
import type { StoredMessage } from './types.js';

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  const envelope = {
    id: 'msg-default',
    from: 'did:agent:alice',
    to: 'did:agent:bob',
    type: 'message',
    protocol: 'test/v1',
    payload: { text: 'hello' },
    timestamp: 1_000,
    signature: 'sig',
    ...(overrides.envelope ?? {}),
  };

  return {
    direction: 'inbound',
    status: 'delivered',
    receivedAt: 2_000,
    ...overrides,
    envelope,
  };
}

describe('message timestamp helpers', () => {
  it('prefers envelope timestamp when clock skew is within threshold', () => {
    const message = makeMessage({
      receivedAt: 2_000,
      envelope: { timestamp: 1_500 } as StoredMessage['envelope'],
    });

    expect(getMessageSortTimestamp(message)).toBe(1_500);
  });

  it('falls back to local time when clock skew exceeds threshold', () => {
    const message = makeMessage({
      receivedAt: MAX_MESSAGE_SORT_SKEW_MS + 10_000,
      envelope: { timestamp: 1_000 } as StoredMessage['envelope'],
    });

    expect(getMessageSortTimestamp(message)).toBe(MAX_MESSAGE_SORT_SKEW_MS + 10_000);
  });

  it('sorts equal message timestamps by local timestamp and id', () => {
    const first = makeMessage({
      receivedAt: 1_000,
      envelope: { id: 'msg-a', timestamp: 500 } as StoredMessage['envelope'],
    });
    const second = makeMessage({
      receivedAt: 1_500,
      envelope: { id: 'msg-b', timestamp: 500 } as StoredMessage['envelope'],
    });

    expect(compareMessagesBySortTimestamp(first, second)).toBeLessThan(0);
  });
});
