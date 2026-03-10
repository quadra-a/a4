/**
 * CVP-0011 §2.7: Offline message queue
 *
 * Stores messages for offline agents with:
 * - 24h TTL
 * - Max 1000 messages per DID
 * - Delivery retry with exponential backoff
 * - Message lifecycle: QUEUED → DELIVERED → ACKED
 */

import { Level } from 'level';

export type QueuedEnvelope = number[];
export type QueuedEnvelopeInput = Uint8Array | number[];
type LegacyQueuedEnvelope = Record<string, unknown>;
type StoredQueuedEnvelope = QueuedEnvelope | LegacyQueuedEnvelope;

export interface QueuedMessage {
  messageId: string;
  toDid: string;
  fromDid: string;
  envelope: QueuedEnvelope;
  queuedAt: number;
  expiresAt: number;
  deliveryAttempts: number;
  lastAttemptAt?: number;
  status: 'queued' | 'delivered' | 'acked' | 'expired';
}

interface StoredQueuedMessage extends Omit<QueuedMessage, 'envelope'> {
  envelope: StoredQueuedEnvelope;
}

export interface MessageQueueConfig {
  storagePath: string;
  maxMessagesPerDid?: number;
  ttlMs?: number;
  maxRetries?: number;
}

const DEFAULT_CONFIG = {
  maxMessagesPerDid: 1000,
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours
  maxRetries: 3,
};

function isByte(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

export function serializeQueuedEnvelope(envelope: QueuedEnvelopeInput): QueuedEnvelope {
  const normalized = Array.from(envelope);
  if (!normalized.every(isByte)) {
    throw new Error('Queued envelope contains non-byte values');
  }
  return normalized;
}

export function deserializeQueuedEnvelope(envelope: StoredQueuedEnvelope): QueuedEnvelope {
  if (Array.isArray(envelope)) {
    if (!envelope.every(isByte)) {
      throw new Error('Queued envelope array contains non-byte values');
    }
    return [...envelope];
  }

  if (envelope.type === 'Buffer' && Array.isArray(envelope.data)) {
    if (!envelope.data.every(isByte)) {
      throw new Error('Queued envelope Buffer data contains non-byte values');
    }
    return [...envelope.data];
  }

  const entries = Object.entries(envelope);
  if (entries.length === 0) {
    return [];
  }

  const indexed = entries.map(([key, value]) => {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || !isByte(value)) {
      throw new Error('Queued envelope object is not a serialized Uint8Array');
    }
    return [index, value] as const;
  });

  indexed.sort((left, right) => left[0] - right[0]);
  const isDense = indexed.every(([index], expected) => index == expected);
  if (!isDense) {
    throw new Error('Queued envelope object is missing byte positions');
  }

  return indexed.map(([, value]) => value);
}

function normalizeQueuedMessage(message: StoredQueuedMessage): QueuedMessage {
  return {
    ...message,
    envelope: deserializeQueuedEnvelope(message.envelope),
  };
}

export class MessageQueue {
  private db: Level<string, StoredQueuedMessage>;
  private config: Required<MessageQueueConfig>;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: MessageQueueConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = new Level<string, StoredQueuedMessage>(config.storagePath, {
      valueEncoding: 'json',
    });
  }

  async start(): Promise<void> {
    await this.db.open();

    // Start cleanup timer (every 5 minutes)
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredMessages().catch(console.error);
    }, 5 * 60 * 1000);

    console.log('Message queue started', { storagePath: this.config.storagePath });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.db.close();
    console.log('Message queue stopped');
  }

  /**
   * Queue a message for an offline agent
   */
  async enqueue(toDid: string, fromDid: string, envelope: QueuedEnvelopeInput): Promise<string> {
    const messageId = Math.random().toString(36).slice(2);
    const now = Date.now();

    // Check queue size for this DID
    const count = await this.getQueueSize(toDid);
    if (count >= this.config.maxMessagesPerDid) {
      throw new Error(`Queue full for ${toDid} (max ${this.config.maxMessagesPerDid})`);
    }

    const message: StoredQueuedMessage = {
      messageId,
      toDid,
      fromDid,
      envelope: serializeQueuedEnvelope(envelope),
      queuedAt: now,
      expiresAt: now + this.config.ttlMs,
      deliveryAttempts: 0,
      status: 'queued',
    };

    await this.db.put(`${toDid}:${messageId}`, message);
    console.log('Message queued', { messageId, toDid, fromDid });
    return messageId;
  }

  /**
   * Get all queued messages for a DID (when agent reconnects)
   */
  async getQueuedMessages(did: string): Promise<QueuedMessage[]> {
    const messages: QueuedMessage[] = [];
    const prefix = `${did}:`;

    for await (const [key, value] of this.db.iterator()) {
      if (!key.startsWith(prefix) || value.status !== 'queued') {
        continue;
      }

      try {
        messages.push(normalizeQueuedMessage(value));
      } catch (err) {
        console.warn('Skipping queued message with invalid envelope', {
          key,
          did,
          error: (err as Error).message,
        });
      }
    }

    return messages.sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /**
   * Mark message as delivered (waiting for ACK)
   */
  async markDelivered(messageId: string, did: string): Promise<void> {
    const key = `${did}:${messageId}`;
    try {
      const stored = await this.db.get(key);
      const message = normalizeQueuedMessage(stored);
      message.status = 'delivered';
      message.deliveryAttempts++;
      message.lastAttemptAt = Date.now();
      await this.db.put(key, message);
      console.log('Message marked as delivered', { messageId, did });
    } catch (err) {
      console.warn('Failed to mark message as delivered', { messageId, did, error: (err as Error).message });
    }
  }

  /**
   * Mark message as acknowledged (can be deleted)
   */
  async markAcked(messageId: string, did: string): Promise<void> {
    const key = `${did}:${messageId}`;
    try {
      await this.db.del(key);
      console.log('Message acknowledged and deleted', { messageId, did });
    } catch (err) {
      console.warn('Failed to delete acked message', { messageId, did, error: (err as Error).message });
    }
  }

  /**
   * Get messages that need retry (delivered but not acked within 60s)
   */
  async getMessagesForRetry(): Promise<QueuedMessage[]> {
    const messages: QueuedMessage[] = [];
    const now = Date.now();
    const retryThreshold = 60 * 1000; // 60 seconds

    for await (const [key, value] of this.db.iterator()) {
      if (
        value.status === 'delivered' &&
        value.lastAttemptAt &&
        now - value.lastAttemptAt > retryThreshold &&
        value.deliveryAttempts < this.config.maxRetries
      ) {
        try {
          messages.push(normalizeQueuedMessage(value));
        } catch (err) {
          console.warn('Skipping retry message with invalid envelope', {
            key,
            error: (err as Error).message,
          });
        }
      }
    }

    return messages;
  }

  /**
   * Mark message as expired
   */
  async markExpired(messageId: string, did: string): Promise<void> {
    const key = `${did}:${messageId}`;
    try {
      const stored = await this.db.get(key);
      const message = normalizeQueuedMessage(stored);
      message.status = 'expired';
      await this.db.put(key, message);
      console.log('Message marked as expired', { messageId, did });
    } catch (err) {
      console.warn('Failed to mark message as expired', { messageId, did, error: (err as Error).message });
    }
  }

  /**
   * Get queue size for a DID
   */
  private async getQueueSize(did: string): Promise<number> {
    let count = 0;
    const prefix = `${did}:`;

    for await (const [key] of this.db.iterator()) {
      if (key.startsWith(prefix)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Cleanup expired messages (runs every 5 minutes)
   */
  private async cleanupExpiredMessages(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for await (const [key, value] of this.db.iterator()) {
      if (now > value.expiresAt || value.status === 'expired') {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      await this.db.del(key);
    }

    if (toDelete.length > 0) {
      console.log('Cleaned up expired messages', { count: toDelete.length });
    }
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{ total: number; queued: number; delivered: number; expired: number }> {
    const stats = { total: 0, queued: 0, delivered: 0, expired: 0 };

    for await (const [, value] of this.db.iterator()) {
      stats.total++;
      if (value.status === 'queued') stats.queued++;
      else if (value.status === 'delivered') stats.delivered++;
      else if (value.status === 'expired') stats.expired++;
    }

    return stats;
  }
}
