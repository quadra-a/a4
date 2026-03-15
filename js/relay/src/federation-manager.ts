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
import type { ClaimedPreKeyBundle } from './types.js';
import type { ConnectionContext } from './relay-agent-types.js';
import type {
  CardMessage,
  FederationHelloMessage,
  FederationAdmittedMessage,
  FederationWelcomeMessage,
  AgentJoinedMessage,
  AgentLeftMessage,
  FetchCardMessage,
  FetchPreKeyBundleMessage,
  PreKeyBundleMessage,
  RouteRequestMessage,
  RouteResponseMessage,
  FederationHealthCheckMessage,
  FederationHealthResponseMessage,
  RelayMessage,
  AgentCard,
} from './types.js';

export type FederationAdmissionState = 'connecting' | 'authenticated' | 'probation' | 'admitted';

interface PendingPeerProbe<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface RelayEligibilityResult {
  ok: boolean;
  endpoints: string[];
  error?: string;
}

interface SlidingWindowCounter {
  count: number;
  windowStart: number;
}

interface FederationAdmissionGuardResult {
  ok: boolean;
  error?: string;
  closeCode?: number;
}

const REQUIRED_RELAY_CAPABILITIES = [
  'relay/message-routing',
  'relay/discovery',
  'relay/health-check',
  'relay/federation',
] as const;

const PROBATIONARY_MESSAGE_TYPES = new Set<string>([
  'FEDERATION_WELCOME',
  'FEDERATION_ADMITTED',
  'FEDERATION_HEALTH_CHECK',
  'FEDERATION_HEALTH_RESPONSE',
  'FETCH_CARD',
  'CARD',
]);

interface FederationPreKeyStore {
  claimBundle(did: string, deviceId: string, requesterRealm: string): Promise<ClaimedPreKeyBundle | null>;
}

function isWebSocketEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('ws://') || endpoint.startsWith('wss://');
}

function normalizeRelayEndpoints(endpoints: string[]): string[] {
  return Array.from(new Set(endpoints
    .map((endpoint) => endpoint.trim())
    .filter(Boolean)
    .filter(isWebSocketEndpoint)));
}

export interface FederatedRelay {
  did: string;
  endpoints: string[];
  card?: AgentCard;
  ws: WebSocket | null;
  inbound?: boolean;
  sourceIp?: string;
  lastSeen: number;
  connected: boolean;
  admissionState?: FederationAdmissionState;
  admittedByPeer?: boolean;
  connecting?: boolean;
  reconnectAttempts?: number;
  reconnectTimer?: NodeJS.Timeout | null;
  probationTimer?: NodeJS.Timeout | null;
  agentCount: number;
  uptime: number;
  pendingPeerDids?: string[];
  admissionError?: string | null;
  eligibilityCheckedAt?: number;
  lastHealthCheckAt?: number;
  lastHealthResponseAt?: number;
  lastProbeStartedAt?: number;
  lastProbeSucceededAt?: number;
  violationCount?: number;
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
  handshakeRateLimitWindowMs: number;
  handshakeRateLimitMaxAttempts: number;
  failedHandshakeWindowMs: number;
  failedHandshakeThreshold: number;
  failedHandshakeQuarantineMs: number;
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
  handshakeRateLimitWindowMs: 60000,
  handshakeRateLimitMaxAttempts: 5,
  failedHandshakeWindowMs: 300000,
  failedHandshakeThreshold: 3,
  failedHandshakeQuarantineMs: 300000,
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
  private pendingHealthChecks = new Map<string, PendingPeerProbe<void>>();
  private pendingCardFetches = new Map<string, PendingPeerProbe<CardMessage> & { did: string }>();
  private pendingPreKeyFetches = new Map<string, PendingPeerProbe<PreKeyBundleMessage> & {
    relayDid: string;
    did: string;
    deviceId: string;
  }>();
  private inboundHandshakeAttemptsByIp = new Map<string, SlidingWindowCounter>();
  private inboundHandshakeAttemptsByDid = new Map<string, SlidingWindowCounter>();
  private inboundHandshakeFailuresByIp = new Map<string, SlidingWindowCounter>();
  private inboundHandshakeFailuresByDid = new Map<string, SlidingWindowCounter>();
  private quarantinedSourceIps = new Map<string, number>();
  private quarantinedRelayDids = new Map<string, number>();

  constructor(
    relayIdentity: RelayIdentity,
    registry: AgentRegistry,
    config: Partial<FederationConfig> = {},
    private preKeyStore: FederationPreKeyStore | null = null,
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

      if (relay.probationTimer) {
        clearTimeout(relay.probationTimer);
        relay.probationTimer = null;
      }

      if (relay.ws && relay.ws.readyState === WebSocket.OPEN) {
        relay.ws.close();
      }
    }

    for (const pending of this.pendingHealthChecks.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Federation manager stopped'));
    }
    this.pendingHealthChecks.clear();

    for (const pending of this.pendingCardFetches.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Federation manager stopped'));
    }
    this.pendingCardFetches.clear();

    for (const pending of this.pendingPreKeyFetches.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Federation manager stopped'));
    }
    this.pendingPreKeyFetches.clear();
    this.inboundHandshakeAttemptsByIp.clear();
    this.inboundHandshakeAttemptsByDid.clear();
    this.inboundHandshakeFailuresByIp.clear();
    this.inboundHandshakeFailuresByDid.clear();
    this.quarantinedSourceIps.clear();
    this.quarantinedRelayDids.clear();

    this.federatedRelays.clear();
    this.remoteAgentRoutes.clear();
    this.exportedLocalAgents.clear();
    console.log('Federation manager stopped');
  }

  private isLocallyAdmitted(relay: FederatedRelay | null | undefined): boolean {
    if (!relay?.connected) {
      return false;
    }

    if (!relay.admissionState) {
      return true;
    }

    return relay.admissionState === 'admitted';
  }

  private isDataPlaneActive(relay: FederatedRelay | null | undefined): boolean {
    if (!relay?.connected) {
      return false;
    }

    if (!relay.admissionState) {
      return true;
    }

    return relay.admissionState === 'admitted' && relay.admittedByPeer === true;
  }

  private validateRelayEligibility(relayDid: string, relayCard: AgentCard, announcedEndpoints?: string[]): RelayEligibilityResult {
    if (relayCard.did !== relayDid) {
      return { ok: false, endpoints: [], error: 'Relay DID mismatch' };
    }

    const capabilityIds = new Set(relayCard.capabilities.map((capability) => capability.id));
    const missingCapabilities = REQUIRED_RELAY_CAPABILITIES.filter((capability) => !capabilityIds.has(capability));
    if (missingCapabilities.length > 0) {
      return {
        ok: false,
        endpoints: [],
        error: `Relay missing required capabilities: ${missingCapabilities.join(', ')}`,
      };
    }

    const endpoints = normalizeRelayEndpoints([...(announcedEndpoints ?? []), ...relayCard.endpoints]);
    if (endpoints.length === 0) {
      return { ok: false, endpoints: [], error: 'Relay must advertise at least one WebSocket endpoint' };
    }

    return { ok: true, endpoints };
  }

  private normalizeSourceKey(value: string | undefined): string | null {
    const normalized = value?.trim();
    if (!normalized || normalized === 'unknown') {
      return null;
    }
    return normalized;
  }

  private isQuarantined(quarantineMap: Map<string, number>, value: string | undefined): boolean {
    const key = this.normalizeSourceKey(value);
    if (!key) {
      return false;
    }

    const expiresAt = quarantineMap.get(key);
    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= Date.now()) {
      quarantineMap.delete(key);
      return false;
    }

    return true;
  }

  private incrementWindowCounter(counterMap: Map<string, SlidingWindowCounter>, value: string | undefined, windowMs: number): number {
    const key = this.normalizeSourceKey(value);
    if (!key) {
      return 0;
    }

    const now = Date.now();
    const current = counterMap.get(key);
    if (!current || now - current.windowStart >= windowMs) {
      counterMap.set(key, { count: 1, windowStart: now });
      return 1;
    }

    current.count += 1;
    return current.count;
  }

  private clearCounter(counterMap: Map<string, SlidingWindowCounter>, value: string | undefined): void {
    const key = this.normalizeSourceKey(value);
    if (key) {
      counterMap.delete(key);
    }
  }

  private clearQuarantine(quarantineMap: Map<string, number>, value: string | undefined): void {
    const key = this.normalizeSourceKey(value);
    if (key) {
      quarantineMap.delete(key);
    }
  }

  private guardIncomingFederationHandshake(context: ConnectionContext, relayDid: string): FederationAdmissionGuardResult {
    if (this.isQuarantined(this.quarantinedSourceIps, context.remoteIp) || this.isQuarantined(this.quarantinedRelayDids, relayDid)) {
      return {
        ok: false,
        error: 'Federation handshake temporarily quarantined',
        closeCode: 1013,
      };
    }

    const ipAttempts = this.incrementWindowCounter(
      this.inboundHandshakeAttemptsByIp,
      context.remoteIp,
      this.config.handshakeRateLimitWindowMs,
    );
    const didAttempts = this.incrementWindowCounter(
      this.inboundHandshakeAttemptsByDid,
      relayDid,
      this.config.handshakeRateLimitWindowMs,
    );

    if (ipAttempts > this.config.handshakeRateLimitMaxAttempts || didAttempts > this.config.handshakeRateLimitMaxAttempts) {
      return {
        ok: false,
        error: 'Federation handshake rate limit exceeded',
        closeCode: 1013,
      };
    }

    return { ok: true };
  }

  private recordIncomingFederationFailure(relayDid: string, remoteIp: string | undefined, _reason: string): void {
    const ipFailures = this.incrementWindowCounter(
      this.inboundHandshakeFailuresByIp,
      remoteIp,
      this.config.failedHandshakeWindowMs,
    );
    const didFailures = this.incrementWindowCounter(
      this.inboundHandshakeFailuresByDid,
      relayDid,
      this.config.failedHandshakeWindowMs,
    );

    const now = Date.now();
    if (ipFailures >= this.config.failedHandshakeThreshold) {
      const sourceIp = this.normalizeSourceKey(remoteIp);
      if (sourceIp) {
        this.quarantinedSourceIps.set(sourceIp, now + this.config.failedHandshakeQuarantineMs);
      }
      this.clearCounter(this.inboundHandshakeFailuresByIp, remoteIp);
    }

    if (didFailures >= this.config.failedHandshakeThreshold) {
      const normalizedDid = this.normalizeSourceKey(relayDid);
      if (normalizedDid) {
        this.quarantinedRelayDids.set(normalizedDid, now + this.config.failedHandshakeQuarantineMs);
      }
      this.clearCounter(this.inboundHandshakeFailuresByDid, relayDid);
    }
  }

  private recordSuccessfulIncomingFederationAdmission(relayDid: string, remoteIp: string | undefined): void {
    this.clearCounter(this.inboundHandshakeFailuresByIp, remoteIp);
    this.clearCounter(this.inboundHandshakeFailuresByDid, relayDid);
    this.clearQuarantine(this.quarantinedSourceIps, remoteIp);
    this.clearQuarantine(this.quarantinedRelayDids, relayDid);
  }

  private clearPendingProbe(relayDid: string, errorMessage?: string): void {
    const healthProbe = this.pendingHealthChecks.get(relayDid);
    if (healthProbe) {
      clearTimeout(healthProbe.timeout);
      this.pendingHealthChecks.delete(relayDid);
      if (errorMessage) {
        healthProbe.reject(new Error(errorMessage));
      }
    }

    const cardProbe = this.pendingCardFetches.get(relayDid);
    if (cardProbe) {
      clearTimeout(cardProbe.timeout);
      this.pendingCardFetches.delete(relayDid);
      if (errorMessage) {
        cardProbe.reject(new Error(errorMessage));
      }
    }

    for (const [requestId, pending] of this.pendingPreKeyFetches.entries()) {
      if (pending.relayDid !== relayDid) {
        continue;
      }

      clearTimeout(pending.timeout);
      this.pendingPreKeyFetches.delete(requestId);
      if (errorMessage) {
        pending.reject(new Error(errorMessage));
      }
    }
  }

  private clearProbationTimer(relay: FederatedRelay | undefined): void {
    if (relay?.probationTimer) {
      clearTimeout(relay.probationTimer);
      relay.probationTimer = null;
    }
  }

  private markAdmissionFailure(relayDid: string, error: string): void {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay) {
      return;
    }

    if (relay.inbound) {
      this.recordIncomingFederationFailure(relayDid, relay.sourceIp, error);
    }

    relay.admissionError = error;
    relay.connected = false;
    relay.admissionState = 'probation';
    this.clearProbationTimer(relay);
    this.clearPendingProbe(relayDid, error);
    this.removeRemoteAgentRoutesForRelay(relayDid);
    if (relay.ws && relay.ws.readyState === WebSocket.OPEN) {
      relay.ws.close(1008, 'Federation admission failed');
    }
  }

  private async maybeActivateRelay(relayDid: string): Promise<void> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay || !this.isDataPlaneActive(relay) || !relay.ws || relay.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.advertiseCurrentAgentsToRelay(relay.ws);
    await this.connectPendingPeers(relayDid);
  }

  private async connectPendingPeers(relayDid: string): Promise<void> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay || !relay.pendingPeerDids?.length) {
      return;
    }

    const pendingPeers = [...relay.pendingPeerDids];
    relay.pendingPeerDids = [];
    const localRelayDid = this.relayIdentity.getIdentity().did;

    for (const peerDid of pendingPeers) {
      if (peerDid === localRelayDid || this.federatedRelays.has(peerDid)) {
        continue;
      }

      const peerAgent = this.registry.get(peerDid);
      if (peerAgent) {
        await this.connectToRelay(peerDid, peerAgent.card);
      }
    }
  }

  private async sendFederationAdmitted(relayDid: string): Promise<void> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay?.ws || relay.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const identity = this.relayIdentity.getIdentity();
    const admitted: FederationAdmittedMessage = {
      type: 'FEDERATION_ADMITTED',
      relayDid: identity.did,
      protocolVersion: 1,
      timestamp: Date.now(),
    };

    relay.ws.send(encodeCBOR(admitted));
  }

  private async beginAdmission(relayDid: string): Promise<boolean> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay?.ws || relay.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    relay.admissionState = 'probation';
    relay.admissionError = null;
    relay.lastProbeStartedAt = Date.now();
    this.clearProbationTimer(relay);
    relay.probationTimer = setTimeout(() => {
      this.markAdmissionFailure(relayDid, 'Federation admission timed out');
    }, this.config.connectionTimeout * 2);

    try {
      await this.runAdmissionProbe(relayDid);
      const currentRelay = this.federatedRelays.get(relayDid);
      if (!currentRelay) {
        return false;
      }

      currentRelay.admissionState = 'admitted';
      currentRelay.lastProbeSucceededAt = Date.now();
      currentRelay.admissionError = null;
      if (currentRelay.inbound) {
        this.recordSuccessfulIncomingFederationAdmission(relayDid, currentRelay.sourceIp);
      }
      this.clearProbationTimer(currentRelay);
      await this.sendFederationAdmitted(relayDid);
      await this.maybeActivateRelay(relayDid);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Federation admission failed';
      console.warn(`Federation admission failed for ${relayDid}: ${error}`);
      this.markAdmissionFailure(relayDid, error);
      return false;
    }
  }

  private async runAdmissionProbe(relayDid: string): Promise<void> {
    await this.runHealthProbe(relayDid);
    const cardMessage = await this.runCardProbe(relayDid, relayDid);
    if (!cardMessage.card) {
      throw new Error('Relay admission probe returned no relay card');
    }

    if (cardMessage.did !== relayDid || cardMessage.card.did !== relayDid) {
      throw new Error('Relay admission probe returned mismatched relay card');
    }

    const isValidCard = await this.verifyRelayCard(relayDid, cardMessage.card);
    if (!isValidCard) {
      throw new Error('Relay admission probe returned invalid relay card');
    }

    const eligibility = this.validateRelayEligibility(relayDid, cardMessage.card);
    if (!eligibility.ok) {
      throw new Error(eligibility.error);
    }

    const relay = this.federatedRelays.get(relayDid);
    if (relay) {
      relay.card = cardMessage.card;
      relay.endpoints = eligibility.endpoints;
    }
  }

  private async runHealthProbe(relayDid: string): Promise<void> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay?.ws || relay.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Relay connection unavailable for health probe');
    }

    this.clearPendingProbe(relayDid, 'Federated relay disconnected');
    const healthCheck: FederationHealthCheckMessage = {
      type: 'FEDERATION_HEALTH_CHECK',
      timestamp: Date.now(),
    };

    relay.lastHealthCheckAt = healthCheck.timestamp;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHealthChecks.delete(relayDid);
        reject(new Error('Federation health probe timed out'));
      }, this.config.connectionTimeout);

      this.pendingHealthChecks.set(relayDid, {
        resolve,
        reject,
        timeout,
      });

      relay.ws!.send(encodeCBOR(healthCheck));
    });
  }

  private async runCardProbe(relayDid: string, cardDid: string): Promise<CardMessage> {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay?.ws || relay.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Relay connection unavailable for card probe');
    }

    const fetchCard: FetchCardMessage = {
      type: 'FETCH_CARD',
      did: cardDid,
    };

    return await new Promise<CardMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCardFetches.delete(relayDid);
        reject(new Error('Federation card probe timed out'));
      }, this.config.connectionTimeout);

      this.pendingCardFetches.set(relayDid, {
        did: cardDid,
        resolve,
        reject,
        timeout,
      });

      relay.ws!.send(encodeCBOR(fetchCard));
    });
  }

  async fetchRemotePreKeyBundle(
    did: string,
    deviceId: string,
    requesterRealm = 'public',
  ): Promise<ClaimedPreKeyBundle | null> {
    const route = this.remoteAgentRoutes.get(did);
    if (!route || route.realm !== requesterRealm) {
      return null;
    }

    const relay = this.getConnectedRelay(route.relayDid);
    if (!relay?.ws || relay.ws.readyState !== WebSocket.OPEN) {
      this.remoteAgentRoutes.delete(did);
      return null;
    }

    const requestId = `${route.relayDid}:${did}:${deviceId}:${Math.random().toString(36).slice(2)}`;
    const request: FetchPreKeyBundleMessage = {
      type: 'FETCH_PREKEY_BUNDLE',
      did,
      deviceId,
      requestId,
      requesterRealm,
    };

    const response = await new Promise<PreKeyBundleMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPreKeyFetches.delete(requestId);
        reject(new Error('Federated pre-key fetch timed out'));
      }, this.config.connectionTimeout);

      this.pendingPreKeyFetches.set(requestId, {
        relayDid: route.relayDid,
        did,
        deviceId,
        resolve,
        reject,
        timeout,
      });

      relay.ws!.send(encodeCBOR(request));
    });

    return response.bundle ?? null;
  }

  private isMessageAllowedDuringProbation(msg: RelayMessage): boolean {
    return PROBATIONARY_MESSAGE_TYPES.has(msg.type);
  }

  private recordProtocolViolation(relayDid: string, msg: RelayMessage): void {
    const relay = this.federatedRelays.get(relayDid);
    if (!relay) {
      return;
    }

    relay.violationCount = (relay.violationCount ?? 0) + 1;
    console.warn(`Ignoring ${msg.type} from non-admitted relay ${relayDid}`);
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
        const eligibility = this.validateRelayEligibility(agent.did, agent.card);
        if (!eligibility.ok) continue;
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

      const eligibility = this.validateRelayEligibility(relayDid, relayCard);
      if (!eligibility.ok) {
        console.warn(`Skipping relay ${relayDid}: ${eligibility.error}`);
        return false;
      }

      const wsEndpoints = eligibility.endpoints;

      const existing = this.federatedRelays.get(relayDid);
      if (this.isLocallyAdmitted(existing) && existing?.ws?.readyState === WebSocket.OPEN) {
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
        admissionState: 'connecting',
        admittedByPeer: false,
        connecting: true,
        reconnectAttempts: existing?.reconnectAttempts ?? 0,
        reconnectTimer: existing?.reconnectTimer ?? null,
        probationTimer: null,
        agentCount: existing?.agentCount ?? 0,
        uptime: existing?.uptime ?? 0,
        pendingPeerDids: existing?.pendingPeerDids ?? [],
        admissionError: null,
        eligibilityCheckedAt: Date.now(),
        violationCount: existing?.violationCount ?? 0,
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

  private registerFederatedRelay(
    relayDid: string,
    relayCard: AgentCard,
    endpoints: string[],
    ws: WebSocket,
    admissionState: FederationAdmissionState,
    source?: { inbound: boolean; remoteIp?: string },
  ): void {
    const existing = this.federatedRelays.get(relayDid);
    if (existing?.ws && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(4001, 'Replaced by new federation connection');
    }

    if (existing?.reconnectTimer) {
      clearTimeout(existing.reconnectTimer);
    }

    if (existing?.probationTimer) {
      clearTimeout(existing.probationTimer);
    }

    this.federatedRelays.set(relayDid, {
      did: relayDid,
      endpoints,
      card: relayCard,
      ws,
      inbound: source?.inbound ?? existing?.inbound ?? false,
      sourceIp: source?.remoteIp ?? existing?.sourceIp,
      lastSeen: Date.now(),
      connected: true,
      admissionState,
      admittedByPeer: existing?.admittedByPeer ?? false,
      connecting: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      probationTimer: null,
      agentCount: existing?.agentCount ?? 0,
      uptime: existing?.uptime ?? 0,
      pendingPeerDids: existing?.pendingPeerDids ?? [],
      admissionError: null,
      eligibilityCheckedAt: Date.now(),
      lastHealthCheckAt: existing?.lastHealthCheckAt,
      lastHealthResponseAt: existing?.lastHealthResponseAt,
      lastProbeStartedAt: existing?.lastProbeStartedAt,
      lastProbeSucceededAt: existing?.lastProbeSucceededAt,
      violationCount: existing?.violationCount ?? 0,
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
    if (!this.isDataPlaneActive(relay) || !relay?.ws || relay.ws.readyState !== WebSocket.OPEN) {
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
      const handshakeBacklog: RelayMessage[] = [];
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
            handshakeBacklog.push(msg);
            return;
          }

          const welcome = msg as FederationWelcomeMessage;
          const relayDid = welcome.relayDid;
          const relayCard = welcome.relayCard ?? expectedRelayCard;
          const relayEndpoints = welcome.endpoints?.length ? welcome.endpoints : relayCard?.endpoints ?? [endpoint];

          // Guard against self-connection (e.g. seed relay pointing to ourselves)
          if (relayDid === this.relayIdentity.getIdentity().did) {
            ws.close(1000, 'Self-connection detected');
            finish(false);
            return;
          }

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
            this.federatedRelays.delete(relayDid);
            ws.close(1008, 'Invalid relay card');
            finish(false);
            return;
          }

          const eligibility = this.validateRelayEligibility(relayDid, relayCard, relayEndpoints);
          if (!eligibility.ok) {
            console.warn(`Relay ${relayDid} failed admission eligibility: ${eligibility.error}`);
            this.federatedRelays.delete(relayDid);
            ws.close(1008, 'Relay missing federation prerequisites');
            finish(false);
            return;
          }

          connectedRelayDid = relayDid;
          this.registerFederatedRelay(relayDid, relayCard, eligibility.endpoints, ws, 'authenticated');
          ws.off('message', initialMessageHandler);
          this.setupFederationHandlers(ws, relayDid);
          await this.handleFederationWelcome(relayDid, welcome);

          while (handshakeBacklog.length > 0) {
            const queuedMessage = handshakeBacklog.shift();
            if (!queuedMessage) {
              continue;
            }
            await this.handleFederationMessage(ws, relayDid, queuedMessage);
          }

          finish(await this.beginAdmission(relayDid));
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

  async acceptIncomingRelay(
    ws: WebSocket,
    msg: FederationHelloMessage,
    context: ConnectionContext = { remoteIp: 'unknown', userAgent: 'unknown' },
  ): Promise<{ ok: boolean; relayDid?: string; error?: string; closeCode?: number }> {
    try {
      const guard = this.guardIncomingFederationHandshake(context, msg.relayDid);
      if (!guard.ok) {
        return { ok: false, error: guard.error, closeCode: guard.closeCode };
      }

      const { verify, extractPublicKey } = await import('@quadra-a/protocol');
      const relayPublicKey = extractPublicKey(msg.relayDid);
      const isValidCard = await this.verifyRelayCard(msg.relayDid, msg.relayCard);
      if (!isValidCard) {
        this.recordIncomingFederationFailure(msg.relayDid, context.remoteIp, 'Invalid federation relay card signature');
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
        this.recordIncomingFederationFailure(msg.relayDid, context.remoteIp, 'Invalid federation hello signature');
        return { ok: false, error: 'Invalid federation hello signature' };
      }

      const eligibility = this.validateRelayEligibility(msg.relayDid, msg.relayCard, msg.endpoints);
      if (!eligibility.ok) {
        this.recordIncomingFederationFailure(msg.relayDid, context.remoteIp, eligibility.error ?? 'Relay missing federation prerequisites');
        return { ok: false, error: eligibility.error };
      }

      this.registerFederatedRelay(
        msg.relayDid,
        msg.relayCard,
        eligibility.endpoints,
        ws,
        'authenticated',
        { inbound: true, remoteIp: context.remoteIp },
      );

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

      setTimeout(() => {
        void this.beginAdmission(msg.relayDid).catch((err) => {
          console.error(`Failed to complete federation admission for ${msg.relayDid}:`, err);
        });
      }, 0);

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
    relay.admittedByPeer = false;
    this.clearProbationTimer(relay);
    this.clearPendingProbe(relayDid);
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

    if (!this.isDataPlaneActive(relay) && !this.isMessageAllowedDuringProbation(msg)) {
      this.recordProtocolViolation(relayDid, msg);
      return;
    }

    switch (msg.type) {
      case 'FEDERATION_WELCOME':
        await this.handleFederationWelcome(relayDid, msg as FederationWelcomeMessage);
        break;

      case 'FEDERATION_ADMITTED':
        await this.handleFederationAdmitted(relayDid, msg as FederationAdmittedMessage);
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

      case 'FETCH_CARD':
        await this.handleFederationFetchCard(ws, relayDid, msg as FetchCardMessage);
        break;

      case 'CARD':
        await this.handleFederationCard(relayDid, msg as CardMessage);
        break;

      case 'FETCH_PREKEY_BUNDLE':
        await this.handleFederationFetchPreKeyBundle(ws, relayDid, msg as FetchPreKeyBundleMessage);
        break;

      case 'PREKEY_BUNDLE':
        await this.handleFederationPreKeyBundle(relayDid, msg as PreKeyBundleMessage);
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
      relay.admissionState = relay.admissionState === 'admitted' ? relay.admissionState : 'authenticated';
      if (msg.relayCard) {
        relay.card = msg.relayCard;
      }
      if (msg.endpoints?.length) {
        relay.endpoints = normalizeRelayEndpoints(msg.endpoints);
      }
      relay.pendingPeerDids = msg.peers.filter((peerDid) => peerDid !== this.relayIdentity.getIdentity().did);
    }
  }

  private async handleFederationAdmitted(relayDid: string, _msg: FederationAdmittedMessage): Promise<void> {
    console.log(`Received federation admitted from ${relayDid}`);

    const relay = this.federatedRelays.get(relayDid);
    if (!relay) {
      return;
    }

    relay.admittedByPeer = true;
    await this.maybeActivateRelay(relayDid);
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
      if (relayDid !== fromRelayDid && this.isDataPlaneActive(relay) && relay.ws && relay.ws.readyState === WebSocket.OPEN) {
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

  private async handleFederationFetchCard(ws: WebSocket, _relayDid: string, msg: FetchCardMessage): Promise<void> {
    const identity = this.relayIdentity.getIdentity();
    const response: CardMessage = {
      type: 'CARD',
      did: msg.did,
      card: msg.did === identity.did ? identity.agentCard : null,
    };

    ws.send(encodeCBOR(response));
  }

  private async handleFederationFetchPreKeyBundle(
    ws: WebSocket,
    _relayDid: string,
    msg: FetchPreKeyBundleMessage,
  ): Promise<void> {
    const requesterRealm = typeof msg.requesterRealm === 'string' && msg.requesterRealm.length > 0
      ? msg.requesterRealm
      : 'public';
    const bundle = this.preKeyStore
      ? await this.preKeyStore.claimBundle(msg.did, msg.deviceId, requesterRealm)
      : null;

    const response: PreKeyBundleMessage = {
      type: 'PREKEY_BUNDLE',
      did: msg.did,
      deviceId: msg.deviceId,
      bundle,
      ...(msg.requestId ? { requestId: msg.requestId } : {}),
    };

    ws.send(encodeCBOR(response));
  }

  private async handleFederationCard(relayDid: string, msg: CardMessage): Promise<void> {
    const pending = this.pendingCardFetches.get(relayDid);
    if (!pending || pending.did !== msg.did) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCardFetches.delete(relayDid);
    pending.resolve(msg);
  }

  private async handleFederationPreKeyBundle(relayDid: string, msg: PreKeyBundleMessage): Promise<void> {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
    if (requestId) {
      const pending = this.pendingPreKeyFetches.get(requestId);
      if (!pending || pending.relayDid !== relayDid) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingPreKeyFetches.delete(requestId);
      pending.resolve(msg);
      return;
    }

    for (const [pendingId, pending] of this.pendingPreKeyFetches.entries()) {
      if (pending.relayDid === relayDid && pending.did === msg.did && pending.deviceId === msg.deviceId) {
        clearTimeout(pending.timeout);
        this.pendingPreKeyFetches.delete(pendingId);
        pending.resolve(msg);
        return;
      }
    }
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
      relay.lastHealthResponseAt = Date.now();
    }

    const pending = this.pendingHealthChecks.get(relayDid);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingHealthChecks.delete(relayDid);
      pending.resolve();
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
      relay.admittedByPeer = false;
      this.clearProbationTimer(relay);
      this.clearPendingProbe(relayDid, 'Federated relay disconnected');
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
      if (this.isLocallyAdmitted(relay) && relay.ws && relay.ws.readyState === WebSocket.OPEN) {
        relay.lastHealthCheckAt = healthCheck.timestamp;
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
    const activeRelays = Array.from(this.federatedRelays.values()).filter((relay) => this.isDataPlaneActive(relay));
    if (activeRelays.length === 0) {
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
      if (this.isDataPlaneActive(relay) && relay.ws && relay.ws.readyState === WebSocket.OPEN) {
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
      if (this.isDataPlaneActive(relay) && relay.ws && relay.ws.readyState === WebSocket.OPEN) {
        relay.ws.send(encoded);
      }
    }
  }

  /**
   * Get federation status
   */
  getFederationStatus(): {
    relayCount: number;
    connectedRelays: string[];
    totalAgents: number;
    knownRelayCount: number;
    probationRelays: string[];
  } {
    const connectedRelays = Array.from(this.federatedRelays.entries())
      .filter(([_, relay]) => this.isDataPlaneActive(relay))
      .map(([did]) => did);

    const probationRelays = Array.from(this.federatedRelays.entries())
      .filter(([_, relay]) => relay.connected && !this.isDataPlaneActive(relay))
      .map(([did]) => did);

    const totalAgents = Array.from(this.federatedRelays.values())
      .filter((relay) => this.isDataPlaneActive(relay))
      .reduce((sum, relay) => sum + relay.agentCount, 0);

    return {
      relayCount: connectedRelays.length,
      connectedRelays,
      totalAgents,
      knownRelayCount: this.federatedRelays.size,
      probationRelays,
    };
  }
}
