/**
 * CVP-0018: Discovery v2 tests
 * - Unicode tokenizer
 * - Grace period for offline agents
 * - SUBSCRIBE/EVENT/UNSUBSCRIBE
 * - Pagination
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '../registry.js';
import { RelayServer } from '../server.js';
import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Tokenizer tests ────────────────────────────────────────────────────────

// We test tokenize indirectly via registry search behavior.
// For direct tokenizer tests we expose it via a test helper.
// The registry's tokenize function is internal, so we test via search.

describe('AgentRegistry — Unicode tokenizer', () => {
  let registry: AgentRegistry;

  function makeCard(name: string, description: string, capName: string) {
    return {
      did: `did:agent:z${Math.random().toString(36).slice(2)}`,
      name,
      description,
      version: '1.0',
      capabilities: [{ id: capName, name: capName, description }],
      endpoints: [],
      timestamp: Date.now(),
      signature: 'sig',
    };
  }

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('tokenizes ASCII query correctly', () => {
    const card = makeCard('Translator', 'translate Japanese text', 'translate');
    const ws = { readyState: 1 } as WebSocket;
    registry.register(card.did, card, ws);
    registry.publish(card.did);
    const { agents } = registry.search('translate japanese');
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].did).toBe(card.did);
  });

  it('finds agent with CJK capability when queried with CJK text', () => {
    const card = makeCard('翻译助手', '翻译日语文本', '翻译');
    const ws = { readyState: 1 } as WebSocket;
    registry.register(card.did, card, ws);
    registry.publish(card.did);
    const { agents } = registry.search('翻译');
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].did).toBe(card.did);
  });

  it('returns empty when CJK query matches no registered capabilities', () => {
    const card = makeCard('Translator', 'translate text', 'translate');
    const ws = { readyState: 1 } as WebSocket;
    registry.register(card.did, card, ws);
    registry.publish(card.did);
    const { agents } = registry.search('翻译');
    expect(agents).toHaveLength(0);
  });

  it('handles mixed Latin+CJK query', () => {
    const card = makeCard('Translator', 'translate 日语 text', 'translate');
    const ws = { readyState: 1 } as WebSocket;
    registry.register(card.did, card, ws);
    registry.publish(card.did);
    const { agents } = registry.search('translate 日语');
    expect(agents.length).toBeGreaterThan(0);
  });

  it('strips punctuation from query', () => {
    const card = makeCard('Translator', 'translate Japanese text', 'translate');
    const ws = { readyState: 1 } as WebSocket;
    registry.register(card.did, card, ws);
    registry.publish(card.did);
    const { agents } = registry.search('translate, Japanese.');
    expect(agents.length).toBeGreaterThan(0);
  });

  it('single-word free-text query still matches capability metadata tokens', () => {
    const card = makeCard('GPU Shell Agent', 'GPU shell agent with Tesla V100 support', 'gpu-compute');
    const ws = { readyState: 1 } as WebSocket;
    registry.register(card.did, card, ws);
    registry.publish(card.did);
    const { agents } = registry.search('gpu shell');
    expect(agents.map(agent => agent.did)).toContain(card.did);
  });
});

// ─── Capability prefix index tests (CVP-0018 §3.1) ──────────────────────────

describe('AgentRegistry — capability prefix index', () => {
  let registry: AgentRegistry;

  function makeCard(did: string, capId: string) {
    return {
      did,
      name: 'Test Agent',
      description: 'test',
      version: '1.0',
      capabilities: [{ id: capId, name: capId, description: capId }],
      endpoints: [],
      timestamp: Date.now(),
      signature: 'sig',
    };
  }

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('exact capability ID match', () => {
    const card = makeCard('did:agent:zA', 'translate');
    registry.register(card.did, card, { readyState: 1 } as WebSocket);
    registry.publish(card.did);
    const { agents } = registry.searchByCapability('translate');
    expect(agents.map(a => a.did)).toContain(card.did);
  });

  it('prefix match: "translate" finds "translate/japanese/technical"', () => {
    const card = makeCard('did:agent:zB', 'translate/japanese/technical');
    registry.register(card.did, card, { readyState: 1 } as WebSocket);
    registry.publish(card.did);
    const { agents } = registry.searchByCapability('translate');
    expect(agents.map(a => a.did)).toContain(card.did);
  });

  it('mid-path prefix match: "translate/japanese" finds "translate/japanese/technical"', () => {
    const card = makeCard('did:agent:zC', 'translate/japanese/technical');
    registry.register(card.did, card, { readyState: 1 } as WebSocket);
    registry.publish(card.did);
    const { agents } = registry.searchByCapability('translate/japanese');
    expect(agents.map(a => a.did)).toContain(card.did);
  });

  it('sibling prefix does NOT match: "translate/korean" does not find "translate/japanese"', () => {
    const card = makeCard('did:agent:zD', 'translate/japanese');
    registry.register(card.did, card, { readyState: 1 } as WebSocket);
    registry.publish(card.did);
    const { agents } = registry.searchByCapability('translate/korean');
    expect(agents.map(a => a.did)).not.toContain(card.did);
  });

  it('unpublish removes agent from prefix index', () => {
    const card = makeCard('did:agent:zE', 'translate/japanese');
    registry.register(card.did, card, { readyState: 1 } as WebSocket);
    registry.publish(card.did);
    registry.unpublish(card.did);
    const { agents } = registry.searchByCapability('translate');
    expect(agents.map(a => a.did)).not.toContain(card.did);
  });

  it('free-text query (with spaces) uses token fallback, not prefix index', () => {
    const card = makeCard('did:agent:zF', 'translate/japanese');
    // name/description contain "japanese translation"
    const cardWithDesc = { ...card, name: 'Japanese Translator', description: 'japanese translation service' };
    registry.register(cardWithDesc.did, cardWithDesc, { readyState: 1 } as WebSocket);
    registry.publish(cardWithDesc.did);
    const { agents } = registry.search('japanese translation');
    expect(agents.map(a => a.did)).toContain(cardWithDesc.did);
  });

  it('query and capability stay separated: free-text gpu matches metadata but capability gpu does not match gpu-compute', () => {
    const card = makeCard('did:agent:zG', 'gpu-compute');
    const cardWithDesc = { ...card, name: 'GPU Shell Agent', description: 'GPU shell agent with Tesla V100 support' };
    registry.register(cardWithDesc.did, cardWithDesc, { readyState: 1 } as WebSocket);
    registry.publish(cardWithDesc.did);

    const { agents: queryAgents } = registry.search('gpu');
    expect(queryAgents.map(a => a.did)).toContain(cardWithDesc.did);

    const { agents: capabilityAgents } = registry.searchByCapability('gpu');
    expect(capabilityAgents.map(a => a.did)).not.toContain(cardWithDesc.did);
  });
});

// ─── Grace period tests ──────────────────────────────────────────────────────

describe('AgentRegistry — grace period', () => {
  let registry: AgentRegistry;

  function makeCard(did: string) {
    return {
      did,
      name: 'Test Agent',
      description: 'test',
      version: '1.0',
      capabilities: [{ id: 'test', name: 'test', description: 'test' }],
      endpoints: [],
      timestamp: Date.now(),
      signature: 'sig',
    };
  }

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('markOffline sets online=false but keeps agent in registry', () => {
    const did = 'did:agent:zAlice';
    const ws = { readyState: 1 } as WebSocket;
    registry.register(did, makeCard(did), ws);
    registry.markOffline(did);
    const agent = registry.get(did);
    expect(agent).toBeDefined();
    expect(agent!.online).toBe(false);
  });

  it('cleanup removes agents offline > 3 minutes', () => {
    const did = 'did:agent:zAlice';
    const ws = { readyState: 1 } as WebSocket;
    registry.register(did, makeCard(did), ws);
    registry.markOffline(did);

    // Manually set lastSeen to > 3 minutes ago
    const agent = registry.get(did)!;
    (agent as { lastSeen: number }).lastSeen = Date.now() - 4 * 60 * 1000;

    registry.cleanup();
    expect(registry.get(did)).toBeUndefined();
  });

  it('cleanup keeps agents offline < 3 minutes', () => {
    const did = 'did:agent:zAlice';
    const ws = { readyState: 1 } as WebSocket;
    registry.register(did, makeCard(did), ws);
    registry.markOffline(did);

    // lastSeen is just now (< 3 minutes)
    registry.cleanup();
    expect(registry.get(did)).toBeDefined();
  });

  it('search excludes offline agents by default', () => {
    const did = 'did:agent:zAlice';
    const ws = { readyState: 1 } as WebSocket;
    registry.register(did, makeCard(did), ws);
    registry.publish(did);
    registry.markOffline(did);

    const { agents } = registry.search('test');
    expect(agents.find(r => r.did === did)).toBeUndefined();
  });

  it('agent that reconnects within grace period is marked online again', () => {
    const did = 'did:agent:zAlice';
    const ws1 = { readyState: 1, close: () => {} } as WebSocket;
    const ws2 = { readyState: 1 } as WebSocket;
    registry.register(did, makeCard(did), ws1);
    registry.markOffline(did);
    expect(registry.get(did)!.online).toBe(false);

    // Re-register (reconnect)
    registry.register(did, makeCard(did), ws2);
    expect(registry.get(did)!.online).toBe(true);
  });
});

// ─── SUBSCRIBE/EVENT integration tests ──────────────────────────────────────

describe('SUBSCRIBE/EVENT', () => {
  let relay: RelayServer;
  let tempDir: string;
  let relayPort: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'discovery-test-'));
    relayPort = 9200 + Math.floor(Math.random() * 800);
    relay = new RelayServer({
      port: relayPort,
      storagePath: join(tempDir, 'relay-data'),
      powDifficulty: 0,
    });
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function connectAgent(name = 'Test Agent', capabilities: string[] = []) {
    const { generateKeyPair, deriveDID, createAgentCard, signAgentCard, sign } = await import('@quadra-a/protocol');
    const kp = await generateKeyPair();
    const did = deriveDID(kp.publicKey);
    const caps = capabilities.map(c => ({ id: c, name: c, description: c }));
    const card = createAgentCard(did, name, name, caps, []);
    const signedCard = await signAgentCard(card, (data) => sign(data, kp.privateKey));
    const ws = new WebSocket(`ws://localhost:${relayPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', async () => {
        const helloPayload = { did, card: signedCard, timestamp: Date.now() };
        const helloData = encodeCBOR(helloPayload);
        const signature = await sign(helloData, kp.privateKey);
        ws.send(encodeCBOR({ type: 'HELLO', protocolVersion: 1, ...helloPayload, signature }));
      });
      ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'WELCOME') {
          // CVP-0018: publish card to become discoverable
          ws.send(encodeCBOR({ type: 'PUBLISH_CARD' }));
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout connecting')), 5000);
    });

    return { ws, did, kp };
  }

  it('SUBSCRIBE returns SUBSCRIBE_ACK with subscriptionId and realm', async () => {
    const agent = await connectAgent();

    const _ack = await new Promise<{ type: string; subscriptionId?: string }>((resolve, reject) => {
      agent.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'SUBSCRIBE_ACK') resolve(msg);
      });
      agent.ws.send(encodeCBOR({ type: 'SUBSCRIBE', events: ['join', 'leave'] }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(_ack.subscriptionId).toBeDefined();
    expect(typeof _ack.subscriptionId).toBe('string');
    expect(_ack.realm).toBe('public');

    agent.ws.close();
  });

  it('EVENT join sent to subscriber when new agent connects', async () => {
    const subscriber = await connectAgent('Subscriber');

    // Subscribe to publish events (fired when agent sends PUBLISH_CARD)
    const _ack = await new Promise<{ type: string; subscriptionId?: string }>((resolve, reject) => {
      subscriber.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'SUBSCRIBE_ACK') resolve(msg);
      });
      subscriber.ws.send(encodeCBOR({ type: 'SUBSCRIBE', events: ['publish'] }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // Now connect a new agent and expect EVENT publish
    const eventPromise = new Promise<{ type: string; event?: { type: string; agent?: unknown } }>((resolve, reject) => {
      subscriber.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'EVENT' && msg.event === 'publish') resolve(msg);
      });
      setTimeout(() => reject(new Error('Timeout waiting for EVENT')), 5000);
    });

    const newAgent = await connectAgent('New Agent');
    const event = await eventPromise;

    expect(event.event).toBe('publish');
    expect(event.did).toBe(newAgent.did);
    expect(event.card).toBeDefined();

    subscriber.ws.close();
    newAgent.ws.close();
  });

  it('EVENT leave sent when agent disconnects', async () => {
    const subscriber = await connectAgent('Subscriber');
    const target = await connectAgent('Target');

    // Subscribe
    await new Promise<void>((resolve, reject) => {
      subscriber.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'SUBSCRIBE_ACK') resolve();
      });
      subscriber.ws.send(encodeCBOR({ type: 'SUBSCRIBE', events: ['leave'] }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    const leavePromise = new Promise<{ type: string; event?: { type: string; agent?: unknown } }>((resolve, reject) => {
      subscriber.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'EVENT' && msg.event === 'leave') resolve(msg);
      });
      setTimeout(() => reject(new Error('Timeout waiting for leave EVENT')), 5000);
    });

    target.ws.close();
    const event = await leavePromise;

    expect(event.event).toBe('leave');
    expect(event.did).toBe(target.did);

    subscriber.ws.close();
  });

  it('UNSUBSCRIBE stops event delivery', async () => {
    const subscriber = await connectAgent('Subscriber');

    const _ack = await new Promise<{ type: string; subscriptionId?: string }>((resolve, reject) => {
      subscriber.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'SUBSCRIBE_ACK') resolve(msg);
      });
      subscriber.ws.send(encodeCBOR({ type: 'SUBSCRIBE', events: ['publish'] }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // Unsubscribe
    subscriber.ws.send(encodeCBOR({ type: 'UNSUBSCRIBE', subscriptionId: _ack.subscriptionId }));
    await new Promise(r => setTimeout(r, 100));

    // Connect new agent — should NOT receive EVENT
    let receivedEvent = false;
    subscriber.ws.on('message', (data: Buffer) => {
      const msg = decodeCBOR(data);
      if (msg.type === 'EVENT') receivedEvent = true;
    });

    const newAgent = await connectAgent('New Agent');
    await new Promise(r => setTimeout(r, 300));

    expect(receivedEvent).toBe(false);

    subscriber.ws.close();
    newAgent.ws.close();
  });

  it('max 10 subscriptions per DID — 11th SUBSCRIBE returns error', async () => {
    const agent = await connectAgent();

    // Create 10 subscriptions
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve, reject) => {
        const handler = (data: Buffer) => {
          const msg = decodeCBOR(data);
          if (msg.type === 'SUBSCRIBE_ACK') {
            agent.ws.off('message', handler);
            resolve();
          }
        };
        agent.ws.on('message', handler);
        agent.ws.send(encodeCBOR({ type: 'SUBSCRIBE', events: ['join'] }));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });
    }

    // 11th should fail
    const response = await new Promise<{ type: string; error?: string }>((resolve, reject) => {
      const handler = (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'SUBSCRIBE_ACK') {
          agent.ws.off('message', handler);
          resolve(msg);
        }
      };
      agent.ws.on('message', handler);
      agent.ws.send(encodeCBOR({ type: 'SUBSCRIBE', events: ['join'] }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(response.error).toBeDefined();

    agent.ws.close();
  });
});

// ─── Pagination tests ────────────────────────────────────────────────────────

describe('DISCOVER pagination', () => {
  let relay: RelayServer;
  let tempDir: string;
  let relayPort: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pagination-test-'));
    relayPort = 9400 + Math.floor(Math.random() * 500);
    relay = new RelayServer({
      port: relayPort,
      storagePath: join(tempDir, 'relay-data'),
      powDifficulty: 0,
    });
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function connectAgent(name: string) {
    const { generateKeyPair, deriveDID, createAgentCard, signAgentCard, sign } = await import('@quadra-a/protocol');
    const kp = await generateKeyPair();
    const did = deriveDID(kp.publicKey);
    const card = createAgentCard(did, name, 'search-test agent', [{ id: 'search-test', name: 'search-test', description: 'search-test' }], []);
    const signedCard = await signAgentCard(card, (data) => sign(data, kp.privateKey));
    const ws = new WebSocket(`ws://localhost:${relayPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', async () => {
        const helloPayload = { did, card: signedCard, timestamp: Date.now() };
        const helloData = encodeCBOR(helloPayload);
        const signature = await sign(helloData, kp.privateKey);
        ws.send(encodeCBOR({ type: 'HELLO', protocolVersion: 1, ...helloPayload, signature }));
      });
      ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'WELCOME') {
          // CVP-0018: publish card to become discoverable
          ws.send(encodeCBOR({ type: 'PUBLISH_CARD' }));
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // Small delay to ensure PUBLISH_CARD is processed before returning
    await new Promise(r => setTimeout(r, 20));

    return { ws, did };
  }

  it('DISCOVER with no cursor returns first page + cursor when more results exist', async () => {
    // Connect 5 agents
    const agents = await Promise.all(
      Array.from({ length: 5 }, (_, i) => connectAgent(`Agent ${i}`))
    );

    const querier = agents[0];
    const result = await new Promise<{ type: string; agents?: unknown[]; cursor?: string }>((resolve, reject) => {
      querier.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'DISCOVERED') resolve(msg);
      });
      querier.ws.send(encodeCBOR({ type: 'DISCOVER', query: 'search-test', limit: 3 }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(result.agents.length).toBe(3);
    expect(result.cursor).toBeDefined();
    expect(result.total).toBeGreaterThanOrEqual(5);

    for (const a of agents) a.ws.close();
  });

  it('DISCOVER with cursor returns next page starting after cursor position', async () => {
    const agents = await Promise.all(
      Array.from({ length: 5 }, (_, i) => connectAgent(`Agent ${i}`))
    );

    const querier = agents[0];

    // First page
    const page1 = await new Promise<{ type: string; agents?: unknown[]; cursor?: string }>((resolve, reject) => {
      querier.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'DISCOVERED') resolve(msg);
      });
      querier.ws.send(encodeCBOR({ type: 'DISCOVER', query: 'search-test', limit: 3 }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    const page1Dids = new Set(page1.agents!.map((a: { did: string }) => a.did));

    // Second page
    const page2 = await new Promise<{ type: string; agents?: unknown[]; cursor?: string }>((resolve, reject) => {
      querier.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'DISCOVERED') resolve(msg);
      });
      querier.ws.send(encodeCBOR({ type: 'DISCOVER', query: 'search-test', limit: 3, cursor: page1.cursor }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // No overlap between pages
    for (const agent of page2.agents) {
      expect(page1Dids.has(agent.did)).toBe(false);
    }

    for (const a of agents) a.ws.close();
  });

  it('last page returns no cursor', async () => {
    const agents = await Promise.all(
      Array.from({ length: 3 }, (_, i) => connectAgent(`Agent ${i}`))
    );

    const querier = agents[0];
    const result = await new Promise<{ type: string; agents?: unknown[]; cursor?: string }>((resolve, reject) => {
      querier.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'DISCOVERED') resolve(msg);
      });
      // Request more than available
      querier.ws.send(encodeCBOR({ type: 'DISCOVER', query: 'search-test', limit: 100 }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(result.cursor).toBeUndefined();

    for (const a of agents) a.ws.close();
  });

  it('limit > 100 is capped at 100', async () => {
    const querier = await connectAgent('Querier');

    const result = await new Promise<{ type: string; agents?: unknown[]; cursor?: string }>((resolve, reject) => {
      querier.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'DISCOVERED') resolve(msg);
      });
      querier.ws.send(encodeCBOR({ type: 'DISCOVER', query: '', limit: 999 }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // Should not throw, and agents count <= 100
    expect(result.agents.length).toBeLessThanOrEqual(100);

    querier.ws.close();
  });
});
