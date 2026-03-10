import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveDID, extractPublicKey } from '../src/identity/did.js';
import { generateKeyPair, sign, verify } from '../src/identity/keys.js';
import { createTrustSystem } from '../src/trust/index.js';

interface TestAgent {
  did: string;
  privateKey: Uint8Array;
}

async function createTestAgent(): Promise<TestAgent> {
  const keyPair = await generateKeyPair();

  return {
    did: deriveDID(keyPair.publicKey),
    privateKey: keyPair.privateKey,
  };
}

describe('TrustSystem', () => {
  let tempDir: string;
  let trustSystem: ReturnType<typeof createTrustSystem>;
  let targetAgent: TestAgent;
  let endorserA: TestAgent;
  let endorserB: TestAgent;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'quadra-a-trust-system-'));
    targetAgent = await createTestAgent();
    endorserA = await createTestAgent();
    endorserB = await createTestAgent();

    trustSystem = createTrustSystem({
      dbPath: join(tempDir, 'trust-db'),
      getPublicKey: async (did) => extractPublicKey(did),
    });

    await trustSystem.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await trustSystem.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records interactions and computes a trust score from history', async () => {
    const baseTimestamp = Date.now() - 5_000;

    await trustSystem.recordInteraction({
      agentDid: targetAgent.did,
      timestamp: baseTimestamp,
      type: 'message',
      success: true,
      responseTime: 120,
    });
    await trustSystem.recordInteraction({
      agentDid: targetAgent.did,
      timestamp: baseTimestamp + 1_000,
      type: 'task',
      success: false,
      responseTime: 300,
    });
    await trustSystem.recordInteraction({
      agentDid: targetAgent.did,
      timestamp: baseTimestamp + 2_000,
      type: 'query',
      success: true,
      responseTime: 180,
    });

    const history = await trustSystem.getHistory(targetAgent.did);
    const score = await trustSystem.getTrustScore(targetAgent.did);

    expect(history).toHaveLength(3);
    expect(history.map((interaction) => interaction.timestamp)).toEqual([
      baseTimestamp + 2_000,
      baseTimestamp + 1_000,
      baseTimestamp,
    ]);
    expect(score.totalInteractions).toBe(3);
    expect(score.completionRate).toBeCloseTo(2 / 3);
    expect(score.recentSuccessRate).toBeCloseTo(2 / 3);
    expect(score.responseTime).toBeCloseTo(200);
    expect(score.interactionScore).toBeCloseTo((2 / 3) * (3 / 50));
    expect(score.endorsementScore).toBe(0);
    expect(score.status).toBe('known');
  });

  it('signs, verifies, and aggregates endorsements into the trust score', async () => {
    const before = await trustSystem.getTrustScore(targetAgent.did);

    const endorsementA = await trustSystem.endorse(
      endorserA.did,
      targetAgent.did,
      0.9,
      'Reliable collaborator',
      (data) => sign(data, endorserA.privateKey),
    );
    const endorsementB = await trustSystem.endorse(
      endorserB.did,
      targetAgent.did,
      0.5,
      'Acceptable quality',
      (data) => sign(data, endorserB.privateKey),
    );

    const endorsements = await trustSystem.getEndorsements(targetAgent.did);
    const after = await trustSystem.getTrustScore(targetAgent.did);

    expect(before.endorsementScore).toBe(0);
    expect(endorsements).toHaveLength(2);
    expect(endorsements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signature: endorsementA.signature }),
        expect.objectContaining({ signature: endorsementB.signature }),
      ]),
    );
    await expect(trustSystem.verifyEndorsement(endorsementA, verify)).resolves.toBe(true);
    await expect(trustSystem.verifyEndorsement(endorsementB, verify)).resolves.toBe(true);
    expect(after.endorsementScore).toBeCloseTo(0.7);
  });

  it('forwards repeated interactions into sybil rate limiting', async () => {
    for (let index = 0; index < 9; index += 1) {
      await trustSystem.recordInteraction({
        agentDid: targetAgent.did,
        timestamp: Date.now() + index,
        type: 'message',
        success: true,
        responseTime: 50,
      });
    }

    expect(trustSystem.isRateLimited(targetAgent.did)).toBe(false);

    await trustSystem.recordInteraction({
      agentDid: targetAgent.did,
      timestamp: Date.now() + 10,
      type: 'message',
      success: true,
      responseTime: 50,
    });

    expect(trustSystem.isRateLimited(targetAgent.did)).toBe(true);
  });

  it('tracks uptime across online and offline windows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    trustSystem.recordOnline(targetAgent.did);
    vi.advanceTimersByTime(30 * 60 * 1000);
    trustSystem.recordOffline(targetAgent.did);
    vi.advanceTimersByTime(30 * 60 * 1000);

    expect(trustSystem.getUptime(targetAgent.did)).toBeCloseTo(0.5, 2);
  });
});
