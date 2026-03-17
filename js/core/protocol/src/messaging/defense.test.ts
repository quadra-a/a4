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

  it('allows solicited replies to bypass inbound rate limiting', async () => {
    const trustSystem = {
      isRateLimited: () => false,
      getTrustScore: async () => ({
        interactionScore: 0.1,
        status: 'unknown',
        totalInteractions: 0,
        recentSuccessRate: 1,
      }),
    } as any;
    const defense = new DefenseMiddleware({
      trustSystem,
      storage,
      minTrustScore: 0,
      rateLimitTiers: {
        newAgent: { capacity: 0, refillRate: 0 },
        established: { capacity: 0, refillRate: 0 },
        trusted: { capacity: 0, refillRate: 0 },
      },
    });
    const envelope = {
      id: 'msg-reply-1',
      from: 'did:agent:alice',
      to: 'did:agent:bob',
      type: 'reply' as const,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'reply' },
      timestamp: Date.now(),
      replyTo: 'msg-request-1',
      signature: 'sig',
    };

    await expect(defense.checkMessage(envelope)).resolves.toMatchObject({
      allowed: false,
      reason: 'rate_limited',
    });
    await expect(defense.checkMessage(
      { ...envelope, id: 'msg-reply-2' },
      { solicitedReply: true },
    )).resolves.toMatchObject({
      allowed: true,
      trustStatus: 'unknown',
    });
  });

  it('allows solicited replies to bypass auto-block entries', async () => {
    const trustSystem = {
      isRateLimited: () => false,
      getTrustScore: async () => ({
        interactionScore: 0.1,
        status: 'unknown',
        totalInteractions: 25,
        recentSuccessRate: 0.1,
      }),
    } as any;
    const defense = new DefenseMiddleware({
      trustSystem,
      storage,
      minTrustScore: 0,
    });
    await storage.putBlock({
      did: 'did:agent:alice',
      reason: 'Auto-blocked: 90% failure rate over last 20 interactions',
      blockedAt: Date.now(),
      blockedBy: 'local',
    });
    const envelope = {
      id: 'msg-reply-3',
      from: 'did:agent:alice',
      to: 'did:agent:bob',
      type: 'reply' as const,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'reply' },
      timestamp: Date.now(),
      replyTo: 'msg-request-2',
      signature: 'sig',
    };

    await expect(defense.checkMessage(envelope)).resolves.toMatchObject({
      allowed: false,
      reason: 'blocked',
    });
    await expect(defense.checkMessage(
      { ...envelope, id: 'msg-reply-4' },
      { solicitedReply: true },
    )).resolves.toMatchObject({
      allowed: true,
      trustStatus: 'unknown',
    });
  });

  it('still rejects solicited replies from manually blocked senders', async () => {
    const trustSystem = {
      isRateLimited: () => false,
      getTrustScore: async () => ({
        interactionScore: 0.1,
        status: 'unknown',
        totalInteractions: 0,
        recentSuccessRate: 1,
      }),
    } as any;
    const defense = new DefenseMiddleware({
      trustSystem,
      storage,
      minTrustScore: 0,
    });
    await storage.putBlock({
      did: 'did:agent:alice',
      reason: 'Blocked by user',
      blockedAt: Date.now(),
      blockedBy: 'local',
    });
    const envelope = {
      id: 'msg-reply-5',
      from: 'did:agent:alice',
      to: 'did:agent:bob',
      type: 'reply' as const,
      protocol: '/agent/msg/1.0.0',
      payload: { text: 'reply' },
      timestamp: Date.now(),
      replyTo: 'msg-request-3',
      signature: 'sig',
    };

    await expect(defense.checkMessage(envelope, { solicitedReply: true })).resolves.toMatchObject({
      allowed: false,
      reason: 'blocked',
    });
  });
});
