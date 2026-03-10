/**
 * Endorsement System
 *
 * Allows agents to endorse each other, building a web of trust
 */

import type { Level } from 'level';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('endorsement');

/**
 * Endorsement Record v1 (legacy)
 */
export interface Endorsement {
  from: string;                 // Endorser DID
  to: string;                   // Endorsed agent DID
  score: number;                // 0-1
  reason: string;
  timestamp: number;
  signature: string;            // Signed by endorser
}

/**
 * Endorsement Record v2 (CVP-0017)
 */
export interface EndorsementV2 {
  version: 2;
  from: string;                 // Endorser DID
  to: string;                   // Endorsed agent DID
  score: number;                // 0.0 - 1.0 (0.0 = explicit distrust/revocation)
  domain?: string;              // Capability domain (e.g., "translation", "gpu-compute")
                                // If omitted, endorsement applies to all domains
  reason: string;
  timestamp: number;            // Unix ms
  expires?: number;             // Unix ms — endorsement invalid after this time
                                // If omitted, default TTL based on domain
  signature: string;            // Ed25519 signature over all fields except signature
}

/**
 * Domain velocity categories for time decay
 */
export const FAST_DOMAINS = ['translation', 'transcription', 'data-entry', 'moderation'];
export const SLOW_DOMAINS = ['research', 'architecture', 'security-audit', 'legal-review'];

/**
 * Default expiration by domain (in days)
 */
export function getDefaultExpiration(domain?: string): number {
  if (!domain) return 180; // Default: 180 days
  if (FAST_DOMAINS.includes(domain)) return 90;
  if (SLOW_DOMAINS.includes(domain)) return 365;
  return 180; // Medium velocity
}

/**
 * Validate domain string
 */
export function validateDomain(domain: string): boolean {
  // Pattern: ^[a-z0-9]+(-[a-z0-9]+)*$
  const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  return pattern.test(domain) && domain.length <= 64;
}

/**
 * Sign function type
 */
export type SignFunction = (data: Uint8Array) => Promise<Uint8Array>;

/**
 * Verify function type
 */
export type VerifyFunction = (signature: Uint8Array, data: Uint8Array, publicKey: Uint8Array) => Promise<boolean>;

/**
 * Endorsement Manager
 */
export class EndorsementManager {
  constructor(
    private db: Level<string, Endorsement>,
    private getPublicKey: (did: string) => Promise<Uint8Array>
  ) {}

  async open(): Promise<void> {
    await this.db.open();
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Create an endorsement (v2)
   */
  async endorseV2(
    fromDid: string,
    toDid: string,
    score: number,
    reason: string,
    signFn: SignFunction,
    domain?: string,
    expires?: number
  ): Promise<EndorsementV2> {
    if (score < 0 || score > 1) {
      throw new Error('Score must be between 0 and 1');
    }

    if (domain && !validateDomain(domain)) {
      throw new Error('Invalid domain format. Must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be <= 64 chars');
    }

    const timestamp = Date.now();
    const defaultExpires = timestamp + getDefaultExpiration(domain) * 24 * 60 * 60 * 1000;

    const endorsement: Omit<EndorsementV2, 'signature'> = {
      version: 2,
      from: fromDid,
      to: toDid,
      score,
      domain,
      reason,
      timestamp,
      expires: expires || defaultExpires,
    };

    // Sign the endorsement
    const data = new TextEncoder().encode(JSON.stringify(endorsement));
    const signatureBytes = await signFn(data);
    const signature = Buffer.from(signatureBytes).toString('hex');

    const signedEndorsement: EndorsementV2 = {
      ...endorsement,
      signature,
    };

    logger.info('Created endorsement v2', { from: fromDid, to: toDid, score, domain });
    return signedEndorsement;
  }

  /**
   * Create an endorsement (v1 - legacy)
   */
  async endorse(
    fromDid: string,
    toDid: string,
    score: number,
    reason: string,
    signFn: SignFunction
  ): Promise<Endorsement> {
    if (score < 0 || score > 1) {
      throw new Error('Score must be between 0 and 1');
    }

    const endorsement: Omit<Endorsement, 'signature'> = {
      from: fromDid,
      to: toDid,
      score,
      reason,
      timestamp: Date.now(),
    };

    // Sign the endorsement
    const data = new TextEncoder().encode(JSON.stringify(endorsement));
    const signatureBytes = await signFn(data);
    const signature = Buffer.from(signatureBytes).toString('hex');

    const signedEndorsement: Endorsement = {
      ...endorsement,
      signature,
    };

    logger.info('Created endorsement', { from: fromDid, to: toDid, score });
    return signedEndorsement;
  }

  /**
   * Verify endorsement signature (v2)
   */
  async verifyV2(endorsement: EndorsementV2, verifyFn: VerifyFunction): Promise<boolean> {
    try {
      const { signature, ...endorsementWithoutSig } = endorsement;
      const data = new TextEncoder().encode(JSON.stringify(endorsementWithoutSig));
      const signatureBytes = Buffer.from(signature, 'hex');
      const publicKey = await this.getPublicKey(endorsement.from);

      return await verifyFn(signatureBytes, data, publicKey);
    } catch (error) {
      logger.error('Failed to verify endorsement v2', { error });
      return false;
    }
  }

  /**
   * Verify endorsement signature (v1)
   */
  async verify(endorsement: Endorsement, verifyFn: VerifyFunction): Promise<boolean> {
    try {
      const { signature, ...endorsementWithoutSig } = endorsement;
      const data = new TextEncoder().encode(JSON.stringify(endorsementWithoutSig));
      const signatureBytes = Buffer.from(signature, 'hex');
      const publicKey = await this.getPublicKey(endorsement.from);

      return await verifyFn(signatureBytes, data, publicKey);
    } catch (error) {
      logger.error('Failed to verify endorsement', { error });
      return false;
    }
  }

  /**
   * Upgrade v1 endorsement to v2
   */
  upgradeEndorsement(e: Endorsement): EndorsementV2 {
    return {
      version: 2,
      from: e.from,
      to: e.to,
      score: e.score,
      domain: undefined,     // v1 endorsements are domain-agnostic
      reason: e.reason,
      timestamp: e.timestamp,
      expires: e.timestamp + 90 * 24 * 60 * 60 * 1000,  // 90-day default
      signature: e.signature,  // v1 signature remains valid
    };
  }

  /**
   * Publish endorsement to local database
   */
  async publish(endorsement: Endorsement): Promise<void> {
    const key = `endorsement:${endorsement.to}:${endorsement.from}`;
    await this.db.put(key, endorsement);
    logger.info('Published endorsement', { from: endorsement.from, to: endorsement.to });
  }

  /**
   * Get all endorsements for an agent
   */
  async getEndorsements(agentDid: string): Promise<Endorsement[]> {
    const endorsements: Endorsement[] = [];
    const prefix = `endorsement:${agentDid}:`;

    try {
      for await (const [_, value] of this.db.iterator({
        gte: prefix,
        lte: prefix + '\xff',
      })) {
        endorsements.push(value);
      }
    } catch (error) {
      logger.error('Failed to get endorsements', { agentDid, error });
    }

    return endorsements;
  }

  /**
   * Get endorsements given by an agent
   */
  async getEndorsementsBy(fromDid: string): Promise<Endorsement[]> {
    const endorsements: Endorsement[] = [];

    try {
      for await (const [_, value] of this.db.iterator()) {
        if (value.from === fromDid) {
          endorsements.push(value);
        }
      }
    } catch (error) {
      logger.error('Failed to get endorsements by agent', { fromDid, error });
    }

    return endorsements;
  }

  /**
   * Calculate average endorsement score
   */
  async getAverageScore(agentDid: string): Promise<number> {
    const endorsements = await this.getEndorsements(agentDid);

    if (endorsements.length === 0) {
      return 0;
    }

    const totalScore = endorsements.reduce((sum, e) => sum + e.score, 0);
    return totalScore / endorsements.length;
  }

  /**
   * Delete an endorsement
   */
  async deleteEndorsement(fromDid: string, toDid: string): Promise<void> {
    const key = `endorsement:${toDid}:${fromDid}`;
    await this.db.del(key);
    logger.info('Deleted endorsement', { from: fromDid, to: toDid });
  }

  /**
   * Publish endorsement to relay (CVP-0017)
   */
  async publishToRelay(
    relay: { publishEndorsement: (e: EndorsementV2) => Promise<{ id: string; stored: boolean; error?: string }> },
    endorsement: EndorsementV2
  ): Promise<{ id: string; stored: boolean; error?: string }> {
    logger.info('Publishing endorsement to relay', { from: endorsement.from, to: endorsement.to });
    return await relay.publishEndorsement(endorsement);
  }

  /**
   * Query endorsements from relay (CVP-0017)
   */
  async queryFromRelay(
    relay: { queryTrust: (target: string, domain?: string, since?: number) => Promise<{ endorsements: EndorsementV2[]; endorsementCount?: number; averageScore?: number }> },
    target: string,
    domain?: string,
    since?: number
  ): Promise<{ endorsements: EndorsementV2[]; total: number; averageScore: number }> {
    logger.info('Querying endorsements from relay', { target, domain });
    const result = await relay.queryTrust(target, domain, since);
    return {
      endorsements: result.endorsements,
      total: result.endorsementCount ?? result.endorsements.length,
      averageScore: result.averageScore ?? (result.endorsements.length > 0 ? result.endorsements.reduce((sum, e) => sum + e.score, 0) / result.endorsements.length : 0),
    };
  }
}
