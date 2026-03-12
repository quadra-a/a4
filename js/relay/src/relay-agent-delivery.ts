import { encode as encodeCBOR } from 'cbor-x';
import type { RelayAgentRuntime, RelayMessageRoutingHandlers } from './relay-agent-internals.js';
import { normalizeEnvelopeBytes, randomMessageId } from './relay-agent-shared.js';
import type { DeliverMessage, DeliveryReportMessage, SendMessage } from './types.js';

export async function routeMessage(
  runtime: RelayAgentRuntime,
  _handlers: RelayMessageRoutingHandlers,
  fromDid: string,
  msg: SendMessage,
): Promise<void> {
  const identity = runtime.relayIdentity.getIdentity();
  if (msg.to === identity.did) {
    const sender = runtime.registry.get(fromDid);
    if (sender) {
      const report: DeliveryReportMessage = {
        type: 'DELIVERY_REPORT',
        messageId: randomMessageId(),
        status: 'unknown_recipient',
        timestamp: Date.now(),
      };
      sender.ws.send(encodeCBOR(report));
    }
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
      const sender = runtime.registry.get(fromDid);
      if (sender) {
        const report: DeliveryReportMessage = {
          type: 'DELIVERY_REPORT',
          messageId: randomMessageId(),
          status: 'delivered',
          timestamp: Date.now(),
        };
        sender.ws.send(encodeCBOR(report));
      }
      return;
    }
  }

  await handleSend(runtime, fromDid, msg);
}

export async function handleSend(runtime: RelayAgentRuntime, fromDid: string, msg: SendMessage): Promise<void> {
  const sender = runtime.registry.get(fromDid);
  const target = runtime.registry.get(msg.to);

  if (sender && target && sender.realm !== target.realm) {
    const report: DeliveryReportMessage = {
      type: 'DELIVERY_REPORT',
      messageId: randomMessageId(),
      status: 'unknown_recipient',
      timestamp: Date.now(),
    };
    sender.ws.send(encodeCBOR(report));
    return;
  }

  if (!target || !target.online) {
    if (runtime.queue) {
      try {
        const messageId = await runtime.queue.enqueue(
          msg.to,
          fromDid,
          normalizeEnvelopeBytes(msg.envelope as Uint8Array | number[] | Record<string, unknown>),
        );

        runtime.statusManager?.recordMessageQueued();

        if (sender) {
          const report: DeliveryReportMessage = {
            type: 'DELIVERY_REPORT',
            messageId,
            status: 'delivered',
            timestamp: Date.now(),
          };
          sender.ws.send(encodeCBOR(report));
        }

        console.log(`Message queued for offline agent ${msg.to}`);
        return;
      } catch (err) {
        if (sender) {
          const report: DeliveryReportMessage = {
            type: 'DELIVERY_REPORT',
            messageId: randomMessageId(),
            status: 'queue_full',
            timestamp: Date.now(),
          };
          sender.ws.send(encodeCBOR(report));
        }
        console.error('Failed to queue message:', (err as Error).message);
        return;
      }
    }

    if (sender) {
      const report: DeliveryReportMessage = {
        type: 'DELIVERY_REPORT',
        messageId: randomMessageId(),
        status: 'unknown_recipient',
        timestamp: Date.now(),
      };
      sender.ws.send(encodeCBOR(report));
    }
    return;
  }

  const deliver: DeliverMessage = {
    type: 'DELIVER',
    messageId: randomMessageId(),
    from: fromDid,
    envelope: normalizeEnvelopeBytes(msg.envelope as Uint8Array | number[] | Record<string, unknown>),
  };

  // Check WebSocket state before sending to prevent silent failures
  if (target.ws.readyState !== 1 /* WebSocket.OPEN */) {
    console.warn(`Target ${msg.to} WebSocket not open (readyState=${target.ws.readyState}), queueing message`);
    // Mark as offline and queue the message
    target.online = false;
    if (runtime.queue) {
      try {
        const messageId = await runtime.queue.enqueue(
          msg.to,
          fromDid,
          normalizeEnvelopeBytes(msg.envelope as Uint8Array | number[] | Record<string, unknown>),
        );
        runtime.statusManager?.recordMessageQueued();
        if (sender) {
          const report: DeliveryReportMessage = {
            type: 'DELIVERY_REPORT',
            messageId,
            status: 'delivered',
            timestamp: Date.now(),
          };
          sender.ws.send(encodeCBOR(report));
        }
        return;
      } catch (err) {
        console.error('Failed to queue message after WebSocket check:', (err as Error).message);
      }
    }
    // Fall through to unknown_recipient if queueing fails
    if (sender) {
      const report: DeliveryReportMessage = {
        type: 'DELIVERY_REPORT',
        messageId: randomMessageId(),
        status: 'unknown_recipient',
        timestamp: Date.now(),
      };
      sender.ws.send(encodeCBOR(report));
    }
    return;
  }

  try {
    target.ws.send(encodeCBOR(deliver));
    runtime.statusManager?.recordMessageRouted();

    if (sender) {
      const report: DeliveryReportMessage = {
        type: 'DELIVERY_REPORT',
        messageId: deliver.messageId,
        status: 'delivered',
        timestamp: Date.now(),
      };
      sender.ws.send(encodeCBOR(report));
    }
  } catch (err) {
    console.error(`Failed to send message to ${msg.to}:`, (err as Error).message);
    // Queue the message if send fails
    if (runtime.queue) {
      try {
        const messageId = await runtime.queue.enqueue(
          msg.to,
          fromDid,
          normalizeEnvelopeBytes(msg.envelope as Uint8Array | number[] | Record<string, unknown>),
        );
        runtime.statusManager?.recordMessageQueued();
        if (sender) {
          const report: DeliveryReportMessage = {
            type: 'DELIVERY_REPORT',
            messageId,
            status: 'delivered',
            timestamp: Date.now(),
          };
          sender.ws.send(encodeCBOR(report));
        }
      } catch (queueErr) {
        console.error('Failed to queue message after send error:', (queueErr as Error).message);
        if (sender) {
          const report: DeliveryReportMessage = {
            type: 'DELIVERY_REPORT',
            messageId: randomMessageId(),
            status: 'queue_full',
            timestamp: Date.now(),
          };
          sender.ws.send(encodeCBOR(report));
        }
      }
    }
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
        await runtime.queue.markDelivered(msg.messageId, msg.toDid);
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
