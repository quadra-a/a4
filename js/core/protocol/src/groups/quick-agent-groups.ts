import type { AgentCard, Capability } from '../discovery/agent-card-types.js';
import type { MessageEnvelope } from '../messaging/envelope.js';
import type { RelayIndexOperations } from '../discovery/relay-index.js';
import type { RelayClient } from '../transport/relay-client.js';
import type { MessageRouter } from '../messaging/router.js';
import { createMessageRouter } from '../messaging/router.js';
import {
  createQuickAgentGroupInvite,
  isQuickAgentGroupInviteExpired,
  verifyQuickAgentGroupInvite,
  validateQuickAgentGroupInvite,
  type CreateQuickAgentGroupInviteInput,
  type QuickAgentGroupInvite,
} from './group-invite.js';

export const QUICK_AGENT_GROUP_CAPABILITY_PREFIX = 'overlay/group';

export interface QuickAgentGroupMembership {
  groupId: string;
  invite: QuickAgentGroupInvite;
  joinedAt: number;
}

export interface QuickAgentGroupManager {
  createInvite(
    input: CreateQuickAgentGroupInviteInput,
    signFn: (data: Uint8Array) => Promise<Uint8Array>,
  ): Promise<QuickAgentGroupInvite>;
  joinGroup(
    invite: QuickAgentGroupInvite,
    verifyFn?: (signature: Uint8Array, data: Uint8Array) => Promise<boolean>,
  ): Promise<QuickAgentGroupMembership>;
  leaveGroup(groupId: string): boolean;
  hasGroup(groupId: string): boolean;
  listGroups(): QuickAgentGroupMembership[];
  purgeExpiredGroups(): string[];
  augmentCard<T extends { capabilities: Capability[]; metadata?: Record<string, unknown> }>(card: T): T;
  acceptsEnvelope(envelope: Pick<MessageEnvelope, 'groupId'>): boolean;
  decorateEnvelope<T extends { groupId?: string }>(envelope: T, groupId: string): T & { groupId: string };
  buildDiscoveryCapability(groupId: string): string;
  filterCardsForGroup<T extends { capabilities: Capability[]; metadata?: Record<string, unknown> }>(
    cards: T[],
    groupId: string,
  ): T[];
}

export function buildQuickAgentGroupCapabilityId(groupId: string): string {
  return `${QUICK_AGENT_GROUP_CAPABILITY_PREFIX}/${groupId}`;
}

export function buildQuickAgentGroupCapability(groupId: string): Capability {
  return {
    id: buildQuickAgentGroupCapabilityId(groupId),
    name: `Quick Agent Group ${groupId}`,
    description: `Overlay membership marker for quick agent group ${groupId}`,
    metadata: {
      overlay: 'quick-agent-group',
      groupId,
    },
  };
}

function readGroupMetadata(metadata: Record<string, unknown> | undefined): string[] {
  const quickAgentGroups = metadata?.quickAgentGroups;
  if (!Array.isArray(quickAgentGroups)) {
    return [];
  }

  return quickAgentGroups.filter((value): value is string => typeof value === 'string');
}

export function extractQuickAgentGroupIds(
  card: Pick<AgentCard, 'capabilities' | 'metadata'>,
): string[] {
  const groups = new Set<string>();

  for (const capability of card.capabilities ?? []) {
    const capabilityId = capability?.id;
    if (typeof capabilityId === 'string' && capabilityId.startsWith(`${QUICK_AGENT_GROUP_CAPABILITY_PREFIX}/`)) {
      groups.add(capabilityId.slice(QUICK_AGENT_GROUP_CAPABILITY_PREFIX.length + 1));
    }
  }

  for (const groupId of readGroupMetadata(card.metadata)) {
    groups.add(groupId);
  }

  return [...groups].sort();
}

export function cardSupportsQuickAgentGroup(
  card: Pick<AgentCard, 'capabilities' | 'metadata'>,
  groupId: string,
): boolean {
  return extractQuickAgentGroupIds(card).includes(groupId);
}

export function augmentCardWithQuickAgentGroups<T extends { capabilities: Capability[]; metadata?: Record<string, unknown> }>(
  card: T,
  groupIds: Iterable<string>,
): T {
  const normalizedGroupIds = [...new Set([...groupIds].filter((groupId): groupId is string => typeof groupId === 'string' && groupId.length > 0))].sort();
  const nonGroupCapabilities = (card.capabilities ?? []).filter((capability) => !capability.id.startsWith(`${QUICK_AGENT_GROUP_CAPABILITY_PREFIX}/`));

  return {
    ...card,
    capabilities: [
      ...nonGroupCapabilities,
      ...normalizedGroupIds.map((groupId) => buildQuickAgentGroupCapability(groupId)),
    ],
    metadata: {
      ...(card.metadata ?? {}),
      quickAgentGroups: normalizedGroupIds,
    },
  };
}

interface QuickAgentGroupManagerOptions {
  now?: () => number;
}

export function createQuickAgentGroupManager(
  options: QuickAgentGroupManagerOptions = {},
): QuickAgentGroupManager {
  const now = options.now ?? (() => Date.now());
  const groups = new Map<string, QuickAgentGroupMembership>();

  function purgeExpiredGroups(): string[] {
    const removed: string[] = [];
    const currentTime = now();
    for (const [groupId, membership] of groups.entries()) {
      if (isQuickAgentGroupInviteExpired(membership.invite, currentTime)) {
        groups.delete(groupId);
        removed.push(groupId);
      }
    }
    return removed;
  }

  function ensureActiveMembership(groupId: string): QuickAgentGroupMembership {
    purgeExpiredGroups();
    const membership = groups.get(groupId);
    if (!membership) {
      throw new Error(`Not a member of quick agent group: ${groupId}`);
    }
    return membership;
  }

  return {
    createInvite(input, signFn) {
      return createQuickAgentGroupInvite(input, signFn);
    },

    async joinGroup(invite, verifyFn) {
      if (!validateQuickAgentGroupInvite(invite)) {
        throw new Error('Invalid quick agent group invite');
      }

      if (verifyFn) {
        const valid = await verifyQuickAgentGroupInvite(invite, verifyFn);
        if (!valid) {
          throw new Error('Quick agent group invite signature verification failed');
        }
      }

      if (isQuickAgentGroupInviteExpired(invite, now())) {
        throw new Error(`Quick agent group invite expired: ${invite.groupId}`);
      }

      const existing = groups.get(invite.groupId);
      if (existing) {
        return existing;
      }

      const membership: QuickAgentGroupMembership = {
        groupId: invite.groupId,
        invite,
        joinedAt: now(),
      };
      groups.set(invite.groupId, membership);
      return membership;
    },

    leaveGroup(groupId) {
      return groups.delete(groupId);
    },

    hasGroup(groupId) {
      purgeExpiredGroups();
      return groups.has(groupId);
    },

    listGroups() {
      purgeExpiredGroups();
      return [...groups.values()].sort((left, right) => left.joinedAt - right.joinedAt);
    },

    purgeExpiredGroups,

    augmentCard(card) {
      purgeExpiredGroups();
      return augmentCardWithQuickAgentGroups(card, groups.keys());
    },

    acceptsEnvelope(envelope) {
      purgeExpiredGroups();
      if (!envelope.groupId) {
        return true;
      }
      return groups.has(envelope.groupId);
    },

    decorateEnvelope(envelope, groupId) {
      ensureActiveMembership(groupId);
      return {
        ...envelope,
        groupId,
      };
    },

    buildDiscoveryCapability(groupId) {
      ensureActiveMembership(groupId);
      return buildQuickAgentGroupCapabilityId(groupId);
    },

    filterCardsForGroup(cards, groupId) {
      ensureActiveMembership(groupId);
      return cards.filter((card) => cardSupportsQuickAgentGroup(card, groupId));
    },
  };
}

export async function discoverQuickAgentGroupMembers(
  relayIndex: Pick<RelayIndexOperations, 'searchSemantic'>,
  manager: Pick<QuickAgentGroupManager, 'buildDiscoveryCapability' | 'filterCardsForGroup'>,
  groupId: string,
  limit = 20,
): Promise<AgentCard[]> {
  const cards = await relayIndex.searchSemantic({
    capability: manager.buildDiscoveryCapability(groupId),
    limit,
  });
  return manager.filterCardsForGroup(cards, groupId);
}

export function createQuickAgentGroupMessageRouter(
  relayClient: RelayClient,
  verifyFn: (signature: Uint8Array, data: Uint8Array) => Promise<boolean>,
  manager: Pick<QuickAgentGroupManager, 'acceptsEnvelope'>,
): MessageRouter {
  return createMessageRouter(relayClient, verifyFn, {
    acceptEnvelope: (envelope) => manager.acceptsEnvelope(envelope),
  });
}
