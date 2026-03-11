import { describe, expect, it } from 'vitest';
import {
  createQuickAgentGroupInvite,
  deriveDID,
  generateKeyPair,
  isQuickAgentGroupInviteExpired,
  sign,
  validateQuickAgentGroupInvite,
  verify,
  verifyQuickAgentGroupInvite,
} from '../src/index.js';

describe('quick agent group invites', () => {
  it('creates and verifies a signed invite', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const invite = await createQuickAgentGroupInvite(
      {
        issuedBy: did,
        expiresAt: Date.now() + 60_000,
        metadata: { name: 'gpu-hackathon-room', purpose: 'temporary coordination' },
      },
      (data) => sign(data, keyPair.privateKey),
    );

    expect(invite.groupId).toMatch(/^grp_/);
    expect(invite.discoveryScope).toBe('group-only');
    expect(validateQuickAgentGroupInvite(invite)).toBe(true);
    await expect(
      verifyQuickAgentGroupInvite(invite, (signature, data) => verify(signature, data, keyPair.publicKey)),
    ).resolves.toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const invite = await createQuickAgentGroupInvite(
      {
        issuedBy: did,
        expiresAt: Date.now() + 60_000,
      },
      (data) => sign(data, keyPair.privateKey),
    );

    invite.signature = '00'.repeat(64);

    await expect(
      verifyQuickAgentGroupInvite(invite, (signature, data) => verify(signature, data, keyPair.publicKey)),
    ).resolves.toBe(false);
  });

  it('detects expiration boundaries', () => {
    expect(isQuickAgentGroupInviteExpired({ expiresAt: 1_000 }, 999)).toBe(false);
    expect(isQuickAgentGroupInviteExpired({ expiresAt: 1_000 }, 1_000)).toBe(true);
  });

  it('rejects malformed invite payloads', () => {
    expect(validateQuickAgentGroupInvite({ type: 'GROUP_INVITE', groupId: 'bad id', issuedBy: 'did:agent:x' })).toBe(false);
  });
});
