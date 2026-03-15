import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { MessageStorage } from './storage.js';
import { DefenseMiddleware } from './defense.js';

describe('DefenseMiddleware', () => {
  let storage: MessageStorage;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hw1-defense-'));
    storage = new MessageStorage(join(tempDir, 'test.db'));
    await storage.open();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects replayed message ids with duplicate reason', async () => {
    const trustSystem = {
      isRateLimited: () => false,
      getTrustScore: async () => ({
        interactionScore: 1,
        status: 'trusted',
        totalInteractions: 0,
        recentSuccessRate: 1,
      }),
    } as any;
    const defense = new DefenseMiddleware({
      trustSystem,
      storage,
      minTrustScore: 0,
    });
    const envelope = {
      id: 'msg-replay-1',
      from: 'did:agent:alice',
      to: 'did:agent:bob',
      type: 'message' as const,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'hello' },
      timestamp: Date.now(),
      signature: 'sig',
    };

    await expect(defense.checkMessage(envelope)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(defense.checkMessage(envelope)).resolves.toMatchObject({
      allowed: false,
      reason: 'duplicate',
    });
  });
});
