import { decode as decodeCBOR, encode as encodeCBOR } from 'cbor-x';
import type { WebSocket } from 'ws';
import type { RelayAgentRuntime } from './relay-agent-internals.js';
import {
  buildRateLimitedTrustResult,
  buildTrustQueryResponse,
  consumeTrustQueryBudget,
} from './relay-agent-client-handlers.js';
import { buildDiscoveryResponse, resolveVisibleAgentCard } from './relay-agent-discovery.js';
import { createRelayDeliverMessage, normalizeEnvelopeBytes } from './relay-agent-shared.js';
import type {
  CardMessage,
  DiscoverMessage,
  FederationHealthCheckMessage,
  FederationHealthResponseMessage,
  FetchCardMessage,
  PingMessage,
  PongMessage,
  RelayMessage,
  SendMessage,
  TrustQueryMessage,
  TrustResultMessage,
} from './types.js';

export interface RelayProtocolHandlers {
  handleRelayHealthCheck: (
    ws: WebSocket | undefined,
    fromDid: string,
    msg: FederationHealthCheckMessage,
  ) => Promise<void>;
  handleRelayPing: (ws: WebSocket | undefined, fromDid: string, msg: PingMessage) => Promise<void>;
  handleFederatedDiscover: (ws: WebSocket | undefined, fromDid: string, msg: DiscoverMessage) => Promise<void>;
  handleRelayTrustQuery: (ws: WebSocket | undefined, fromDid: string, msg: TrustQueryMessage) => Promise<void>;
  handleRelayFetchCard: (ws: WebSocket | undefined, fromDid: string, msg: FetchCardMessage) => Promise<void>;
}

async function sendRelayResponse(runtime: RelayAgentRuntime, ws: WebSocket | undefined, payload: unknown): Promise<void> {
  if (!ws) {
    return;
  }

  const deliver = createRelayDeliverMessage(runtime.relayIdentity.getIdentity().did, payload);
  ws.send(encodeCBOR(deliver));
}

export async function handleRelayMessage(
  runtime: RelayAgentRuntime,
  fromDid: string,
  msg: SendMessage,
  handlers: RelayProtocolHandlers,
  fallbackHandleSend: (fromDid: string, msg: SendMessage) => Promise<void>,
): Promise<void> {
  try {
    let decodedMessage: RelayMessage | { type?: string };
    try {
      decodedMessage = decodeCBOR(normalizeEnvelopeBytes(msg.envelope as Uint8Array | number[] | Record<string, unknown>));
    } catch {
      console.warn('Failed to decode relay message as CBOR, treating as regular message envelope');
      await fallbackHandleSend(fromDid, msg);
      return;
    }

    if (decodedMessage.type === 'message' || decodedMessage.type === 'reply') {
      await fallbackHandleSend(fromDid, msg);
      return;
    }

    const sender = runtime.registry.get(fromDid);

    switch (decodedMessage.type) {
      case 'FEDERATION_HEALTH_CHECK':
        await handlers.handleRelayHealthCheck(sender?.ws, fromDid, decodedMessage as FederationHealthCheckMessage);
        return;
      case 'PING':
        await handlers.handleRelayPing(sender?.ws, fromDid, decodedMessage as PingMessage);
        return;
      case 'DISCOVER':
        await handlers.handleFederatedDiscover(sender?.ws, fromDid, decodedMessage as DiscoverMessage);
        return;
      case 'TRUST_QUERY':
        await handlers.handleRelayTrustQuery(sender?.ws, fromDid, decodedMessage as TrustQueryMessage);
        return;
      case 'FETCH_CARD':
        await handlers.handleRelayFetchCard(sender?.ws, fromDid, decodedMessage as FetchCardMessage);
        return;
      default:
        console.warn(`Relay received unknown relay protocol message type: ${decodedMessage.type}`);
        await fallbackHandleSend(fromDid, msg);
    }
  } catch (err) {
    console.error('Error handling relay message:', err);
    await fallbackHandleSend(fromDid, msg);
  }
}

export async function handleRelayHealthCheck(
  runtime: RelayAgentRuntime,
  ws: WebSocket | undefined,
  _fromDid: string,
  _msg: FederationHealthCheckMessage,
): Promise<void> {
  const response: FederationHealthResponseMessage = {
    type: 'FEDERATION_HEALTH_RESPONSE',
    uptime: process.uptime() * 1000,
    connectedAgents: runtime.registry.getOnlineCount(),
    queuedMessages: runtime.queue ? (await runtime.queue.getStats()).total : 0,
    timestamp: Date.now(),
  };

  await sendRelayResponse(runtime, ws, response);
}

export async function handleRelayPing(
  runtime: RelayAgentRuntime,
  ws: WebSocket | undefined,
  _fromDid: string,
  _msg: PingMessage,
): Promise<void> {
  const federationStatus = runtime.federationManager?.getFederationStatus();
  const bootstrapStatus = runtime.bootstrapManager?.getBootstrapStatus();

  const response: PongMessage & {
    relayInfo: {
      did: string;
      mode: string;
      networkId: string;
      federatedRelays: number;
      totalFederatedAgents: number;
      uptime: number;
    };
  } = {
    type: 'PONG',
    peers: runtime.registry.getOnlineCount(),
    relayInfo: {
      did: runtime.relayIdentity.getIdentity().did,
      mode: bootstrapStatus?.mode || 'unknown',
      networkId: bootstrapStatus?.networkId || 'unknown',
      federatedRelays: federationStatus?.connectedRelays.length || 0,
      totalFederatedAgents: federationStatus?.totalAgents || 0,
      uptime: process.uptime() * 1000,
    },
  };

  await sendRelayResponse(runtime, ws, response);
}

export async function handleFederatedDiscover(
  runtime: RelayAgentRuntime,
  ws: WebSocket | undefined,
  fromDid: string,
  msg: DiscoverMessage,
): Promise<void> {
  const response = buildDiscoveryResponse(runtime, fromDid, msg);
  await sendRelayResponse(runtime, ws, response);
}

export async function handleRelayTrustQuery(
  runtime: RelayAgentRuntime,
  ws: WebSocket | undefined,
  fromDid: string,
  msg: TrustQueryMessage,
): Promise<void> {
  const response = consumeTrustQueryBudget(runtime, fromDid)
    ? buildTrustQueryResponse(runtime, msg)
    : buildRateLimitedTrustResult(msg);

  const relayTrustResponse: TrustResultMessage & {
    relayTrustInfo: {
      sourceRelay: string;
      networkId: string | undefined;
      federatedEndorsements: boolean;
    };
  } = {
    ...response,
    relayTrustInfo: {
      sourceRelay: runtime.relayIdentity.getIdentity().did,
      networkId: runtime.bootstrapManager?.getBootstrapStatus().networkId,
      federatedEndorsements: false,
    },
  };

  await sendRelayResponse(runtime, ws, relayTrustResponse);
}

export async function handleRelayFetchCard(
  runtime: RelayAgentRuntime,
  ws: WebSocket | undefined,
  fromDid: string,
  msg: FetchCardMessage,
): Promise<void> {
  const response: CardMessage = {
    type: 'CARD',
    did: msg.did,
    card: resolveVisibleAgentCard(runtime, fromDid, msg.did),
  };

  await sendRelayResponse(runtime, ws, response);
}
