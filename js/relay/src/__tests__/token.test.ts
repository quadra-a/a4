import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { generateKeyPair } from '@quadra-a/protocol';
import { createInviteToken, TokenError, verifyInviteToken } from '../token.js';

describe('invite token', () => {
  it('creates and verifies a valid token', async () => {
    const keyPair = await generateKeyPair();
    const now = Math.floor(Date.now() / 1000);

    const token = await createInviteToken(
      {
        iss: 'did:agent:operator',
        sub: '*',
        realm: 'alpha',
        exp: now + 3600,
        iat: now,
        jti: randomUUID(),
        maxAgents: 2,
        note: 'test token',
      },
      keyPair.privateKey,
    );

    const payload = await verifyInviteToken(token, keyPair.publicKey);
    expect(payload.realm).toBe('alpha');
    expect(payload.sub).toBe('*');
    expect(payload.maxAgents).toBe(2);
    expect(payload.note).toBe('test token');
  });

  it('rejects a tampered token', async () => {
    const keyPair = await generateKeyPair();
    const now = Math.floor(Date.now() / 1000);

    const token = await createInviteToken(
      {
        iss: 'did:agent:operator',
        sub: '*',
        realm: 'alpha',
        exp: now + 3600,
        iat: now,
        jti: randomUUID(),
      },
      keyPair.privateKey,
    );

    const [header, payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
        realm: 'beta',
      })
    ).toString('base64url');

    await expect(verifyInviteToken(`${header}.${tamperedPayload}.${signature}`, keyPair.publicKey))
      .rejects.toMatchObject({ code: 'INVALID_SIGNATURE' satisfies TokenError['code'] });
  });

  it('rejects an expired token', async () => {
    const keyPair = await generateKeyPair();
    const now = Math.floor(Date.now() / 1000);

    const token = await createInviteToken(
      {
        iss: 'did:agent:operator',
        sub: '*',
        realm: 'alpha',
        exp: now - 1,
        iat: now - 10,
        jti: randomUUID(),
      },
      keyPair.privateKey,
    );

    await expect(verifyInviteToken(token, keyPair.publicKey))
      .rejects.toMatchObject({ code: 'EXPIRED' satisfies TokenError['code'] });
  });
});
