/**
 * CVP-0018: Subscription manager for real-time agent change notifications
 */

import { encode as encodeCBOR } from 'cbor-x';
import type { WebSocket } from 'ws';
import type { AgentCard, EventMessage } from './types.js';

interface Subscription {
  id: string;
  did: string;
  ws: WebSocket;
  events: Set<'join' | 'leave' | 'update' | 'publish' | 'unpublish'>;
  realm: string;
  // Rate limiting: track event timestamps in a sliding window
  eventTimestamps: number[];
}

const MAX_SUBSCRIPTIONS_PER_DID = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_EVENTS = 1000;

export class SubscriptionManager {
  private subscriptions = new Map<string, Subscription>();
  // did → Set<subscriptionId>
  private byDid = new Map<string, Set<string>>();

  subscribe(
    did: string,
    ws: WebSocket,
    events: Array<'join' | 'leave' | 'update' | 'publish' | 'unpublish'>,
    realm: string
  ): { subscriptionId: string } | { error: string } {
    const existing = this.byDid.get(did);
    if (existing && existing.size >= MAX_SUBSCRIPTIONS_PER_DID) {
      return { error: `Max ${MAX_SUBSCRIPTIONS_PER_DID} subscriptions per DID` };
    }

    const subscriptionId = `sub-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const sub: Subscription = {
      id: subscriptionId,
      did,
      ws,
      events: new Set(events),
      realm,
      eventTimestamps: [],
    };

    this.subscriptions.set(subscriptionId, sub);

    if (!this.byDid.has(did)) {
      this.byDid.set(did, new Set());
    }
    this.byDid.get(did)!.add(subscriptionId);

    return { subscriptionId };
  }

  unsubscribe(subscriptionId: string): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;

    this.subscriptions.delete(subscriptionId);
    this.byDid.get(sub.did)?.delete(subscriptionId);
    if (this.byDid.get(sub.did)?.size === 0) {
      this.byDid.delete(sub.did);
    }
  }

  unsubscribeAll(did: string): void {
    const ids = this.byDid.get(did);
    if (!ids) return;
    for (const id of ids) {
      this.subscriptions.delete(id);
    }
    this.byDid.delete(did);
  }

  /**
   * Dispatch an event to all subscribers interested in it.
   * Enforces realm scoping and per-subscriber rate limiting.
   */
  dispatch(
    event: 'join' | 'leave' | 'update' | 'publish' | 'unpublish',
    did: string,
    card: AgentCard | undefined,
    realm: string
  ): void {
    const now = Date.now();

    for (const sub of this.subscriptions.values()) {
      // Realm scoping: subscriber only receives events from own realm
      if (sub.realm !== realm) continue;

      // Event type filter
      if (!sub.events.has(event)) continue;

      // Don't send events about the subscriber to themselves
      if (sub.did === did) continue;

      // Rate limiting: 1000 events/min per subscriber
      sub.eventTimestamps = sub.eventTimestamps.filter(
        t => now - t < RATE_LIMIT_WINDOW_MS
      );
      if (sub.eventTimestamps.length >= RATE_LIMIT_MAX_EVENTS) {
        // Drop silently
        continue;
      }
      sub.eventTimestamps.push(now);

      // Send event
      if (sub.ws.readyState === 1 /* OPEN */) {
        const msg: EventMessage = {
          type: 'EVENT',
          subscriptionId: sub.id,
          event,
          did,
          card: event !== 'leave' && event !== 'unpublish' ? card : undefined,
          realm,
        };
        try {
          sub.ws.send(encodeCBOR(msg));
        } catch {
          // Ignore send errors — ws may have closed
        }
      }
    }
  }
}
