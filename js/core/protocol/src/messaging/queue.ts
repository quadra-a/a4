/**
 * Message Queue
 *
 * Persistent inbox/outbox backed by LevelDB.
 * Supports real-time subscriptions and pagination.
 */

import { createLogger } from '../utils/logger.js';
import type { MessageEnvelope } from './envelope.js';
import { MessageStorage } from './storage.js';
import type {
  StoredMessage,
  MessageFilter,
  PaginationOptions,
  MessagePage,
  MessageCallback,
  SubscriptionFilter,
  QueueStats,
  E2EDeliveryMetadata,
  E2ERetryMetadata,
} from './types.js';

const logger = createLogger('message-queue');

export interface MessageQueueConfig {
  dbPath: string;
}

interface Subscription {
  id: string;
  filter: SubscriptionFilter;
  callback: MessageCallback;
}

export class MessageQueue {
  private storage: MessageStorage;
  private subscriptions = new Map<string, Subscription>();
  private subCounter = 0;

  constructor(config: MessageQueueConfig) {
    this.storage = new MessageStorage(config.dbPath);
  }

  get store(): MessageStorage {
    return this.storage;
  }

  async start(): Promise<void> {
    await this.storage.open();
    logger.info('Message queue started');
  }

  async stop(): Promise<void> {
    await this.storage.close();
    this.subscriptions.clear();
    logger.info('Message queue stopped');
  }

  // ─── Inbox ────────────────────────────────────────────────────────────────

  async getInbox(filter: MessageFilter = {}, pagination: PaginationOptions = {}): Promise<MessagePage> {
    return this.storage.queryMessages('inbound', filter, pagination);
  }

  async getMessage(id: string): Promise<StoredMessage | null> {
    return this.storage.getMessage(id);
  }

  async getOutboundMessage(id: string): Promise<StoredMessage | null> {
    return this.storage.getMessage(id, 'outbound');
  }

  async markAsRead(id: string): Promise<void> {
    await this.storage.updateMessage(id, { readAt: Date.now() });
  }

  async deleteMessage(id: string): Promise<void> {
    await this.storage.deleteMessage(id);
  }

  // ─── Outbox ───────────────────────────────────────────────────────────────

  async getOutbox(pagination: PaginationOptions = {}): Promise<MessagePage> {
    return this.storage.queryMessages('outbound', {}, pagination);
  }

  async retryMessage(id: string): Promise<void> {
    await this.storage.updateMessage(id, { status: 'pending', error: undefined });
  }

  // ─── Enqueue ──────────────────────────────────────────────────────────────

  async enqueueInbound(
    envelope: MessageEnvelope,
    trustScore?: number,
    trustStatus?: import('./types.js').StoredMessage['trustStatus'],
    e2eDelivery?: E2EDeliveryMetadata,
  ): Promise<StoredMessage> {
    const msg: StoredMessage = {
      envelope,
      direction: 'inbound',
      status: 'pending',
      receivedAt: Date.now(),
      trustScore,
      trustStatus,
      ...(e2eDelivery ? { e2e: { deliveries: [e2eDelivery] } } : {}),
    };
    await this.storage.putMessage(msg);
    logger.debug('Enqueued inbound message', { id: envelope.id, from: envelope.from });
    this.notifySubscribers(msg);
    return msg;
  }

  async enqueueOutbound(envelope: MessageEnvelope, e2eDeliveries: E2EDeliveryMetadata[] = []): Promise<StoredMessage> {
    const msg: StoredMessage = {
      envelope,
      direction: 'outbound',
      status: 'pending',
      sentAt: Date.now(),
      ...(e2eDeliveries.length > 0 ? { e2e: { deliveries: e2eDeliveries } } : {}),
    };
    await this.storage.putMessage(msg);
    logger.debug('Enqueued outbound message', { id: envelope.id, to: envelope.to });
    return msg;
  }

  async markOutboundDelivered(id: string): Promise<void> {
    await this.storage.updateMessage(id, { status: 'delivered' });
  }

  async markOutboundFailed(id: string, error: string): Promise<void> {
    await this.storage.updateMessage(id, { status: 'failed', error });
  }

  async appendE2EDelivery(id: string, delivery: E2EDeliveryMetadata): Promise<StoredMessage | null> {
    return this.storage.upsertE2EDeliveries(id, [delivery]);
  }

  async appendE2ERetry(id: string, retry: E2ERetryMetadata): Promise<StoredMessage | null> {
    return this.storage.upsertE2ERetry(id, retry);
  }

  // ─── Subscriptions ────────────────────────────────────────────────────────

  subscribe(filter: SubscriptionFilter, callback: MessageCallback): string {
    const id = `sub_${++this.subCounter}`;
    this.subscriptions.set(id, { id, filter, callback });
    logger.debug('Subscription added', { id });
    return id;
  }

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
    logger.debug('Subscription removed', { id: subscriptionId });
  }

  private notifySubscribers(msg: StoredMessage): void {
    for (const sub of this.subscriptions.values()) {
      if (this.matchesSubscriptionFilter(msg, sub.filter)) {
        Promise.resolve(sub.callback(msg)).catch((err) => {
          logger.warn('Subscription callback error', { id: sub.id, error: (err as Error).message });
        });
      }
    }
  }

  private matchesSubscriptionFilter(msg: StoredMessage, filter: SubscriptionFilter): boolean {
    if (filter.fromDid) {
      const froms = Array.isArray(filter.fromDid) ? filter.fromDid : [filter.fromDid];
      if (!froms.includes(msg.envelope.from)) return false;
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
    if (filter.threadId && msg.envelope.threadId !== filter.threadId) return false;
    return true;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats(): Promise<QueueStats> {
    const [inboxTotal, inboxUnread, outboxPending, outboxFailed, blocked, allowed] =
      await Promise.all([
        this.storage.countMessages('inbound'),
        this.storage.countMessages('inbound', { unreadOnly: true }),
        this.storage.countMessages('outbound', { status: 'pending' }),
        this.storage.countMessages('outbound', { status: 'failed' }),
        this.storage.listBlocked().then((l) => l.length),
        this.storage.listAllowed().then((l) => l.length),
      ]);

    return {
      inboxTotal,
      inboxUnread,
      outboxPending,
      outboxFailed,
      blockedAgents: blocked,
      allowedAgents: allowed,
      rateLimitedAgents: 0,
    };
  }
}
