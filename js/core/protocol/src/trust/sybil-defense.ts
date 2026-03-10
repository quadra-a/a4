/**
 * Sybil Defense Mechanisms
 *
 * Protects the network from Sybil attacks through:
 * - Entry cost (Hashcash challenges)
 * - Progressive trust (rate limiting for new agents)
 * - Discovery hardening (prefer established peers)
 */

import { createLogger } from '../utils/logger.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const logger = createLogger('sybil-defense');

/**
 * Hashcash Challenge
 */
export interface Challenge {
  did: string;
  difficulty: number;  // Number of leading zero bits required
  nonce: string;
  timestamp: number;
}

/**
 * Challenge Solution
 */
export interface ChallengeSolution {
  challenge: Challenge;
  solution: string;  // Nonce that produces required hash
}

/**
 * Rate Limit Record
 */
interface RateLimitRecord {
  did: string;
  requests: number[];  // Timestamps of requests
  firstSeen: number;
}

/**
 * Peer Trust Level
 */
export type PeerTrustLevel = 'new' | 'established' | 'trusted';

/**
 * Sybil Defense Manager
 */
export class SybilDefense {
  private rateLimits = new Map<string, RateLimitRecord>();
  private peerFirstSeen = new Map<string, number>();
  private readonly NEW_AGENT_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
  private readonly RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
  private readonly MAX_REQUESTS_NEW = 10; // Max requests per hour for new agents
  private readonly ESTABLISHED_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days

  /**
   * Generate a Hashcash challenge for a new DID
   */
  generateChallenge(did: string, difficulty = 20): Challenge {
    const nonce = this.generateNonce();
    return {
      did,
      difficulty,
      nonce,
      timestamp: Date.now(),
    };
  }

  /**
   * Verify a Hashcash challenge solution
   */
  verifyChallenge(solution: ChallengeSolution): boolean {
    const { challenge, solution: solutionNonce } = solution;

    // Check challenge is not too old (valid for 1 hour)
    if (Date.now() - challenge.timestamp > 60 * 60 * 1000) {
      logger.warn('Challenge expired', { did: challenge.did });
      return false;
    }

    // Compute hash
    const data = `${challenge.did}:${challenge.nonce}:${solutionNonce}`;
    const hash = sha256(new TextEncoder().encode(data));

    // Check leading zeros
    const leadingZeros = this.countLeadingZeroBits(hash);
    const valid = leadingZeros >= challenge.difficulty;

    if (valid) {
      logger.info('Challenge verified', { did: challenge.did, leadingZeros });
    } else {
      logger.warn('Challenge failed', { did: challenge.did, leadingZeros, required: challenge.difficulty });
    }

    return valid;
  }

  /**
   * Check if an agent should be rate limited
   */
  isRateLimited(did: string): boolean {
    const record = this.rateLimits.get(did);
    if (!record) {
      return false;
    }

    const now = Date.now();
    const agentAge = now - record.firstSeen;

    // Only rate limit new agents
    if (agentAge > this.NEW_AGENT_WINDOW) {
      return false;
    }

    // Count recent requests
    const recentRequests = record.requests.filter(
      t => now - t < this.RATE_LIMIT_WINDOW
    );

    return recentRequests.length >= this.MAX_REQUESTS_NEW;
  }

  /**
   * Record a request from an agent
   */
  recordRequest(did: string): void {
    const now = Date.now();
    let record = this.rateLimits.get(did);

    if (!record) {
      record = {
        did,
        requests: [],
        firstSeen: now,
      };
      this.rateLimits.set(did, record);
    }

    // Add request timestamp
    record.requests.push(now);

    // Clean up old requests
    record.requests = record.requests.filter(
      t => now - t < this.RATE_LIMIT_WINDOW
    );

    logger.debug('Recorded request', { did, count: record.requests.length });
  }

  /**
   * Get peer trust level based on age
   */
  getPeerTrustLevel(peerId: string): PeerTrustLevel {
    const firstSeen = this.peerFirstSeen.get(peerId);
    if (!firstSeen) {
      return 'new';
    }

    const age = Date.now() - firstSeen;

    if (age < this.NEW_AGENT_WINDOW) {
      return 'new';
    } else if (age < this.ESTABLISHED_THRESHOLD) {
      return 'established';
    } else {
      return 'trusted';
    }
  }

  /**
   * Record first seen time for a peer
   */
  recordPeerSeen(peerId: string): void {
    if (!this.peerFirstSeen.has(peerId)) {
      this.peerFirstSeen.set(peerId, Date.now());
      logger.debug('Recorded new peer', { peerId });
    }
  }

  /**
   * Clean up old records
   */
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.NEW_AGENT_WINDOW;

    // Clean up rate limits for old agents
    for (const [did, record] of this.rateLimits.entries()) {
      if (record.firstSeen < cutoff) {
        this.rateLimits.delete(did);
      }
    }

    logger.info('Cleaned up Sybil defense records', {
      rateLimits: this.rateLimits.size,
      peers: this.peerFirstSeen.size,
    });
  }

  /**
   * Generate a random nonce
   */
  private generateNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  /**
   * Count leading zero bits in a hash
   */
  private countLeadingZeroBits(hash: Uint8Array): number {
    let count = 0;
    for (const byte of hash) {
      if (byte === 0) {
        count += 8;
      } else {
        // Count leading zeros in this byte
        let b = byte;
        while ((b & 0x80) === 0) {
          count++;
          b <<= 1;
        }
        break;
      }
    }
    return count;
  }
}
