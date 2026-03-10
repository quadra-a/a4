/**
 * CVP-0011: Heartbeat / liveness tracker for relay server
 * Disconnects agents that haven't sent a PING within the timeout window.
 */

import type { AgentRegistry } from './registry.js';

const HEARTBEAT_TIMEOUT_MS = 90_000; // 90 seconds
const CHECK_INTERVAL_MS = 15_000;    // check every 15 seconds

export class HeartbeatTracker {
  private lastPing = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private registry: AgentRegistry,
    private onTimeout: (did: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  recordPing(did: string): void {
    this.lastPing.set(did, Date.now());
    this.registry.updateLastSeen(did);
  }

  remove(did: string): void {
    this.lastPing.delete(did);
  }

  private check(): void {
    const now = Date.now();
    for (const [did, ts] of this.lastPing.entries()) {
      if (now - ts > HEARTBEAT_TIMEOUT_MS) {
        this.lastPing.delete(did);
        this.onTimeout(did);
      }
    }
  }
}
