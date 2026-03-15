import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decode as decodeCBOR, encode as encodeCBOR } from 'cbor-x';
import { rmSync } from 'fs';
import { WebSocket } from 'ws';

import {
  createAgentCard,
  deriveDID,
  generateKeyPair,
  sign,
  signAgentCard,
} from '@quadra-a/protocol';

import { RelayServer } from '../server.js';
import type { DeliveryReportMessage, DeliverMessage, RelayMessage } from '../types.js';

interface SignedIdentity {
  did: string;
  card: Awaited<ReturnType<typeof signAgentCard>>;
  keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
}

async function createSignedIdentity(name: string): Promise<SignedIdentity> {
  const keyPair = await generateKeyPair();
  const did = deriveDID(keyPair.publicKey);
  const card = createAgentCard(did, name, `${name} description`, [], []);
  return {
    did,
    keyPair,
    card: await signAgentCard(card, (data) => sign(data, keyPair.privateKey)),
  };
}

async function connectAuthenticatedClient(
  relayPort: number,
  identity: SignedIdentity,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${relayPort}`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Authentication timeout')), 5000);

    ws.on('open', async () => {
      try {
        const timestamp = Date.now();
        const helloData = encodeCBOR({ did: identity.did, card: identity.card, timestamp });
        const signature = await sign(helloData, identity.keyPair.privateKey);
        ws.send(encodeCBOR({
          type: 'HELLO',
          protocolVersion: 1,
          did: identity.did,
          card: identity.card,
          timestamp,
          signature: Array.from(signature),
        }));
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });

    const onMessage = (data: Buffer) => {
      const message = decodeCBOR(data) as RelayMessage;
      if (message.type === 'WELCOME') {
        clearTimeout(timeout);
        ws.off('message', onMessage);
        resolve(ws);
      }
    };

    ws.on('message', onMessage);
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForMessage<T extends RelayMessage>(
  ws: WebSocket,
  predicate: (message: RelayMessage) => message is T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for relay message'));
    }, 5000);

    const onMessage = (data: Buffer) => {
      const message = decodeCBOR(data) as RelayMessage;
      if (predicate(message)) {
        clearTimeout(timeout);
        ws.off('message', onMessage);
        resolve(message);
      }
    };

    ws.on('message', onMessage);
    ws.on('error', (error) => {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      reject(error);
    });
  });
}

async function expectNoMessage(
  ws: WebSocket,
  predicate: (message: RelayMessage) => boolean,
  timeoutMs = 250,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
    }, timeoutMs);

    const onMessage = (data: Buffer) => {
      const message = decodeCBOR(data) as RelayMessage;
      if (predicate(message)) {
        clearTimeout(timeout);
        ws.off('message', onMessage);
        reject(new Error(`Unexpected relay message: ${JSON.stringify(message)}`));
      }
    };

    ws.on('message', onMessage);
    ws.on('error', (error) => {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      reject(error);
    });
  });
}

function isAcceptedReport(message: RelayMessage): message is DeliveryReportMessage {
  return message.type === 'DELIVERY_REPORT' && message.status === 'accepted';
}

function isDeliveredReport(message: RelayMessage): message is DeliveryReportMessage {
  return message.type === 'DELIVERY_REPORT' && message.status === 'delivered';
}

function isDeliver(message: RelayMessage): message is DeliverMessage {
  return message.type === 'DELIVER';
}

describe('relay delivery ACK semantics', () => {
  let server: RelayServer;
  let storagePath: string;
  let relayPort = 0;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    storagePath = `./test-relay-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    relayPort = 10000 + Math.floor(Math.random() * 20000);
    server = new RelayServer({ port: relayPort, storagePath });
    await server.start();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.stop();
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('emits accepted immediately and only emits delivered after ACK', async () => {
    const senderIdentity = await createSignedIdentity('Sender');
    const recipientIdentity = await createSignedIdentity('Recipient');
    const sender = await connectAuthenticatedClient(relayPort, senderIdentity);
    const recipient = await connectAuthenticatedClient(relayPort, recipientIdentity);
    sockets.push(sender, recipient);

    sender.send(encodeCBOR({
      type: 'SEND',
      to: recipientIdentity.did,
      envelope: new Uint8Array([1, 2, 3]),
    }));

    const accepted = await waitForMessage(sender, isAcceptedReport);
    const deliveredToRecipient = await waitForMessage(recipient, isDeliver);

    expect(accepted.messageId).toBe(deliveredToRecipient.messageId);

    await expectNoMessage(
      sender,
      (message) => isDeliveredReport(message) && message.messageId === deliveredToRecipient.messageId,
    );

    recipient.send(encodeCBOR({
      type: 'ACK',
      messageId: deliveredToRecipient.messageId,
    }));

    const delivered = await waitForMessage(
      sender,
      (message): message is DeliveryReportMessage => (
        isDeliveredReport(message) && message.messageId === deliveredToRecipient.messageId
      ),
    );
    expect(delivered.messageId).toBe(deliveredToRecipient.messageId);
  });

  it('replays unacked inflight messages after the recipient reconnects', async () => {
    const senderIdentity = await createSignedIdentity('Sender');
    const recipientIdentity = await createSignedIdentity('Recipient');
    const sender = await connectAuthenticatedClient(relayPort, senderIdentity);
    let recipient = await connectAuthenticatedClient(relayPort, recipientIdentity);
    sockets.push(sender, recipient);

    sender.send(encodeCBOR({
      type: 'SEND',
      to: recipientIdentity.did,
      envelope: new Uint8Array([9, 8, 7]),
    }));

    const accepted = await waitForMessage(sender, isAcceptedReport);
    const firstDelivery = await waitForMessage(recipient, isDeliver);
    expect(accepted.messageId).toBe(firstDelivery.messageId);

    recipient.close();
    await new Promise((resolve) => recipient.once('close', resolve));

    recipient = await connectAuthenticatedClient(relayPort, recipientIdentity);
    sockets.push(recipient);

    const replayedDelivery = await waitForMessage(
      recipient,
      (message): message is DeliverMessage => (
        isDeliver(message) && message.messageId === firstDelivery.messageId
      ),
    );
    expect(replayedDelivery.messageId).toBe(firstDelivery.messageId);

    recipient.send(encodeCBOR({
      type: 'ACK',
      messageId: replayedDelivery.messageId,
    }));

    const delivered = await waitForMessage(
      sender,
      (message): message is DeliveryReportMessage => (
        isDeliveredReport(message) && message.messageId === replayedDelivery.messageId
      ),
    );
    expect(delivered.messageId).toBe(replayedDelivery.messageId);
  });
});
