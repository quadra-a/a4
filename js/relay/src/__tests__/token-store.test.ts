/**
 * CVP-0015: Token store tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenStore } from '../token-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TokenStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'token-store-test-'));
    storePath = join(tempDir, 'tokens.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load empty store when file does not exist', async () => {
    const store = new TokenStore(storePath);
    await store.load();
    const tokens = await store.list();
    expect(tokens).toHaveLength(0);
  });

  it('should save and retrieve a token', async () => {
    const store = new TokenStore(storePath);
    await store.load();

    const meta = {
      jti: 'test-jti-1',
      realm: 'test-realm',
      sub: 'did:agent:agent1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      createdBy: 'did:agent:operator',
      token: 'hw1_invite.v4.public.test',
    };

    await store.save(meta);
    const retrieved = await store.get('test-jti-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.jti).toBe('test-jti-1');
    expect(retrieved!.realm).toBe('test-realm');
    expect(retrieved!.sub).toBe('did:agent:agent1');
  });

  it('should persist tokens across instances', async () => {
    const store1 = new TokenStore(storePath);
    await store1.load();
    await store1.save({
      jti: 'persist-jti',
      realm: 'persist-realm',
      sub: '*',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      createdBy: 'did:agent:operator',
      token: 'hw1_invite.v4.public.test',
    });

    const store2 = new TokenStore(storePath);
    await store2.load();
    const tokens = await store2.list();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].jti).toBe('persist-jti');
  });

  it('should list tokens filtered by realm', async () => {
    const store = new TokenStore(storePath);
    await store.load();

    await store.save({ jti: 'jti-1', realm: 'realm-a', sub: '*', exp: 9999999999, iat: 0, createdBy: 'op', token: 't1' });
    await store.save({ jti: 'jti-2', realm: 'realm-b', sub: '*', exp: 9999999999, iat: 0, createdBy: 'op', token: 't2' });
    await store.save({ jti: 'jti-3', realm: 'realm-a', sub: '*', exp: 9999999999, iat: 0, createdBy: 'op', token: 't3' });

    const realmA = await store.list('realm-a');
    expect(realmA).toHaveLength(2);
    expect(realmA.every(t => t.realm === 'realm-a')).toBe(true);

    const all = await store.list();
    expect(all).toHaveLength(3);
  });

  it('should delete a token', async () => {
    const store = new TokenStore(storePath);
    await store.load();

    await store.save({ jti: 'delete-me', realm: 'r', sub: '*', exp: 9999999999, iat: 0, createdBy: 'op', token: 't' });
    expect(await store.get('delete-me')).not.toBeNull();

    await store.delete('delete-me');
    expect(await store.get('delete-me')).toBeNull();

    const tokens = await store.list();
    expect(tokens).toHaveLength(0);
  });

  it('should return null for non-existent JTI', async () => {
    const store = new TokenStore(storePath);
    await store.load();
    expect(await store.get('nonexistent')).toBeNull();
  });
});
