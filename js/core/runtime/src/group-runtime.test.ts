import { describe, expect, it } from 'vitest';
import { createAgentCard, deriveDID, generateKeyPair, sign, verify } from '@quadra-a/protocol';
import {
  augmentCardWithQuickAgentGroups,
  createQuickAgentGroupManager,
  discoverQuickAgentGroupMembers,
} from './group-runtime.js';

describe('quick agent group manager', () => {
  it('joins a signed invite and keeps duplicate imports idempotent', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const manager = createQuickAgentGroupManager();
    const invite = await manager.createInvite(
      {
        issuedBy: did,
        expiresAt: Date.now() + 60_000,
      },
      (data) => sign(data, keyPair.privateKey),
    );

    const first = await manager.joinGroup(invite, (signature, data) => verify(signature, data, keyPair.publicKey));
    const second = await manager.joinGroup(invite, (signature, data) => verify(signature, data, keyPair.publicKey));

    expect(first).toBe(second);
    expect(manager.listGroups()).toHaveLength(1);
    expect(manager.hasGroup(invite.groupId)).toBe(true);
  });

  it('purges expired groups and rejects expired invites', async () => {
    let now = 1_000;
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const manager = createQuickAgentGroupManager({ now: () => now });
    const invite = await manager.createInvite(
      {
        issuedBy: did,
        createdAt: 1_000,
        expiresAt: 1_500,
      },
      (data) => sign(data, keyPair.privateKey),
    );

    await manager.joinGroup(invite, (signature, data) => verify(signature, data, keyPair.publicKey));
    now = 2_000;

    expect(manager.purgeExpiredGroups()).toEqual([invite.groupId]);
    expect(manager.hasGroup(invite.groupId)).toBe(false);
    await expect(
      manager.joinGroup(invite, (signature, data) => verify(signature, data, keyPair.publicKey)),
    ).rejects.toThrow('expired');
  });

  it('augments cards and filters discovery results to joined groups', async () => {
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);
    const manager = createQuickAgentGroupManager();
    const invite = await manager.createInvite(
      {
        issuedBy: did,
        expiresAt: Date.now() + 60_000,
      },
      (data) => sign(data, keyPair.privateKey),
    );
    await manager.joinGroup(invite, (signature, data) => verify(signature, data, keyPair.publicKey));

    const sameGroupCard = augmentCardWithQuickAgentGroups(
      createAgentCard('did:agent:same', 'Same Group', 'same', [], []),
      [invite.groupId],
    );
    const otherGroupCard = augmentCardWithQuickAgentGroups(
      createAgentCard('did:agent:other', 'Other Group', 'other', [], []),
      ['grp_other'],
    );

    const filtered = manager.filterCardsForGroup([sameGroupCard, otherGroupCard], invite.groupId);
    expect(filtered.map((card) => card.did)).toEqual(['did:agent:same']);

    const relayIndex = {
      searchSemantic: async () => [sameGroupCard, otherGroupCard],
    };
    const discovered = await discoverQuickAgentGroupMembers(relayIndex, manager, invite.groupId);
    expect(discovered.map((card) => card.did)).toEqual(['did:agent:same']);
  });
});
