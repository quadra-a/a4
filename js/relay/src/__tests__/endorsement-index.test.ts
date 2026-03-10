import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EndorsementIndex } from '../endorsement-index.js';

function createEndorsement(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    from: 'did:agent:endorser',
    to: 'did:agent:target',
    score: 0.8,
    domain: 'security',
    reason: 'trusted collaborator',
    timestamp: 1_700_000_000_000,
    expires: 1_800_000_000_000,
    signature: 'deadbeef',
    ...overrides,
  };
}

describe('EndorsementIndex persistence', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'endorsement-index-test-'));
    storePath = join(tempDir, 'endorsements.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists endorsements across instances', async () => {
    const index1 = new EndorsementIndex(storePath);
    await index1.load();
    index1.store(createEndorsement() as any);
    await index1.save();

    const index2 = new EndorsementIndex(storePath);
    await index2.load();

    const result = index2.query('did:agent:target');
    expect(result.total).toBe(1);
    expect(result.endorsements[0]?.from).toBe('did:agent:endorser');
    expect(index2.size()).toBe(1);
  });

  it('replaces duplicate from/to/domain endorsements after reload', async () => {
    const index1 = new EndorsementIndex(storePath);
    await index1.load();
    index1.store(createEndorsement({ score: 0.4 }) as any);
    index1.store(createEndorsement({ score: 0.9, reason: 'updated trust' }) as any);
    await index1.save();

    const index2 = new EndorsementIndex(storePath);
    await index2.load();

    const result = index2.query('did:agent:target', 'security');
    expect(result.total).toBe(1);
    expect(result.endorsements[0]?.score).toBe(0.9);
    expect(result.endorsements[0]?.reason).toBe('updated trust');
  });
});
