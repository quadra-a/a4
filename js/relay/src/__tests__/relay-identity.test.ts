import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPublicKey, verify, verifyAgentCard } from '@quadra-a/protocol';
import { RelayIdentity } from '../relay-identity.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-identity-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('RelayIdentity', () => {
  it('generates an agent card with a valid signature', async () => {
    const storagePath = await makeTempDir();
    const identity = new RelayIdentity(storagePath);
    const created = await identity.initialize('relay-a', ['ws://localhost:8080']);
    const publicKey = extractPublicKey(created.did);

    const ok = await verifyAgentCard(created.agentCard, (signature, data) => verify(signature, data, publicKey));
    expect(ok).toBe(true);
  });

  it('refreshes published endpoints for an existing identity', async () => {
    const storagePath = await makeTempDir();
    const identity = new RelayIdentity(storagePath);

    const initial = await identity.initialize('relay-a', ['ws://localhost:8080']);
    const refreshed = await identity.initialize('relay-a', ['wss://relay.example.com']);

    expect(refreshed.did).toBe(initial.did);
    expect(refreshed.agentCard.endpoints).toEqual(['wss://relay.example.com']);
    expect(refreshed.agentCard.name).toBe('quadra-a Relay (relay-a)');
  });

  it('migrates a persisted legacy DID to the derived did:agent value', async () => {
    const storagePath = await makeTempDir();
    const identity = new RelayIdentity(storagePath);
    const created = await identity.initialize('relay-a', ['ws://localhost:8080']);

    const identityPath = join(storagePath, 'relay-identity.json');
    const persisted = JSON.parse(await readFile(identityPath, 'utf8'));
    const legacyDid = created.did.replace('did:agent:', 'did:clawiverse:');

    persisted.did = legacyDid;
    persisted.agentCard = {
      ...persisted.agentCard,
      did: legacyDid,
    };

    await writeFile(identityPath, JSON.stringify(persisted, null, 2), 'utf8');

    const reloaded = new RelayIdentity(storagePath);
    const migrated = await reloaded.initialize('relay-a', ['ws://localhost:8080']);
    const publicKey = extractPublicKey(created.did);

    expect(migrated.did).toBe(created.did);
    expect(migrated.agentCard.did).toBe(created.did);

    const ok = await verifyAgentCard(migrated.agentCard, (signature, data) => verify(signature, data, publicKey));
    expect(ok).toBe(true);
  });
});
