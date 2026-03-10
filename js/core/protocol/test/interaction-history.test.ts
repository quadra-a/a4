import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveDID } from '../src/identity/did.js';
import { generateKeyPair } from '../src/identity/keys.js';
import { InteractionHistory } from '../src/trust/interaction-history.js';

async function createDid(): Promise<string> {
  const keyPair = await generateKeyPair();
  return deriveDID(keyPair.publicKey);
}

describe('InteractionHistory', () => {
  let tempDir: string;
  let history: InteractionHistory;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'quadra-a-interaction-history-'));
    history = new InteractionHistory(join(tempDir, 'history-db'));
    await history.open();
  });

  afterEach(async () => {
    await history.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns complete DIDs when enumerating known agents', async () => {
    const aliceDid = await createDid();
    const bobDid = await createDid();

    await history.record({
      agentDid: aliceDid,
      timestamp: Date.now(),
      type: 'message',
      success: true,
      responseTime: 100,
    });
    await history.record({
      agentDid: bobDid,
      timestamp: Date.now() + 1,
      type: 'query',
      success: true,
      responseTime: 120,
    });

    const agents = await history.getAllAgents();

    expect(agents.sort()).toEqual([aliceDid, bobDid].sort());
  });
});
