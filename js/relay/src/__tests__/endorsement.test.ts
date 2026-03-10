/**
 * CVP-0017: EndorsementIndex unit tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EndorsementIndex } from '../endorsement-index.js';
import type { EndorsementV2 } from '@quadra-a/protocol';

function makeEndorsement(overrides: Partial<EndorsementV2> = {}): EndorsementV2 {
  return {
    version: 2,
    from: 'did:agent:zAlice',
    to: 'did:agent:zBob',
    score: 0.8,
    reason: 'Good work',
    timestamp: Date.now(),
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    signature: 'deadbeef',
    ...overrides,
  };
}

describe('EndorsementIndex', () => {
  let index: EndorsementIndex;

  beforeEach(() => {
    index = new EndorsementIndex();
  });

  it('stores endorsement and retrieves by target', () => {
    const e = makeEndorsement();
    index.store(e);
    const { endorsements, total } = index.query(e.to);
    expect(total).toBe(1);
    expect(endorsements[0].from).toBe(e.from);
    expect(endorsements[0].score).toBe(e.score);
  });

  it('replaces existing endorsement for same (from, to, domain) tuple', () => {
    const e1 = makeEndorsement({ score: 0.5, timestamp: Date.now() - 1000 });
    const e2 = makeEndorsement({ score: 0.9, timestamp: Date.now() });
    index.store(e1);
    index.store(e2);
    const { total, endorsements } = index.query(e1.to);
    expect(total).toBe(1);
    expect(endorsements[0].score).toBe(0.9);
  });

  it('filters expired endorsements from query results', () => {
    const expired = makeEndorsement({ expires: Date.now() - 1000 });
    const valid = makeEndorsement({ from: 'did:agent:zCarol', expires: Date.now() + 60000 });
    index.store(expired);
    index.store(valid);
    const { total } = index.query(expired.to);
    expect(total).toBe(1);
  });

  it('filters by domain — includes domain-agnostic and matching, excludes others', () => {
    const agnostic = makeEndorsement({ from: 'did:agent:zA', domain: undefined });
    const matching = makeEndorsement({ from: 'did:agent:zB', domain: 'translation' });
    const other = makeEndorsement({ from: 'did:agent:zC', domain: 'research' });
    index.store(agnostic);
    index.store(matching);
    index.store(other);

    const { total } = index.query('did:agent:zBob', 'translation');
    expect(total).toBe(2); // agnostic + matching
  });

  it('filters by since timestamp', () => {
    const old = makeEndorsement({ from: 'did:agent:zA', timestamp: 1000 });
    const recent = makeEndorsement({ from: 'did:agent:zB', timestamp: Date.now() });
    index.store(old);
    index.store(recent);

    const { total } = index.query('did:agent:zBob', undefined, Date.now() - 5000);
    expect(total).toBe(1);
  });

  it('sorts results newest-first and caps at limit', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      index.store(makeEndorsement({
        from: `did:agent:z${i}`,
        timestamp: now - i * 1000,
      }));
    }
    const { endorsements } = index.query('did:agent:zBob', undefined, undefined, 3);
    expect(endorsements).toHaveLength(3);
    expect(endorsements[0].timestamp).toBeGreaterThanOrEqual(endorsements[1].timestamp);
    expect(endorsements[1].timestamp).toBeGreaterThanOrEqual(endorsements[2].timestamp);
  });

  it('getTrustSummary returns undefined when count < 3', () => {
    index.store(makeEndorsement({ from: 'did:agent:zA' }));
    index.store(makeEndorsement({ from: 'did:agent:zB' }));
    expect(index.getTrustSummary('did:agent:zBob')).toBeUndefined();
  });

  it('getTrustSummary returns summary when count >= 3', () => {
    for (let i = 0; i < 3; i++) {
      index.store(makeEndorsement({ from: `did:agent:z${i}`, score: 0.8 }));
    }
    const summary = index.getTrustSummary('did:agent:zBob');
    expect(summary).toBeDefined();
    expect(summary!.endorsementCount).toBe(3);
    expect(summary!.averageScore).toBeCloseTo(0.8, 2);
  });

  it('verified=true when count >= 10 AND averageScore >= 0.7', () => {
    for (let i = 0; i < 10; i++) {
      index.store(makeEndorsement({ from: `did:agent:z${i}`, score: 0.9 }));
    }
    const summary = index.getTrustSummary('did:agent:zBob');
    expect(summary!.verified).toBe(true);
  });

  it('verified=false when count >= 10 but averageScore < 0.7', () => {
    for (let i = 0; i < 10; i++) {
      index.store(makeEndorsement({ from: `did:agent:z${i}`, score: 0.5 }));
    }
    const summary = index.getTrustSummary('did:agent:zBob');
    expect(summary!.verified).toBe(false);
  });

  it('garbage collects endorsements past 2x TTL, keeps within 2x TTL', () => {
    const now = Date.now();
    const ttl = 10 * 24 * 60 * 60 * 1000; // 10 days

    // Expired and past 2x TTL: timestamp=0, expires=ttl, gcThreshold=2*ttl
    const gcable = makeEndorsement({
      from: 'did:agent:zA',
      timestamp: 0,
      expires: ttl,
    });

    // Expired but within 2x TTL: expires just before now, ttl is large
    const keepable = makeEndorsement({
      from: 'did:agent:zB',
      timestamp: now - ttl,
      expires: now - 1000, // just expired
    });

    index.store(gcable);
    index.store(keepable);

    const removed = index.garbageCollect();
    expect(removed).toBe(1);
    expect(index.size()).toBe(1);
  });
});
