import type { IncomingMessage } from 'http';
import { decode as decodeCBOR, encode as encodeCBOR } from 'cbor-x';
import { WebSocket } from 'ws';
import type {
  RelayAgentRuntime,
  RelayConnectionHandlers,
  RelayHelloResult,
} from './relay-agent-internals.js';
import { formatConnectionContext, getConnectionContext, normalizeEnvelopeBytes } from './relay-agent-shared.js';
import type { ConnectionContext } from './relay-agent-types.js';
import type { DeliverMessage, FederationHelloMessage, HelloMessage, RelayMessage, WelcomeMessage } from './types.js';

function rejectHello(
  ws: WebSocket,
  context: ConnectionContext,
  closeCode: number,
  reason: string,
): RelayHelloResult {
  console.warn(`Rejected HELLO: ${reason} ${formatConnectionContext(context)}`);
  ws.close(closeCode, reason);
  return { success: false, error: reason };
}

export function handleConnection(
  runtime: RelayAgentRuntime,
  handlers: RelayConnectionHandlers,
  ws: WebSocket,
  req?: IncomingMessage,
): void {
  let authenticated = false;
  let connectionMode: 'agent' | 'federation' | null = null;
  let did: string | undefined;
  let federationRelayDid: string | undefined;
  let processingChain = Promise.resolve();
  const connectionContext = getConnectionContext(req);

  ws.on('message', (data: Buffer) => {
    processingChain = processingChain.then(async () => {
      try {
        const msg: RelayMessage = decodeCBOR(data);

        if (!authenticated) {
          if (msg.type === 'HELLO') {
            const result = await handlers.handleHello(ws, msg as HelloMessage, connectionContext);
            if (result.success) {
              authenticated = true;
              connectionMode = 'agent';
              did = msg.did;
              runtime.wsToDidMap.set(ws, did);
            }
          } else if (msg.type === 'FEDERATION_HELLO') {
            if (!runtime.federationManager) {
              ws.close(1008, 'Federation disabled');
              return;
            }

            const result = await runtime.federationManager.acceptIncomingRelay(ws, msg as FederationHelloMessage, connectionContext);
            if (result.ok) {
              authenticated = true;
              connectionMode = 'federation';
              federationRelayDid = result.relayDid ?? msg.relayDid;
            } else {
              ws.close(result.closeCode ?? 1008, result.error ?? 'Invalid federation hello');
            }
          } else {
            ws.close(1008, 'Must send HELLO first');
          }
          return;
        }

        if (connectionMode === 'federation') {
          if (!runtime.federationManager || !federationRelayDid) {
            ws.close(1011, 'Federation handler unavailable');
            return;
          }

          await runtime.federationManager.handleIncomingMessage(ws, federationRelayDid, msg);
          return;
        }

        await handlers.dispatchAuthenticatedMessage(ws, did!, msg);
      } catch (err) {
        console.error('Error handling message:', err);
        ws.close(1011, 'Internal error');
      }
    });
  });

  ws.on('close', () => {
    if (connectionMode === 'federation') {
      if (federationRelayDid) {
        runtime.federationManager?.handleIncomingDisconnect(federationRelayDid);
        console.log(`Federated relay disconnected: ${federationRelayDid}`);
      }
      return;
    }

    if (did) {
      handlers.handleAgentDisconnect(ws, did);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

export function handleAgentDisconnect(runtime: RelayAgentRuntime, ws: WebSocket, did: string): void {
  const agent = runtime.registry.get(did);
  const realm = agent?.realm ?? 'public';
  runtime.registry.markOffline(did);
  runtime.registry.unpublish(did);
  runtime.heartbeat.remove(did);
  runtime.subscriptions.unsubscribeAll(did);
  runtime.wsToDidMap.delete(ws);
  runtime.subscriptions.dispatch('leave', did, agent?.card, realm);
  runtime.federationManager?.notifyAgentLeft(did, realm);
  console.log(`Agent disconnected: ${did}`);
}

export async function handleHello(
  runtime: RelayAgentRuntime,
  ws: WebSocket,
  msg: HelloMessage,
  context: ConnectionContext = { remoteIp: 'unknown', userAgent: 'unknown' },
): Promise<RelayHelloResult> {
  try {
    const now = Date.now();
    if (Math.abs(now - msg.timestamp) > 300_000) {
      return rejectHello(ws, context, 1008, 'Timestamp too old');
    }

    const { verifyAgentCard, verify, extractPublicKey, validateDID } = await import('@quadra-a/protocol');
    if (!validateDID(msg.did)) {
      return rejectHello(ws, context, 1008, 'Invalid DID format');
    }

    if (msg.card.did !== msg.did) {
      return rejectHello(ws, context, 1008, 'HELLO DID mismatch');
    }

    const cardPublicKey = extractPublicKey(msg.did);
    const isValid = await verifyAgentCard(msg.card as never, (sig, data) => verify(sig, data, cardPublicKey));
    if (!isValid) {
      return rejectHello(ws, context, 1008, 'Invalid agent card signature');
    }

    const helloData = encodeCBOR(
      msg.inviteToken
        ? { did: msg.did, card: msg.card, timestamp: msg.timestamp, inviteToken: msg.inviteToken }
        : { did: msg.did, card: msg.card, timestamp: msg.timestamp },
    );
    const signature = Array.isArray(msg.signature)
      ? new Uint8Array(msg.signature)
      : msg.signature;
    const isValidSig = await verify(signature, helloData, cardPublicKey);
    if (!isValidSig) {
      return rejectHello(ws, context, 1008, 'Invalid HELLO signature');
    }

    let realm = 'public';
    if (runtime.config.privateRelay || runtime.config.operatorPublicKey) {
      if (!msg.inviteToken) {
        return rejectHello(ws, context, 4010, 'Invite token required');
      }

      if (!runtime.config.operatorPublicKey) {
        return rejectHello(ws, context, 4010, 'Relay not configured for token validation');
      }

      const { verifyInviteToken, TokenError } = await import('./token.js');
      const operatorPubKey = Buffer.from(runtime.config.operatorPublicKey, 'hex');
      let payload;

      try {
        payload = await verifyInviteToken(msg.inviteToken, operatorPubKey);
      } catch (err) {
        if (err instanceof TokenError) {
          const closeCode = err.code === 'EXPIRED' ? 4012
            : err.code === 'INVALID_SIGNATURE' ? 4011
            : 4010;
          return rejectHello(ws, context, closeCode, err.message);
        }
        return rejectHello(ws, context, 4010, 'Token validation failed');
      }

      if (runtime.revocationList) {
        await runtime.revocationList.load();
      }

      if (runtime.revocationList?.isRevoked(payload.jti)) {
        return rejectHello(ws, context, 4013, 'Token has been revoked');
      }

      if (payload.sub !== '*' && payload.sub !== msg.did) {
        return rejectHello(ws, context, 4014, 'Token not valid for this DID');
      }

      if (payload.maxAgents !== undefined && payload.maxAgents > 0) {
        const currentUsage = runtime.registry.countOnlineByTokenJti(payload.jti, msg.did);
        if (currentUsage >= payload.maxAgents) {
          return rejectHello(ws, context, 4015, 'Token max agents reached');
        }
      }

      realm = payload.realm;
      runtime.registry.register(msg.did, msg.card, ws, realm, {
        jti: payload.jti,
        exp: payload.exp * 1000,
      });
    } else {
      runtime.registry.register(msg.did, msg.card, ws, realm);
    }

    runtime.heartbeat.recordPing(msg.did);

    const identity = runtime.relayIdentity.getIdentity();
    const federationStatus = runtime.federationManager?.getFederationStatus();
    const welcome: WelcomeMessage = {
      type: 'WELCOME',
      protocolVersion: 1,
      relayId: identity.did,
      peers: runtime.registry.getOnlineCountByRealm(realm),
      federatedRelays: federationStatus?.connectedRelays || [],
      yourAddr: `ws://relay/${msg.did}`,
      realm,
    };

    ws.send(encodeCBOR(welcome));
    console.log(`Agent connected: ${msg.did} (${msg.card.name}) realm=${realm}`);

    runtime.federationManager?.notifyAgentJoined(msg.did, msg.card, realm);

    if (runtime.queue) {
      const queuedMessages = await runtime.queue.getQueuedMessages(msg.did);
      if (queuedMessages.length > 0) {
        console.log(`Delivering ${queuedMessages.length} queued messages to ${msg.did}`);
      }

      for (const queuedMsg of queuedMessages) {
        const deliver: DeliverMessage = {
          type: 'DELIVER',
          messageId: queuedMsg.messageId,
          from: queuedMsg.fromDid,
          envelope: normalizeEnvelopeBytes(queuedMsg.envelope),
        };

        ws.send(encodeCBOR(deliver));
        await runtime.queue.markDelivered(queuedMsg.messageId, msg.did);
      }
    }

    if (runtime.config.operatorPublicKey && runtime.bootstrapManager && !runtime.endorsements.hasEndorsementFrom(identity.did, msg.did)) {
      try {
        const endorsement = await runtime.bootstrapManager.createNetworkBootstrapEndorsement(
          msg.did,
          'Relay cold-start bootstrap endorsement',
        );
        runtime.endorsements.store(endorsement as never);
        await runtime.endorsements.save();
        console.log(`✓ Created signed bootstrap endorsement for ${msg.did}`);
      } catch (err) {
        console.error('Failed to create bootstrap endorsement:', err);
      }
    }

    return { success: true };
  } catch (err) {
    const error = err as Error & { code?: string };
    if (error.name === 'IdentityError' || error.code === 'IDENTITY_ERROR') {
      return rejectHello(ws, context, 1008, error.message || 'Invalid identity');
    }

    console.error(`HELLO handler error (${formatConnectionContext(context)}):`, err);
    ws.close(1011, 'Internal error');
    return { success: false, error: 'Internal error' };
  }
}

export async function revalidateActiveSessions(runtime: RelayAgentRuntime): Promise<void> {
  if (!runtime.revocationList) {
    return;
  }

  await runtime.revocationList.load();
  const now = Date.now();
  for (const agent of runtime.registry.listAgents()) {
    if (!agent.online) {
      continue;
    }

    if (agent.tokenExp && agent.tokenExp <= now) {
      if (agent.ws.readyState <= WebSocket.OPEN) {
        agent.ws.close(4012, 'Token expired');
      }
      continue;
    }

    if (agent.tokenJti && runtime.revocationList.isRevoked(agent.tokenJti)) {
      if (agent.ws.readyState <= WebSocket.OPEN) {
        agent.ws.close(4013, 'Token has been revoked');
      }
    }
  }
}
