/**
 * CVP-0017: Endorsement index for relay server
 *
 * Stores and queries endorsements. Relay is a dumb index — it does NOT compute
 * trust scores, only stores signed endorsements and returns them on query.
 */

import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { EndorsementV2 } from '@quadra-a/protocol';

export interface StoredEndorsement extends EndorsementV2 {
  id: string;  // sha256 hash of endorsement
  storedAt: number;
}

interface PersistedEndorsements {
  endorsements: StoredEndorsement[];
}

/**
 * Endorsement Index
 */
export class EndorsementIndex {
  // Primary index: target DID -> endorsements
  private byTarget = new Map<string, Map<string, StoredEndorsement>>();
  // Secondary index: endorser DID -> endorsements
  private byEndorser = new Map<string, Set<string>>();
  // All endorsements by ID
  private byId = new Map<string, StoredEndorsement>();

  constructor(private storagePath?: string) {}

  async load(): Promise<void> {
    this.clear();

    if (!this.storagePath) {
      return;
    }

    try {
      const raw = await readFile(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedEndorsements | StoredEndorsement[];
      const endorsements = Array.isArray(parsed) ? parsed : parsed.endorsements;

      if (!Array.isArray(endorsements)) {
        return;
      }

      for (const endorsement of endorsements) {
        this.indexStoredEndorsement(endorsement);
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    if (!this.storagePath) {
      return;
    }

    await mkdir(dirname(this.storagePath), { recursive: true });
    const payload: PersistedEndorsements = {
      endorsements: Array.from(this.byId.values()).sort((a, b) => a.storedAt - b.storedAt),
    };
    await writeFile(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * Store an endorsement
   * Returns endorsement ID
   */
  store(endorsement: EndorsementV2): string {
    const id = this.computeId(endorsement);

    // Check if this replaces an existing endorsement (same from/to/domain)
    const key = this.getKey(endorsement.from, endorsement.to, endorsement.domain);
    const targetMap = this.byTarget.get(endorsement.to);
    const existing = targetMap?.get(key);

    if (existing) {
      this.removeStoredEndorsement(existing);
    }

    const stored: StoredEndorsement = {
      ...endorsement,
      id,
      storedAt: Date.now(),
    };

    this.indexStoredEndorsement(stored);

    return id;
  }

  /**
   * Query endorsements for a target DID
   */
  query(
    target: string,
    domain?: string,
    since?: number,
    limit = 100
  ): { endorsements: StoredEndorsement[]; total: number; averageScore: number } {
    const targetMap = this.byTarget.get(target);
    if (!targetMap) {
      return { endorsements: [], total: 0, averageScore: 0 };
    }

    const now = Date.now();
    let all = Array.from(targetMap.values());

    // Filter expired
    all = all.filter(e => !e.expires || e.expires > now);

    // Filter by domain
    if (domain !== undefined) {
      all = all.filter(e => e.domain === domain || e.domain === undefined || e.domain === '*');
    }

    // Filter by timestamp
    if (since !== undefined) {
      all = all.filter(e => e.timestamp >= since);
    }

    // Sort by timestamp descending (newest first)
    all.sort((a, b) => b.timestamp - a.timestamp);

    const total = all.length;
    const endorsements = all.slice(0, limit);

    // Compute average score (unweighted)
    const averageScore = total > 0
      ? all.reduce((sum, e) => sum + e.score, 0) / total
      : 0;

    return { endorsements, total, averageScore };
  }

  /**
   * Get trust summary for a target (for discovery)
   * Returns undefined if endorsementCount < 3
   */
  getTrustSummary(target: string): {
    endorsementCount: number;
    averageScore: number;
    oldestEndorsement: number;
    verified?: boolean;
  } | undefined {
    const { endorsements, total, averageScore } = this.query(target, undefined, undefined, 1000);

    // CVP-0017: Only show trust if >= 3 endorsements
    if (total < 3) {
      return undefined;
    }

    const oldestEndorsement = endorsements.length > 0
      ? Math.min(...endorsements.map(e => e.timestamp))
      : Date.now();

    const verified = total >= 10 && averageScore >= 0.7;

    return {
      endorsementCount: total,
      averageScore,
      oldestEndorsement,
      verified,
    };
  }

  /**
   * Get endorsements by endorser
   */
  getByEndorser(endorser: string): StoredEndorsement[] {
    const ids = this.byEndorser.get(endorser);
    if (!ids) return [];

    return Array.from(ids)
      .map(id => this.byId.get(id))
      .filter((e): e is StoredEndorsement => e !== undefined);
  }

  /**
   * Check if an endorsement from a specific endorser to a target already exists.
   * Used for cold-start dedup — relay only gives bootstrap endorsement once.
   */
  hasEndorsementFrom(endorserPrefix: string, target: string): boolean {
    const targetMap = this.byTarget.get(target);
    if (!targetMap) return false;
    for (const e of targetMap.values()) {
      if (e.from.includes(endorserPrefix)) return true;
    }
    return false;
  }

  /**
   * Garbage collect expired endorsements
   * Removes endorsements that expired more than 2x their TTL ago
   */
  garbageCollect(): number {
    const now = Date.now();
    let removed = 0;

    for (const endorsement of Array.from(this.byId.values())) {
      if (!endorsement.expires) continue;

      const ttl = endorsement.expires - endorsement.timestamp;
      const gcThreshold = endorsement.expires + ttl; // 2x TTL

      if (now > gcThreshold) {
        this.removeStoredEndorsement(endorsement);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get total endorsement count
   */
  size(): number {
    return this.byId.size;
  }

  private clear(): void {
    this.byTarget.clear();
    this.byEndorser.clear();
    this.byId.clear();
  }

  private indexStoredEndorsement(endorsement: StoredEndorsement): void {
    const key = this.getKey(endorsement.from, endorsement.to, endorsement.domain);

    if (!this.byTarget.has(endorsement.to)) {
      this.byTarget.set(endorsement.to, new Map());
    }
    this.byTarget.get(endorsement.to)!.set(key, endorsement);

    if (!this.byEndorser.has(endorsement.from)) {
      this.byEndorser.set(endorsement.from, new Set());
    }
    this.byEndorser.get(endorsement.from)!.add(endorsement.id);

    this.byId.set(endorsement.id, endorsement);
  }

  private removeStoredEndorsement(endorsement: StoredEndorsement): void {
    const key = this.getKey(endorsement.from, endorsement.to, endorsement.domain);

    const targetMap = this.byTarget.get(endorsement.to);
    targetMap?.delete(key);
    if (targetMap && targetMap.size === 0) {
      this.byTarget.delete(endorsement.to);
    }

    const endorserSet = this.byEndorser.get(endorsement.from);
    endorserSet?.delete(endorsement.id);
    if (endorserSet && endorserSet.size === 0) {
      this.byEndorser.delete(endorsement.from);
    }

    this.byId.delete(endorsement.id);
  }

  /**
   * Compute endorsement ID (sha256 hash)
   */
  private computeId(endorsement: EndorsementV2): string {
    const data = JSON.stringify({
      from: endorsement.from,
      to: endorsement.to,
      score: endorsement.score,
      domain: endorsement.domain,
      timestamp: endorsement.timestamp,
    });
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Get unique key for (from, to, domain) tuple
   */
  private getKey(from: string, _to: string, domain?: string): string {
    return `${from}:${domain || '*'}`;
  }
}
