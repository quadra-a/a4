/**
 * CVP-0011: WebSocket relay client with reconnection logic
 */

import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import { createLogger } from '../utils/logger.js';
import { TransportError } from '../utils/errors.js';
import { extractPublicKey, validateDID } from '../identity/did.js';
import { sign, verify } from '../identity/keys.js';
import type { KeyPair } from '../identity/keys.js';
import { verifyAgentCard } from '../discovery/agent-card.js';
import type { AgentCard, Capability } from '../discovery/agent-card-types.js';
import type { ClaimedPreKeyBundle, PublishedPreKeyBundle } from '../e2e/types.js';
import type {
  RelayMessage,
  HelloMessage,
  WelcomeMessage,
  DeliverMessage,
  DiscoveredAgent,
  DeliveryReportMessage,
  TrustResultMessage,
} from './relay-types.js';

const logger = createLogger('relay-client');

export interface RelayClientConfig {
  relayUrls: string[];
  inviteToken?: string;
  did: string;
  keyPair: KeyPair;
  card: AgentCard;
  autoDiscoverRelays?: boolean;
  targetRelayCount?: number;
  discoveryCapability?: string;
  reconnect?: {
    baseMs?: number;
    jitterMs?: number;
    maxDelayMs?: number;
    stableAfterMs?: number;
  };
}

export type MessageDeliveryHandler = (msg: DeliverMessage) => Promise<void>;
export type DeliveryReportHandler = (msg: DeliveryReportMessage) => void;

export interface RelayReachabilityFailure {
  provider: string;
  attempts: number;
  lastFailureAt: number;
  lastError?: string;
}

export interface RelayReachabilityStatus {
  connectedRelays: string[];
  knownRelays: string[];
  lastDiscoveryAt: number | null;
  relayFailures: RelayReachabilityFailure[];
  targetRelayCount: number;
  autoDiscoverRelays: boolean;
}

export interface RelayClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendEnvelope(toDid: string, envelopeBytes: Uint8Array): Promise<void>;
  discover(input: string | { query?: string; capability?: string }, minTrust?: number, limit?: number): Promise<DiscoveredAgent[]>;
  fetchCard(did: string): Promise<AgentCard | null>;
  publishPreKeyBundles(bundles: PublishedPreKeyBundle[]): Promise<void>;
  fetchPreKeyBundle(did: string, deviceId: string): Promise<ClaimedPreKeyBundle | null>;
  queryTrust(target: string, domain?: string, since?: number, cursor?: string): Promise<TrustResultMessage>;
  publishCard(card?: AgentCard): Promise<void>;
  unpublishCard(): Promise<void>;
  onDeliver(handler: MessageDeliveryHandler): void;
  onDeliveryReport(handler: DeliveryReportHandler): void;
  isConnected(): boolean;
  getConnectedRelays(): string[];
  getKnownRelays(): string[];
  getReachabilityStatus(): RelayReachabilityStatus;
  getPeerCount(): number;
}

interface PendingControlRequest {
  description: string;
  matches: (msg: RelayMessage) => boolean;
  timeout: NodeJS.Timeout;
  resolve: (msg: RelayMessage) => void;
  reject: (error: TransportError) => void;
  queuedMatch: RelayMessage | null;
  allowOutOfBandResponse: boolean;
}

interface RelayConnection {
  url: string;
  ws: WebSocket | null;
  connected: boolean;
  connecting: boolean;
  fatalError: TransportError | null;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  stableTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  peerCount: number;
  pendingRequest: PendingControlRequest | null;
  inboundDispatchChain: Promise<void>;
  deliveryHandlerDepth: number;
  relayId: string | null;
}

const DEFAULT_RECONNECT = {
  baseMs: 1000,
  jitterMs: 2000,
  maxDelayMs: 30000,
  stableAfterMs: 60000,
};

function normalizeRelayUrl(url: string): string {
  return url.trim();
}

function isWebSocketEndpoint(url: string): boolean {
  return /^wss?:\/\//.test(url);
}

function hasRelayCapability(capabilities: Capability[] | undefined): boolean {
  return (capabilities ?? []).some((capability) => capability?.id?.startsWith('relay/'));
}

function extractRelayEndpoints(card: AgentCard | undefined): string[] {
  if (!card) {
    return [];
  }

  return Array.from(new Set((card.endpoints ?? [])
    .map((endpoint) => endpoint.trim())
    .filter((endpoint) => endpoint.length > 0)
    .filter(isWebSocketEndpoint)));
}

function isRelayProvider(agent: DiscoveredAgent): boolean {
  return hasRelayCapability(agent.card.capabilities) && extractRelayEndpoints(agent.card).length > 0;
}

async function verifyCardBinding(card: AgentCard | null | undefined, expectedDid?: string): Promise<{ valid: boolean; reason?: string }> {
  if (!card) {
    return { valid: false, reason: 'missing card payload' };
  }

  if (!validateDID(card.did)) {
    return { valid: false, reason: `invalid card DID: ${card.did}` };
  }

  if (expectedDid && card.did !== expectedDid) {
    return {
      valid: false,
      reason: `envelope DID ${expectedDid} does not match card DID ${card.did}`,
    };
  }

  try {
    const publicKey = extractPublicKey(card.did);
    const valid = await verifyAgentCard(card, (signature, data) => verify(signature, data, publicKey));

    return valid
      ? { valid: true }
      : { valid: false, reason: `invalid signature for ${card.did}` };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function filterVerifiedDiscoveredAgents(agents: DiscoveredAgent[]): Promise<DiscoveredAgent[]> {
  const verifiedAgents: DiscoveredAgent[] = [];

  for (const agent of agents) {
    const verification = await verifyCardBinding(agent.card, agent.did);
    if (!verification.valid) {
      logger.warn('Discarded discovered agent card with invalid signature', {
        did: agent.did,
        reason: verification.reason,
      });
      continue;
    }

    verifiedAgents.push(agent);
  }

  return verifiedAgents;
}

export function createRelayClient(config: RelayClientConfig): RelayClient {
  const { inviteToken, did, keyPair } = config;
  const reconnectConfig = { ...DEFAULT_RECONNECT, ...config.reconnect };
  const autoDiscoverRelays = config.autoDiscoverRelays ?? true;
  const targetRelayCount = Math.max(1, Math.round(config.targetRelayCount ?? Math.max(1, config.relayUrls.length || 1)));
  const discoveryCapability = config.discoveryCapability ?? 'relay/message-routing';
  let currentCard = config.card;

  const connections: RelayConnection[] = [];
  const failureStates = new Map<string, RelayReachabilityFailure>();
  let deliveryHandler: MessageDeliveryHandler | null = null;
  let deliveryReportHandler: DeliveryReportHandler | null = null;
  let stopped = false;
  let maintenanceTimer: NodeJS.Timeout | null = null;
  let maintenanceInFlight = false;
  let lastDiscoveryAt: number | null = null;
  let requestChain: Promise<void> = Promise.resolve();

  function withSerializedRequest<T>(operation: () => Promise<T>): Promise<T> {
    const pending = requestChain.then(operation, operation);
    requestChain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  function getConnection(url: string): RelayConnection | undefined {
    return connections.find((connection) => connection.url === url);
  }

  function clearPendingRequest(conn: RelayConnection): PendingControlRequest | null {
    const pending = conn.pendingRequest;
    if (!pending) {
      return null;
    }

    clearTimeout(pending.timeout);
    conn.pendingRequest = null;
    return pending;
  }

  function rejectPendingRequest(conn: RelayConnection, error: TransportError, force = false): void {
    const pending = conn.pendingRequest;
    if (!pending) {
      return;
    }

    if (!force && pending.queuedMatch) {
      return;
    }

    clearPendingRequest(conn)?.reject(error);
  }

  function queueInboundRelayMessage(conn: RelayConnection, msg: RelayMessage): void {
    const processMessage = async (): Promise<void> => {
      try {
        await dispatchRelayMessage(conn, msg);
      } catch (error) {
        logger.warn('Failed to process relay message', {
          url: conn.url,
          type: msg.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    conn.inboundDispatchChain = conn.inboundDispatchChain.then(processMessage, processMessage);
  }

  async function dispatchRelayMessage(conn: RelayConnection, msg: RelayMessage): Promise<void> {
    const pending = conn.pendingRequest;
    if (pending && pending.matches(msg)) {
      clearPendingRequest(conn)?.resolve(msg);
      return;
    }

    await handleRelayMessage(conn, msg);
  }

  function awaitControlResponse<T extends RelayMessage>(
    conn: RelayConnection,
    request: RelayMessage,
    timeoutMs: number,
    timeoutMessage: string,
    matches: (msg: RelayMessage) => msg is T,
  ): Promise<T> {
    const ws = conn.ws;
    if (!conn.connected || !ws) {
      throw new TransportError('No connected relay');
    }

    if (conn.pendingRequest) {
      throw new TransportError(`Relay request already pending: ${conn.pendingRequest.description}`);
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingControlRequest = {
        description: request.type,
        matches,
        timeout: setTimeout(() => {
          if (conn.pendingRequest === pending) {
            conn.pendingRequest = null;
          }
          reject(new TransportError(timeoutMessage, { relayUrl: conn.url, requestType: request.type }));
        }, timeoutMs),
        resolve: (msg) => resolve(msg as T),
        reject,
        queuedMatch: null,
        allowOutOfBandResponse: conn.deliveryHandlerDepth > 0,
      };

      conn.pendingRequest = pending;

      try {
        ws.send(encodeCBOR(request));
      } catch (error) {
        clearPendingRequest(conn);
        reject(new TransportError(`Failed to send ${request.type}`, {
          relayUrl: conn.url,
          requestType: request.type,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  }

  function ensureConnection(url: string): RelayConnection {
    const normalized = normalizeRelayUrl(url);
    const existing = getConnection(normalized);
    if (existing) {
      return existing;
    }

    const connection: RelayConnection = {
      url: normalized,
      ws: null,
      connected: false,
      connecting: false,
      fatalError: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      stableTimer: null,
      pingTimer: null,
      peerCount: 0,
      pendingRequest: null,
      inboundDispatchChain: Promise.resolve(),
      deliveryHandlerDepth: 0,
      relayId: null,
    };

    connections.push(connection);
    return connection;
  }

  function recordFailure(url: string, error: unknown): void {
    const previous = failureStates.get(url);
    failureStates.set(url, {
      provider: url,
      attempts: (previous?.attempts ?? 0) + 1,
      lastFailureAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  function clearFailure(url: string): void {
    failureStates.delete(url);
  }

  function mapRelayCloseError(url: string, code: number, reason: string): TransportError | null {
    const detail = { relayUrl: url, closeCode: code, closeReason: reason };

    switch (code) {
      case 4010:
        return new TransportError(`Relay rejected authentication: ${reason || 'Invite token required'}`, detail);
      case 4011:
        return new TransportError(`Relay rejected invite token signature: ${reason || 'Invalid token signature'}`, detail);
      case 4012:
        return new TransportError(`Relay rejected expired invite token: ${reason || 'Token expired'}`, detail);
      case 4013:
        return new TransportError(`Relay rejected revoked invite token: ${reason || 'Token revoked'}`, detail);
      case 4014:
        return new TransportError(`Relay rejected invite token DID binding: ${reason || 'Token not valid for this DID'}`, detail);
      case 4015:
        return new TransportError(`Relay rejected invite token due to max agent limit: ${reason || 'Token max agents reached'}`, detail);
      case 4016:
        return new TransportError(`Relay rejected connection because the realm is full: ${reason || 'Realm full'}`, detail);
      case 1008:
        return new TransportError(`Relay rejected handshake: ${reason || 'Policy violation'}`, detail);
      default:
        return null;
    }
  }

  function getConnectedConnection(): RelayConnection | null {
    return connections.find((connection) => connection.connected && connection.ws) || null;
  }

  function listConnectedRelays(): string[] {
    return connections.filter((connection) => connection.connected).map((connection) => connection.url);
  }

  function getConnectedRelayIds(): Set<string> {
    const ids = new Set<string>();
    for (const conn of connections) {
      if (conn.connected && conn.relayId) {
        ids.add(conn.relayId);
      }
    }
    return ids;
  }

  function listKnownRelays(): string[] {
    return connections.map((connection) => connection.url);
  }

  async function connectToRelay(conn: RelayConnection): Promise<void> {
    if (stopped || conn.connected || conn.connecting) {
      return;
    }

    conn.fatalError = null;
    conn.connecting = true;

    try {
      logger.info('Connecting to relay', { url: conn.url });
      const ws = new WebSocket(conn.url);
      conn.ws = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.on('open', async () => {
          clearTimeout(timeout);
          logger.info('WebSocket connected', { url: conn.url });

          try {
            const timestamp = Date.now();
            const helloPayload = inviteToken
              ? { did, card: currentCard, timestamp, inviteToken }
              : { did, card: currentCard, timestamp };
            const helloData = encodeCBOR(helloPayload);
            const signature = await sign(helloData, keyPair.privateKey);

            const hello: HelloMessage = {
              type: 'HELLO',
              protocolVersion: 1,
              did,
              card: currentCard,
              timestamp,
              signature,
              ...(inviteToken ? { inviteToken } : {}),
            };

            ws.send(encodeCBOR(hello));
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg: RelayMessage = decodeCBOR(data);
          const pending = conn.pendingRequest;
          if (pending && pending.matches(msg)) {
            pending.queuedMatch = msg;
            if (pending.allowOutOfBandResponse) {
              clearPendingRequest(conn)?.resolve(msg);
              return;
            }
          }
          queueInboundRelayMessage(conn, msg);
        } catch (error) {
          logger.warn('Failed to parse relay message', { error: (error as Error).message });
        }
      });

      ws.on('close', (code, reasonBuffer) => {
        const reason = reasonBuffer.toString();
        logger.info('WebSocket closed', { url: conn.url, code, reason });
        conn.connected = false;
        conn.connecting = false;
        conn.ws = null;

        if (conn.stableTimer) {
          clearTimeout(conn.stableTimer);
          conn.stableTimer = null;
        }
        if (conn.pingTimer) {
          clearInterval(conn.pingTimer);
          conn.pingTimer = null;
        }

        rejectPendingRequest(conn, new TransportError('Relay connection closed before response', {
          relayUrl: conn.url,
          closeCode: code,
          closeReason: reason,
        }));

        const fatalError = mapRelayCloseError(conn.url, code, reason);
        if (fatalError) {
          conn.fatalError = fatalError;
          recordFailure(conn.url, fatalError);
          return;
        }

        if (!stopped) {
          recordFailure(conn.url, new Error(reason || `Relay closed with code ${code}`));
          scheduleReconnect(conn);
        }
      });

      ws.on('error', (error) => {
        logger.warn('WebSocket error', { url: conn.url, error: error.message });
      });
    } catch (error) {
      logger.warn('Failed to connect to relay', { url: conn.url, error: (error as Error).message });
      conn.ws = null;
      conn.connected = false;
      conn.connecting = false;
      recordFailure(conn.url, error);

      if (!stopped) {
        scheduleReconnect(conn);
      }
    }
  }

  function scheduleReconnect(conn: RelayConnection): void {
    if (conn.reconnectTimer || stopped) {
      return;
    }

    const delay = Math.min(
      reconnectConfig.baseMs * Math.pow(2, conn.reconnectAttempt) + Math.random() * reconnectConfig.jitterMs,
      reconnectConfig.maxDelayMs,
    );

    conn.reconnectAttempt++;
    logger.debug('Scheduling reconnect', { url: conn.url, attempt: conn.reconnectAttempt, delayMs: delay });

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      void connectToRelay(conn);
    }, delay);
  }

  async function handleRelayMessage(conn: RelayConnection, msg: RelayMessage): Promise<void> {
    switch (msg.type) {
      case 'WELCOME': {
        const welcome = msg as WelcomeMessage;
        logger.info('Received WELCOME', { relayId: welcome.relayId, peers: welcome.peers, url: conn.url });
        conn.relayId = welcome.relayId ?? null;

        // Deduplicate: if another connection already has this relayId, close this one
        if (conn.relayId) {
          const duplicate = connections.find(
            (other) => other !== conn && other.connected && other.relayId === conn.relayId,
          );
          if (duplicate) {
            logger.info('Closing duplicate relay connection', {
              url: conn.url,
              existingUrl: duplicate.url,
              relayId: conn.relayId,
            });
            conn.connected = false;
            conn.connecting = false;
            conn.fatalError = new TransportError('Duplicate relay connection', { relayUrl: conn.url });
            if (conn.ws) {
              conn.ws.close(1000, 'Duplicate relay');
              conn.ws = null;
            }
            break;
          }
        }

        conn.connected = true;
        conn.connecting = false;
        conn.peerCount = welcome.peers;
        conn.reconnectAttempt = 0;
        clearFailure(conn.url);

        if (conn.stableTimer) {
          clearTimeout(conn.stableTimer);
        }
        conn.stableTimer = setTimeout(() => {
          conn.reconnectAttempt = 0;
          logger.debug('Connection stable', { url: conn.url });
        }, reconnectConfig.stableAfterMs);

        if (conn.pingTimer) {
          clearInterval(conn.pingTimer);
        }
        conn.pingTimer = setInterval(() => {
          if (conn.ws && conn.connected) {
            conn.ws.send(encodeCBOR({ type: 'PING' }));
            logger.debug('Sent PING', { url: conn.url });
          }
        }, 30000);

        break;
      }

      case 'DELIVER': {
        const deliver = msg as DeliverMessage;
        logger.info('Received DELIVER', { messageId: deliver.messageId, from: deliver.from });
        if (deliveryHandler) {
          conn.deliveryHandlerDepth += 1;
          try {
            await deliveryHandler(deliver);
          } finally {
            conn.deliveryHandlerDepth = Math.max(0, conn.deliveryHandlerDepth - 1);
          }
        }
        if (conn.ws && conn.connected) {
          conn.ws.send(encodeCBOR({ type: 'ACK', messageId: deliver.messageId }));
          logger.debug('Sent ACK', { messageId: deliver.messageId });
        }
        break;
      }

      case 'DELIVERY_REPORT': {
        const report = msg as DeliveryReportMessage;
        logger.info('Received DELIVERY_REPORT', { messageId: report.messageId, status: report.status });
        if (deliveryReportHandler) {
          deliveryReportHandler(report);
        }
        break;
      }

      case 'PONG': {
        conn.peerCount = msg.peers;
        logger.debug('Received PONG', { peers: msg.peers, url: conn.url });
        break;
      }

      case 'GOODBYE': {
        const goodbye = msg as { reconnectAfter?: number };
        const reconnectAfter = goodbye.reconnectAfter || 5000;
        logger.info('Received GOODBYE', { url: conn.url, reconnectAfter });

        if (conn.ws) {
          conn.ws.close();
        }

        setTimeout(() => {
          if (!stopped) {
            void connectToRelay(conn);
          }
        }, reconnectAfter);
        break;
      }

      default:
        logger.debug('Received relay message', { type: msg.type });
    }
  }

  async function sendToRelay(msg: RelayMessage): Promise<void> {
    const conn = getConnectedConnection();
    if (!conn || !conn.ws) {
      throw new TransportError('No connected relay');
    }

    conn.ws.send(encodeCBOR(msg));
  }

  async function performDiscover(
    input: string | { query?: string; capability?: string },
    minTrust?: number,
    limit?: number,
  ): Promise<DiscoveredAgent[]> {
    const conn = getConnectedConnection();
    if (!conn) {
      throw new TransportError('No connected relay');
    }

    const discoverMessage = typeof input === 'string'
      ? { type: 'DISCOVER', query: input, minTrust, limit }
      : { type: 'DISCOVER', ...input, minTrust, limit };

    const response = await awaitControlResponse(
      conn,
      discoverMessage as RelayMessage,
      10000,
      'Discover timeout',
      (msg): msg is Extract<RelayMessage, { type: 'DISCOVERED' }> => msg.type === 'DISCOVERED',
    );

    return filterVerifiedDiscoveredAgents(response.agents);
  }

  async function maintainRelaySet(): Promise<void> {
    if (stopped || maintenanceInFlight || !autoDiscoverRelays) {
      return;
    }

    if (listConnectedRelays().length >= targetRelayCount || !getConnectedConnection()) {
      return;
    }

    maintenanceInFlight = true;

    try {
      const discovered = await withSerializedRequest(() =>
        performDiscover({ capability: discoveryCapability }, undefined, Math.max(targetRelayCount * 4, 10))
      );
      lastDiscoveryAt = Date.now();
      let plannedConnections = listConnectedRelays().length;
      const connectedIds = getConnectedRelayIds();

      for (const agent of discovered) {
        if (!isRelayProvider(agent)) {
          continue;
        }

        // Skip relay agents whose DID is already connected via another URL
        if (connectedIds.has(agent.did)) {
          logger.debug('Skipping already-connected relay', { did: agent.did });
          continue;
        }

        for (const endpoint of extractRelayEndpoints(agent.card)) {
          const conn = ensureConnection(endpoint);
          if (!conn.connected && !conn.connecting && !conn.reconnectTimer && plannedConnections < targetRelayCount) {
            plannedConnections += 1;
            void connectToRelay(conn);
          }
        }
      }
    } catch (error) {
      logger.debug('Relay maintenance skipped', { error: (error as Error).message });
    } finally {
      maintenanceInFlight = false;
    }
  }

  function startMaintenanceLoop(): void {
    if (!autoDiscoverRelays || maintenanceTimer) {
      return;
    }

    maintenanceTimer = setInterval(() => {
      void maintainRelaySet();
    }, 60000);

    setTimeout(() => {
      void maintainRelaySet();
    }, 1000);
  }

  function stopMaintenanceLoop(): void {
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = null;
    }
  }

  for (const relayUrl of config.relayUrls) {
    ensureConnection(relayUrl);
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      logger.info('Starting relay client', { relays: connections.length, autoDiscoverRelays, targetRelayCount });

      for (const conn of connections) {
        setTimeout(() => {
          void connectToRelay(conn);
        }, Math.random() * 2000);
      }

      const maxWait = 15000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        if (getConnectedConnection()) {
          logger.info('Relay client started');
          startMaintenanceLoop();
          return;
        }

        const fatalConnections = connections.filter((connection) => connection.fatalError);
        if (connections.length > 0 && fatalConnections.length === connections.length) {
          throw fatalConnections[0].fatalError!;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const fatalError = connections.find((connection) => connection.fatalError)?.fatalError;
      if (fatalError) {
        throw fatalError;
      }

      throw new TransportError('Failed to connect to any relay');
    },

    async stop(): Promise<void> {
      stopped = true;
      stopMaintenanceLoop();
      logger.info('Stopping relay client');

      for (const conn of connections) {
        if (conn.reconnectTimer) {
          clearTimeout(conn.reconnectTimer);
          conn.reconnectTimer = null;
        }
        if (conn.stableTimer) {
          clearTimeout(conn.stableTimer);
          conn.stableTimer = null;
        }
        if (conn.pingTimer) {
          clearInterval(conn.pingTimer);
          conn.pingTimer = null;
        }
        rejectPendingRequest(conn, new TransportError('Relay client stopped before response', {
          relayUrl: conn.url,
        }), true);
        if (conn.ws) {
          conn.ws.close();
          conn.ws = null;
        }
        conn.connected = false;
        conn.connecting = false;
      }

      logger.info('Relay client stopped');
    },

    async sendEnvelope(toDid: string, envelopeBytes: Uint8Array): Promise<void> {
      const msg: RelayMessage = {
        type: 'SEND',
        to: toDid,
        envelope: envelopeBytes,
      };

      await sendToRelay(msg);
      logger.debug('Sent envelope', { to: toDid, size: envelopeBytes.length });
    },

    async discover(input: string | { query?: string; capability?: string }, minTrust?: number, limit?: number): Promise<DiscoveredAgent[]> {
      return withSerializedRequest(() => performDiscover(input, minTrust, limit));
    },

    async fetchCard(didToFetch: string): Promise<AgentCard | null> {
      return withSerializedRequest(async () => {
        const conn = getConnectedConnection();
        if (!conn) {
          throw new TransportError('No connected relay');
        }

        const response = await awaitControlResponse(
          conn,
          { type: 'FETCH_CARD', did: didToFetch } as RelayMessage,
          5000,
          'Fetch card timeout',
          (msg): msg is Extract<RelayMessage, { type: 'CARD' }> => msg.type === 'CARD' && msg.did === didToFetch,
        );

        if (!response.card) {
          return null;
        }

        const verification = await verifyCardBinding(response.card, didToFetch);
        if (!verification.valid) {
          logger.warn('Discarded fetched agent card with invalid signature', {
            did: didToFetch,
            reason: verification.reason,
          });
          return null;
        }

        return response.card;
      });
    },

    async queryTrust(target: string, domain?: string, since?: number, cursor?: string): Promise<TrustResultMessage> {
      return withSerializedRequest(async () => {
        const conn = getConnectedConnection();
        if (!conn) {
          throw new TransportError('No connected relay');
        }

        return await awaitControlResponse(
          conn,
          { type: 'TRUST_QUERY', target, domain, since, cursor } as RelayMessage,
          10000,
          'Trust query timeout',
          (msg): msg is Extract<RelayMessage, { type: 'TRUST_RESULT' }> => msg.type === 'TRUST_RESULT' && msg.target === target,
        );
      });
    },

    async publishPreKeyBundles(bundles: PublishedPreKeyBundle[]): Promise<void> {
      await withSerializedRequest(async () => {
        const conn = getConnectedConnection();
        if (!conn) {
          throw new TransportError('No connected relay');
        }

        await awaitControlResponse(
          conn,
          { type: 'PUBLISH_PREKEYS', bundles } as RelayMessage,
          5000,
          'Publish pre-key bundles timeout',
          (msg): msg is Extract<RelayMessage, { type: 'PREKEYS_PUBLISHED' }> => msg.type === 'PREKEYS_PUBLISHED',
        );
      });
      logger.debug('Published pre-key bundles', { deviceCount: bundles.length });
    },

    async fetchPreKeyBundle(didToFetch: string, deviceId: string): Promise<ClaimedPreKeyBundle | null> {
      return withSerializedRequest(async () => {
        const conn = getConnectedConnection();
        if (!conn) {
          throw new TransportError('No connected relay');
        }

        const response = await awaitControlResponse(
          conn,
          { type: 'FETCH_PREKEY_BUNDLE', did: didToFetch, deviceId } as RelayMessage,
          5000,
          'Fetch pre-key bundle timeout',
          (msg): msg is Extract<RelayMessage, { type: 'PREKEY_BUNDLE' }> => (
            msg.type === 'PREKEY_BUNDLE' && msg.did === didToFetch && msg.deviceId === deviceId
          ),
        );

        return response.bundle ?? null;
      });
    },

    async publishCard(card?: AgentCard): Promise<void> {
      if (card) {
        currentCard = card;
      }
      await sendToRelay({ type: 'PUBLISH_CARD', card } as RelayMessage);
      logger.debug('Sent PUBLISH_CARD');
    },

    async unpublishCard(): Promise<void> {
      await sendToRelay({ type: 'UNPUBLISH_CARD' } as RelayMessage);
      logger.debug('Sent UNPUBLISH_CARD');
    },

    onDeliver(handler: MessageDeliveryHandler): void {
      deliveryHandler = handler;
    },

    onDeliveryReport(handler: DeliveryReportHandler): void {
      deliveryReportHandler = handler;
    },

    isConnected(): boolean {
      return getConnectedConnection() !== null;
    },

    getConnectedRelays(): string[] {
      return listConnectedRelays();
    },

    getKnownRelays(): string[] {
      return listKnownRelays();
    },

    getReachabilityStatus(): RelayReachabilityStatus {
      return {
        connectedRelays: listConnectedRelays(),
        knownRelays: listKnownRelays(),
        lastDiscoveryAt,
        relayFailures: Array.from(failureStates.values()),
        targetRelayCount,
        autoDiscoverRelays,
      };
    },

    getPeerCount(): number {
      const conn = getConnectedConnection();
      return conn ? conn.peerCount : 0;
    },
  };
}
