/**
 * Message Storage - LevelDB operations for message queue
 *
 * Key schema:
 *   msg:inbound:{timestamp}:{id}   → StoredMessage
 *   msg:outbound:{timestamp}:{id}  → StoredMessage
 *   block:{did}                    → BlocklistEntry
 *   allow:{did}                    → AllowlistEntry
 *   seen:{messageId}               → SeenEntry
 *   rate:{did}                     → RateLimitState
 *   idx:from:{did}:{timestamp}:{id} → '1'
 */

import { Level } from 'level';
import { createLogger } from '../utils/logger.js';
import type {
  StoredMessage,
  BlocklistEntry,
  AllowlistEntry,
  SeenEntry,
  RateLimitState,
  MessageFilter,
  PaginationOptions,
  MessagePage,
  E2EDeliveryMetadata,
  E2ERetryMetadata,
} from './types.js';
import { normalizeEnvelope } from './envelope.js';
import { compareMessagesBySortTimestamp, getMessageSortTimestamp } from './timestamp.js';

const logger = createLogger('message-storage');

function buildE2EDeliveryKey(delivery: E2EDeliveryMetadata): string {
  return `${delivery.senderDeviceId}:${delivery.receiverDeviceId}:${delivery.sessionId}`;
}

function mergeE2EDeliveries(
  existing: E2EDeliveryMetadata[] = [],
  incoming: E2EDeliveryMetadata[] = [],
): E2EDeliveryMetadata[] {
  const merged = new Map<string, E2EDeliveryMetadata>();

  for (const delivery of existing) {
    merged.set(buildE2EDeliveryKey(delivery), { ...delivery });
  }

  for (const delivery of incoming) {
    const key = buildE2EDeliveryKey(delivery);
    const previous = merged.get(key);
    merged.set(key, previous ? { ...previous, ...delivery } : { ...delivery });
  }

  return [...merged.values()].sort((left, right) => (
    left.receiverDeviceId.localeCompare(right.receiverDeviceId)
    || left.senderDeviceId.localeCompare(right.senderDeviceId)
    || left.sessionId.localeCompare(right.sessionId)
  ));
}

function mergeStoredMessageE2EDeliveries(
  message: StoredMessage,
  deliveries: E2EDeliveryMetadata[],
): StoredMessage {
  if (deliveries.length === 0) {
    return message;
  }

  return {
    ...message,
    e2e: {
      deliveries: mergeE2EDeliveries(message.e2e?.deliveries ?? [], deliveries),
      retry: message.e2e?.retry,
    },
  };
}

function mergeE2ERetryMetadata(
  existing: E2ERetryMetadata | undefined,
  incoming: E2ERetryMetadata | undefined,
): E2ERetryMetadata | undefined {
  if (!existing) {
    return incoming ? { ...incoming } : undefined;
  }

  if (!incoming) {
    return existing;
  }

  return {
    replayCount: Math.max(existing.replayCount, incoming.replayCount),
    lastRequestedAt: incoming.lastRequestedAt ?? existing.lastRequestedAt,
    lastReplayedAt: incoming.lastReplayedAt ?? existing.lastReplayedAt,
    lastReason: incoming.lastReason ?? existing.lastReason,
  };
}

function mergeStoredMessages(existing: StoredMessage, incoming: StoredMessage): StoredMessage {
  const merged: StoredMessage = {
    ...existing,
    ...incoming,
    envelope: {
      ...existing.envelope,
      ...incoming.envelope,
    },
    status: existing.status,
    receivedAt: existing.receivedAt ?? incoming.receivedAt,
    sentAt: existing.sentAt ?? incoming.sentAt,
    readAt: existing.readAt ?? incoming.readAt,
    trustScore: incoming.trustScore ?? existing.trustScore,
    trustStatus: incoming.trustStatus ?? existing.trustStatus,
    error: incoming.error ?? existing.error,
    e2e: existing.e2e,
  };
  const withDeliveries = mergeStoredMessageE2EDeliveries(merged, incoming.e2e?.deliveries ?? []);
  if (!existing.e2e?.retry && !incoming.e2e?.retry) {
    return withDeliveries;
  }

  return {
    ...withDeliveries,
    e2e: {
      deliveries: withDeliveries.e2e?.deliveries ?? [],
      retry: mergeE2ERetryMetadata(existing.e2e?.retry, incoming.e2e?.retry),
    },
  };
}

export class MessageStorage {
  private db: Level<string, unknown>;
  private ready = false;

  private static compareSessionsByLastMessageAt(
    left: { threadId: string; lastMessageAt: number },
    right: { threadId: string; lastMessageAt: number },
  ): number {
    if (left.lastMessageAt !== right.lastMessageAt) {
      return right.lastMessageAt - left.lastMessageAt;
    }

    return left.threadId.localeCompare(right.threadId);
  }

  constructor(dbPath: string) {
    this.db = new Level<string, unknown>(dbPath, { valueEncoding: 'json' });
  }

  async open(): Promise<void> {
    await this.db.open();
    this.ready = true;
    logger.info('Message storage opened');
  }

  async close(): Promise<void> {
    if (this.ready) {
      await this.db.close();
      this.ready = false;
      logger.info('Message storage closed');
    }
  }

  // ─── Message Operations ───────────────────────────────────────────────────

  async putMessage(msg: StoredMessage): Promise<void> {
    const normalized = this.requireStoredMessage(msg);
    const existing = await this.findStoredMessageRecord(normalized.envelope.id);
    if (existing) {
      await this.db.put(existing.key, mergeStoredMessages(existing.message, normalized));
      return;
    }

    const ts = String(getMessageSortTimestamp(normalized)).padStart(16, '0');
    const key = `msg:${normalized.direction}:${ts}:${normalized.envelope.id}`;
    await this.db.put(key, normalized);

    // Secondary index by sender
    const idxKey = `idx:from:${normalized.envelope.from}:${ts}:${normalized.envelope.id}`;
    await this.db.put(idxKey, '1');

    // CVP-0014: Thread index
    if (normalized.envelope.threadId) {
      const threadIdxKey = `idx:thread:${normalized.envelope.threadId}:${ts}:${normalized.envelope.id}`;
      await this.db.put(threadIdxKey, '1');

      // Update or create session metadata
      await this.updateSessionMeta(normalized);
    }
  }

  async getMessage(id: string, direction?: 'inbound' | 'outbound'): Promise<StoredMessage | null> {
    const match = await this.findStoredMessageRecord(id, direction);
    return match?.message ?? null;
  }

  async updateMessage(id: string, updates: Partial<StoredMessage>): Promise<void> {
    const match = await this.findStoredMessageRecord(id);
    if (!match) return;
    await this.db.put(match.key, { ...match.message, ...updates });
  }

  async upsertE2EDeliveries(id: string, deliveries: E2EDeliveryMetadata[]): Promise<StoredMessage | null> {
    if (deliveries.length === 0) {
      return this.getMessage(id);
    }

    const match = await this.findStoredMessageRecord(id);
    if (!match) return null;

    const merged = mergeStoredMessageE2EDeliveries(match.message, deliveries);
    await this.db.put(match.key, merged);
    return merged;
  }

  async upsertE2ERetry(id: string, retry: E2ERetryMetadata): Promise<StoredMessage | null> {
    const match = await this.findStoredMessageRecord(id, 'outbound');
    if (!match) return null;

    const merged: StoredMessage = {
      ...match.message,
      e2e: {
        deliveries: match.message.e2e?.deliveries ?? [],
        retry: mergeE2ERetryMetadata(match.message.e2e?.retry, retry),
      },
    };
    await this.db.put(match.key, merged);
    return merged;
  }

  async deleteMessage(id: string): Promise<void> {
    const match = await this.findStoredMessageRecord(id);
    if (!match) return;

    const timestampSegment = this.getTimestampSegmentFromStorageKey(match.key);
    const operations: Array<{ type: 'del'; key: string }> = [
      { type: 'del', key: match.key },
      { type: 'del', key: `idx:from:${match.message.envelope.from}:${timestampSegment}:${id}` },
    ];

    if (match.message.envelope.threadId) {
      operations.push({
        type: 'del',
        key: `idx:thread:${match.message.envelope.threadId}:${timestampSegment}:${id}`,
      });
    }

    await this.db.batch(operations);
  }

  async queryMessages(
    direction: 'inbound' | 'outbound',
    filter: MessageFilter = {},
    pagination: PaginationOptions = {}
  ): Promise<MessagePage> {
    const { limit = 50, offset = 0 } = pagination;
    const prefix = `msg:${direction}:`;
    const matches: StoredMessage[] = [];

    for await (const [, value] of this.db.iterator<string, StoredMessage>({
      gte: prefix,
      lte: prefix + '\xff',
      valueEncoding: 'json',
    })) {
      const normalized = this.normalizeStoredMessage(value);
      if (!normalized || !this.matchesFilter(normalized, filter)) continue;
      matches.push(normalized);
    }

    matches.sort((left, right) => compareMessagesBySortTimestamp(right, left));
    const results = matches.slice(offset, offset + limit);
    const total = matches.length;

    return {
      messages: results,
      total,
      hasMore: total > offset + results.length,
    };
  }

  private matchesFilter(msg: StoredMessage, filter: MessageFilter): boolean {
    if (filter.fromDid) {
      const froms = Array.isArray(filter.fromDid) ? filter.fromDid : [filter.fromDid];
      if (!froms.includes(msg.envelope.from)) return false;
    }
    if (filter.toDid) {
      const tos = Array.isArray(filter.toDid) ? filter.toDid : [filter.toDid];
      if (!tos.includes(msg.envelope.to)) return false;
    }
    if (filter.protocol) {
      const protos = Array.isArray(filter.protocol) ? filter.protocol : [filter.protocol];
      if (!protos.includes(msg.envelope.protocol)) return false;
    }
    if (filter.type && msg.envelope.type !== filter.type) return false;
    if (filter.replyTo) {
      const replyIds = Array.isArray(filter.replyTo) ? filter.replyTo : [filter.replyTo];
      if (!msg.envelope.replyTo || !replyIds.includes(msg.envelope.replyTo)) return false;
    }
    if (filter.unreadOnly && msg.readAt != null) return false;
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!statuses.includes(msg.status)) return false;
    }
    if (filter.maxAge) {
      const age = Date.now() - getMessageSortTimestamp(msg);
      if (age > filter.maxAge) return false;
    }
    if (filter.minTrustScore != null && (msg.trustScore ?? 0) < filter.minTrustScore) return false;
    // CVP-0014: Thread filter
    if (filter.threadId && msg.envelope.threadId !== filter.threadId) return false;
    return true;
  }

  async countMessages(direction: 'inbound' | 'outbound', filter: MessageFilter = {}): Promise<number> {
    const prefix = `msg:${direction}:`;
    let count = 0;
    for await (const [, value] of this.db.iterator<string, StoredMessage>({
      gte: prefix,
      lte: prefix + '\xff',
      valueEncoding: 'json',
    })) {
      const normalized = this.normalizeStoredMessage(value);
      if (normalized && this.matchesFilter(normalized, filter)) count++;
    }
    return count;
  }

  private normalizeStoredMessage(msg: StoredMessage): StoredMessage | null {
    const envelope = normalizeEnvelope(msg.envelope);
    if (!envelope) {
      logger.warn('Skipping invalid stored message envelope', { id: msg.envelope?.id });
      return null;
    }

    return {
      ...msg,
      envelope,
    };
  }

  private requireStoredMessage(msg: StoredMessage): StoredMessage {
    const normalized = this.normalizeStoredMessage(msg);
    if (!normalized) {
      throw new Error(`Invalid stored message envelope: ${msg.envelope?.id ?? 'unknown'}`);
    }

    return normalized;
  }

  private async findStoredMessageRecord(
    id: string,
    direction?: 'inbound' | 'outbound',
  ): Promise<{ key: string; message: StoredMessage } | null> {
    const directions = direction ? [direction] : ['inbound', 'outbound'] as const;
    for (const currentDirection of directions) {
      const prefix = `msg:${currentDirection}:`;
      for await (const [key, value] of this.db.iterator<string, StoredMessage>({
        gte: prefix,
        lte: prefix + '\xff',
        valueEncoding: 'json',
      })) {
        if (value.envelope.id !== id) continue;
        const normalized = this.normalizeStoredMessage(value);
        if (normalized) {
          return { key, message: normalized };
        }
      }
    }

    return null;
  }

  private getTimestampSegmentFromStorageKey(key: string): string {
    const parts = key.split(':');
    return parts[2] ?? '0000000000000000';
  }

  // ─── Blocklist ────────────────────────────────────────────────────────────

  async putBlock(entry: BlocklistEntry): Promise<void> {
    await this.db.put(`block:${entry.did}`, entry);
  }

  async getBlock(did: string): Promise<BlocklistEntry | null> {
    try {
      return await this.db.get(`block:${did}`) as BlocklistEntry;
    } catch {
      return null;
    }
  }

  async deleteBlock(did: string): Promise<void> {
    try { await this.db.del(`block:${did}`); } catch { /* not found */ }
  }

  async listBlocked(): Promise<BlocklistEntry[]> {
    const results: BlocklistEntry[] = [];
    for await (const [, value] of this.db.iterator<string, BlocklistEntry>({
      gte: 'block:',
      lte: 'block:\xff',
      valueEncoding: 'json',
    })) {
      results.push(value);
    }
    return results;
  }

  // ─── Allowlist ────────────────────────────────────────────────────────────

  async putAllow(entry: AllowlistEntry): Promise<void> {
    await this.db.put(`allow:${entry.did}`, entry);
  }

  async getAllow(did: string): Promise<AllowlistEntry | null> {
    try {
      return await this.db.get(`allow:${did}`) as AllowlistEntry;
    } catch {
      return null;
    }
  }

  async deleteAllow(did: string): Promise<void> {
    try { await this.db.del(`allow:${did}`); } catch { /* not found */ }
  }

  async listAllowed(): Promise<AllowlistEntry[]> {
    const results: AllowlistEntry[] = [];
    for await (const [, value] of this.db.iterator<string, AllowlistEntry>({
      gte: 'allow:',
      lte: 'allow:\xff',
      valueEncoding: 'json',
    })) {
      results.push(value);
    }
    return results;
  }

  // ─── Seen Cache ───────────────────────────────────────────────────────────

  async putSeen(entry: SeenEntry): Promise<void> {
    await this.db.put(`seen:${entry.messageId}`, entry);
  }

  async getSeen(messageId: string): Promise<SeenEntry | null> {
    try {
      return await this.db.get(`seen:${messageId}`) as SeenEntry;
    } catch {
      return null;
    }
  }

  async cleanupSeen(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const toDelete: string[] = [];
    for await (const [key, value] of this.db.iterator<string, SeenEntry>({
      gte: 'seen:',
      lte: 'seen:\xff',
      valueEncoding: 'json',
    })) {
      if (value.seenAt < cutoff) toDelete.push(key);
    }
    await this.db.batch(toDelete.map((key) => ({ type: 'del' as const, key })));
  }

  // ─── Rate Limit State ─────────────────────────────────────────────────────

  async putRateLimit(state: RateLimitState): Promise<void> {
    await this.db.put(`rate:${state.did}`, state);
  }

  async getRateLimit(did: string): Promise<RateLimitState | null> {
    try {
      return await this.db.get(`rate:${did}`) as RateLimitState;
    } catch {
      return null;
    }
  }

  async cleanupRateLimits(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const toDelete: string[] = [];
    for await (const [key, value] of this.db.iterator<string, RateLimitState>({
      gte: 'rate:',
      lte: 'rate:\xff',
      valueEncoding: 'json',
    })) {
      if (value.lastRefill < cutoff) toDelete.push(key);
    }
    await this.db.batch(toDelete.map((key) => ({ type: 'del' as const, key })));
  }

  // ─── Session Management (CVP-0014) ────────────────────────────────────────

  private async updateSessionMeta(msg: StoredMessage): Promise<void> {
    if (!msg.envelope.threadId) return;

    const sortTimestamp = getMessageSortTimestamp(msg);

    const sessionKey = `session:${msg.envelope.threadId}`;
    let session: { peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number };

    try {
      session = await this.db.get(sessionKey) as typeof session;
    } catch {
      // Create new session
      const peerDid = msg.direction === 'inbound' ? msg.envelope.from : msg.envelope.to;
      const text = typeof msg.envelope.payload === 'object' && msg.envelope.payload !== null
        ? (msg.envelope.payload as Record<string, unknown>).text ?? (msg.envelope.payload as Record<string, unknown>).message ?? ''
        : String(msg.envelope.payload ?? '');
      const title = text ? String(text).slice(0, 50) : undefined;

      session = {
        threadId: msg.envelope.threadId,
        peerDid,
        startedAt: sortTimestamp,
        lastMessageAt: sortTimestamp,
        messageCount: 1,
        title,
      };
      await this.db.put(sessionKey, session);
      return;
    }

    // Update existing session
    session.startedAt = Math.min(session.startedAt ?? sortTimestamp, sortTimestamp);
    session.lastMessageAt = Math.max(session.lastMessageAt ?? sortTimestamp, sortTimestamp);
    session.messageCount = (session.messageCount ?? 0) + 1;
    await this.db.put(sessionKey, session);
  }

  async getSession(threadId: string): Promise<{ peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number } | null> {
    try {
      return await this.db.get(`session:${threadId}`) as { peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number };
    } catch {
      return null;
    }
  }

  async listSessions(peerDid?: string, limit = 50, includeArchived = false): Promise<Array<{ peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }>> {
    const results: Array<{ peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }> = [];
    for await (const [, value] of this.db.iterator<string, { peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }>({
      gte: 'session:',
      lte: 'session:\xff',
      valueEncoding: 'json',
    })) {
      if (peerDid && value.peerDid !== peerDid) continue;
      if (!includeArchived && value.archived) continue; // Skip archived sessions by default
      results.push(value);
    }

    return results
      .sort(MessageStorage.compareSessionsByLastMessageAt)
      .slice(0, limit);
  }

  async archiveSession(threadId: string): Promise<void> {
    const session = await this.getSession(threadId);
    if (!session) {
      throw new Error(`Session not found: ${threadId}`);
    }

    session.archived = true;
    session.archivedAt = Date.now();
    await this.db.put(`session:${threadId}`, session);
  }

  async unarchiveSession(threadId: string): Promise<void> {
    const session = await this.getSession(threadId);
    if (!session) {
      throw new Error(`Session not found: ${threadId}`);
    }

    session.archived = false;
    delete session.archivedAt;
    await this.db.put(`session:${threadId}`, session);
  }

  async listArchivedSessions(peerDid?: string, limit = 50): Promise<Array<{ peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }>> {
    const results: Array<{ peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }> = [];
    for await (const [, value] of this.db.iterator<string, { peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }>({
      gte: 'session:',
      lte: 'session:\xff',
      valueEncoding: 'json',
    })) {
      if (!value.archived) continue; // Only archived sessions
      if (peerDid && value.peerDid !== peerDid) continue;
      results.push(value);
    }

    return results
      .sort(MessageStorage.compareSessionsByLastMessageAt)
      .slice(0, limit);
  }

  async searchSessions(query: string, limit = 50): Promise<Array<{ peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }>> {
    const results: Array<{ peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }> = [];
    const lowerQuery = query.toLowerCase();

    for await (const [, value] of this.db.iterator<string, { peerDid: string; threadId: string; messageCount: number; lastMessageAt: number; startedAt?: number; title?: string; archived?: boolean; archivedAt?: number }>({
      gte: 'session:',
      lte: 'session:\xff',
      valueEncoding: 'json',
    })) {
      // Search in title
      if (value.title && value.title.toLowerCase().includes(lowerQuery)) {
        results.push(value);
        if (results.length >= limit) break;
        continue;
      }

      // Search in peer DID
      if (value.peerDid && value.peerDid.toLowerCase().includes(lowerQuery)) {
        results.push(value);
        if (results.length >= limit) break;
        continue;
      }

      // Search in thread messages
      const messages = await this.queryMessagesByThread(value.threadId, { limit: 100 });
      for (const msg of messages.messages) {
        const payload = msg.envelope.payload as Record<string, unknown>;
        const text = payload?.text || payload?.message || '';
        if (text && String(text).toLowerCase().includes(lowerQuery)) {
          results.push(value);
          if (results.length >= limit) break;
          break; // Found match in this thread, move to next
        }
      }

    }

    return results
      .sort(MessageStorage.compareSessionsByLastMessageAt)
      .slice(0, limit);
  }

  async queryMessagesByThread(
    threadId: string,
    pagination: PaginationOptions = {}
  ): Promise<MessagePage> {
    const { limit = 50, offset = 0 } = pagination;
    const prefix = `idx:thread:${threadId}:`;
    const matches: StoredMessage[] = [];

    // Get message IDs from thread index
    const messageIds: string[] = [];
    for await (const [key] of this.db.iterator<string, string>({
      gte: prefix,
      lte: prefix + '\xff',
    })) {
      const parts = key.split(':');
      const msgId = parts[parts.length - 1];
      messageIds.push(msgId);
    }

    // Fetch full messages
    for (const msgId of messageIds) {
      const msg = await this.getMessage(msgId);
      if (!msg) continue;
      matches.push(msg);
    }

    matches.sort(compareMessagesBySortTimestamp);
    const results = matches.slice(offset, offset + limit);
    const total = matches.length;

    return {
      messages: results,
      total,
      hasMore: total > offset + results.length,
    };
  }
}
