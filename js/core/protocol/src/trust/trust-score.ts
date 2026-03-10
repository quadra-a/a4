/**
 * Trust Score System
 *
 * Tracks agent reputation based on interactions, endorsements,
 * and network behavior.
 */

/**
 * Trust status for an agent
 */
export type TrustStatus = 'unknown' | 'known' | 'suspicious' | 'blocked' | 'allowed';

/**
 * Trust Score Metrics
 */
export interface TrustScore {
  interactionScore: number;      // 0-1, based on successful interactions
  endorsements: number;          // Count of endorsements
  endorsementScore: number;      // Average endorsement score (0-1)
  completionRate: number;        // % of completed tasks (0-1)
  responseTime: number;          // Average response time (ms)
  uptime: number;               // % of time online last 30 days (0-1)
  lastUpdated: number;          // Timestamp
  totalInteractions: number;     // Raw interaction count (0 = new agent)
  recentSuccessRate: number;     // Success rate of last 20 interactions
  status: TrustStatus;           // Current trust status
}

/**
 * Interaction Record
 */
export interface Interaction {
  agentDid: string;
  timestamp: number;
  type: 'message' | 'task' | 'query';
  success: boolean;
  responseTime: number;
  rating?: number;              // 1-5 stars (optional user rating)
  feedback?: string;
}

/**
 * Interaction Statistics
 */
export interface InteractionStats {
  totalInteractions: number;
  successRate: number;
  recentSuccessRate: number;  // Success rate of last 20 interactions (sliding window)
  avgResponseTime: number;
  lastInteraction: number;
}

/**
 * Trust Metrics Calculator
 */
export class TrustMetrics {
  /**
   * Calculate trust score from interaction history.
   * @param endorsementScore - Average endorsement score (0-1), not count
   */
  calculateScore(stats: InteractionStats, endorsementScore: number, uptime: number): TrustScore {
    // Maturity weight: 50 interactions reaches full weight
    const maturityWeight = Math.min(stats.totalInteractions / 50, 1);
    const interactionScore = stats.successRate * maturityWeight;

    // Derive status from interaction history
    const status = this.deriveStatus(stats);

    return {
      interactionScore,
      endorsements: 0, // kept for backwards compat
      endorsementScore,
      completionRate: stats.successRate,
      responseTime: stats.avgResponseTime,
      uptime,
      lastUpdated: Date.now(),
      totalInteractions: stats.totalInteractions,
      recentSuccessRate: stats.recentSuccessRate,
      status,
    };
  }

  private deriveStatus(stats: InteractionStats): TrustStatus {
    if (stats.totalInteractions === 0) return 'unknown';
    const recentFailureRate = 1 - stats.recentSuccessRate;
    if (stats.totalInteractions >= 10 && recentFailureRate > 0.5) return 'suspicious';
    return 'known';
  }

  /**
   * Calculate overall trust level (0-1)
   * @param score - TrustScore
   * @param endorsementScore - Average endorsement score (0-1)
   */
  calculateOverallTrust(score: TrustScore): number {
    const weights = {
      interaction: 0.6,
      endorsement: 0.4,
    };

    return (
      score.interactionScore * weights.interaction +
      score.endorsementScore * weights.endorsement
    );
  }

  /**
   * Get trust level category
   */
  getTrustLevel(score: TrustScore): 'new' | 'low' | 'medium' | 'high' | 'trusted' {
    const overall = this.calculateOverallTrust(score);

    if (score.totalInteractions === 0) return 'new';
    if (overall < 0.3) return 'low';
    if (overall < 0.6) return 'medium';
    if (overall < 0.8) return 'high';
    return 'trusted';
  }

  /**
   * Check if agent should be rate limited
   */
  shouldRateLimit(score: TrustScore, agentAge: number): boolean {
    const overall = this.calculateOverallTrust(score);
    const ONE_DAY = 24 * 60 * 60 * 1000;

    if (agentAge < ONE_DAY && overall < 0.3) return true;
    if (overall < 0.1) return true;

    return false;
  }
}

/**
 * Default trust score for new agents
 */
export function createDefaultTrustScore(): TrustScore {
  return {
    interactionScore: 0,
    endorsements: 0,
    endorsementScore: 0,
    completionRate: 0,
    responseTime: 0,
    uptime: 0,
    lastUpdated: Date.now(),
    totalInteractions: 0,
    recentSuccessRate: 1,
    status: 'unknown',
  };
}
