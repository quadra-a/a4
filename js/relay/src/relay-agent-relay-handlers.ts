import { encode as encodeCBOR } from 'cbor-x';
import type { WebSocket } from 'ws';
import type { RelayAgentRuntime } from './relay-agent-internals.js';
import {
  buildRateLimitedTrustResult,
  buildTrustQueryResponse,
  consumeTrustQueryBudget,
} from './relay-agent-client-handlers.js';
import { buildDiscoveryResponse, resolveVisibleAgentCard } from './relay-agent-discovery.js';
import { createRelayDeliverMessage } from './relay-agent-shared.js';
import type {
  CardMessage,
  DeliveryReportMessage,
  DiscoverMessage,
  FederationHealthCheckMessage,
  FederationHealthResponseMessage,
  FetchCardMessage,
  PingMessage,
  PongMessage,
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
  _msg: SendMessage,
  _handlers: RelayProtocolHandlers,
  _fallbackHandleSend: (fromDid: string, msg: SendMessage) => Promise<void>,
): Promise<void> {
  const sender = runtime.registry.get(fromDid);
  if (!sender?.ws) {
    return;
  }

  const report: DeliveryReportMessage = {
    type: 'DELIVERY_REPORT',
    messageId: Math.random().toString(36).slice(2),
    status: 'unknown_recipient',
    timestamp: Date.now(),
  };
  sender.ws.send(encodeCBOR(report));
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
