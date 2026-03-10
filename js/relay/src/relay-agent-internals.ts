import type { WebSocket } from 'ws';
import type { BootstrapManager } from './bootstrap-manager.js';
import type { EndorsementIndex } from './endorsement-index.js';
import type { FederationManager } from './federation-manager.js';
import type { HeartbeatTracker } from './heartbeat.js';
import type { MessageQueue } from './queue.js';
import type { AgentRegistry } from './registry.js';
import type { RelayIdentity } from './relay-identity.js';
import type { RelayStatusManager } from './relay-status-manager.js';
import type { RevocationList } from './revocation.js';
import type { SubscriptionManager } from './subscription-manager.js';
import type { ConnectionContext, RelayAgentConfig } from './relay-agent-types.js';
import type { HelloMessage, RelayMessage, SendMessage } from './types.js';

export interface RateLimitCounter {
  count: number;
  windowStart: number;
}

export interface RelayAgentRuntime {
  config: Required<RelayAgentConfig>;
  registry: AgentRegistry;
  heartbeat: HeartbeatTracker;
  queue: MessageQueue | null;
  wsToDidMap: Map<WebSocket, string>;
  subscriptions: SubscriptionManager;
  endorsements: EndorsementIndex;
  revocationList: RevocationList | null;
  relayIdentity: RelayIdentity;
  federationManager: FederationManager | null;
  bootstrapManager: BootstrapManager | null;
  statusManager: RelayStatusManager | null;
  endorseCounters: Map<string, RateLimitCounter>;
  trustQueryCounters: Map<string, RateLimitCounter>;
  endorseDedup: Map<string, number>;
}

export interface RelayHelloResult {
  success: boolean;
  error?: string;
}

export interface RelayConnectionHandlers {
  handleHello: (ws: WebSocket, msg: HelloMessage, context: ConnectionContext) => Promise<RelayHelloResult>;
  dispatchAuthenticatedMessage: (ws: WebSocket, did: string, msg: RelayMessage) => Promise<void>;
  handleAgentDisconnect: (ws: WebSocket, did: string) => void;
}

export interface RelayMessageRoutingHandlers {
  handleRelayMessage: (fromDid: string, msg: SendMessage) => Promise<void>;
}
