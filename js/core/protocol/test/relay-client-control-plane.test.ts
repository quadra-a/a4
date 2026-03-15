import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { decode, encode } from 'cbor-x';

import {
  createAgentCard,
  createRelayClient,
  deriveDID,
  generateKeyPair,
  sign,
  signAgentCard,
} from '../src/index.js';
import type { AgentCard } from '../src/discovery/agent-card-types.js';
import type { PublishedPreKeyBundle } from '../src/e2e/types.js';
import type { RelayMessage } from '../src/transport/relay-types.js';

type FakeRelayHandler = (socket: import('ws').WebSocket, msg: RelayMessage) => void | Promise<void>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

async function createSignedCard(name: string, description = `${name} description`) {
  const keyPair = await generateKeyPair();
  const did = deriveDID(keyPair.publicKey);
  const unsignedCard = createAgentCard(
    did,
    name,
    description,
    [{ id: 'agent/test', name: 'Test', description: 'Test capability' }],
    [],
  );
  const card = await signAgentCard(unsignedCard, (data) => sign(data, keyPair.privateKey));

  return { keyPair, did, card };
}

function samplePublishedPreKeyBundle(deviceId = 'device-primary'): PublishedPreKeyBundle {
  return {
    deviceId,
    identityKeyPublic: 'identity-public-key',
    signedPreKeyPublic: 'signed-pre-key-public',
    signedPreKeyId: 7,
    signedPreKeySignature: 'signed-pre-key-signature',
    oneTimePreKeyCount: 1,
    lastResupplyAt: 1_700_000_000_000,
    oneTimePreKeys: [
      {
        keyId: 11,
        publicKey: 'one-time-pre-key-public',
      },
    ],
  };
}

async function startFakeRelay(handler: FakeRelayHandler): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

  server.on('connection', (socket) => {
    socket.on('message', async (raw) => {
      const msg = decode(raw as Buffer) as RelayMessage;

      switch (msg.type) {
        case 'HELLO':
          socket.send(encode({
            type: 'WELCOME',
            protocolVersion: 1,
            relayId: 'relay:test',
            peers: 1,
            federatedRelays: [],
            yourAddr: '127.0.0.1',
          }));
          return;
        case 'PING':
          socket.send(encode({ type: 'PONG', peers: 1 }));
          return;
        case 'GOODBYE':
          socket.close();
          return;
        default:
          await handler(socket, msg);
      }
    });
  });

  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve fake relay address');
  }

  return `ws://127.0.0.1:${address.port}`;
}

async function withClient<T>(relayUrl: string, callback: (client: ReturnType<typeof createRelayClient>) => Promise<T>) {
  const identity = await createSignedCard('Control Plane Agent', 'Temporary control-plane session');
  const client = createRelayClient({
    relayUrls: [relayUrl],
    did: identity.did,
    keyPair: identity.keyPair,
    card: identity.card,
    autoDiscoverRelays: false,
    targetRelayCount: 1,
  });

  await client.start();
  try {
    return await callback(client);
  } finally {
    await client.stop();
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe('relay client control-plane dispatch', () => {
  it('surfaces accepted delivery reports without blocking control responses', async () => {
    const reports: string[] = [];
    const relayUrl = await startFakeRelay(async (socket, msg) => {
      if (msg.type === 'PUBLISH_PREKEYS') {
        socket.send(encode({
          type: 'DELIVERY_REPORT',
          messageId: 'accepted-1',
          status: 'accepted',
          timestamp: Date.now(),
        }));
        socket.send(encode({
          type: 'PREKEYS_PUBLISHED',
          did: 'did:agent:test',
          deviceCount: msg.bundles.length,
        }));
      }
    });

    await withClient(relayUrl, async (client) => {
      client.onDeliveryReport((report) => {
        reports.push(`${report.messageId}:${report.status}`);
      });

      await client.publishPreKeyBundles([samplePublishedPreKeyBundle()]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(reports).toEqual(['accepted-1:accepted']);
  }, 15000);

  it('preserves interleaved deliver and delivery-report frames during pre-key publication', async () => {
    const sender = await createSignedCard('Queued Sender');
    const delivered: string[] = [];
    const reports: string[] = [];
    const relayUrl = await startFakeRelay(async (socket, msg) => {
      if (msg.type === 'PUBLISH_PREKEYS') {
        socket.send(encode({
          type: 'DELIVER',
          messageId: 'queued-1',
          from: sender.did,
          envelope: new Uint8Array([1, 2, 3]),
        }));
        socket.send(encode({
          type: 'DELIVERY_REPORT',
          messageId: 'queued-1',
          status: 'delivered',
          timestamp: Date.now(),
        }));
        socket.send(encode({
          type: 'PREKEYS_PUBLISHED',
          did: sender.did,
          deviceCount: msg.bundles.length,
        }));
      }
    });

    await withClient(relayUrl, async (client) => {
      client.onDeliver(async (message) => {
        delivered.push(message.messageId);
      });
      client.onDeliveryReport((report) => {
        reports.push(`${report.messageId}:${report.status}`);
      });

      await client.publishPreKeyBundles([samplePublishedPreKeyBundle()]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(delivered).toEqual(['queued-1']);
    expect(reports).toEqual(['queued-1:delivered']);
  }, 15000);

  it('serializes back-to-back deliver frames before later control responses', async () => {
    const sender = await createSignedCard('Ordered Sender');
    const deliveryOrder: string[] = [];
    let releaseFirstDelivery: (() => void) | null = null;
    let publishResolved = false;
    const firstDeliveryReleased = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });

    const relayUrl = await startFakeRelay(async (socket, msg) => {
      if (msg.type === 'PUBLISH_PREKEYS') {
        socket.send(encode({
          type: 'DELIVER',
          messageId: 'queued-1',
          from: sender.did,
          envelope: new Uint8Array([1, 2, 3]),
        }));
        socket.send(encode({
          type: 'DELIVER',
          messageId: 'queued-2',
          from: sender.did,
          envelope: new Uint8Array([4, 5, 6]),
        }));
        socket.send(encode({
          type: 'PREKEYS_PUBLISHED',
          did: sender.did,
          deviceCount: msg.bundles.length,
        }));
      }
    });

    await withClient(relayUrl, async (client) => {
      client.onDeliver(async (message) => {
        deliveryOrder.push(`start:${message.messageId}`);
        if (message.messageId === 'queued-1') {
          await firstDeliveryReleased;
        }
        deliveryOrder.push(`end:${message.messageId}`);
      });

      const publishPromise = client.publishPreKeyBundles([samplePublishedPreKeyBundle()]).then(() => {
        publishResolved = true;
      });

      await waitFor(() => deliveryOrder.length > 0);
      expect(deliveryOrder).toEqual(['start:queued-1']);
      expect(publishResolved).toBe(false);

      releaseFirstDelivery?.();
      await publishPromise;
    });

    expect(deliveryOrder).toEqual([
      'start:queued-1',
      'end:queued-1',
      'start:queued-2',
      'end:queued-2',
    ]);
  }, 15000);

  it('allows fetchCard inside a DELIVER handler without deadlocking the matching CARD response', async () => {
    const target = await createSignedCard('Nested Fetch Target');
    const events: string[] = [];

    const relayUrl = await startFakeRelay(async (socket, msg) => {
      if (msg.type === 'PUBLISH_CARD') {
        socket.send(encode({
          type: 'DELIVER',
          messageId: 'nested-1',
          from: target.did,
          envelope: new Uint8Array([1, 2, 3]),
        }));
        return;
      }

      if (msg.type === 'FETCH_CARD' && msg.did === target.did) {
        socket.send(encode({
          type: 'CARD',
          did: target.did,
          card: target.card,
        }));
        return;
      }

      if (msg.type === 'ACK' && msg.messageId === 'nested-1') {
        events.push('ack:nested-1');
      }
    });

    await withClient(relayUrl, async (client) => {
      client.onDeliver(async (message) => {
        events.push(`start:${message.messageId}`);
        const card = await client.fetchCard(target.did);
        expect(card?.did).toBe(target.did);
        events.push(`end:${message.messageId}`);
      });

      await client.publishCard();
      await waitFor(() => events.includes('ack:nested-1'));
    });

    expect(events).toEqual([
      'start:nested-1',
      'end:nested-1',
      'ack:nested-1',
    ]);
  }, 15000);

  it('rejects pending control requests immediately when the relay closes before replying', async () => {
    const target = await createSignedCard('Fetch Target');
    const relayUrl = await startFakeRelay(async (socket, msg) => {
      if (msg.type === 'FETCH_CARD' && msg.did === target.did) {
        socket.close(1011, 'closing before reply');
      }
    });

    const startedAt = Date.now();

    await expect(withClient(relayUrl, (client) => client.fetchCard(target.did))).rejects.toThrow(
      'Relay connection closed before response',
    );
    expect(Date.now() - startedAt).toBeLessThan(4000);
  }, 15000);
});
