import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '@quadra-a/protocol';

const mocks = vi.hoisted(() => ({
  sendMock: vi.fn(),
  isDaemonRunningMock: vi.fn(),
  subscribeInboxMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('./daemon-client.js', () => ({
  DaemonClient: class {
    send(command: string, params: unknown) {
      return mocks.sendMock(command, params);
    }

    isDaemonRunning() {
      return mocks.isDaemonRunningMock();
    }
  },
  DaemonSubscriptionClient: class {
    subscribeInbox(params: unknown, onEvent: unknown) {
      return mocks.subscribeInboxMock(params, onEvent);
    }

    close() {
      return mocks.closeMock();
    }
  },
}));

import { waitForMessageOutcome } from './inbox.js';

function makeReply(replyTo: string): StoredMessage {
  return {
    envelope: {
      id: 'msg-reply',
      from: 'did:agent:worker',
      to: 'did:agent:sender',
      type: 'reply',
      protocol: '/jobs/1.0.0',
      payload: { ok: true },
      timestamp: Date.now(),
      signature: 'sig',
      replyTo,
    },
    direction: 'inbound',
    status: 'pending',
    receivedAt: Date.now(),
  };
}

describe('waitForMessageOutcome', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sendMock.mockReset();
    mocks.isDaemonRunningMock.mockReset();
    mocks.subscribeInboxMock.mockReset();
    mocks.closeMock.mockReset();
    mocks.isDaemonRunningMock.mockResolvedValue(true);
    mocks.subscribeInboxMock.mockResolvedValue('sub_1');
    mocks.closeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to polling even when the inbox subscription stays silent', async () => {
    const reply = makeReply('msg-origin');
    let inboxReads = 0;

    mocks.sendMock.mockImplementation(async (command: string) => {
      if (command !== 'inbox') {
        throw new Error(`Unexpected command: ${command}`);
      }

      inboxReads += 1;
      return {
        messages: inboxReads >= 2 ? [reply] : [],
        total: inboxReads >= 2 ? 1 : 0,
        hasMore: false,
      };
    });

    const waitPromise = waitForMessageOutcome('msg-origin', 2_000);
    await vi.advanceTimersByTimeAsync(600);

    await expect(waitPromise).resolves.toEqual(expect.objectContaining({
      kind: 'reply',
      terminal: true,
      message: expect.objectContaining({
        envelope: expect.objectContaining({
          id: 'msg-reply',
          replyTo: 'msg-origin',
        }),
      }),
    }));
    expect(mocks.subscribeInboxMock).toHaveBeenCalledOnce();
    expect(mocks.closeMock).toHaveBeenCalledOnce();
  });
});
