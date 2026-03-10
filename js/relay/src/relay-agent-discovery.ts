import { searchDirectoryEntries, type DirectoryAgentEntry } from './registry.js';
import type { RelayAgentRuntime } from './relay-agent-internals.js';
import type { CardMessage, DiscoverMessage, DiscoveredMessage } from './types.js';

export function getRequesterRealm(runtime: RelayAgentRuntime, did: string): string {
  return runtime.registry.get(did)?.realm ?? 'public';
}

export function listDiscoveryDirectoryEntries(runtime: RelayAgentRuntime): DirectoryAgentEntry[] {
  const homeRelay = runtime.relayIdentity.getIdentity().did;
  const localEntries = runtime.registry.listDirectoryEntries().map((entry) => ({
    ...entry,
    homeRelay: entry.homeRelay ?? homeRelay,
  }));
  const remoteEntries = runtime.federationManager?.listRemoteDirectoryEntries() ?? [];
  return [...localEntries, ...remoteEntries];
}

function buildTrustSummaries(
  runtime: RelayAgentRuntime,
  minTrust: number | undefined,
  entries: DirectoryAgentEntry[],
): Map<string, { averageScore: number }> | undefined {
  if (!minTrust || minTrust <= 0) {
    return undefined;
  }

  const trustSummaries = new Map<string, { averageScore: number }>();
  for (const entry of entries) {
    const summary = runtime.endorsements.getTrustSummary(entry.did);
    if (summary) {
      trustSummaries.set(entry.did, { averageScore: summary.averageScore });
    }
  }

  return trustSummaries;
}

export function buildDiscoveryResponse(
  runtime: RelayAgentRuntime,
  requesterDid: string,
  msg: DiscoverMessage,
): DiscoveredMessage & {
  federationInfo: {
    searchedRelays: string[];
    totalRelaysInFederation: number;
    crossRelayResults: boolean;
  };
} {
  const realm = getRequesterRealm(runtime, requesterDid);
  const query = msg.query || '';
  const capability = msg.capability || '';
  const entries = listDiscoveryDirectoryEntries(runtime);
  const trustSummaries = buildTrustSummaries(runtime, msg.minTrust, entries);
  const { agents, cursor, total } = searchDirectoryEntries(
    entries,
    query,
    msg.minTrust,
    msg.limit,
    msg.cursor,
    realm,
    trustSummaries,
    capability,
  );

  const homeRelay = runtime.relayIdentity.getIdentity().did;
  const federationStatus = runtime.federationManager?.getFederationStatus();
  const discoveredAgents = agents.map((agent) => ({
    ...agent,
    trust: runtime.endorsements.getTrustSummary(agent.did),
    homeRelay: agent.homeRelay ?? homeRelay,
  }));

  return {
    type: 'DISCOVERED',
    agents: discoveredAgents,
    cursor,
    total,
    federationInfo: {
      searchedRelays: [...new Set([homeRelay, ...(federationStatus?.connectedRelays ?? [])])],
      totalRelaysInFederation: (federationStatus?.relayCount ?? 0) + 1,
      crossRelayResults: discoveredAgents.some((agent) => agent.homeRelay && agent.homeRelay !== homeRelay),
    },
  };
}

export function resolveVisibleAgentCard(
  runtime: RelayAgentRuntime,
  requesterDid: string,
  targetDid: string,
): CardMessage['card'] {
  const identity = runtime.relayIdentity.getIdentity();
  if (targetDid === identity.did) {
    return identity.agentCard;
  }

  const requesterRealm = getRequesterRealm(runtime, requesterDid);
  const localAgent = runtime.registry.get(targetDid);
  if (localAgent) {
    return localAgent.realm === requesterRealm ? localAgent.card : null;
  }

  return runtime.federationManager?.getRemoteAgentCard(targetDid, requesterRealm) ?? null;
}
