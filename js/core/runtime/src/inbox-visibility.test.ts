import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '@quadra-a/protocol';
import { paginateVisibleInboxMessages } from './inbox-visibility.js';

function buildMessage(
  id: string,
  direction: StoredMessage['direction'],
  from: string,
  to: string,
): StoredMessage {
  return {
    envelope: {
      id,
      from,
      to,
      type: 'message',
      protocol: '/agent/msg/1.0.0',
      payload: { text: id },
      timestamp: 1,
      signature: 'sig',
    },
    direction,
    status: 'pending',
    ...(direction === 'inbound' ? { receivedAt: 1 } : { sentAt: 1 }),
  };
}

describe('paginateVisibleInboxMessages', () => {
  it('hides blocked inbound messages and keeps outbound history visible', () => {
    const page = paginateVisibleInboxMessages(
      [
        buildMessage('msg-blocked', 'inbound', 'did:agent:blocked', 'did:agent:me'),
        buildMessage('msg-ok', 'inbound', 'did:agent:ok', 'did:agent:me'),
        buildMessage('msg-outbound', 'outbound', 'did:agent:me', 'did:agent:blocked'),
      ],
      new Set(['did:agent:blocked']),
      { limit: 10, offset: 0 },
    );

    expect(page.messages.map((message) => message.envelope.id)).toEqual(['msg-ok', 'msg-outbound']);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
  });
});
