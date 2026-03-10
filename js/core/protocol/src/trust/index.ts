/**
 * Trust System - Main Export
 *
 * Combines all trust components into a unified interface
 */

export * from './trust-score.js';
export * from './interaction-history.js';
export * from './endorsement.js';
export * from './sybil-defense.js';
export * from './trust-computer.js';

import { Level } from 'level';
import { TrustMetrics } from './trust-score.js';
import type { TrustScore, Interaction } from './trust-score.js';
import { InteractionHistory } from './interaction-history.js';
import { EndorsementManager } from './endorsement.js';
import type { Endorsement, SignFunction, VerifyFunction } from './endorsement.js';
import { SybilDefense } from './sybil-defense.js';
import type { ChallengeSolution } from './sybil-defense.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('trust-system');

/**
 * Trust System Configuration
 */
export interface TrustSystemConfig {
  dbPath: string;
  getPublicKey: (did: string) => Promise<Uint8Array>;
}

/**
 * Unified Trust System
 */
export class TrustSystem {
  private metrics: TrustMetrics;
  private history: InteractionHistory;
  private endorsements: EndorsementManager;
  private sybilDefense: SybilDefense;
  private trustCache = new Map<string, { score: TrustScore; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  // Uptime tracking: DID → { firstSeen, totalOnlineMs, lastOnlineAt }
  private uptimeTracker = new Map<string, { firstSeen: number; totalOnlineMs: number; lastOnlineAt: number }>();

  constructor(config: TrustSystemConfig) {
    this.metrics = new TrustMetrics();
    this.history = new InteractionHistory(`${config.dbPath}/interactions`);

    const endorsementDb = new Level<string, Endorsement>(`${config.dbPath}/endorsements`, {
      valueEncoding: 'json',
    });
    this.endorsements = new EndorsementManager(endorsementDb, config.getPublicKey);
    this.sybilDefense = new SybilDefense();
  }

  /**
   * Initialize the trust system
   */
  async start(): Promise<void> {
    await Promise.all([
      this.history.open(),
      this.endorsements.open(),
    ]);
    logger.info('Trust system started');
  }

  /**
   * Shutdown the trust system
   */
  async stop(): Promise<void> {
    await Promise.all([
      this.history.close(),
      this.endorsements.close(),
    ]);
    logger.info('Trust system stopped');
  }

  /**
   * Record an interaction
   */
  async recordInteraction(interaction: Interaction): Promise<void> {
    await this.history.record(interaction);
    this.sybilDefense.recordRequest(interaction.agentDid);

    // Invalidate cache
    this.trustCache.delete(interaction.agentDid);
  }

  /**
   * Record agent coming online (for uptime tracking)
   */
  recordOnline(agentDid: string): void {
    const now = Date.now();
    const existing = this.uptimeTracker.get(agentDid);
    if (existing) {
      existing.lastOnlineAt = now;
    } else {
      this.uptimeTracker.set(agentDid, { firstSeen: now, totalOnlineMs: 0, lastOnlineAt: now });
    }
  }

  /**
   * Record agent going offline (for uptime tracking)
   */
  recordOffline(agentDid: string): void {
    const now = Date.now();
    const entry = this.uptimeTracker.get(agentDid);
    if (entry && entry.lastOnlineAt > 0) {
      entry.totalOnlineMs += now - entry.lastOnlineAt;
      entry.lastOnlineAt = 0;
    }
  }

  /**
   * Get uptime ratio for an agent (0.0 - 1.0)
   * Based on time since first seen vs total online time.
   */
  getUptime(agentDid: string): number {
    const entry = this.uptimeTracker.get(agentDid);
    if (!entry) return 1.0; // No data — assume good (benefit of the doubt)

    const now = Date.now();
    const totalMs = now - entry.firstSeen;
    if (totalMs < 60_000) return 1.0; // Too early to judge

    // Add current online session if still online
    const onlineMs = entry.totalOnlineMs + (entry.lastOnlineAt > 0 ? now - entry.lastOnlineAt : 0);
    return Math.min(1.0, onlineMs / totalMs);
  }

  /**
   * Get trust score for an agent
   */
  async getTrustScore(agentDid: string): Promise<TrustScore> {
    // Check cache
    const cached = this.trustCache.get(agentDid);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.score;
    }

    // Calculate fresh score
    const stats = await this.history.getStats(agentDid);
    const endorsementList = await this.endorsements.getEndorsements(agentDid);
    const uptime = this.getUptime(agentDid);

    // Use average endorsement score (0-1) instead of raw count
    const endorsementScore = endorsementList.length > 0
      ? endorsementList.reduce((sum, e) => sum + e.score, 0) / endorsementList.length
      : 0;

    const score = this.metrics.calculateScore(stats, endorsementScore, uptime);

    // Cache result
    this.trustCache.set(agentDid, { score, timestamp: Date.now() });

    return score;
  }

  /**
   * Create an endorsement
   */
  async endorse(
    fromDid: string,
    toDid: string,
    score: number,
    reason: string,
    signFn: SignFunction
  ): Promise<Endorsement> {
    const endorsement = await this.endorsements.endorse(fromDid, toDid, score, reason, signFn);
    await this.endorsements.publish(endorsement);

    // Invalidate cache
    this.trustCache.delete(toDid);

    return endorsement;
  }

  /**
   * Get endorsements for an agent
   */
  async getEndorsements(agentDid: string): Promise<Endorsement[]> {
    return this.endorsements.getEndorsements(agentDid);
  }

  /**
   * Verify an endorsement
   */
  async verifyEndorsement(endorsement: Endorsement, verifyFn: VerifyFunction): Promise<boolean> {
    return this.endorsements.verify(endorsement, verifyFn);
  }

  /**
   * Check if agent should be rate limited
   */
  isRateLimited(agentDid: string): boolean {
    return this.sybilDefense.isRateLimited(agentDid);
  }

  /**
   * Generate Sybil defense challenge
   */
  generateChallenge(did: string, difficulty?: number) {
    return this.sybilDefense.generateChallenge(did, difficulty);
  }

  /**
   * Verify Sybil defense challenge
   */
  verifyChallenge(solution: ChallengeSolution): boolean {
    return this.sybilDefense.verifyChallenge(solution);
  }

  /**
   * Get peer trust level
   */
  getPeerTrustLevel(peerId: string) {
    return this.sybilDefense.getPeerTrustLevel(peerId);
  }

  /**
   * Record peer seen
   */
  recordPeerSeen(peerId: string): void {
    this.sybilDefense.recordPeerSeen(peerId);
  }

  /**
   * Get interaction history
   */
  async getHistory(agentDid: string, limit?: number): Promise<Interaction[]> {
    return this.history.getHistory(agentDid, limit);
  }

  /**
   * Clean up old data
   */
  async cleanup(): Promise<void> {
    await this.history.cleanup();
    this.sybilDefense.cleanup();
    this.trustCache.clear();
    logger.info('Trust system cleanup completed');
  }
}

/**
 * Create a trust system instance
 */
export function createTrustSystem(config: TrustSystemConfig): TrustSystem {
  return new TrustSystem(config);
}
