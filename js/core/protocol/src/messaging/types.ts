/**
 * Message Queue Types
 *
 * Types for message queue, storage, and filtering operations.
 */

import type { MessageEnvelope, MessageEnvelopeType } from './envelope.js';
import type { TrustStatus } from '../trust/trust-score.js';

/**
 * Message direction
 */
export type MessageDirection = 'inbound' | 'outbound';

/**
 * Message status
 */
export type MessageStatus = 'pending' | 'delivered' | 'failed' | 'archived';

export type E2EDeliveryState = 'pending' | 'sent' | 'received' | 'failed';

export interface E2EDeliveryMetadata {
  transport: 'prekey' | 'session';
  transportMessageId?: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  sessionId: string;
  state: E2EDeliveryState;
  recordedAt: number;
  usedSkippedMessageKey?: boolean;
  error?: string;
}

export interface E2ERetryMetadata {
  replayCount: number;
  lastRequestedAt?: number;
  lastReplayedAt?: number;
  lastReason?: string;
}

export interface StoredMessageE2EMetadata {
  deliveries: E2EDeliveryMetadata[];
  retry?: E2ERetryMetadata;
}

/**
 * Stored message with metadata
 */
export interface StoredMessage {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  status: MessageStatus;
  receivedAt?: number;
  sentAt?: number;
  readAt?: number;
  trustScore?: number;
  trustStatus?: TrustStatus;
  error?: string;
  e2e?: StoredMessageE2EMetadata;
}

/**
 * Message filter for queries
 */
export interface MessageFilter {
  fromDid?: string | string[];
  toDid?: string | string[];
  protocol?: string | string[];
  minTrustScore?: number;
  maxAge?: number; // milliseconds
  type?: MessageEnvelopeType;
  replyTo?: string | string[];
  unreadOnly?: boolean;
  status?: MessageStatus | MessageStatus[];
  threadId?: string; // CVP-0014: Filter by conversation thread
}

/**
 * Session metadata for conversation threads (CVP-0014)
 */
export interface SessionMeta {
  threadId: string;
  peerDid: string;
  startedAt: number;
  lastMessageAt: number;
  messageCount: number;
  title?: string; // First message text, truncated to 50 chars
  archived?: boolean; // Thread archiving feature
  archivedAt?: number; // Timestamp when archived
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
  startKey?: string; // For cursor-based pagination
}

/**
 * Paginated message results
 */
export interface MessagePage {
  messages: StoredMessage[];
  total: number;
  hasMore: boolean;
  nextKey?: string;
}

/**
 * Blocklist entry
 */
export interface BlocklistEntry {
  did: string;
  reason: string;
  blockedAt: number;
  blockedBy: string; // Local agent DID
}

/**
 * Allowlist entry
 */
export interface AllowlistEntry {
  did: string;
  addedAt: number;
  note?: string;
}

/**
 * Seen cache entry (for deduplication)
 */
export interface SeenEntry {
  messageId: string;
  seenAt: number;
  fromDid: string;
}

/**
 * Rate limit state
 */
export interface RateLimitState {
  did: string;
  tokens: number;
  lastRefill: number;
  totalRequests: number;
  firstSeen: number;
}

/**
 * Defense check result
 */
export interface DefenseResult {
  allowed: boolean;
  reason?: 'blocked' | 'duplicate' | 'trust_too_low' | 'rate_limited' | 'invalid';
  trustScore?: number;
  trustStatus?: TrustStatus;
  remainingTokens?: number;
  resetTime?: number;
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  limit: number;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  inboxTotal: number;
  inboxUnread: number;
  outboxPending: number;
  outboxFailed: number;
  blockedAgents: number;
  allowedAgents: number;
  rateLimitedAgents: number;
}

/**
 * Subscription callback
 */
export type MessageCallback = (message: StoredMessage) => void | Promise<void>;

/**
 * Subscription filter
 */
export interface SubscriptionFilter extends MessageFilter {
  webhookUrl?: string;
}
