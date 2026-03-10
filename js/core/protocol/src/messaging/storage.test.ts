/**
 * Unit tests for thread/session functions (CVP-0014)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateThreadId } from './envelope.js';
import { MessageStorage } from './storage.js';
import type { MessageEnvelope } from './envelope.js';
import type { StoredMessage } from './types.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

describe('generateThreadId', () => {
  it('should generate thread ID with correct format', () => {
    const threadId = generateThreadId();
    expect(threadId).toMatch(/^thread_\d+_[a-z0-9]+$/);
  });

  it('should generate unique thread IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateThreadId());
    }
    expect(ids.size).toBe(100);
  });

  it('should include timestamp in thread ID', () => {
    const threadId = generateThreadId();
    const parts = threadId.split('_');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('thread');
    expect(parseInt(parts[1])).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it('should generate thread IDs with increasing timestamps', async () => {
    const id1 = generateThreadId();
    await new Promise(resolve => setTimeout(resolve, 10));
    const id2 = generateThreadId();

    const ts1 = parseInt(id1.split('_')[1]);
    const ts2 = parseInt(id2.split('_')[1]);
    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });
});

describe('MessageStorage - Thread Operations', () => {
  let storage: MessageStorage;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hw1-test-'));
    storage = new MessageStorage(join(tempDir, 'test.db'));
    await storage.open();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const createTestMessage = (
    id: string,
    from: string,
    to: string,
    threadId?: string,
    text?: string
  ): StoredMessage => {
    const envelope: MessageEnvelope = {
      id,
      from,
      to,
      type: 'message',
      protocol: 'test/v1',
      payload: { text: text !== undefined ? text : 'Test message' },
      timestamp: Date.now(),
      signature: 'test-signature',
      threadId,
    };

    return {
      envelope,
      direction: 'inbound',
      status: 'delivered',
      receivedAt: Date.now(),
    };
  };

  describe('Thread Storage', () => {
    it('should store messages with thread ID', async () => {
      const threadId = generateThreadId();
      const msg = createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', threadId);

      await storage.putMessage(msg);

      const retrieved = await storage.getMessage('msg1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.envelope.threadId).toBe(threadId);
    });

    it('should store messages without thread ID', async () => {
      const msg = createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob');

      await storage.putMessage(msg);

      const retrieved = await storage.getMessage('msg1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.envelope.threadId).toBeUndefined();
    });

    it('should normalize legacy envelope types when storing messages', async () => {
      const legacy = createTestMessage('msg-legacy', 'did:agent:alice', 'did:agent:bob') as StoredMessage & { envelope: MessageEnvelope & { type: string } };
      legacy.envelope = {
        ...legacy.envelope,
        type: 'request',
      } as unknown as MessageEnvelope;

      await storage.putMessage(legacy as unknown as StoredMessage);

      const retrieved = await storage.getMessage('msg-legacy');
      expect(retrieved).toBeDefined();
      expect(retrieved?.envelope.type).toBe('message');
    });

    it('should create session metadata when storing message with thread ID', async () => {
      const threadId = generateThreadId();
      const msg = createTestMessage(
        'msg1',
        'did:agent:alice',
        'did:agent:bob',
        threadId,
        'Hello world'
      );

      await storage.putMessage(msg);

      const session = await storage.getSession(threadId);
      expect(session).toBeDefined();
      expect(session.threadId).toBe(threadId);
      expect(session.peerDid).toBe('did:agent:alice');
      expect(session.messageCount).toBe(1);
      expect(session.title).toBe('Hello world');
    });

    it('should update session metadata when adding more messages', async () => {
      const threadId = generateThreadId();
      const now = Date.now();
      const msg1 = createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', threadId);
      msg1.receivedAt = now;
      const msg2 = createTestMessage('msg2', 'did:agent:alice', 'did:agent:bob', threadId);
      msg2.receivedAt = now + 100;

      await storage.putMessage(msg1);
      await storage.putMessage(msg2);

      const session = await storage.getSession(threadId);
      expect(session).toBeDefined();
      expect(session.messageCount).toBe(2);
      expect(session.lastMessageAt).toBeGreaterThan(session.startedAt);
    });

    it('should truncate long titles to 50 characters', async () => {
      const threadId = generateThreadId();
      const longText = 'a'.repeat(100);
      const msg = createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', threadId, longText);

      await storage.putMessage(msg);

      const session = await storage.getSession(threadId);
      expect(session).toBeDefined();
      expect(session.title?.length).toBeLessThanOrEqual(50);
    });
  });

  describe('Thread Filtering', () => {
    it('should filter messages by thread ID', async () => {
      const thread1 = generateThreadId();
      const thread2 = generateThreadId();

      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', thread1));
      await storage.putMessage(createTestMessage('msg2', 'did:agent:alice', 'did:agent:bob', thread1));
      await storage.putMessage(createTestMessage('msg3', 'did:agent:alice', 'did:agent:bob', thread2));
      await storage.putMessage(createTestMessage('msg4', 'did:agent:alice', 'did:agent:bob')); // no thread

      const page = await storage.queryMessages('inbound', { threadId: thread1 });
      expect(page.messages.length).toBe(2);
      expect(page.messages.every(m => m.envelope.threadId === thread1)).toBe(true);
    });

    it('should return empty result for non-existent thread', async () => {
      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob'));

      const page = await storage.queryMessages('inbound', { threadId: 'thread_999_nonexistent' });
      expect(page.messages.length).toBe(0);
    });

    it('should not filter when threadId is not specified', async () => {
      const thread1 = generateThreadId();

      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', thread1));
      await storage.putMessage(createTestMessage('msg2', 'did:agent:alice', 'did:agent:bob'));

      const page = await storage.queryMessages('inbound', {});
      expect(page.messages.length).toBe(2);
    });
  });

  describe('Session Management', () => {
    it('should list all sessions', async () => {
      const thread1 = generateThreadId();
      const thread2 = generateThreadId();

      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', thread1));
      await storage.putMessage(createTestMessage('msg2', 'did:agent:charlie', 'did:agent:bob', thread2));

      const sessions = await storage.listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions.map(s => s.threadId)).toContain(thread1);
      expect(sessions.map(s => s.threadId)).toContain(thread2);
    });

    it('should filter sessions by peer DID', async () => {
      const thread1 = generateThreadId();
      const thread2 = generateThreadId();

      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', thread1));
      await storage.putMessage(createTestMessage('msg2', 'did:agent:charlie', 'did:agent:bob', thread2));

      const sessions = await storage.listSessions('did:agent:alice');
      expect(sessions.length).toBe(1);
      expect(sessions[0].peerDid).toBe('did:agent:alice');
    });

    it('should limit number of sessions returned', async () => {
      for (let i = 0; i < 10; i++) {
        const threadId = generateThreadId();
        await storage.putMessage(
          createTestMessage(`msg${i}`, 'did:agent:alice', 'did:agent:bob', threadId)
        );
      }

      const sessions = await storage.listSessions(undefined, 5);
      expect(sessions.length).toBe(5);
    });

    it('should return sessions in reverse chronological order', async () => {
      const thread1 = generateThreadId();
      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', thread1));

      await new Promise(resolve => setTimeout(resolve, 10));

      const thread2 = generateThreadId();
      await storage.putMessage(createTestMessage('msg2', 'did:agent:charlie', 'did:agent:bob', thread2));

      const sessions = await storage.listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions[0].lastMessageAt).toBeGreaterThanOrEqual(sessions[1].lastMessageAt);
    });
  });

  describe('Query Messages by Thread', () => {
    it('should query messages in a thread', async () => {
      const threadId = generateThreadId();

      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', threadId));
      await storage.putMessage(createTestMessage('msg2', 'did:agent:bob', 'did:agent:alice', threadId));
      await storage.putMessage(createTestMessage('msg3', 'did:agent:alice', 'did:agent:bob', threadId));

      const page = await storage.queryMessagesByThread(threadId);
      expect(page.messages.length).toBe(3);
      expect(page.total).toBe(3);
    });

    it('should return messages in chronological order', async () => {
      const threadId = generateThreadId();

      await storage.putMessage(createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', threadId));
      await new Promise(resolve => setTimeout(resolve, 10));
      await storage.putMessage(createTestMessage('msg2', 'did:agent:bob', 'did:agent:alice', threadId));
      await new Promise(resolve => setTimeout(resolve, 10));
      await storage.putMessage(createTestMessage('msg3', 'did:agent:alice', 'did:agent:bob', threadId));

      const page = await storage.queryMessagesByThread(threadId);
      expect(page.messages[0].envelope.id).toBe('msg1');
      expect(page.messages[1].envelope.id).toBe('msg2');
      expect(page.messages[2].envelope.id).toBe('msg3');
    });

    it('should support pagination', async () => {
      const threadId = generateThreadId();

      for (let i = 0; i < 10; i++) {
        await storage.putMessage(
          createTestMessage(`msg${i}`, 'did:agent:alice', 'did:agent:bob', threadId)
        );
      }

      const page1 = await storage.queryMessagesByThread(threadId, { limit: 5 });
      expect(page1.messages.length).toBe(5);
      expect(page1.hasMore).toBe(true);

      const page2 = await storage.queryMessagesByThread(threadId, { limit: 5, offset: 5 });
      expect(page2.messages.length).toBe(5);
      expect(page2.hasMore).toBe(false);
    });

    it('should return empty result for non-existent thread', async () => {
      const page = await storage.queryMessagesByThread('thread_999_nonexistent');
      expect(page.messages.length).toBe(0);
      expect(page.total).toBe(0);
    });
  });

  describe('Session Metadata Edge Cases', () => {
    it('should handle messages with empty payload', async () => {
      const threadId = generateThreadId();
      const msg = createTestMessage('msg1', 'did:agent:alice', 'did:agent:bob', threadId, '');

      await storage.putMessage(msg);

      const session = await storage.getSession(threadId);
      expect(session).toBeDefined();
      expect(session.title).toBeUndefined();
    });

    it('should handle messages with non-text payload', async () => {
      const threadId = generateThreadId();
      const envelope: MessageEnvelope = {
        id: 'msg1',
        from: 'did:agent:alice',
        to: 'did:agent:bob',
        type: 'message',
        protocol: 'test/v1',
        payload: { data: [1, 2, 3] },
        timestamp: Date.now(),
        signature: 'test-signature',
        threadId,
      };

      await storage.putMessage({
        envelope,
        direction: 'inbound',
        status: 'delivered',
        receivedAt: Date.now(),
      });

      const session = await storage.getSession(threadId);
      expect(session).toBeDefined();
    });

    it('should handle outbound messages in session', async () => {
      const threadId = generateThreadId();
      const envelope: MessageEnvelope = {
        id: 'msg1',
        from: 'did:agent:bob',
        to: 'did:agent:alice',
        type: 'message',
        protocol: 'test/v1',
        payload: { text: 'Hello' },
        timestamp: Date.now(),
        signature: 'test-signature',
        threadId,
      };

      await storage.putMessage({
        envelope,
        direction: 'outbound',
        status: 'delivered',
        sentAt: Date.now(),
      });

      const session = await storage.getSession(threadId);
      expect(session).toBeDefined();
      expect(session.peerDid).toBe('did:agent:alice');
    });
  });
});
