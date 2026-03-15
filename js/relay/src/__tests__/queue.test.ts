import { describe, it, expect } from 'vitest';

import { deserializeQueuedEnvelope, MessageQueue, serializeQueuedEnvelope } from '../queue.js';
import { rmSync } from 'fs';

describe('queued envelope serialization', () => {
  it('serializes Uint8Array values as JSON-safe byte arrays', () => {
    const envelope = new Uint8Array([123, 34, 125]);

    expect(serializeQueuedEnvelope(envelope)).toEqual([123, 34, 125]);
  });

  it('deserializes legacy typed-array objects from JSON storage', () => {
    const envelope = deserializeQueuedEnvelope({
      0: 123,
      1: 34,
      2: 105,
      3: 100,
      4: 34,
      5: 58,
      6: 34,
      7: 109,
      8: 115,
      9: 103,
      10: 34,
      11: 125,
    });

    expect(envelope).toEqual([123, 34, 105, 100, 34, 58, 34, 109, 115, 103, 34, 125]);
  });

  it('deserializes empty legacy typed-array objects', () => {
    expect(deserializeQueuedEnvelope({})).toEqual([]);
  });

  it('rejects non-byte object payloads', () => {
    expect(() => deserializeQueuedEnvelope({ foo: 'bar' })).toThrow(/serialized Uint8Array/);
  });

  it('treats legacy delivered queue entries as inflight on reload', async () => {
    const storagePath = `./test-relay-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queue = new MessageQueue({ storagePath });
    await queue.start();

    const internalDb = (queue as unknown as {
      db: {
        put(key: string, value: Record<string, unknown>): Promise<void>;
      };
    }).db;

    await internalDb.put('did:agent:zTarget:msg-legacy', {
      messageId: 'msg-legacy',
      toDid: 'did:agent:zTarget',
      fromDid: 'did:agent:zSender',
      envelope: [1, 2, 3],
      queuedAt: 1,
      expiresAt: Date.now() + 60_000,
      deliveryAttempts: 1,
      lastAttemptAt: Date.now(),
      status: 'delivered',
    });

    const queued = await queue.getQueuedMessages('did:agent:zTarget');
    expect(queued).toEqual([
      expect.objectContaining({
        messageId: 'msg-legacy',
        status: 'inflight',
      }),
    ]);

    await queue.stop();
    rmSync(storagePath, { recursive: true, force: true });
  });
});
