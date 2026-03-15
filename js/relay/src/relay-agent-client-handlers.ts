import { encode as encodeCBOR } from 'cbor-x';
import type { WebSocket } from 'ws';
import type { RelayAgentRuntime } from './relay-agent-internals.js';
import { buildDiscoveryResponse, resolveVisibleAgentCard } from './relay-agent-discovery.js';
import type {
  AckMessage,
  CardMessage,
  DeliveryReportMessage,
  DiscoverMessage,
  EndorseAckMessage,
  EndorseMessage,
  PingMessage,
  PreKeyBundleMessage,
  PreKeysPublishedMessage,
  PublishPreKeysMessage,
  FetchPreKeyBundleMessage,
  PongMessage,
  PublishCardMessage,
  SubscribeAckMessage,
  SubscribeMessage,
  TrustQueryMessage,
  TrustResultMessage,
  UnsubscribeMessage,
} from './types.js';

const TRUST_QUERY_WINDOW_MS = 60 * 60 * 1000;
const TRUST_QUERY_LIMIT = 100;
const TRUST_QUERY_PAGE_SIZE = 50;

export function buildRateLimitedTrustResult(msg: TrustQueryMessage): TrustResultMessage {
  return {
    type: 'TRUST_RESULT',
    target: msg.target,
    endorsements: [],
    endorsementCount: 0,
    averageScore: 0,
  };
}

export function consumeTrustQueryBudget(runtime: RelayAgentRuntime, did: string): boolean {
  const now = Date.now();
  const counter = runtime.trustQueryCounters.get(did);
  if (counter && now - counter.windowStart < TRUST_QUERY_WINDOW_MS) {
    if (counter.count >= TRUST_QUERY_LIMIT) {
      return false;
    }
    counter.count++;
    return true;
  }

  runtime.trustQueryCounters.set(did, { count: 1, windowStart: now });
  return true;
}

export function buildTrustQueryResponse(runtime: RelayAgentRuntime, msg: TrustQueryMessage): TrustResultMessage {
  let offset = 0;
  if (msg.cursor) {
    try {
      offset = parseInt(Buffer.from(msg.cursor, 'base64url').toString('utf8'), 10);
    } catch {
      offset = 0;
    }
  }

  const { endorsements: allEndorsements, total, averageScore } = runtime.endorsements.query(
    msg.target,
    msg.domain,
    msg.since,
    10_000,
  );

  const page = allEndorsements.slice(offset, offset + TRUST_QUERY_PAGE_SIZE);
  const nextOffset = offset + TRUST_QUERY_PAGE_SIZE;
  const nextCursor = nextOffset < total
    ? Buffer.from(String(nextOffset)).toString('base64url')
    : undefined;

  return {
    type: 'TRUST_RESULT',
    target: msg.target,
    endorsements: page,
    endorsementCount: total,
    averageScore,
    nextCursor,
  };
}

export async function handleDiscover(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  did: string,
  msg: DiscoverMessage,
): Promise<void> {
  const response = buildDiscoveryResponse(runtime, did, msg);
  ws.send(encodeCBOR(response));
}

export async function handleFetchCard(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  requesterDid: string,
  msg: { did: string },
): Promise<void> {
  const response: CardMessage = {
    type: 'CARD',
    did: msg.did,
    card: resolveVisibleAgentCard(runtime, requesterDid, msg.did),
  };

  ws.send(encodeCBOR(response));
}

export async function handlePing(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  did: string,
  _msg: PingMessage,
): Promise<void> {
  runtime.heartbeat.recordPing(did);
  const realm = runtime.registry.get(did)?.realm ?? 'public';

  const response: PongMessage = {
    type: 'PONG',
    peers: runtime.registry.getOnlineCountByRealm(realm),
  };

  ws.send(encodeCBOR(response));
}

export async function handleAck(runtime: RelayAgentRuntime, did: string, msg: AckMessage): Promise<void> {
  if (!runtime.queue) {
    return;
  }

  const acknowledged = await runtime.queue.markAcked(msg.messageId, did);
  console.log(`Received ACK from ${did} for message ${msg.messageId}`);

  if (!acknowledged) {
    return;
  }

  const sender = runtime.registry.get(acknowledged.fromDid);
  if (!sender?.online || sender.ws.readyState !== 1) {
    return;
  }

  const report: DeliveryReportMessage = {
    type: 'DELIVERY_REPORT',
    messageId: acknowledged.messageId,
    status: 'delivered',
    timestamp: Date.now(),
  };
  sender.ws.send(encodeCBOR(report));
}

export async function handleSubscribe(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  did: string,
  msg: SubscribeMessage,
): Promise<void> {
  const realm = runtime.registry.get(did)?.realm ?? 'public';
  const result = runtime.subscriptions.subscribe(did, ws, msg.events, realm);

  const response: SubscribeAckMessage = {
    type: 'SUBSCRIBE_ACK',
    ...result,
    realm,
  };

  ws.send(encodeCBOR(response));
}

export async function handleUnsubscribe(
  runtime: RelayAgentRuntime,
  _did: string,
  msg: UnsubscribeMessage,
): Promise<void> {
  runtime.subscriptions.unsubscribe(msg.subscriptionId);
}

export async function handleEndorse(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  did: string,
  msg: EndorseMessage,
): Promise<void> {
  const endorsement = msg.endorsement;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const counter = runtime.endorseCounters.get(did);

  if (counter && now - counter.windowStart < dayMs) {
    if (counter.count >= 20) {
      const response: EndorseAckMessage = {
        type: 'ENDORSE_ACK',
        stored: false,
        error: 'Rate limit exceeded: 20 endorsements per day',
      };
      ws.send(encodeCBOR(response));
      return;
    }
    counter.count++;
  } else {
    runtime.endorseCounters.set(did, { count: 1, windowStart: now });
  }

  const dedupKey = `${did}:${endorsement.to}:${endorsement.domain ?? '*'}`;
  const lastEndorse = runtime.endorseDedup.get(dedupKey);
  if (lastEndorse && now - lastEndorse < dayMs) {
    const response: EndorseAckMessage = {
      type: 'ENDORSE_ACK',
      stored: false,
      error: 'Already endorsed this target+domain within 24h',
    };
    ws.send(encodeCBOR(response));
    return;
  }
  runtime.endorseDedup.set(dedupKey, now);

  if (endorsement.from !== did) {
    const response: EndorseAckMessage = {
      type: 'ENDORSE_ACK',
      stored: false,
      error: 'Endorsement from field must match connected DID',
    };
    ws.send(encodeCBOR(response));
    return;
  }

  if (endorsement.version !== 2) {
    const response: EndorseAckMessage = {
      type: 'ENDORSE_ACK',
      stored: false,
      error: 'Only endorsement version 2 is supported',
    };
    ws.send(encodeCBOR(response));
    return;
  }

  if (endorsement.score < 0 || endorsement.score > 1) {
    const response: EndorseAckMessage = {
      type: 'ENDORSE_ACK',
      stored: false,
      error: 'Score must be between 0 and 1',
    };
    ws.send(encodeCBOR(response));
    return;
  }

  if (endorsement.domain) {
    const domainPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!domainPattern.test(endorsement.domain) || endorsement.domain.length > 64) {
      const response: EndorseAckMessage = {
        type: 'ENDORSE_ACK',
        stored: false,
        error: 'Invalid domain format',
      };
      ws.send(encodeCBOR(response));
      return;
    }
  }

  if (endorsement.expires) {
    if (endorsement.expires < now) {
      const response: EndorseAckMessage = {
        type: 'ENDORSE_ACK',
        stored: false,
        error: 'Expires must be in the future',
      };
      ws.send(encodeCBOR(response));
      return;
    }
    if (endorsement.expires - endorsement.timestamp > 365 * 24 * 60 * 60 * 1000) {
      const response: EndorseAckMessage = {
        type: 'ENDORSE_ACK',
        stored: false,
        error: 'Expires cannot be more than 365 days from timestamp',
      };
      ws.send(encodeCBOR(response));
      return;
    }
  }

  try {
    const { verify, extractPublicKey } = await import('@quadra-a/protocol');
    const { signature, ...endorsementWithoutSig } = endorsement;
    const data = new TextEncoder().encode(JSON.stringify(endorsementWithoutSig));
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKey = extractPublicKey(endorsement.from);
    const isValid = await verify(signatureBytes, data, publicKey);

    if (!isValid) {
      const response: EndorseAckMessage = {
        type: 'ENDORSE_ACK',
        stored: false,
        error: 'Invalid endorsement signature',
      };
      ws.send(encodeCBOR(response));
      return;
    }
  } catch {
    const response: EndorseAckMessage = {
      type: 'ENDORSE_ACK',
      stored: false,
      error: 'Failed to verify signature',
    };
    ws.send(encodeCBOR(response));
    return;
  }

  const id = runtime.endorsements.store(endorsement);
  await runtime.endorsements.save();

  const response: EndorseAckMessage = {
    type: 'ENDORSE_ACK',
    id,
    stored: true,
  };

  ws.send(encodeCBOR(response));
}

export async function handleTrustQuery(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  did: string,
  msg: TrustQueryMessage,
): Promise<void> {
  const response = consumeTrustQueryBudget(runtime, did)
    ? buildTrustQueryResponse(runtime, msg)
    : buildRateLimitedTrustResult(msg);

  ws.send(encodeCBOR(response));
}

export async function handlePublishCard(
  runtime: RelayAgentRuntime,
  _ws: WebSocket,
  did: string,
  msg: PublishCardMessage,
): Promise<void> {
  const agent = runtime.registry.get(did);
  if (!agent) {
    return;
  }

  const published = runtime.registry.publish(did, msg.card);
  if (!published) {
    return;
  }

  const updatedAgent = runtime.registry.get(did) ?? agent;
  runtime.subscriptions.dispatch('publish', did, updatedAgent.card, updatedAgent.realm);
  runtime.federationManager?.notifyAgentJoined(did, updatedAgent.card, updatedAgent.realm);
  console.log(`Agent published: ${did}`);
}

export async function handleUnpublishCard(runtime: RelayAgentRuntime, did: string): Promise<void> {
  const agent = runtime.registry.get(did);
  if (!agent) {
    return;
  }

  runtime.registry.unpublish(did);
  runtime.subscriptions.dispatch('unpublish', did, agent.card, agent.realm);
  console.log(`Agent unpublished: ${did}`);
}


export async function handlePublishPreKeys(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  did: string,
  msg: PublishPreKeysMessage,
): Promise<void> {
  const agent = runtime.registry.get(did);
  if (!agent || !runtime.preKeyStore) {
    return;
  }

  await runtime.preKeyStore.publishBundles(did, agent.realm, msg.bundles ?? []);
  const response: PreKeysPublishedMessage = {
    type: 'PREKEYS_PUBLISHED',
    did,
    deviceCount: msg.bundles?.length ?? 0,
  };
  ws.send(encodeCBOR(response));
}

export async function handleFetchPreKeyBundle(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  requesterDid: string,
  msg: FetchPreKeyBundleMessage,
): Promise<void> {
  const requesterRealm = runtime.registry.get(requesterDid)?.realm ?? 'public';
  let bundle = runtime.preKeyStore
    ? await runtime.preKeyStore.claimBundle(msg.did, msg.deviceId, requesterRealm)
    : null;

  if (!bundle && runtime.federationManager) {
    bundle = await runtime.federationManager.fetchRemotePreKeyBundle(msg.did, msg.deviceId, requesterRealm);
  }

  const response: PreKeyBundleMessage = {
    type: 'PREKEY_BUNDLE',
    did: msg.did,
    deviceId: msg.deviceId,
    bundle,
    ...(msg.requestId ? { requestId: msg.requestId } : {}),
  };
  ws.send(encodeCBOR(response));
}
