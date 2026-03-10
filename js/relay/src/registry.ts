/**
 * CVP-0011 / CVP-0018: In-memory agent registry for relay server
 *
 * CVP-0018 v2 changes:
 * - Capability prefix index replaces tokenizer + inverted index
 *   "translate/japanese/technical" is indexed at "translate", "translate/japanese",
 *   and "translate/japanese/technical" — DISCOVER { capability: "translate" } hits all three.
 * - Unicode tokenizer kept for free-text name/description fallback search
 * - markOffline() / cleanup() for 3-minute grace period
 * - search() returns { agents, cursor?, total } with keyset pagination
 * - discoverable=false by default; set to true only after PUBLISH_CARD (CVP-0018)
 * - realm field for CVP-0015 isolation
 */

import type { AgentCard, DiscoveredAgent } from './types.js';
import type { WebSocket } from 'ws';

export interface RegisteredAgent {
  did: string;
  card: AgentCard;
  cardHash: string;
  capabilityKeys: string[];
  connectedAt: number;
  lastSeen: number;
  online: boolean;
  discoverable: boolean;  // CVP-0018: true only after PUBLISH_CARD
  realm: string;          // CVP-0015: realm this agent belongs to
  tokenJti?: string;      // CVP-0015: invite token JTI used for admission
  tokenExp?: number;      // CVP-0015: invite token expiry in unix ms
  ws: WebSocket;
}

export interface DirectoryAgentEntry {
  did: string;
  card: AgentCard;
  online: boolean;
  discoverable: boolean;
  visibilityRealm?: string;
  lastSeen?: number;
  homeRelay?: string;
}
function matchesCapabilityPrefix(card: AgentCard, query: string): boolean {
  const normalized = query.toLowerCase();
  return extractCapabilityIds(card).some((capId) => {
    const candidate = capId.toLowerCase();
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function entryTokenScore(entry: DirectoryAgentEntry, queryTokens: string[]): number {
  const tokens = new Set(extractTokenKeys(entry.card));
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

export function searchDirectoryEntries(
  entries: DirectoryAgentEntry[],
  query: string,
  minTrust?: number,
  limit = 10,
  cursor?: string,
  requesterRealm = 'public',
  trustSummaries?: Map<string, { averageScore: number }>,
  capability?: string,
): { agents: DiscoveredAgent[]; cursor?: string; total: number } {
  const effectiveLimit = Math.min(limit, 100);
  const trimmed = query.trim();
  const uniqueEntries: DirectoryAgentEntry[] = [];
  const seenDids = new Set<string>();

  for (const entry of entries) {
    if (seenDids.has(entry.did)) {
      continue;
    }
    seenDids.add(entry.did);
    uniqueEntries.push(entry);
  }

  const visibleEntries = uniqueEntries.filter((entry) => {
    if (!entry.online || !entry.discoverable) {
      return false;
    }
    if (entry.visibilityRealm && entry.visibilityRealm !== requesterRealm) {
      return false;
    }
    return true;
  });

  let orderedEntries: DirectoryAgentEntry[];
  const trimmedCapability = capability?.trim().toLowerCase() ?? '';

  if (trimmedCapability) {
    orderedEntries = visibleEntries.filter((entry) => matchesCapabilityPrefix(entry.card, trimmedCapability));
  } else if (!trimmed) {
    orderedEntries = visibleEntries;
  } else {
    const queryTokens = tokenize(trimmed);
    orderedEntries = visibleEntries
      .map((entry) => ({ entry, score: entryTokenScore(entry, queryTokens) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.entry.did.localeCompare(right.entry.did))
      .map(({ entry }) => entry);
  }

  let filteredEntries = orderedEntries;
  if (minTrust !== undefined && minTrust > 0 && trustSummaries) {
    filteredEntries = orderedEntries.filter((entry) => {
      const summary = trustSummaries.get(entry.did);
      return summary ? summary.averageScore >= minTrust : false;
    });
  }

  const filteredTotal = filteredEntries.length;

  let startIdx = 0;
  if (cursor) {
    const cursorDid = Buffer.from(cursor, 'base64').toString('utf8');
    const idx = filteredEntries.findIndex((entry) => entry.did === cursorDid);
    if (idx !== -1) {
      startIdx = idx + 1;
    }
  }

  const page = filteredEntries.slice(startIdx, startIdx + effectiveLimit);
  const nextCursor = startIdx + effectiveLimit < filteredTotal
    ? Buffer.from(page[page.length - 1].did).toString('base64')
    : undefined;

  return {
    agents: page.map((entry) => ({
      did: entry.did,
      card: entry.card,
      online: entry.online,
      lastSeen: entry.lastSeen,
      homeRelay: entry.homeRelay,
    })),
    cursor: nextCursor,
    total: filteredTotal,
  };
}

/**
 * Unicode-aware tokenizer for free-text name/description fallback.
 * - Splits on whitespace and ASCII punctuation
 * - Preserves CJK characters as individual tokens
 * - Lowercases ASCII
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const chunks = text.split(/[\s,.\-_!?;:'"()[\]{}]+/).filter(Boolean);

  for (const chunk of chunks) {
    if (/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(chunk)) {
      let current = '';
      for (const ch of chunk) {
        if (/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(ch)) {
          if (current) { tokens.push(current.toLowerCase()); current = ''; }
          tokens.push(ch);
        } else {
          current += ch;
        }
      }
      if (current) tokens.push(current.toLowerCase());
    } else {
      const lower = chunk.toLowerCase();
      if (lower.length > 1) tokens.push(lower);
    }
  }

  return tokens.filter(t => t.length > 0);
}

function hashCard(card: AgentCard): string {
  return Buffer.from(JSON.stringify({
    did: card.did,
    name: card.name,
    capabilities: card.capabilities,
    timestamp: card.timestamp,
  })).toString('base64').slice(0, 16);
}

/**
 * CVP-0018 §3.1: Hierarchical capability prefix index.
 *
 * "translate/japanese/technical" is indexed at:
 *   "translate", "translate/japanese", "translate/japanese/technical"
 *
 * DISCOVER { capability: "translate" } matches all three.
 * DISCOVER { capability: "translate/korean" } matches nothing.
 */
class CapabilityPrefixIndex {
  // capabilityId (or prefix) → Set<did>
  private capToDids = new Map<string, Set<string>>();

  add(did: string, capId: string): void {
    const segments = capId.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      let set = this.capToDids.get(prefix);
      if (!set) { set = new Set(); this.capToDids.set(prefix, set); }
      set.add(did);
    }
  }

  remove(did: string, capId: string): void {
    const segments = capId.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      this.capToDids.get(prefix)?.delete(did);
    }
  }

  /** Returns DIDs that have the given capability prefix (or exact ID). */
  lookup(capabilityId: string): Set<string> {
    return this.capToDids.get(capabilityId) ?? new Set();
  }

  /** Returns all indexed DIDs (for bulk export / Discovery Agent sync). */
  all(): Set<string> {
    const result = new Set<string>();
    for (const set of this.capToDids.values()) {
      for (const did of set) result.add(did);
    }
    return result;
  }
}

/**
 * Extract all capability IDs from an agent card.
 * Used for both the prefix index and the token fallback index.
 */
function extractCapabilityIds(card: AgentCard): string[] {
  return card.capabilities.map(c => c.id).filter(Boolean);
}

/**
 * Extract token keys for free-text fallback search (name + description).
 */
function extractTokenKeys(card: AgentCard): string[] {
  const keys = new Set<string>();
  for (const token of tokenize(card.name)) keys.add(token);
  for (const token of tokenize(card.description)) keys.add(token);
  for (const cap of card.capabilities) {
    for (const token of tokenize(cap.name)) keys.add(token);
    for (const token of tokenize(cap.description)) keys.add(token);
  }
  return [...keys];
}

const GRACE_PERIOD_MS = 3 * 60 * 1000; // 3 minutes

export class AgentRegistry {
  private agents = new Map<string, RegisteredAgent>();
  // CVP-0018 §3.1: Hierarchical capability prefix index
  private capPrefixIndex = new CapabilityPrefixIndex();
  // Fallback: token inverted index for name/description free-text search
  private tokenIndex = new Map<string, Set<string>>();

  register(
    did: string,
    card: AgentCard,
    ws: WebSocket,
    realm = 'public',
    token?: { jti?: string; exp?: number }
  ): void {
    const existing = this.agents.get(did);
    if (existing) {
      if (existing.discoverable) {
        this.removeFromIndexes(did, existing);
      }
      if (existing.ws !== ws && existing.ws.readyState <= 1) {
        existing.ws.close(4001, 'Replaced by new connection');
      }
    }

    const agent: RegisteredAgent = {
      did,
      card,
      cardHash: hashCard(card),
      capabilityKeys: extractTokenKeys(card),
      connectedAt: existing?.connectedAt ?? Date.now(),
      lastSeen: Date.now(),
      online: true,
      discoverable: false,  // CVP-0018: not discoverable until PUBLISH_CARD
      realm,
      tokenJti: token?.jti,
      tokenExp: token?.exp,
      ws,
    };

    this.agents.set(did, agent);
    // Don't add to index yet — wait for PUBLISH_CARD
  }

  /**
   * CVP-0018: Publish agent to discovery index.
   * Called when agent sends PUBLISH_CARD.
   */
  publish(did: string, card?: AgentCard): boolean {
    const agent = this.agents.get(did);
    if (!agent) return false;

    if (card) {
      if (agent.discoverable) {
        this.removeFromIndexes(did, agent);
      }
      agent.card = card;
      agent.cardHash = hashCard(card);
      agent.capabilityKeys = extractTokenKeys(card);
    }

    if (!agent.discoverable) {
      agent.discoverable = true;
      this.addToIndexes(did, agent);
    }
    return true;
  }

  /**
   * CVP-0018: Remove agent from discovery index.
   * Called when agent sends UNPUBLISH_CARD or disconnects.
   */
  unpublish(did: string): void {
    const agent = this.agents.get(did);
    if (agent && agent.discoverable) {
      agent.discoverable = false;
      this.removeFromIndexes(did, agent);
    }
  }

  unregister(did: string): void {
    const agent = this.agents.get(did);
    if (agent) {
      if (agent.discoverable) this.removeFromIndexes(did, agent);
      this.agents.delete(did);
    }
  }

  markOffline(did: string): void {
    const agent = this.agents.get(did);
    if (agent) {
      agent.online = false;
      agent.lastSeen = Date.now();
    }
  }

  cleanup(): void {
    const cutoff = Date.now() - GRACE_PERIOD_MS;
    for (const [did, agent] of this.agents) {
      if (!agent.online && agent.lastSeen < cutoff) {
        this.unregister(did);
      }
    }
  }

  get(did: string): RegisteredAgent | undefined {
    return this.agents.get(did);
  }

  isOnline(did: string): boolean {
    return this.agents.get(did)?.online ?? false;
  }

  updateLastSeen(did: string): void {
    const agent = this.agents.get(did);
    if (agent) agent.lastSeen = Date.now();
  }

  getOnlineCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.online) count++;
    }
    return count;
  }

  getOnlineCountByRealm(realm: string): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.online && agent.realm === realm) count++;
    }
    return count;
  }

  countOnlineByTokenJti(tokenJti: string, excludeDid?: string): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (!agent.online) continue;
      if (excludeDid && agent.did === excludeDid) continue;
      if (agent.tokenJti === tokenJti) count++;
    }
    return count;
  }

  listAgents(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  listDirectoryEntries(): DirectoryAgentEntry[] {
    return Array.from(this.agents.values()).map((agent) => ({
      did: agent.did,
      card: agent.card,
      online: agent.online,
      discoverable: agent.discoverable,
      visibilityRealm: agent.realm,
      lastSeen: agent.lastSeen,
    }));
  }

  /**
   * Search agents by free-text query.
   *
   * Empty query returns all online+discoverable agents in the specified realm.
   */
  search(
    query: string,
    minTrust?: number,
    limit = 10,
    cursor?: string,
    realm = 'public',
    trustSummaries?: Map<string, { averageScore: number }>
  ): { agents: DiscoveredAgent[]; cursor?: string; total: number } {
    return searchDirectoryEntries(
      this.listDirectoryEntries(),
      query,
      minTrust,
      limit,
      cursor,
      realm,
      trustSummaries,
    );
  }

  /**
   * Search agents by capability prefix.
   */
  searchByCapability(
    capability: string,
    minTrust?: number,
    limit = 10,
    cursor?: string,
    realm = 'public',
    trustSummaries?: Map<string, { averageScore: number }>
  ): { agents: DiscoveredAgent[]; cursor?: string; total: number } {
    return searchDirectoryEntries(
      this.listDirectoryEntries(),
      '',
      minTrust,
      limit,
      cursor,
      realm,
      trustSummaries,
      capability,
    );
  }

  private addToIndexes(did: string, agent: RegisteredAgent): void {
    // Capability prefix index
    for (const capId of extractCapabilityIds(agent.card)) {
      this.capPrefixIndex.add(did, capId.toLowerCase());
    }
    // Token fallback index
    for (const key of agent.capabilityKeys) {
      let set = this.tokenIndex.get(key);
      if (!set) { set = new Set(); this.tokenIndex.set(key, set); }
      set.add(did);
    }
  }

  private removeFromIndexes(did: string, agent: RegisteredAgent): void {
    // Capability prefix index
    for (const capId of extractCapabilityIds(agent.card)) {
      this.capPrefixIndex.remove(did, capId.toLowerCase());
    }
    // Token fallback index
    for (const key of agent.capabilityKeys) {
      this.tokenIndex.get(key)?.delete(did);
    }
  }
}
