import { encode as encodeCBOR } from 'cbor-x';
import type { RelayAgentRuntime, RelayMessageRoutingHandlers } from './relay-agent-internals.js';
import { normalizeEnvelopeBytes, randomMessageId } from './relay-agent-shared.js';
import type { DeliverMessage, DeliveryReportMessage, SendMessage } from './types.js';

function sendDeliveryReport(
  sender: {
    online?: boolean;
    ws: {
      readyState: number;
      send(data: Uint8Array): void;
    };
  } | undefined,
  messageId: string,
  status: DeliveryReportMessage['status'],
): void {
  if (!sender || sender.online === false || sender.ws.readyState !== 1) {
    return;
  }

  const report: DeliveryReportMessage = {
    type: 'DELIVERY_REPORT',
    messageId,
    status,
    timestamp: Date.now(),
  };
  sender.ws.send(encodeCBOR(report));
}

export async function routeMessage(
  runtime: RelayAgentRuntime,
  _handlers: RelayMessageRoutingHandlers,
  fromDid: string,
  msg: SendMessage,
): Promise<void> {
  const identity = runtime.relayIdentity.getIdentity();
  if (msg.to === identity.did) {
    sendDeliveryReport(runtime.registry.get(fromDid), randomMessageId(), 'unknown_recipient');
    return;
  }

  const target = runtime.registry.get(msg.to);
  if (target && target.online) {
    await handleSend(runtime, fromDid, msg);
    return;
  }

  if (runtime.federationManager) {
    const routed = await runtime.federationManager.routeToFederation(
      msg.to,
      normalizeEnvelopeBytes(msg.envelope as Uint8Array | number[] | Record<string, unknown>),
      fromDid,
    );
    if (routed) {
      sendDeliveryReport(runtime.registry.get(fromDid), randomMessageId(), 'delivered');
      return;
    }
  }

  await handleSend(runtime, fromDid, msg);
}

export async function handleSend(runtime: RelayAgentRuntime, fromDid: string, msg: SendMessage): Promise<void> {
  const sender = runtime.registry.get(fromDid);
  const target = runtime.registry.get(msg.to);

  if (sender && target && sender.realm !== target.realm) {
    sendDeliveryReport(sender, randomMessageId(), 'unknown_recipient');
    return;
  }

  if (!runtime.queue) {
    sendDeliveryReport(sender, randomMessageId(), 'queue_full');
    return;
  }

  const normalizedEnvelope = normalizeEnvelopeBytes(msg.envelope as Uint8Array | number[] | Record<string, unknown>);
  let messageId: string;
  try {
    messageId = await runtime.queue.enqueue(msg.to, fromDid, normalizedEnvelope);
    runtime.statusManager?.recordMessageQueued();
  } catch (err) {
    sendDeliveryReport(sender, randomMessageId(), 'queue_full');
    console.error('Failed to queue message:', (err as Error).message);
    return;
  }

  sendDeliveryReport(sender, messageId, 'accepted');

  if (!target || !target.online) {
    console.log(`Message queued for offline agent ${msg.to}`);
    return;
  }

  // Check WebSocket state before sending to prevent silent failures
  if (target.ws.readyState !== 1 /* WebSocket.OPEN */) {
    console.warn(`Target ${msg.to} WebSocket not open (readyState=${target.ws.readyState}), queueing message`);
    target.online = false;
    return;
  }

  const deliver: DeliverMessage = {
    type: 'DELIVER',
    messageId,
    from: fromDid,
    envelope: normalizedEnvelope,
  };

  try {
    target.ws.send(encodeCBOR(deliver));
    await runtime.queue.markInflight(messageId, msg.to);
    runtime.statusManager?.recordMessageRouted();
  } catch (err) {
    console.error(`Failed to send message to ${msg.to}:`, (err as Error).message);
    target.online = false;
  }
}

export async function retryUnackedMessages(runtime: RelayAgentRuntime): Promise<void> {
  if (!runtime.queue) {
    return;
  }

  const messages = await runtime.queue.getMessagesForRetry();
  for (const msg of messages) {
    const agent = runtime.registry.get(msg.toDid);

    if (agent && agent.online && agent.ws.readyState === 1 /* WebSocket.OPEN */) {
      const deliver: DeliverMessage = {
        type: 'DELIVER',
        messageId: msg.messageId,
        from: msg.fromDid,
        envelope: msg.envelope,
      };

      try {
        agent.ws.send(encodeCBOR(deliver));
        await runtime.queue.markInflight(msg.messageId, msg.toDid);
        console.log(`Retrying message ${msg.messageId} to ${msg.toDid} (attempt ${msg.deliveryAttempts + 1})`);
      } catch (err) {
        console.error(`Failed to retry message ${msg.messageId} to ${msg.toDid}:`, (err as Error).message);
        // Don't mark as delivered if send fails, will retry later
      }
      continue;
    }

    if (msg.deliveryAttempts >= 3) {
      await runtime.queue.markExpired(msg.messageId, msg.toDid);

      const sender = runtime.registry.get(msg.fromDid);
      if (sender && sender.online) {
        const report: DeliveryReportMessage = {
          type: 'DELIVERY_REPORT',
          messageId: msg.messageId,
          status: 'expired',
          timestamp: Date.now(),
        };
        sender.ws.send(encodeCBOR(report));
      }

      console.log(`Message ${msg.messageId} expired after ${msg.deliveryAttempts} attempts`);
    }
  }
}

export function handleTimeout(runtime: RelayAgentRuntime, did: string): void {
  console.log(`Agent timeout: ${did}`);
  const agent = runtime.registry.get(did);
  if (!agent) {
    return;
  }

  agent.ws.close(1000, 'Heartbeat timeout');
  runtime.registry.unregister(did);
}
