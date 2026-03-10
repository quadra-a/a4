/**
 * CVP-0017: TrustComputer unit tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TrustComputer } from '../../trust/trust-computer.js';
import type { EndorsementV2 } from '../../trust/endorsement.js';

function makeEndorsement(overrides: Partial<EndorsementV2> = {}): EndorsementV2 {
  return {
    version: 2,
    from: 'did:agent:zAlice',
    to: 'did:agent:zBob',
    score: 0.8,
    reason: 'Good work',
    timestamp: Date.now(),
    expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
    signature: 'deadbeef',
    ...overrides,
  };
}

describe('TrustComputer', () => {
  let computer: TrustComputer;

  beforeEach(() => {
    computer = new TrustComputer();
  });

  it('returns 0 for empty endorsements', () => {
    const result = computer.compute('did:agent:zBob', []);
    expect(result.score).toBe(0);
    expect(result.networkScore).toBe(0);
    expect(result.endorsementCount).toBe(0);
  });

  it('applies time decay — recent endorsement scores higher than old', () => {
    const recent = makeEndorsement({ from: 'did:agent:zA', timestamp: Date.now() - 1000 });
    const old = makeEndorsement({ from: 'did:agent:zB', timestamp: Date.now() - 180 * 24 * 60 * 60 * 1000 });

    const resultRecent = computer.compute('did:agent:zBob', [recent]);
    computer.clearCache();
    const resultOld = computer.compute('did:agent:zBob', [old]);

    expect(resultRecent.networkScore).toBeGreaterThan(resultOld.networkScore);
  });

  it('fast domain (translation) decays faster than slow domain (research)', () => {
    // Use 120 days — well past translation half-life (30d) but within research half-life (180d)
    const age = 120 * 24 * 60 * 60 * 1000;
    const fastEndorsement = makeEndorsement({
      from: 'did:agent:zA',
      domain: 'translation',
      timestamp: Date.now() - age,
      expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
    });
    const slowEndorsement = makeEndorsement({
      from: 'did:agent:zB',
      domain: 'research',
      timestamp: Date.now() - age,
      expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
    });

    const fastResult = computer.compute('did:agent:zBob', [fastEndorsement], 0, 0, 'translation');
    computer.clearCache();
    const slowResult = computer.compute('did:agent:zBob', [slowEndorsement], 0, 0, 'research');

    // translation half-life=30d: decay = exp(-120/30) ≈ 0.018
    // research half-life=180d: decay = exp(-120/180) ≈ 0.51
    expect(fastResult.networkScore).toBeLessThan(slowResult.networkScore);
  });

  it('skips expired endorsements', () => {
    const expired = makeEndorsement({ expires: Date.now() - 1000 });
    const result = computer.compute('did:agent:zBob', [expired]);
    expect(result.networkScore).toBe(0);
    expect(result.endorsementCount).toBe(1); // counted in filtered set
  });

  it('seed peers have weight 1.0 (higher than non-seed)', () => {
    const seedComputer = new TrustComputer({ seedPeers: ['did:agent:zSeed'] });
    const nonSeedComputer = new TrustComputer({ seedPeers: [] });

    const endorsement = makeEndorsement({ from: 'did:agent:zSeed', score: 0.8 });

    const _seedResult = seedComputer.compute('did:agent:zBob', [endorsement]);
    const _nonSeedResult = nonSeedComputer.compute('did:agent:zBob', [endorsement]);

    // Seed peer weight=1.0, non-seed weight=0.1 (neutral prior)
    // Both produce score = endorsement.score * weight / weight = endorsement.score
    // But seed has higher weight so the weighted average is the same score
    // The difference is that seed peer's endorsement is weighted 10x more
    // With a single endorsement: score = endorsement.score * weight / weight = endorsement.score
    // So both should equal 0.8 — the test should check that seed weight >= non-seed weight
    // Actually with a single endorsement, the weighted average = score regardless of weight
    // The difference only matters with multiple endorsers of different trust levels
    // Let's test with two endorsers: one seed, one non-seed
    const seedEndorsement = makeEndorsement({ from: 'did:agent:zSeed', score: 1.0 });
    const lowEndorsement = makeEndorsement({ from: 'did:agent:zLow', score: 0.0 });

    seedComputer.clearCache();
    const mixedSeedResult = seedComputer.compute('did:agent:zBob', [seedEndorsement, lowEndorsement]);
    nonSeedComputer.clearCache();
    const mixedNonSeedResult = nonSeedComputer.compute('did:agent:zBob', [seedEndorsement, lowEndorsement]);

    // With seed peer: seed weight=1.0, low weight=0.1 → score = (1.0*1.0 + 0.0*0.1) / (1.0+0.1) ≈ 0.91
    // Without seed peer: both weight=0.1 → score = (1.0*0.1 + 0.0*0.1) / (0.1+0.1) = 0.5
    expect(mixedSeedResult.networkScore).toBeGreaterThan(mixedNonSeedResult.networkScore);
  });

  it('blends local + network scores with alpha = min(localCount/20, 0.8)', () => {
    const endorsements = [makeEndorsement()];

    // 0 local interactions: alpha=0, score = networkScore
    const result0 = computer.compute('did:agent:zBob', endorsements, 1.0, 0);
    expect(result0.score).toBeCloseTo(result0.networkScore, 5);

    computer.clearCache();

    // 20 local interactions: alpha=min(20/20, 0.8)=0.8
    const result20 = computer.compute('did:agent:zBob', endorsements, 1.0, 20);
    const expectedAlpha = Math.min(20 / 20, 0.8);
    const expected = expectedAlpha * 1.0 + (1 - expectedAlpha) * result20.networkScore;
    expect(result20.score).toBeCloseTo(expected, 5);
  });

  it('caches result for 5 minutes; clearCache() forces recomputation', () => {
    const endorsements = [makeEndorsement({ score: 0.8 })];
    const result1 = computer.compute('did:agent:zBob', endorsements);

    // Second call with different endorsements — should return cached result
    const different = [makeEndorsement({ score: 0.1 })];
    const result2 = computer.compute('did:agent:zBob', different);
    expect(result2.score).toBeCloseTo(result1.score, 5);

    // After clearCache, recomputes with new data
    computer.clearCache();
    const result3 = computer.compute('did:agent:zBob', different);
    expect(result3.score).not.toBeCloseTo(result1.score, 1);
  });

  it('collusion detection: false for linear chain', () => {
    // A→B→C→D — no cycle, no collusion
    const endorsements = [
      makeEndorsement({ from: 'did:agent:zA', to: 'did:agent:zB' }),
      makeEndorsement({ from: 'did:agent:zB', to: 'did:agent:zC' }),
      makeEndorsement({ from: 'did:agent:zC', to: 'did:agent:zD' }),
    ];
    const result = computer.compute('did:agent:zD', endorsements);
    expect(result.collusionDetected).toBe(false);
  });

  it('collusion detection: false for small cycle (≤3 nodes)', () => {
    // A→B→C→A — cycle but only 3 nodes, threshold is >3
    const endorsements = [
      makeEndorsement({ from: 'did:agent:zA', to: 'did:agent:zB' }),
      makeEndorsement({ from: 'did:agent:zB', to: 'did:agent:zC' }),
      makeEndorsement({ from: 'did:agent:zC', to: 'did:agent:zA' }),
    ];
    const result = computer.compute('did:agent:zA', endorsements);
    expect(result.collusionDetected).toBe(false);
  });

  it('collusion detection: true for tight cluster of 4+ nodes with low external/internal ratio', () => {
    // 5 nodes all endorsing each other (fully connected), no external edges
    const nodes = ['A', 'B', 'C', 'D', 'E'].map(n => `did:agent:z${n}`);
    const endorsements: EndorsementV2[] = [];
    for (const from of nodes) {
      for (const to of nodes) {
        if (from !== to) {
          endorsements.push(makeEndorsement({ from, to }));
        }
      }
    }
    const result = computer.compute('did:agent:zA', endorsements);
    expect(result.collusionDetected).toBe(true);
  });
});
