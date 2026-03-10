/**
 * CVP-0015: Revocation list management
 *
 * Persists a list of revoked token JTIs with their expiry times.
 * Entries are automatically pruned once the token's original expiry has passed
 * (no need to keep revoked entries for tokens that would have expired anyway).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export interface RevocationEntry {
  jti: string;
  revokedAt: number;   // Unix seconds
  reason?: string;
  originalExp: number; // Unix seconds — used for GC
}

export class RevocationList {
  private entries = new Map<string, RevocationEntry>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const list: RevocationEntry[] = JSON.parse(data);
      this.entries = new Map(list.map((e) => [e.jti, e]));
      this.gc();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        this.entries = new Map();
      } else {
        throw err;
      }
    }
  }

  async save(): Promise<void> {
    this.gc();
    const list = Array.from(this.entries.values());
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(list, null, 2), 'utf-8');
  }

  async revoke(jti: string, reason: string | undefined, originalExp: number): Promise<void> {
    this.entries.set(jti, {
      jti,
      revokedAt: Math.floor(Date.now() / 1000),
      reason,
      originalExp,
    });
  }

  isRevoked(jti: string): boolean {
    return this.entries.has(jti);
  }

  /** Remove entries whose original token has already expired — they're harmless now */
  private gc(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, entry] of this.entries) {
      if (entry.originalExp < now) {
        this.entries.delete(jti);
      }
    }
  }
}
