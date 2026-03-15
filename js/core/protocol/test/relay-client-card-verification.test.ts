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
import type { RelayMessage } from '../src/transport/relay-types.js';

type FakeRelayScenario = {
  discoveredAgents?: Array<Record<string, unknown>>;
  fetchedCards?: Record<string, AgentCard | null>;
};

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

async function startFakeRelay(scenario: FakeRelayScenario): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
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
          break;
        case 'DISCOVER':
          socket.send(encode({
            type: 'DISCOVERED',
            agents: scenario.discoveredAgents ?? [],
          }));
          break;
        case 'FETCH_CARD':
          socket.send(encode({
            type: 'CARD',
            did: msg.did,
            card: scenario.fetchedCards?.[msg.did] ?? null,
          }));
          break;
        case 'PING':
          socket.send(encode({ type: 'PONG', peers: 1 }));
          break;
        case 'GOODBYE':
          socket.close();
          break;
        default:
          break;
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
  const identity = await createSignedCard('Query Agent', 'Temporary discovery session');
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

describe('relay client card verification', () => {
  it('filters discovered cards with invalid signatures', async () => {
    const valid = await createSignedCard('Valid Agent');
    const invalid = await createSignedCard('Tampered Agent');
    const relayUrl = await startFakeRelay({
      discoveredAgents: [
        { did: valid.did, card: valid.card, online: true },
        {
          did: invalid.did,
          card: { ...invalid.card, description: 'tampered description' },
          online: true,
        },
      ],
    });

    const results = await withClient(relayUrl, (client) => client.discover({ query: 'agent' }));

    expect(results).toHaveLength(1);
    expect(results[0]?.did).toBe(valid.did);
    expect(results[0]?.card.name).toBe('Valid Agent');
  }, 15000);

  it('filters discovered cards whose envelope DID does not match the signed card DID', async () => {
    const expected = await createSignedCard('Expected Agent');
    const other = await createSignedCard('Other Agent');
    const relayUrl = await startFakeRelay({
      discoveredAgents: [
        { did: expected.did, card: expected.card, online: true },
        { did: expected.did, card: other.card, online: true },
      ],
    });

    const results = await withClient(relayUrl, (client) => client.discover({ query: 'agent' }));

    expect(results).toHaveLength(1);
    expect(results[0]?.did).toBe(expected.did);
    expect(results[0]?.card.did).toBe(expected.did);
  }, 15000);

  it('returns null when a fetched card has an invalid signature', async () => {
    const valid = await createSignedCard('Fetch Target');
    const relayUrl = await startFakeRelay({
      fetchedCards: {
        [valid.did]: { ...valid.card, name: 'Fetch Target (tampered)' },
      },
    });

    const fetchedCard = await withClient(relayUrl, (client) => client.fetchCard(valid.did));

    expect(fetchedCard).toBeNull();
  }, 15000);
});
