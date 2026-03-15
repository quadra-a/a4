/**
 * Defense Middleware
 *
 * Checks incoming messages against:
 * 1. Allowlist bypass
 * 2. Blocklist rejection
 * 3. Deduplication (seen cache)
 * 4. Trust score filtering
 * 5. Rate limiting (token bucket, tiered by trust)
 */

import { createLogger } from '../utils/logger.js';
import type { MessageEnvelope } from './envelope.js';
import type { TrustSystem } from '../trust/index.js';
import type { TrustStatus } from '../trust/trust-score.js';
import type { MessageStorage } from './storage.js';
import type { DefenseResult, RateLimitResult } from './types.js';
import {
  TokenBucket,
  DEFAULT_RATE_LIMIT_TIERS,
  getTierConfig,
  type RateLimitTiers,
} from './rate-limiter.js';

const logger = createLogger('defense');

export interface DefenseConfig {
  trustSystem: TrustSystem;
  storage: MessageStorage;
  /** Minimum trust score to accept messages (0 = accept all) */
  minTrustScore?: number;
  rateLimitTiers?: RateLimitTiers;
  /** TTL for seen-cache entries in ms (default: 1 hour) */
  seenTtlMs?: number;
}

export class DefenseMiddleware {
  private readonly trust: TrustSystem;
  private readonly storage: MessageStorage;
  private readonly minTrustScore: number;
  private readonly tiers: RateLimitTiers;
  private readonly seenTtlMs: number;

  // In-memory LRU-style seen cache (backed by LevelDB for persistence)
  private readonly seenCache = new Map<string, number>(); // id → seenAt
  private readonly MAX_SEEN_CACHE = 10_000;

  // In-memory token buckets (backed by LevelDB for persistence)
  private readonly buckets = new Map<string, TokenBucket>();

  // Grace period tracking: DID → unblock timestamp
  private readonly recentlyUnblocked = new Map<string, number>();
  private readonly UNBLOCK_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

  constructor(config: DefenseConfig) {
    this.trust = config.trustSystem;
    this.storage = config.storage;
    this.minTrustScore = config.minTrustScore ?? 0;
    this.tiers = config.rateLimitTiers ?? DEFAULT_RATE_LIMIT_TIERS;
    this.seenTtlMs = config.seenTtlMs ?? 60 * 60 * 1000; // 1 hour
  }

  /**
   * Run all defense checks on an incoming message.
   * Returns { allowed: true } if the message should be processed,
   * or { allowed: false, reason } if it should be dropped.
   */
  async checkMessage(envelope: MessageEnvelope): Promise<DefenseResult> {
    const did = envelope.from;

    // 1. Allowlist bypass — skip all other checks
    if (await this.isAllowed(did)) {
      this.markAsSeen(envelope.id);
      return { allowed: true, trustStatus: 'allowed' };
    }

    // 2. Blocklist check
    if (await this.isBlocked(did)) {
      logger.debug('Message rejected: blocked', { id: envelope.id, from: did });
      return { allowed: false, reason: 'blocked' };
    }

    // 2.5. Sybil / rate-limit check (in-memory, resets on daemon restart)
    if (this.trust.isRateLimited(did)) {
      logger.debug('Message rejected: sybil rate limited', { id: envelope.id, from: did });
      return { allowed: false, reason: 'rate_limited' };
    }

    // 3. Deduplication
    if (this.hasSeen(envelope.id)) {
      logger.debug('Message rejected: duplicate', { id: envelope.id });
      return { allowed: false, reason: 'duplicate' };
    }

    // 4. Trust score check + auto-block logic
    let trustScore = 0;
    let trustStatus: TrustStatus = 'unknown';
    try {
      const score = await this.trust.getTrustScore(did);
      trustScore = score.interactionScore;
      trustStatus = score.status;

      const totalInteractions = score.totalInteractions ?? 0;
      const recentFailureRate = 1 - (score.recentSuccessRate ?? 1);

      // Suspicious: ≥10 interactions, recent failure rate > 50%
      // Don't auto-block yet, but force strictest rate limit tier
      if (totalInteractions >= 10 && recentFailureRate > 0.5) {
        logger.warn('Suspicious agent detected', { did, recentFailureRate: recentFailureRate.toFixed(2), totalInteractions });
        trustScore = 0; // Force strictest rate limit tier
      }

      // Auto-block: ≥20 interactions, recent failure rate > 70%
      // Skip if agent was recently manually unblocked (grace period)
      const unblockTime = this.recentlyUnblocked.get(did);
      const inGracePeriod = unblockTime && (Date.now() - unblockTime) < this.UNBLOCK_GRACE_PERIOD_MS;

      if (totalInteractions >= 20 && recentFailureRate > 0.7 && !inGracePeriod) {
        logger.warn('Auto-blocking high-failure-rate agent', { did, recentFailureRate: recentFailureRate.toFixed(2), totalInteractions });
        await this.blockAgent(did, `Auto-blocked: ${(recentFailureRate * 100).toFixed(0)}% failure rate over last 20 interactions`);
        return { allowed: false, reason: 'blocked' };
      }

      if (trustScore < this.minTrustScore) {
        logger.debug('Message rejected: trust too low', { id: envelope.id, trustScore });
        return { allowed: false, reason: 'trust_too_low', trustScore };
      }
    } catch (err) {
      logger.warn('Trust score lookup failed, using 0', { did, error: (err as Error).message });
    }

    // 5. Rate limiting (tiered by trust)
    const rateLimitResult = await this.checkRateLimit(did, trustScore);
    if (!rateLimitResult.allowed) {
      logger.debug('Message rejected: rate limited', {
        id: envelope.id,
        from: did,
        resetTime: rateLimitResult.resetTime,
      });
      return {
        allowed: false,
        reason: 'rate_limited',
        remainingTokens: rateLimitResult.remaining,
        resetTime: rateLimitResult.resetTime,
      };
    }

    // All checks passed
    this.markAsSeen(envelope.id);
    return { allowed: true, trustScore, trustStatus, remainingTokens: rateLimitResult.remaining };
  }

  // ─── Blocklist ────────────────────────────────────────────────────────────

  async blockAgent(did: string, reason: string, blockedBy = 'local'): Promise<void> {
    await this.storage.putBlock({ did, reason, blockedAt: Date.now(), blockedBy });
    logger.info('Agent blocked', { did, reason });
  }

  async unblockAgent(did: string): Promise<void> {
    await this.storage.deleteBlock(did);
    this.recentlyUnblocked.set(did, Date.now());
    logger.info('Agent unblocked', { did });
  }

  async isBlocked(did: string): Promise<boolean> {
    return (await this.storage.getBlock(did)) !== null;
  }

  // ─── Allowlist ────────────────────────────────────────────────────────────

  async allowAgent(did: string, note?: string): Promise<void> {
    await this.storage.putAllow({ did, addedAt: Date.now(), note });
    logger.info('Agent allowlisted', { did });
  }

  async removeFromAllowlist(did: string): Promise<void> {
    await this.storage.deleteAllow(did);
    logger.info('Agent removed from allowlist', { did });
  }

  async isAllowed(did: string): Promise<boolean> {
    return (await this.storage.getAllow(did)) !== null;
  }

  // ─── Rate Limiting ────────────────────────────────────────────────────────

  async checkRateLimit(did: string, trustScore: number): Promise<RateLimitResult> {
    const tierConfig = getTierConfig(trustScore, this.tiers);

    // Load or create bucket
    let bucket = this.buckets.get(did);
    if (!bucket) {
      // Try to restore from LevelDB
      const persisted = await this.storage.getRateLimit(did);
      if (persisted) {
        bucket = new TokenBucket(tierConfig, persisted.tokens, persisted.lastRefill);
      } else {
        bucket = new TokenBucket(tierConfig);
      }
      this.buckets.set(did, bucket);
    }

    const allowed = bucket.consume();
    const state = bucket.toState();

    // Persist updated state
    await this.storage.putRateLimit({
      did,
      tokens: state.tokens,
      lastRefill: state.lastRefill,
      totalRequests: 0,
      firstSeen: Date.now(),
    });

    return {
      allowed,
      remaining: bucket.getRemaining(),
      resetTime: bucket.getResetTime(),
      limit: tierConfig.capacity,
    };
  }

  // ─── Seen Cache (deduplication) ───────────────────────────────────────────

  hasSeen(messageId: string): boolean {
    return this.seenCache.has(messageId);
  }

  markAsSeen(messageId: string): void {
    // Evict oldest entries if at capacity
    if (this.seenCache.size >= this.MAX_SEEN_CACHE) {
      const firstKey = this.seenCache.keys().next().value;
      if (firstKey) this.seenCache.delete(firstKey);
    }
    this.seenCache.set(messageId, Date.now());

    // Persist to LevelDB (fire-and-forget)
    this.storage.putSeen({ messageId, seenAt: Date.now(), fromDid: '' }).catch(() => {});
  }

  /** Periodic cleanup of expired seen entries */
  async cleanupSeen(): Promise<void> {
    const cutoff = Date.now() - this.seenTtlMs;
    for (const [id, seenAt] of this.seenCache) {
      if (seenAt < cutoff) this.seenCache.delete(id);
    }
    await this.storage.cleanupSeen(this.seenTtlMs);

    // Cleanup expired grace period entries
    const graceCutoff = Date.now() - this.UNBLOCK_GRACE_PERIOD_MS;
    for (const [did, unblockTime] of this.recentlyUnblocked) {
      if (unblockTime < graceCutoff) this.recentlyUnblocked.delete(did);
    }
  }

  /** Periodic cleanup of stale rate limit buckets (24h inactive) */
  async cleanupRateLimits(): Promise<void> {
    const staleMs = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - staleMs;
    for (const [did, bucket] of this.buckets) {
      if (bucket.toState().lastRefill < cutoff) this.buckets.delete(did);
    }
    await this.storage.cleanupRateLimits(staleMs);
  }
}
