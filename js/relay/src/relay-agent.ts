import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { AgentRegistry } from './registry.js';
import { HeartbeatTracker } from './heartbeat.js';
import { MessageQueue } from './queue.js';
import { SubscriptionManager } from './subscription-manager.js';
import { EndorsementIndex } from './endorsement-index.js';
import { TokenStore } from './token-store.js';
import { RevocationList } from './revocation.js';
import { RelayIdentity } from './relay-identity.js';
import { FederationManager, type FederationExportPolicy } from './federation-manager.js';
import { BootstrapManager } from './bootstrap-manager.js';
import { RelayStatusManager } from './relay-status-manager.js';
import * as connectionHandlers from './relay-agent-connection.js';
import * as clientHandlers from './relay-agent-client-handlers.js';
import * as deliveryHandlers from './relay-agent-delivery.js';
import type { RelayAgentRuntime } from './relay-agent-internals.js';
import * as relayHandlers from './relay-agent-relay-handlers.js';
import { getRelayStartupWarnings } from './relay-agent-shared.js';
import {
  DEFAULT_RELAY_AGENT_CONFIG,
  type ConnectionContext,
  type RelayAgentConfig,
} from './relay-agent-types.js';
import type {
  AckMessage,
  DiscoverMessage,
  EndorseMessage,
  FederationHealthCheckMessage,
  FetchCardMessage,
  HelloMessage,
  PingMessage,
  PublishCardMessage,
  RelayMessage,
  SendMessage,
  SubscribeMessage,
  TrustQueryMessage,
  UnsubscribeMessage,
} from './types.js';

export { getRelayStartupWarnings };
export type { RelayAgentConfig };

export class RelayAgent {
  private config: Required<RelayAgentConfig>;
  private wss: WebSocketServer | null = null;
  private registry = new AgentRegistry();
  private heartbeat: HeartbeatTracker;
  private queue: MessageQueue | null = null;
  private wsToDidMap = new Map<WebSocket, string>();
  private subscriptions = new SubscriptionManager();
  private endorsements: EndorsementIndex;
  private tokenStore: TokenStore | null = null;
  private revocationList: RevocationList | null = null;
  private relayIdentity: RelayIdentity;
  private federationManager: FederationManager | null = null;
  private bootstrapManager: BootstrapManager | null = null;
  private statusManager: RelayStatusManager | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private authValidationTimer: NodeJS.Timeout | null = null;
  private endorseCounters = new Map<string, { count: number; windowStart: number }>();
  private trustQueryCounters = new Map<string, { count: number; windowStart: number }>();
  private endorseDedup = new Map<string, number>();

  constructor(config: RelayAgentConfig = {}) {
    this.config = { ...DEFAULT_RELAY_AGENT_CONFIG, ...config };
    this.endorsements = new EndorsementIndex(`${this.config.storagePath}/endorsements.json`);
    this.relayIdentity = new RelayIdentity(this.config.storagePath);
    this.heartbeat = new HeartbeatTracker(this.registry, (did) => {
      this.handleTimeout(did);
    });
  }

  async start(): Promise<void> {
    const endpoints = this.config.publicEndpoints.length > 0
      ? this.config.publicEndpoints
      : [`ws://localhost:${this.config.port}`];
    const identity = await this.relayIdentity.initialize(this.config.relayId, endpoints);

    console.log(`✓ Relay agent identity: ${identity.did}`);
    console.log(`  Name: ${identity.agentCard.name}`);
    console.log(`  Capabilities: ${identity.agentCard.capabilities.length}`);

    this.wss = new WebSocketServer({ port: this.config.port });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.queue = new MessageQueue({ storagePath: this.config.storagePath });
    await this.queue.start();

    if (this.config.privateRelay || this.config.operatorPublicKey) {
      this.tokenStore = new TokenStore(`${this.config.storagePath}/tokens.json`);
      this.revocationList = new RevocationList(`${this.config.storagePath}/revoked.json`);
      await this.tokenStore.load();
      await this.revocationList.load();
    }

    await this.endorsements.load();
    await this.registerSelfAsAgent();

    if (this.config.federationEnabled) {
      this.federationManager = new FederationManager(this.relayIdentity, this.registry, {
        exportPolicy: this.resolveFederationExportPolicy(),
        selectiveVisibilityValue: this.config.federationExportVisibility,
        realmPolicies: this.config.federationRealmPolicies,
      });
      await this.federationManager.start();
    }

    this.bootstrapManager = new BootstrapManager(
      this.relayIdentity,
      this.registry,
      this.federationManager,
      {
        genesisMode: this.config.genesisMode,
        seedRelays: this.config.seedRelays,
        networkId: this.config.networkId,
      },
    );

    const bootstrapResult = await this.bootstrapManager.initialize();
    console.log(`✓ Network bootstrap: ${bootstrapResult.mode} mode`);

    this.heartbeat.start();
    this.retryTimer = setInterval(() => {
      this.retryUnackedMessages().catch(console.error);
    }, 60 * 1000);

    if (this.config.privateRelay || this.config.operatorPublicKey) {
      this.authValidationTimer = setInterval(() => {
        this.revalidateActiveSessions().catch(console.error);
      }, 5000);
    }

    this.statusManager = new RelayStatusManager(
      this.relayIdentity,
      this.registry,
      this.federationManager,
      this.bootstrapManager,
      this.endorsements,
      this.queue,
    );

    console.log('✓ Relay agent started');
    console.log(`  Port: ${this.config.port}`);
    console.log(`  Relay ID: ${this.config.relayId}`);
    console.log(`  Storage: ${this.config.storagePath}`);
    console.log(`  Public Endpoints: ${identity.agentCard.endpoints.join(', ')}`);
    console.log(`  Federation: ${this.config.federationEnabled ? 'ENABLED' : 'DISABLED'}`);
    if (this.config.federationEnabled) {
      console.log(`  Federation Export Policy: ${this.resolveFederationExportPolicy()}`);
      const configuredRealms = Object.keys(this.config.federationRealmPolicies);
      if (configuredRealms.length > 0) {
        console.log(`  Federation Realm Policies: ${configuredRealms.join(', ')}`);
      }
    }
    if (this.config.privateRelay) {
      console.log('  Mode: PRIVATE (invite tokens required)');
    }

    for (const warning of getRelayStartupWarnings({
      port: this.config.port,
      configuredPublicEndpoints: this.config.publicEndpoints,
      publishedEndpoints: identity.agentCard.endpoints,
    })) {
      console.warn(`Warning: ${warning}`);
    }
  }

  async stop(): Promise<void> {
    this.heartbeat.stop();

    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.authValidationTimer) {
      clearInterval(this.authValidationTimer);
      this.authValidationTimer = null;
    }

    if (this.federationManager) {
      await this.federationManager.stop();
      this.federationManager = null;
    }

    if (this.queue) {
      await this.queue.stop();
      this.queue = null;
    }

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }

      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    await this.endorsements.save();
    console.log('Relay agent stopped');
  }

  private getRuntime(): RelayAgentRuntime {
    return {
      config: this.config,
      registry: this.registry,
      heartbeat: this.heartbeat,
      queue: this.queue,
      wsToDidMap: this.wsToDidMap,
      subscriptions: this.subscriptions,
      endorsements: this.endorsements,
      revocationList: this.revocationList,
      relayIdentity: this.relayIdentity,
      federationManager: this.federationManager,
      bootstrapManager: this.bootstrapManager,
      statusManager: this.statusManager,
      endorseCounters: this.endorseCounters,
      trustQueryCounters: this.trustQueryCounters,
      endorseDedup: this.endorseDedup,
    };
  }

  private async registerSelfAsAgent(): Promise<void> {
    const identity = this.relayIdentity.getIdentity();
    const mockWs = {
      send: () => {},
      close: () => {},
      readyState: 1,
    } as unknown as WebSocket;

    this.registry.register(identity.did, identity.agentCard, mockWs, 'public');
    this.registry.publish(identity.did, identity.agentCard);
    console.log(`✓ Relay registered as agent: ${identity.did}`);
  }

  private async dispatchAuthenticatedMessage(ws: WebSocket, did: string, msg: RelayMessage): Promise<void> {
    switch (msg.type) {
      case 'SEND':
        await this.routeMessage(did, msg as SendMessage);
        break;
      case 'DISCOVER':
        await this.handleDiscover(ws, did, msg as DiscoverMessage);
        break;
      case 'FETCH_CARD':
        await this.handleFetchCard(ws, did, msg as FetchCardMessage);
        break;
      case 'PING':
        await this.handlePing(ws, did, msg as PingMessage);
        break;
      case 'ACK':
        await this.handleAck(did, msg as AckMessage);
        break;
      case 'SUBSCRIBE':
        await this.handleSubscribe(ws, did, msg as SubscribeMessage);
        break;
      case 'UNSUBSCRIBE':
        await this.handleUnsubscribe(did, msg as UnsubscribeMessage);
        break;
      case 'ENDORSE':
        await this.handleEndorse(ws, did, msg as EndorseMessage);
        break;
      case 'TRUST_QUERY':
        await this.handleTrustQuery(ws, did, msg as TrustQueryMessage);
        break;
      case 'PUBLISH_CARD':
        await this.handlePublishCard(ws, did, msg as PublishCardMessage);
        break;
      case 'UNPUBLISH_CARD':
        await this.handleUnpublishCard(did);
        break;
      case 'GOODBYE':
        ws.close();
        break;
      default:
        console.warn('Unknown message type:', (msg as { type?: string }).type);
    }
  }

  private handleConnection(ws: WebSocket, req?: IncomingMessage): void {
    connectionHandlers.handleConnection(
      this.getRuntime(),
      {
        handleHello: (socket, msg, context) => this.handleHello(socket, msg, context),
        dispatchAuthenticatedMessage: (socket, did, msg) => this.dispatchAuthenticatedMessage(socket, did, msg),
        handleAgentDisconnect: (socket, did) => this.handleAgentDisconnect(socket, did),
      },
      ws,
      req,
    );
  }

  private handleAgentDisconnect(ws: WebSocket, did: string): void {
    connectionHandlers.handleAgentDisconnect(this.getRuntime(), ws, did);
  }

  private async handleHello(
    ws: WebSocket,
    msg: HelloMessage,
    context: ConnectionContext = { remoteIp: 'unknown', userAgent: 'unknown' },
  ): Promise<{ success: boolean; error?: string }> {
    return connectionHandlers.handleHello(this.getRuntime(), ws, msg, context);
  }

  private async routeMessage(fromDid: string, msg: SendMessage): Promise<void> {
    await deliveryHandlers.routeMessage(this.getRuntime(), {
      handleRelayMessage: (senderDid, sendMsg) => this.handleRelayMessage(senderDid, sendMsg),
    }, fromDid, msg);
  }

  private async handleRelayMessage(fromDid: string, msg: SendMessage): Promise<void> {
    await relayHandlers.handleRelayMessage(
      this.getRuntime(),
      fromDid,
      msg,
      {
        handleRelayHealthCheck: (ws, senderDid, relayMsg) => this.handleRelayHealthCheck(ws, senderDid, relayMsg),
        handleRelayPing: (ws, senderDid, relayMsg) => this.handleRelayPing(ws, senderDid, relayMsg),
        handleFederatedDiscover: (ws, senderDid, relayMsg) => this.handleFederatedDiscover(ws, senderDid, relayMsg),
        handleRelayTrustQuery: (ws, senderDid, relayMsg) => this.handleRelayTrustQuery(ws, senderDid, relayMsg),
        handleRelayFetchCard: (ws, senderDid, relayMsg) => this.handleRelayFetchCard(ws, senderDid, relayMsg),
      },
      (senderDid, sendMsg) => this.handleSend(senderDid, sendMsg),
    );
  }

  private async handleRelayHealthCheck(
    ws: WebSocket | undefined,
    fromDid: string,
    msg: FederationHealthCheckMessage,
  ): Promise<void> {
    await relayHandlers.handleRelayHealthCheck(this.getRuntime(), ws, fromDid, msg);
  }

  private async handleRelayPing(ws: WebSocket | undefined, fromDid: string, msg: PingMessage): Promise<void> {
    await relayHandlers.handleRelayPing(this.getRuntime(), ws, fromDid, msg);
  }

  private async handleFederatedDiscover(
    ws: WebSocket | undefined,
    fromDid: string,
    msg: DiscoverMessage,
  ): Promise<void> {
    await relayHandlers.handleFederatedDiscover(this.getRuntime(), ws, fromDid, msg);
  }

  private async handleRelayTrustQuery(
    ws: WebSocket | undefined,
    fromDid: string,
    msg: TrustQueryMessage,
  ): Promise<void> {
    await relayHandlers.handleRelayTrustQuery(this.getRuntime(), ws, fromDid, msg);
  }

  private async handleRelayFetchCard(
    ws: WebSocket | undefined,
    fromDid: string,
    msg: FetchCardMessage,
  ): Promise<void> {
    await relayHandlers.handleRelayFetchCard(this.getRuntime(), ws, fromDid, msg);
  }

  private async handleSend(fromDid: string, msg: SendMessage): Promise<void> {
    await deliveryHandlers.handleSend(this.getRuntime(), fromDid, msg);
  }

  private async handleDiscover(ws: WebSocket, did: string, msg: DiscoverMessage): Promise<void> {
    await clientHandlers.handleDiscover(this.getRuntime(), ws, did, msg);
  }

  private async handleFetchCard(ws: WebSocket, requesterDid: string, msg: FetchCardMessage): Promise<void> {
    await clientHandlers.handleFetchCard(this.getRuntime(), ws, requesterDid, msg);
  }

  private async handlePing(ws: WebSocket, did: string, msg: PingMessage): Promise<void> {
    await clientHandlers.handlePing(this.getRuntime(), ws, did, msg);
  }

  private async handleAck(did: string, msg: AckMessage): Promise<void> {
    await clientHandlers.handleAck(this.getRuntime(), did, msg);
  }

  private async handleSubscribe(ws: WebSocket, did: string, msg: SubscribeMessage): Promise<void> {
    await clientHandlers.handleSubscribe(this.getRuntime(), ws, did, msg);
  }

  private async handleUnsubscribe(did: string, msg: UnsubscribeMessage): Promise<void> {
    await clientHandlers.handleUnsubscribe(this.getRuntime(), did, msg);
  }

  private async handleEndorse(ws: WebSocket, did: string, msg: EndorseMessage): Promise<void> {
    await clientHandlers.handleEndorse(this.getRuntime(), ws, did, msg);
  }

  private async handleTrustQuery(ws: WebSocket, did: string, msg: TrustQueryMessage): Promise<void> {
    await clientHandlers.handleTrustQuery(this.getRuntime(), ws, did, msg);
  }

  private async handlePublishCard(ws: WebSocket, did: string, msg: PublishCardMessage): Promise<void> {
    await clientHandlers.handlePublishCard(this.getRuntime(), ws, did, msg);
  }

  private async handleUnpublishCard(did: string): Promise<void> {
    await clientHandlers.handleUnpublishCard(this.getRuntime(), did);
  }

  private async retryUnackedMessages(): Promise<void> {
    await deliveryHandlers.retryUnackedMessages(this.getRuntime());
  }

  private handleTimeout(did: string): void {
    deliveryHandlers.handleTimeout(this.getRuntime(), did);
  }

  private resolveFederationExportPolicy(): FederationExportPolicy {
    if (this.config.federationPolicy !== 'auto') {
      return this.config.federationPolicy;
    }

    return (this.config.privateRelay || !!this.config.operatorPublicKey) ? 'none' : 'full';
  }

  private async revalidateActiveSessions(): Promise<void> {
    await connectionHandlers.revalidateActiveSessions(this.getRuntime());
  }
}
