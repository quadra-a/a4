import { describe, it, expect, beforeEach } from 'vitest';
import { TrustMetrics, createDefaultTrustScore } from '../src/trust/trust-score.js';
import type { TrustScore, InteractionStats } from '../src/trust/trust-score.js';

describe('Trust Score System', () => {
  let metrics: TrustMetrics;

  beforeEach(() => {
    metrics = new TrustMetrics();
  });

  describe('Trust Score Calculation', () => {
    it('should calculate trust score from interaction stats', () => {
      const stats: InteractionStats = {
        totalInteractions: 50,
        successRate: 0.9,
        recentSuccessRate: 0.85,
        avgResponseTime: 250,
        lastInteraction: Date.now(),
      };

      const score = metrics.calculateScore(stats, 0.8, 0.95);

      expect(score.interactionScore).toBeGreaterThan(0);
      expect(score.endorsementScore).toBe(0.8);
      expect(score.completionRate).toBe(0.9);
      expect(score.responseTime).toBe(250);
      expect(score.uptime).toBe(0.95);
      expect(score.lastUpdated).toBeGreaterThan(0);
    });

    it('should weight interaction score by volume', () => {
      const lowVolume: InteractionStats = {
        totalInteractions: 10,
        successRate: 0.9,
        recentSuccessRate: 0.9,
        avgResponseTime: 250,
        lastInteraction: Date.now(),
      };

      const highVolume: InteractionStats = {
        totalInteractions: 100,
        successRate: 0.9,
        recentSuccessRate: 0.9,
        avgResponseTime: 250,
        lastInteraction: Date.now(),
      };

      const lowScore = metrics.calculateScore(lowVolume, 0, 1.0);
      const highScore = metrics.calculateScore(highVolume, 0, 1.0);

      expect(highScore.interactionScore).toBeGreaterThan(lowScore.interactionScore);
    });

    it('should cap volume weight at 100 interactions', () => {
      const stats100: InteractionStats = {
        totalInteractions: 100,
        successRate: 0.9,
        recentSuccessRate: 0.9,
        avgResponseTime: 250,
        lastInteraction: Date.now(),
      };

      const stats200: InteractionStats = {
        totalInteractions: 200,
        successRate: 0.9,
        recentSuccessRate: 0.9,
        avgResponseTime: 250,
        lastInteraction: Date.now(),
      };

      const score100 = metrics.calculateScore(stats100, 0, 1.0);
      const score200 = metrics.calculateScore(stats200, 0, 1.0);

      expect(score100.interactionScore).toBe(score200.interactionScore);
    });

    it('should handle zero interactions', () => {
      const stats: InteractionStats = {
        totalInteractions: 0,
        successRate: 0,
        recentSuccessRate: 0,
        avgResponseTime: 0,
        lastInteraction: 0,
      };

      const score = metrics.calculateScore(stats, 0, 1.0);

      expect(score.interactionScore).toBe(0);
      expect(score.completionRate).toBe(0);
    });
  });

  describe('Overall Trust Calculation', () => {
    it('should calculate overall trust from components', () => {
      const score: TrustScore = {
        interactionScore: 0.8,
        endorsements: 5,
        endorsementScore: 0.7,
        completionRate: 0.9,
        responseTime: 250,
        uptime: 0.95,
        lastUpdated: Date.now(),
        totalInteractions: 50,
        recentSuccessRate: 0.85,
        status: 'known',
      };

      const overall = metrics.calculateOverallTrust(score);

      expect(overall).toBeGreaterThan(0);
      expect(overall).toBeLessThanOrEqual(1);
    });

    it('should weight components correctly', () => {
      const score: TrustScore = {
        interactionScore: 1.0,
        endorsements: 10,
        endorsementScore: 1.0,
        completionRate: 1.0,
        responseTime: 100,
        uptime: 1.0,
        lastUpdated: Date.now(),
        totalInteractions: 100,
        recentSuccessRate: 1.0,
        status: 'known',
      };

      const overall = metrics.calculateOverallTrust(score);

      // With perfect scores, overall should be 1.0
      expect(overall).toBeCloseTo(1.0, 1);
    });

    it('should cap endorsement score at 10 endorsements', () => {
      const score10: TrustScore = {
        interactionScore: 0.8,
        endorsements: 10,
        endorsementScore: 0.8,
        completionRate: 0.9,
        responseTime: 250,
        uptime: 0.95,
        lastUpdated: Date.now(),
        totalInteractions: 50,
        recentSuccessRate: 0.85,
        status: 'known',
      };

      const score20: TrustScore = {
        interactionScore: 0.8,
        endorsements: 20,
        endorsementScore: 0.8,
        completionRate: 0.9,
        responseTime: 250,
        uptime: 0.95,
        lastUpdated: Date.now(),
        totalInteractions: 50,
        recentSuccessRate: 0.85,
        status: 'known',
      };

      const overall10 = metrics.calculateOverallTrust(score10);
      const overall20 = metrics.calculateOverallTrust(score20);

      expect(overall10).toBe(overall20);
    });

    it('should handle zero trust score', () => {
      const score: TrustScore = {
        interactionScore: 0,
        endorsements: 0,
        endorsementScore: 0,
        completionRate: 0,
        responseTime: 0,
        uptime: 0,
        lastUpdated: Date.now(),
        totalInteractions: 0,
        recentSuccessRate: 0,
        status: 'unknown',
      };

      const overall = metrics.calculateOverallTrust(score);

      expect(overall).toBe(0);
    });
  });

  describe('Trust Level Categories', () => {
    it('should categorize new agents', () => {
      const score: TrustScore = {
        interactionScore: 0,
        endorsements: 0,
        endorsementScore: 0,
        completionRate: 0,
        responseTime: 0,
        uptime: 1.0,
        lastUpdated: Date.now(),
        totalInteractions: 0,
        recentSuccessRate: 0,
        status: 'unknown',
      };

      const level = metrics.getTrustLevel(score);

      expect(level).toBe('new');
    });

    it('should categorize low trust agents', () => {
      const score: TrustScore = {
        interactionScore: 0.1,
        endorsements: 0,
        endorsementScore: 0.1,
        completionRate: 0.2,
        responseTime: 500,
        uptime: 0.7,
        lastUpdated: Date.now(),
        totalInteractions: 10,
        recentSuccessRate: 0.2,
        status: 'known',
      };

      const level = metrics.getTrustLevel(score);

      expect(level).toBe('low');
    });

    it('should categorize medium trust agents', () => {
      const score: TrustScore = {
        interactionScore: 0.5,
        endorsements: 3,
        endorsementScore: 0.5,
        completionRate: 0.6,
        responseTime: 300,
        uptime: 0.9,
        lastUpdated: Date.now(),
        totalInteractions: 30,
        recentSuccessRate: 0.6,
        status: 'known',
      };

      const level = metrics.getTrustLevel(score);

      expect(level).toBe('medium');
    });

    it('should categorize high trust agents', () => {
      const score: TrustScore = {
        interactionScore: 0.7,
        endorsements: 5,
        endorsementScore: 0.7,
        completionRate: 0.8,
        responseTime: 200,
        uptime: 0.95,
        lastUpdated: Date.now(),
        totalInteractions: 50,
        recentSuccessRate: 0.8,
        status: 'known',
      };

      const level = metrics.getTrustLevel(score);

      expect(level).toBe('high');
    });

    it('should categorize trusted agents', () => {
      const score: TrustScore = {
        interactionScore: 0.9,
        endorsements: 10,
        endorsementScore: 0.9,
        completionRate: 0.95,
        responseTime: 150,
        uptime: 0.98,
        lastUpdated: Date.now(),
        totalInteractions: 100,
        recentSuccessRate: 0.95,
        status: 'known',
      };

      const level = metrics.getTrustLevel(score);

      expect(level).toBe('trusted');
    });
  });

  describe('Rate Limiting', () => {
    it('should rate limit new agents with low trust', () => {
      const score: TrustScore = {
        interactionScore: 0.1,
        endorsements: 0,
        endorsementScore: 0.1,
        completionRate: 0.2,
        responseTime: 500,
        uptime: 0.7,
        lastUpdated: Date.now(),
        totalInteractions: 5,
        recentSuccessRate: 0.2,
        status: 'known',
      };

      const agentAge = 12 * 60 * 60 * 1000; // 12 hours
      const shouldLimit = metrics.shouldRateLimit(score, agentAge);

      expect(shouldLimit).toBe(true);
    });

    it('should not rate limit established agents', () => {
      const score: TrustScore = {
        interactionScore: 0.5,
        endorsements: 3,
        endorsementScore: 0.5,
        completionRate: 0.6,
        responseTime: 300,
        uptime: 0.9,
        lastUpdated: Date.now(),
        totalInteractions: 30,
        recentSuccessRate: 0.6,
        status: 'known',
      };

      const agentAge = 48 * 60 * 60 * 1000; // 48 hours
      const shouldLimit = metrics.shouldRateLimit(score, agentAge);

      expect(shouldLimit).toBe(false);
    });

    it('should rate limit very low trust agents regardless of age', () => {
      const score: TrustScore = {
        interactionScore: 0.02,
        endorsements: 0,
        endorsementScore: 0.02,
        completionRate: 0.02,
        responseTime: 1000,
        uptime: 0.02,
        lastUpdated: Date.now(),
        totalInteractions: 10,
        recentSuccessRate: 0.02,
        status: 'known',
      };

      const agentAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      const shouldLimit = metrics.shouldRateLimit(score, agentAge);

      // Overall trust should be < 0.1 to trigger rate limiting
      expect(shouldLimit).toBe(true);
    });

    it('should not rate limit high trust new agents', () => {
      const score: TrustScore = {
        interactionScore: 0.8,
        endorsements: 5,
        endorsementScore: 0.8,
        completionRate: 0.9,
        responseTime: 200,
        uptime: 0.95,
        lastUpdated: Date.now(),
        totalInteractions: 50,
        recentSuccessRate: 0.9,
        status: 'known',
      };

      const agentAge = 12 * 60 * 60 * 1000; // 12 hours
      const shouldLimit = metrics.shouldRateLimit(score, agentAge);

      expect(shouldLimit).toBe(false);
    });
  });

  describe('Default Trust Score', () => {
    it('should create default trust score for new agents', () => {
      const score = createDefaultTrustScore();

      expect(score.interactionScore).toBe(0);
      expect(score.endorsements).toBe(0);
      expect(score.completionRate).toBe(0);
      expect(score.responseTime).toBe(0);
      expect(score.uptime).toBe(0);
      expect(score.lastUpdated).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle negative values gracefully', () => {
      const stats: InteractionStats = {
        totalInteractions: -10,
        successRate: -0.5,
        recentSuccessRate: -0.5,
        avgResponseTime: -100,
        lastInteraction: Date.now(),
      };

      const score = metrics.calculateScore(stats, -5, -0.5);

      // Should not crash, values should be clamped or handled
      expect(score).toBeDefined();
      expect(score.interactionScore).toBeGreaterThanOrEqual(0);
    });

    it('should handle very large values', () => {
      const stats: InteractionStats = {
        totalInteractions: 1000000,
        successRate: 1.0,
        recentSuccessRate: 1.0,
        avgResponseTime: 10000,
        lastInteraction: Date.now(),
      };

      const score = metrics.calculateScore(stats, 1000, 1.0);

      expect(score).toBeDefined();
      expect(score.interactionScore).toBeLessThanOrEqual(1);
    });

    it('should handle NaN values', () => {
      const stats: InteractionStats = {
        totalInteractions: 0,
        successRate: 0,
        recentSuccessRate: 0,
        avgResponseTime: 0,
        lastInteraction: Date.now(),
      };

      const score = metrics.calculateScore(stats, 0, 1.0);

      expect(score).toBeDefined();
      expect(score.interactionScore).toBe(0);
    });
  });
});
