/**
 * Token Bucket Rate Limiter
 *
 * Classic token bucket algorithm for per-sender rate limiting.
 * Tokens refill at a constant rate up to capacity.
 */

export interface TokenBucketConfig {
  capacity: number;    // Max tokens (burst size)
  refillRate: number;  // Tokens per millisecond
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per ms

  constructor(config: TokenBucketConfig, initialTokens?: number, lastRefill?: number) {
    this.capacity = config.capacity;
    this.refillRate = config.refillRate;
    this.tokens = initialTokens ?? config.capacity;
    this.lastRefill = lastRefill ?? Date.now();
  }

  /** Attempt to consume one token. Returns true if allowed. */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  getRemaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Milliseconds until at least one token is available */
  getResetTime(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const needed = 1 - this.tokens;
    return Math.ceil(needed / this.refillRate);
  }

  /** Serialize state for persistence */
  toState(): { tokens: number; lastRefill: number } {
    return { tokens: this.tokens, lastRefill: this.lastRefill };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

/**
 * Rate limiter tiers based on trust score
 */
export interface RateLimitTiers {
  /** Trust < 0.3: new/unknown agents */
  newAgent: TokenBucketConfig;
  /** Trust 0.3–0.6: established agents */
  established: TokenBucketConfig;
  /** Trust > 0.6: trusted agents */
  trusted: TokenBucketConfig;
}

export const DEFAULT_RATE_LIMIT_TIERS: RateLimitTiers = {
  newAgent:    { capacity: 10,   refillRate: 10   / (60 * 1000) }, // 10/min, burst 10
  established: { capacity: 100,  refillRate: 60   / (60 * 1000) }, // 60/min, burst 100
  trusted:     { capacity: 1000, refillRate: 600  / (60 * 1000) }, // 600/min, burst 1000
};

export function getTierConfig(trustScore: number, tiers: RateLimitTiers): TokenBucketConfig {
  if (trustScore >= 0.6) return tiers.trusted;
  if (trustScore >= 0.3) return tiers.established;
  return tiers.newAgent;
}
