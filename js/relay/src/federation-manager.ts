/**
 * Federation Manager - Handles relay-to-relay communication and coordination
 *
 * Implements CVP-0011 federation protocol:
 * - Relay-to-relay discovery using standard agent discovery
 * - Cross-relay message routing with hop limits
 * - Federation health monitoring and peer management
 * - Automatic federation join protocol
 */

import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import type { RelayIdentity } from './relay-identity.js';
import type { AgentRegistry, DirectoryAgentEntry } from './registry.js';
import type {
  FederationHelloMessage,
  FederationWelcomeMessage,
  AgentJoinedMessage,
  AgentLeftMessage,
  RouteRequestMessage,
  RouteResponseMessage,
  FederationHealthCheckMessage,
  FederationHealthResponseMessage,
  RelayMessage,
  AgentCard,
} from './types.js';

export interface FederatedRelay {
  did: string;
  endpoints: string[];
  card?: AgentCard;
  ws: WebSocket | null;
  lastSeen: number;
  connected: boolean;
  connecting?: boolean;
  reconnectAttempts?: number;
  reconnectTimer?: NodeJS.Timeout | null;
  agentCount: number;
  uptime: number;
}

export interface FederatedAgentRoute {
  relayDid: string;
  realm: string;
  card: AgentCard;
  lastSeen: number;
}

export type FederationExportPolicy = 'none' | 'selective' | 'full';

export interface FederationRealmPolicyConfig {
  exportPolicy?: FederationExportPolicy;
  selectiveVisibilityValue?: string;
}

export interface FederationConfig {
  maxHops: number;
  healthCheckInterval: number;
  connectionTimeout: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  maxReconnectAttempts: number;
  exportPolicy: FederationExportPolicy;
  selectiveVisibilityValue: string;
  realmPolicies: Record<string, FederationRealmPolicyConfig>;
}

const DEFAULT_FEDERATION_CONFIG: FederationConfig = {
  maxHops: 3,
  healthCheckInterval: 30000,
  connectionTimeout: 10000,
  reconnectDelay: 5000,
  maxReconnectDelay: 60000,
  maxReconnectAttempts: 5,
  exportPolicy: 'full',
  selectiveVisibilityValue: 'public',
  realmPolicies: {},
};

function normalizeFederatedEnvelope(envelope: Uint8Array | number[]): Uint8Array {
  return envelope instanceof Uint8Array ? envelope : Uint8Array.from(envelope);
}

export class FederationManager {
  private relayIdentity: RelayIdentity;
  private registry: AgentRegistry;
  private config: FederationConfig;
  private federatedRelays = new Map<string, FederatedRelay>();
  private remoteAgentRoutes = new Map<string, FederatedAgentRoute>();
  private exportedLocalAgents = new Set<string>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    relayIdentity: RelayIdentity,
    registry: AgentRegistry,
    config: Partial<FederationConfig> = {}
  ) {
    this.relayIdentity = relayIdentity;
    this.registry = registry;
    this.config = { ...DEFAULT_FEDERATION_CONFIG, ...config };
  }

  /**
   * Start federation - discover other relays and establish connections
   */
  async start(): Promise<void> {
    console.log('Starting federation manager...');

    this.discoveryTimer = setInterval(() => {
      this.discoverRelays().catch(console.error);
    }, 60000);

    this.healthCheckTimer = setInterval(() => {
      this.performHealthChecks().catch(console.error);
    }, this.config.healthCheckInterval);

    await this.discoverRelays();

    console.log('✓ Federation manager started');
  }

  /**
   * Stop federation - close all connections and timers
   */
  async stop(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    for (const relay of this.federatedRelays.values()) {
      if (relay.reconnectTimer) {
        clearTimeout(relay.reconnectTimer);
        relay.reconnectTimer = null;
      }

      if (relay.ws && relay.ws.readyState === WebSocket.OPEN) {
        relay.ws.close();
      }
    }

    this.federatedRelays.clear();
    this.remoteAgentRoutes.clear();
    this.exportedLocalAgents.clear();
    console.log('Federation manager stopped');
  }

  /**
   * Discover other relays using the standard agent discovery mechanism
   */
  private async discoverRelays(): Promise<void> {
    try {
      const { agents } = this.registry.searchByCapability('relay/message-routing', undefined, 50);
      const myDid = this.relayIdentity.getIdentity().did;

      for (const agent of agents) {
        if (agent.did === myDid) continue;
        if (this.federatedRelays.has(agent.did)) continue;
        await this.connectToRelay(agent.did, agent.card);
      }
    } catch (err) {
      console.error('Error discovering relays:', err);
    }
  }

  async connectToSeedRelay(seedEndpoint: string): Promise<boolean> {
    console.log(`Connecting to seed relay at ${seedEndpoint}`);
    return await this.openFederationConnection(seedEndpoint);
  }

  /**
   * Connect to a discovered relay
   */
  private async connectToRelay(relayDid: string, relayCard: AgentCard): Promise<boolean> {
    try {
      if (relayDid === this.relayIdentity.getIdentity().did) {
        return false;
      }

      const wsEndpoints = relayCard.endpoints.filter(ep => ep.startsWith('ws://') || ep.startsWith('wss://'));

      if (wsEndpoints.length === 0) {
        console.warn(`No WebSocket endpoints found for relay ${relayDid}`);
        return false;
      }

      const existing = this.federatedRelays.get(relayDid);
      if (existing?.connected && existing.ws?.readyState === WebSocket.OPEN) {
        return true;
      }

      if (existing?.connecting) {
        return false;
      }

      const endpoint = wsEndpoints[0];
      this.federatedRelays.set(relayDid, {
        did: relayDid,
        endpoints: wsEndpoints,
        card: relayCard,
        ws: existing?.ws ?? null,
        lastSeen: existing?.lastSeen ?? Date.now(),
        connected: false,
        connecting: true,
        reconnectAttempts: existing?.reconnectAttempts ?? 0,
        reconnectTimer: existing?.reconnectTimer ?? null,
        agentCount: existing?.agentCount ?? 0,
        uptime: existing?.uptime ?? 0,
      });

      console.log(`Connecting to relay ${relayDid} at ${endpoint}`);
      const connected = await this.openFederationConnection(endpoint, relayDid, relayCard);
      const current = this.federatedRelays.get(relayDid);
      if (current && !current.connected) {
        current.connecting = false;
      }
      return connected;
    } catch (err) {
      console.error(`Failed to connect to relay ${relayDid}:`, err);
      const relay = this.federatedRelays.get(relayDid);
      if (relay) {
        relay.connecting = false;
      }
      return false;
    }
  }

  private async verifyRelayCard(relayDid: string, relayCard: AgentCard): Promise<boolean> {
    const { verifyAgentCard, verify, extractPublicKey } = await import('@quadra-a/protocol');
    const relayPublicKey = extractPublicKey(relayDid);
    return await verifyAgentCard(relayCard as any, (sig, data) => verify(sig, data, relayPublicKey));
  }

  private registerFederatedRelay(relayDid: string, relayCard: AgentCard, endpoints: string[], ws: WebSocket): void {
    const existing = this.federatedRelays.get(relayDid);
    if (existing?.ws && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(4001, 'Replaced by new federation connection');
    }

    if (existing?.reconnectTimer) {
      clearTimeout(existing.reconnectTimer);
    }

    this.federatedRelays.set(relayDid, {
      did: relayDid,
      endpoints,
      card: relayCard,
      ws,
      lastSeen: Date.now(),
      connected: true,
      connecting: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      agentCount: existing?.agentCount ?? 0,
      uptime: existing?.uptime ?? 0,
    });
  }

  private scheduleReconnection(relayDid: string): void {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay || relay.reconnectTimer) {
      return;
    }

    const reconnectAttempts = relay.reconnectAttempts ?? 0;
    if (reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.warn(`Reached max reconnect attempts for relay ${relayDid}; waiting for discovery before retrying`);
      this.federatedRelays.delete(relayDid);
      this.removeRemoteAgentRoutesForRelay(relayDid);
      return;
    }

    const delay = Math.min(
      this.config.reconnectDelay * (2 ** reconnectAttempts),
      this.config.maxReconnectDelay,
    );

    relay.reconnectAttempts = reconnectAttempts + 1;
    relay.reconnectTimer = setTimeout(() => {
      const current = this.federatedRelays.get(relayDid);
      if (current) {
        current.reconnectTimer = null;
      }

      this.attemptReconnection(relayDid).catch(console.error);
    }, delay);
  }

  private getConnectedRelay(relayDid: string): FederatedRelay | null {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay || !relay.connected || !relay.ws || relay.ws.readyState !== WebSocket.OPEN) {
      return null;
    }
    return relay;
  }

  private getSelectiveVisibility(card: AgentCard, selectiveVisibilityValue: string): string | null {
    const metadata = card.metadata ?? {};
    if (typeof metadata.visibility === 'string') {
      return metadata.visibility;
    }
    if (typeof metadata.federationVisibility === 'string') {
      return metadata.federationVisibility;
    }
    if (selectiveVisibilityValue === 'public' && (metadata.public === true || metadata.federate === true)) {
      return 'public';
    }
    return null;
  }

  private getRealmPolicy(realm: string): { exportPolicy: FederationExportPolicy; selectiveVisibilityValue: string } {
    const realmPolicy = this.config.realmPolicies[realm] ?? {};
    return {
      exportPolicy: realmPolicy.exportPolicy ?? this.config.exportPolicy,
      selectiveVisibilityValue: realmPolicy.selectiveVisibilityValue ?? this.config.selectiveVisibilityValue,
    };
  }

  private shouldExportAgent(card: AgentCard, realm: string): boolean {
    const realmPolicy = this.getRealmPolicy(realm);

    switch (realmPolicy.exportPolicy) {
      case 'full':
        return true;
      case 'none':
        return false;
      case 'selective':
        return this.getSelectiveVisibility(card, realmPolicy.selectiveVisibilityValue) === realmPolicy.selectiveVisibilityValue;
      default:
        return false;
    }
  }

  private upsertRemoteAgentRoute(relayDid: string, msg: AgentJoinedMessage): void {
    this.remoteAgentRoutes.set(msg.agentDid, {
      relayDid,
      realm: msg.realm,
      card: msg.agentCard,
      lastSeen: Date.now(),
    });
  }

  private removeRemoteAgentRoute(agentDid: string, relayDid: string): void {
    const existing = this.remoteAgentRoutes.get(agentDid);
    if (existing?.relayDid === relayDid) {
      this.remoteAgentRoutes.delete(agentDid);
    }
  }

  private removeRemoteAgentRoutesForRelay(relayDid: string): void {
    for (const [agentDid, route] of this.remoteAgentRoutes.entries()) {
      if (route.relayDid === relayDid) {
        this.remoteAgentRoutes.delete(agentDid);
      }
    }
  }

  listRemoteDirectoryEntries(): DirectoryAgentEntry[] {
    return Array.from(this.remoteAgentRoutes.entries()).map(([did, route]) => ({
      did,
      card: route.card,
      online: true,
      discoverable: true,
      visibilityRealm: route.realm,
      lastSeen: route.lastSeen,
      homeRelay: route.relayDid,
    }));
  }

  getRemoteAgentCard(did: string, requesterRealm = 'public'): AgentCard | null {
    const route = this.remoteAgentRoutes.get(did);
    if (!route) {
      return null;
    }

    if (route.realm !== requesterRealm) {
      return null;
    }

    return route.card;
  }

  private advertiseCurrentAgentsToRelay(ws: WebSocket): void {
    const relayDid = this.relayIdentity.getIdentity().did;

    for (const agent of this.registry.listAgents()) {
      if (!agent.online) continue;
      if (agent.did === relayDid) continue;
      if (!this.shouldExportAgent(agent.card, agent.realm)) continue;

      this.exportedLocalAgents.add(agent.did);
      const joined: AgentJoinedMessage = {
        type: 'AGENT_JOINED',
        agentDid: agent.did,
        agentCard: agent.card,
        realm: agent.realm,
        timestamp: Date.now(),
      };
      ws.send(encodeCBOR(joined));
    }
  }

  private async openFederationConnection(
    endpoint: string,
    expectedRelayDid?: string,
    expectedRelayCard?: AgentCard,
  ): Promise<boolean> {
    return await new Promise((resolve) => {
      let settled = false;
      let connectedRelayDid = expectedRelayDid;
      const ws = new WebSocket(endpoint);

      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        console.warn(`Connection timeout to relay ${expectedRelayDid ?? endpoint}`);
        ws.close();
        finish(false);
      }, this.config.connectionTimeout);

      const initialMessageHandler = async (data: Buffer): Promise<void> => {
        try {
          const msg: RelayMessage = decodeCBOR(data);
          if (msg.type !== 'FEDERATION_WELCOME') {
            return;
          }

          const welcome = msg as FederationWelcomeMessage;
          const relayDid = welcome.relayDid;
          const relayCard = welcome.relayCard ?? expectedRelayCard;
          const relayEndpoints = welcome.endpoints?.length ? welcome.endpoints : relayCard?.endpoints ?? [endpoint];

          if (!relayCard) {
            console.warn(`Seed relay ${relayDid} did not return a relay card`);
            ws.close(1008, 'Missing relay card in federation welcome');
            finish(false);
            return;
          }

          if (expectedRelayDid && relayDid !== expectedRelayDid) {
            console.warn(`Relay DID mismatch: expected ${expectedRelayDid}, got ${relayDid}`);
            ws.close(1008, 'Relay DID mismatch');
            finish(false);
            return;
          }

          const isValidCard = await this.verifyRelayCard(relayDid, relayCard);
          if (!isValidCard) {
            console.warn(`Invalid relay card from ${relayDid}`);
            ws.close(1008, 'Invalid relay card');
            finish(false);
            return;
          }

          connectedRelayDid = relayDid;
          this.registerFederatedRelay(relayDid, relayCard, relayEndpoints, ws);
          ws.off('message', initialMessageHandler);
          this.setupFederationHandlers(ws, relayDid);
          await this.handleFederationWelcome(relayDid, welcome);
          this.advertiseCurrentAgentsToRelay(ws);
          finish(true);
        } catch (err) {
          console.error(`Error handling federation handshake from ${expectedRelayDid ?? endpoint}:`, err);
          ws.close(1011, 'Federation handshake failed');
          finish(false);
        }
      };

      ws.on('open', async () => {
        try {
          console.log(`✓ Connected to relay ${expectedRelayDid ?? endpoint}`);
          await this.sendFederationHello(ws);
        } catch (err) {
          console.error(`Failed to send federation hello to ${expectedRelayDid ?? endpoint}:`, err);
          ws.close(1011, 'Could not send federation hello');
          finish(false);
        }
      });

      ws.on('message', initialMessageHandler);

      ws.on('error', (err) => {
        console.error(`Error connecting to relay ${expectedRelayDid ?? endpoint}:`, err.message);
        finish(false);
      });

      ws.on('close', () => {
        if (connectedRelayDid) {
          this.handleRelayDisconnection(connectedRelayDid);
        }
        finish(false);
      });
    });
  }

  /**
   * Send federation hello to establish relay-to-relay connection
   */
  private async sendFederationHello(ws: WebSocket): Promise<void> {
    const identity = this.relayIdentity.getIdentity();
    const now = Date.now();

    const hello: FederationHelloMessage = {
      type: 'FEDERATION_HELLO',
      relayDid: identity.did,
      relayCard: identity.agentCard,
      endpoints: identity.agentCard.endpoints,
      timestamp: now,
      signature: [],
    };

    const helloData = encodeCBOR({
      relayDid: hello.relayDid,
      relayCard: hello.relayCard,
      endpoints: hello.endpoints,
      timestamp: hello.timestamp,
    });

    const signature = await this.relayIdentity.sign(helloData);
    hello.signature = Array.from(signature);

    ws.send(encodeCBOR(hello));
  }

  async acceptIncomingRelay(ws: WebSocket, msg: FederationHelloMessage): Promise<{ ok: boolean; relayDid?: string; error?: string }> {
    try {
      const { verify, extractPublicKey } = await import('@quadra-a/protocol');
      const relayPublicKey = extractPublicKey(msg.relayDid);
      const isValidCard = await this.verifyRelayCard(msg.relayDid, msg.relayCard);
      if (!isValidCard) {
        return { ok: false, error: 'Invalid federation relay card signature' };
      }

      const helloData = encodeCBOR({
        relayDid: msg.relayDid,
        relayCard: msg.relayCard,
        endpoints: msg.endpoints,
        timestamp: msg.timestamp,
      });
      const signature = Array.isArray(msg.signature) ? new Uint8Array(msg.signature) : msg.signature;
      const isValidHello = await verify(signature, helloData, relayPublicKey);
      if (!isValidHello) {
        return { ok: false, error: 'Invalid federation hello signature' };
      }

      this.registerFederatedRelay(msg.relayDid, msg.relayCard, msg.endpoints, ws);

      const identity = this.relayIdentity.getIdentity();
      const welcome: FederationWelcomeMessage = {
        type: 'FEDERATION_WELCOME',
        relayDid: identity.did,
        peers: Array.from(this.federatedRelays.keys()).filter((did) => did !== msg.relayDid),
        protocolVersion: 1,
        relayCard: identity.agentCard,
        endpoints: identity.agentCard.endpoints,
      };
      ws.send(encodeCBOR(welcome));
      this.advertiseCurrentAgentsToRelay(ws);

      return { ok: true, relayDid: msg.relayDid };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async handleIncomingMessage(ws: WebSocket, relayDid: string, msg: RelayMessage): Promise<void> {
    await this.handleFederationMessage(ws, relayDid, msg);
  }

  handleIncomingDisconnect(relayDid: string): void {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay) return;

    relay.connected = false;
    relay.connecting = false;
    relay.ws = null;
    relay.lastSeen = Date.now();
    this.removeRemoteAgentRoutesForRelay(relayDid);
  }

  /**
   * Setup message handlers for federation connection
   */
  private setupFederationHandlers(ws: WebSocket, relayDid: string): void {
    ws.on('message', async (data: Buffer) => {
      try {
        const msg: RelayMessage = decodeCBOR(data);
        await this.handleFederationMessage(ws, relayDid, msg);
      } catch (err) {
        console.error(`Error handling federation message from ${relayDid}:`, err);
      }
    });
  }

  /**
   * Handle messages from federated relays
   */
  private async handleFederationMessage(ws: WebSocket, relayDid: string, msg: RelayMessage): Promise<void> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay) return;

    relay.lastSeen = Date.now();

    switch (msg.type) {
      case 'FEDERATION_WELCOME':
        await this.handleFederationWelcome(relayDid, msg as FederationWelcomeMessage);
        break;

      case 'AGENT_JOINED':
        await this.handleAgentJoined(relayDid, msg as AgentJoinedMessage);
        break;

      case 'AGENT_LEFT':
        await this.handleAgentLeft(relayDid, msg as AgentLeftMessage);
        break;

      case 'ROUTE_REQUEST':
        await this.handleRouteRequest(ws, relayDid, msg as RouteRequestMessage);
        break;

      case 'ROUTE_RESPONSE':
        await this.handleRouteResponse(relayDid, msg as RouteResponseMessage);
        break;

      case 'FEDERATION_HEALTH_CHECK':
        await this.handleFederationHealthCheck(ws, relayDid, msg as FederationHealthCheckMessage);
        break;

      case 'FEDERATION_HEALTH_RESPONSE':
        await this.handleFederationHealthResponse(relayDid, msg as FederationHealthResponseMessage);
        break;

      default:
        console.warn(`Unknown federation message type: ${msg.type}`);
    }
  }

  /**
   * Handle federation welcome message
   */
  private async handleFederationWelcome(relayDid: string, msg: FederationWelcomeMessage): Promise<void> {
    console.log(`Received federation welcome from ${relayDid}`);

    const relay = this.federatedRelays.get(relayDid);
    if (relay) {
      relay.connected = true;
      if (msg.relayCard) {
        relay.card = msg.relayCard;
      }
      if (msg.endpoints?.length) {
        relay.endpoints = msg.endpoints;
      }
    }

    for (const peerDid of msg.peers) {
      if (peerDid !== this.relayIdentity.getIdentity().did && !this.federatedRelays.has(peerDid)) {
        const peerAgent = this.registry.get(peerDid);
        if (peerAgent) {
          await this.connectToRelay(peerDid, peerAgent.card);
        }
      }
    }
  }

  /**
   * Handle agent joined notification from federated relay
   */
  private async handleAgentJoined(relayDid: string, msg: AgentJoinedMessage): Promise<void> {
    console.log(`Agent ${msg.agentDid} joined relay ${relayDid}`);
    this.upsertRemoteAgentRoute(relayDid, msg);
  }

  /**
   * Handle agent left notification from federated relay
   */
  private async handleAgentLeft(relayDid: string, msg: AgentLeftMessage): Promise<void> {
    console.log(`Agent ${msg.agentDid} left relay ${relayDid}`);
    this.removeRemoteAgentRoute(msg.agentDid, relayDid);
  }

  /**
   * Handle cross-relay route request
   */
  private async handleRouteRequest(ws: WebSocket, fromRelayDid: string, msg: RouteRequestMessage): Promise<void> {
    if (msg.hopCount >= this.config.maxHops) {
      const response: RouteResponseMessage = {
        type: 'ROUTE_RESPONSE',
        messageId: msg.messageId,
        status: 'hop_limit_exceeded',
      };
      ws.send(encodeCBOR(response));
      return;
    }

    const targetAgent = this.registry.get(msg.targetDid);
    if (targetAgent && targetAgent.online) {
      if (!this.shouldExportAgent(targetAgent.card, targetAgent.realm)) {
        const response: RouteResponseMessage = {
          type: 'ROUTE_RESPONSE',
          messageId: msg.messageId,
          status: 'not_found',
        };
        ws.send(encodeCBOR(response));
        return;
      }

      try {
        const deliver = {
          type: 'DELIVER',
          messageId: msg.messageId,
          from: `relay:${fromRelayDid}`,
          envelope: normalizeFederatedEnvelope(msg.envelope),
        };

        targetAgent.ws.send(encodeCBOR(deliver));

        const response: RouteResponseMessage = {
          type: 'ROUTE_RESPONSE',
          messageId: msg.messageId,
          status: 'delivered',
          targetRelay: this.relayIdentity.getIdentity().did,
        };
        ws.send(encodeCBOR(response));
      } catch {
        const response: RouteResponseMessage = {
          type: 'ROUTE_RESPONSE',
          messageId: msg.messageId,
          status: 'not_found',
        };
        ws.send(encodeCBOR(response));
      }
      return;
    }

    let forwarded = false;
    for (const [relayDid, relay] of this.federatedRelays) {
      if (relayDid !== fromRelayDid && relay.ws && relay.connected && relay.ws.readyState === WebSocket.OPEN) {
        const forwardedRequest: RouteRequestMessage = {
          ...msg,
          hopCount: msg.hopCount + 1,
          fromRelay: this.relayIdentity.getIdentity().did,
        };
        relay.ws.send(encodeCBOR(forwardedRequest));
        forwarded = true;
        break;
      }
    }

    if (!forwarded) {
      const response: RouteResponseMessage = {
        type: 'ROUTE_RESPONSE',
        messageId: msg.messageId,
        status: 'not_found',
      };
      ws.send(encodeCBOR(response));
    }
  }

  /**
   * Handle route response from federated relay
   */
  private async handleRouteResponse(relayDid: string, msg: RouteResponseMessage): Promise<void> {
    console.log(`Route response from ${relayDid}: ${msg.status} for message ${msg.messageId}`);
  }

  /**
   * Handle federation health check
   */
  private async handleFederationHealthCheck(ws: WebSocket, _relayDid: string, _msg: FederationHealthCheckMessage): Promise<void> {
    const response: FederationHealthResponseMessage = {
      type: 'FEDERATION_HEALTH_RESPONSE',
      uptime: process.uptime() * 1000,
      connectedAgents: this.registry.getOnlineCount(),
      queuedMessages: 0,
      timestamp: Date.now(),
    };

    ws.send(encodeCBOR(response));
  }

  /**
   * Handle federation health response
   */
  private async handleFederationHealthResponse(relayDid: string, msg: FederationHealthResponseMessage): Promise<void> {
    const relay = this.federatedRelays.get(relayDid);
    if (relay) {
      relay.uptime = msg.uptime;
      relay.agentCount = msg.connectedAgents;
      relay.lastSeen = Date.now();
    }
  }

  /**
   * Handle relay disconnection
   */
  private handleRelayDisconnection(relayDid: string): void {
    const relay = this.federatedRelays.get(relayDid);
    if (relay) {
      const shouldScheduleReconnect = !relay.reconnectTimer;

      relay.connected = false;
      relay.connecting = false;
      relay.ws = null;
      relay.lastSeen = Date.now();
      this.removeRemoteAgentRoutesForRelay(relayDid);
      console.log(`Relay ${relayDid} disconnected`);

      if (shouldScheduleReconnect) {
        this.scheduleReconnection(relayDid);
      }
    }
  }

  /**
   * Attempt to reconnect to a disconnected relay
   */
  private async attemptReconnection(relayDid: string): Promise<void> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay || relay.connected || relay.connecting) return;

    console.log(`Attempting to reconnect to relay ${relayDid}`);

    let connected = false;
    if (relay.card) {
      connected = await this.connectToRelay(relayDid, relay.card);
    } else {
      const relayAgent = this.registry.get(relayDid);
      if (relayAgent) {
        connected = await this.connectToRelay(relayDid, relayAgent.card);
      } else {
        this.federatedRelays.delete(relayDid);
        this.removeRemoteAgentRoutesForRelay(relayDid);
        return;
      }
    }

    const current = this.federatedRelays.get(relayDid);
    if (!connected && current && !current.connected && !current.reconnectTimer) {
      this.scheduleReconnection(relayDid);
    }
  }

  /**
   * Perform health checks on all federated relays
   */
  private async performHealthChecks(): Promise<void> {
    const healthCheck: FederationHealthCheckMessage = {
      type: 'FEDERATION_HEALTH_CHECK',
      timestamp: Date.now(),
    };

    for (const relay of this.federatedRelays.values()) {
      if (relay.ws && relay.connected && relay.ws.readyState === WebSocket.OPEN) {
        relay.ws.send(encodeCBOR(healthCheck));
      }
    }

    const now = Date.now();
    const staleThreshold = this.config.healthCheckInterval * 3;

    for (const [relayDid, relay] of this.federatedRelays) {
      if (now - relay.lastSeen > staleThreshold) {
        console.warn(`Relay ${relayDid} appears stale, disconnecting`);
        if (relay.ws) {
          relay.ws.close();
        }
        this.handleRelayDisconnection(relayDid);
      }
    }
  }

  /**
   * Route a message to another relay if the target agent is not local
   */
  async routeToFederation(targetDid: string, envelope: Uint8Array, _fromDid: string): Promise<boolean> {
    if (this.federatedRelays.size === 0) {
      return false;
    }

    const messageId = Math.random().toString(36).slice(2);
    const routeRequest: RouteRequestMessage = {
      type: 'ROUTE_REQUEST',
      targetDid,
      envelope: normalizeFederatedEnvelope(envelope),
      fromRelay: this.relayIdentity.getIdentity().did,
      hopCount: 0,
      messageId,
    };

    const knownRoute = this.remoteAgentRoutes.get(targetDid);
    if (knownRoute) {
      const preferredRelay = this.getConnectedRelay(knownRoute.relayDid);
      if (preferredRelay?.ws) {
        preferredRelay.ws.send(encodeCBOR(routeRequest));
        console.log(`Routed message to known relay ${knownRoute.relayDid} for ${targetDid}`);
        return true;
      }
      this.remoteAgentRoutes.delete(targetDid);
    }

    for (const [relayDid, relay] of this.federatedRelays) {
      if (relay.ws && relay.connected && relay.ws.readyState === WebSocket.OPEN) {
        relay.ws.send(encodeCBOR(routeRequest));
        console.log(`Routed message to federation via relay ${relayDid}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Notify federation when an agent joins this relay
   */
  notifyAgentJoined(agentDid: string, agentCard: AgentCard, realm: string): void {
    if (!this.shouldExportAgent(agentCard, realm)) {
      if (this.exportedLocalAgents.has(agentDid)) {
        this.notifyAgentLeft(agentDid, realm);
      }
      return;
    }

    this.exportedLocalAgents.add(agentDid);

    const notification: AgentJoinedMessage = {
      type: 'AGENT_JOINED',
      agentDid,
      agentCard,
      realm,
      timestamp: Date.now(),
    };

    this.broadcastToFederation(notification);
  }

  /**
   * Notify federation when an agent leaves this relay
   */
  notifyAgentLeft(agentDid: string, realm: string): void {
    if (!this.exportedLocalAgents.delete(agentDid)) {
      return;
    }

    const notification: AgentLeftMessage = {
      type: 'AGENT_LEFT',
      agentDid,
      realm,
      timestamp: Date.now(),
    };

    this.broadcastToFederation(notification);
  }

  /**
   * Broadcast a message to all federated relays
   */
  private broadcastToFederation(message: RelayMessage): void {
    const encoded = encodeCBOR(message);

    for (const relay of this.federatedRelays.values()) {
      if (relay.ws && relay.connected && relay.ws.readyState === WebSocket.OPEN) {
        relay.ws.send(encoded);
      }
    }
  }

  /**
   * Get federation status
   */
  getFederationStatus(): { relayCount: number; connectedRelays: string[]; totalAgents: number } {
    const connectedRelays = Array.from(this.federatedRelays.entries())
      .filter(([_, relay]) => relay.connected)
      .map(([did]) => did);

    const totalAgents = Array.from(this.federatedRelays.values())
      .reduce((sum, relay) => sum + relay.agentCount, 0);

    return {
      relayCount: this.federatedRelays.size,
      connectedRelays,
      totalAgents,
    };
  }
}
