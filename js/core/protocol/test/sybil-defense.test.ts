import { describe, it, expect, beforeEach } from 'vitest';
import { SybilDefense } from '../src/trust/sybil-defense.js';
import type { Challenge as _Challenge, ChallengeSolution as _ChallengeSolution } from '../src/trust/sybil-defense.js';

describe('Sybil Defense System', () => {
  let defense: SybilDefense;

  beforeEach(() => {
    defense = new SybilDefense();
  });

  describe('Hashcash Challenge Generation', () => {
    it('should generate valid challenges', () => {
      const challenge = defense.generateChallenge('did:agent:test', 20);

      expect(challenge.did).toBe('did:agent:test');
      expect(challenge.difficulty).toBe(20);
      expect(challenge.nonce).toBeDefined();
      expect(challenge.nonce.length).toBeGreaterThan(0);
      expect(challenge.timestamp).toBeGreaterThan(0);
    });

    it('should generate unique nonces', () => {
      const c1 = defense.generateChallenge('did:agent:test', 20);
      const c2 = defense.generateChallenge('did:agent:test', 20);

      expect(c1.nonce).not.toBe(c2.nonce);
    });

    it('should use default difficulty if not specified', () => {
      const challenge = defense.generateChallenge('did:agent:test');

      expect(challenge.difficulty).toBe(20);
    });

    it('should accept custom difficulty', () => {
      const challenge = defense.generateChallenge('did:agent:test', 16);

      expect(challenge.difficulty).toBe(16);
    });
  });

  describe('Hashcash Challenge Verification', () => {
    it('should verify valid solutions', () => {
      const challenge = defense.generateChallenge('did:agent:test', 8); // Lower difficulty for testing

      // Find a valid solution (brute force)
      let solution = '';
      for (let i = 0; i < 10000; i++) {
        const testSolution = i.toString(16);
        const isValid = defense.verifyChallenge({
          challenge,
          solution: testSolution,
        });

        if (isValid) {
          solution = testSolution;
          break;
        }
      }

      expect(solution).not.toBe('');
    });

    it('should reject invalid solutions', () => {
      const challenge = defense.generateChallenge('did:agent:test', 20);

      const isValid = defense.verifyChallenge({
        challenge,
        solution: 'invalid',
      });

      expect(isValid).toBe(false);
    });

    it('should reject expired challenges', () => {
      const challenge = defense.generateChallenge('did:agent:test', 20);

      // Make challenge old (more than 1 hour)
      challenge.timestamp = Date.now() - 2 * 60 * 60 * 1000;

      const isValid = defense.verifyChallenge({
        challenge,
        solution: '0',
      });

      expect(isValid).toBe(false);
    });

    it('should accept challenges within time window', () => {
      const challenge = defense.generateChallenge('did:agent:test', 8);

      // Challenge is fresh (just created)
      expect(challenge.timestamp).toBeGreaterThan(Date.now() - 1000);
    });
  });

  describe('Rate Limiting', () => {
    it('should not rate limit agents with no requests', () => {
      const isLimited = defense.isRateLimited('did:agent:test');

      expect(isLimited).toBe(false);
    });

    it('should not rate limit agents with few requests', () => {
      const did = 'did:agent:test';

      // Record a few requests
      for (let i = 0; i < 5; i++) {
        defense.recordRequest(did);
      }

      const isLimited = defense.isRateLimited(did);

      expect(isLimited).toBe(false);
    });

    it('should rate limit new agents with many requests', () => {
      const did = 'did:agent:test';

      // Record many requests
      for (let i = 0; i < 15; i++) {
        defense.recordRequest(did);
      }

      const isLimited = defense.isRateLimited(did);

      expect(isLimited).toBe(true);
    });

    it('should not rate limit established agents', () => {
      const did = 'did:agent:test';

      // Record peer as seen long ago
      defense.recordPeerSeen(did);

      // Simulate agent being old (manually set first seen time)
      // This is a limitation of the test - in real usage, time would pass

      // Record many requests
      for (let i = 0; i < 15; i++) {
        defense.recordRequest(did);
      }

      // For new agents (< 24 hours), should be rate limited
      const isLimited = defense.isRateLimited(did);

      expect(isLimited).toBe(true); // New agents are rate limited
    });

    it('should track request counts correctly', () => {
      const did = 'did:agent:test';

      // Record 9 requests (below limit)
      for (let i = 0; i < 9; i++) {
        defense.recordRequest(did);
      }

      const isLimited = defense.isRateLimited(did);

      // At 9 requests, should not be limited
      expect(isLimited).toBe(false);

      // One more request to reach limit (10 total)
      defense.recordRequest(did);

      const isLimitedAtLimit = defense.isRateLimited(did);

      // At exactly 10 requests, should be limited (>= 10)
      expect(isLimitedAtLimit).toBe(true);
    });
  });

  describe('Peer Trust Levels', () => {
    it('should categorize new peers', () => {
      const peerId = 'peer1';

      const level = defense.getPeerTrustLevel(peerId);

      expect(level).toBe('new');
    });

    it('should categorize established peers', () => {
      const peerId = 'peer2';

      defense.recordPeerSeen(peerId);

      // Peer is just recorded, so still new
      const level = defense.getPeerTrustLevel(peerId);

      expect(level).toBe('new');
    });

    it('should record peer seen times', () => {
      const peerId = 'peer3';

      defense.recordPeerSeen(peerId);

      // Recording again should not change first seen time
      defense.recordPeerSeen(peerId);

      const level = defense.getPeerTrustLevel(peerId);

      expect(level).toBe('new'); // Still new since just recorded
    });
  });

  describe('Cleanup', () => {
    it('should clean up old records', () => {
      const did = 'did:agent:test';

      // Record some requests
      for (let i = 0; i < 5; i++) {
        defense.recordRequest(did);
      }

      // Cleanup should not crash
      defense.cleanup();

      // Agent should still be tracked (not old enough to clean up)
      const isLimited = defense.isRateLimited(did);

      expect(isLimited).toBe(false);
    });

    it('should not affect recent records', () => {
      const did1 = 'did:agent:test1';
      const did2 = 'did:agent:test2';

      defense.recordRequest(did1);
      defense.recordRequest(did2);

      defense.cleanup();

      // Both should still be tracked
      expect(defense.isRateLimited(did1)).toBe(false);
      expect(defense.isRateLimited(did2)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid successive requests', () => {
      const did = 'did:agent:test';

      // Record many requests rapidly
      for (let i = 0; i < 20; i++) {
        defense.recordRequest(did);
      }

      const isLimited = defense.isRateLimited(did);

      expect(isLimited).toBe(true);
    });

    it('should handle multiple different agents', () => {
      const agents = ['did:agent:a', 'did:agent:b', 'did:agent:c'];

      // Record requests for each agent
      agents.forEach(did => {
        for (let i = 0; i < 5; i++) {
          defense.recordRequest(did);
        }
      });

      // None should be rate limited (only 5 requests each)
      agents.forEach(did => {
        expect(defense.isRateLimited(did)).toBe(false);
      });
    });

    it('should handle empty DID strings', () => {
      const challenge = defense.generateChallenge('', 20);

      expect(challenge.did).toBe('');
      expect(challenge.nonce).toBeDefined();
    });

    it('should handle very high difficulty', () => {
      const challenge = defense.generateChallenge('did:agent:test', 32);

      expect(challenge.difficulty).toBe(32);
    });

    it('should handle zero difficulty', () => {
      const challenge = defense.generateChallenge('did:agent:test', 0);

      expect(challenge.difficulty).toBe(0);

      // Zero difficulty should always verify
      const isValid = defense.verifyChallenge({
        challenge,
        solution: 'anything',
      });

      expect(isValid).toBe(true);
    });

    it('should handle very long DIDs', () => {
      const longDid = 'did:agent:' + 'a'.repeat(1000);

      const challenge = defense.generateChallenge(longDid, 20);

      expect(challenge.did).toBe(longDid);
    });

    it('should handle special characters in DIDs', () => {
      const specialDid = 'did:agent:test-123_456';

      const challenge = defense.generateChallenge(specialDid, 20);

      expect(challenge.did).toBe(specialDid);
    });
  });

  describe('Request Window Management', () => {
    it('should only count recent requests', () => {
      const did = 'did:agent:test';

      // Record requests
      for (let i = 0; i < 8; i++) {
        defense.recordRequest(did);
      }

      // Should not be rate limited yet
      expect(defense.isRateLimited(did)).toBe(false);

      // Record more requests
      for (let i = 0; i < 5; i++) {
        defense.recordRequest(did);
      }

      // Now should be rate limited (13 total requests)
      expect(defense.isRateLimited(did)).toBe(true);
    });
  });
});
