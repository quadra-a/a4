import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import {
  createAgentCard,
  createRelayClient,
  deriveDID,
  generateKeyPair,
  importKeyPair,
  sign,
  signAgentCard,
} from '@quadra-a/protocol';
import { RelayServer } from '../server.js';
import { createInviteToken } from '../token.js';
import type { HelloMessage, WelcomeMessage } from '../types.js';

async function buildSignedAgent(name: string) {
  const keyPair = await generateKeyPair();
  const did = deriveDID(keyPair.publicKey);
  const card = createAgentCard(did, name, 'private relay test', [], []);
  const signedCard = await signAgentCard(card, (data) => sign(data, keyPair.privateKey));

  return {
    keyPair,
    did,
    card: signedCard,
  };
}

describe('Private relay', () => {
  let relay: RelayServer;
  let tempDir: string;
  let relayPort: number;
  let operatorKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let storagePath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'private-relay-test-'));
    storagePath = join(tempDir, 'relay-data');
    relayPort = 9200 + Math.floor(Math.random() * 500);
    operatorKeyPair = await generateKeyPair();

    relay = new RelayServer({
      port: relayPort,
      storagePath,
      federationEnabled: false,
      privateRelay: true,
      operatorPublicKey: Buffer.from(operatorKeyPair.publicKey).toString('hex'),
    });

    await relay.start();
  });

  afterAll(async () => {
    await relay.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function issueToken(realm: string, sub = '*', overrides: Partial<{ exp: number; maxAgents: number }> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return createInviteToken(
      {
        iss: 'did:agent:operator',
        sub,
        realm,
        exp: overrides.exp ?? now + 3600,
        iat: now,
        jti: randomUUID(),
        ...(overrides.maxAgents !== undefined ? { maxAgents: overrides.maxAgents } : {}),
      },
      operatorKeyPair.privateKey,
    );
  }

  async function connectViaWebSocket(name: string, inviteToken?: string) {
    const agent = await buildSignedAgent(name);
    const ws = new WebSocket(`ws://localhost:${relayPort}`);

    const welcome = await new Promise<WelcomeMessage>((resolve, reject) => {
      ws.on('open', async () => {
        const timestamp = Date.now();
        const helloPayload = inviteToken
          ? { did: agent.did, card: agent.card, timestamp, inviteToken }
          : { did: agent.did, card: agent.card, timestamp };
        const signature = await sign(encodeCBOR(helloPayload), agent.keyPair.privateKey);

        const hello: HelloMessage = {
          type: 'HELLO',
          protocolVersion: 1,
          did: agent.did,
          card: agent.card,
          timestamp,
          signature: Array.from(signature),
          ...(inviteToken ? { inviteToken } : {}),
        };

        ws.send(encodeCBOR(hello));
      });

      ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'WELCOME') {
          resolve(msg as WelcomeMessage);
        }
      });

      ws.on('error', reject);
      ws.on('close', (code, reason) => reject(new Error(`closed:${code}:${reason.toString()}`)));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    return { ...agent, ws, welcome };
  }

  it('rejects HELLO without invite token', async () => {
    const agent = await buildSignedAgent('No Token');
    const ws = new WebSocket(`ws://localhost:${relayPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', async () => {
        const timestamp = Date.now();
        const helloPayload = { did: agent.did, card: agent.card, timestamp };
        const signature = await sign(encodeCBOR(helloPayload), agent.keyPair.privateKey);
        const hello: HelloMessage = {
          type: 'HELLO',
          protocolVersion: 1,
          did: agent.did,
          card: agent.card,
          timestamp,
          signature: Array.from(signature),
        };
        ws.send(encodeCBOR(hello));
      });

      ws.on('close', (code, reason) => {
        expect(code).toBe(4010);
        expect(reason.toString()).toContain('Invite token required');
        resolve();
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });
  });

  it('accepts a valid token and returns admitted realm', async () => {
    const token = await issueToken('alpha');
    const agent = await connectViaWebSocket('Alpha Agent', token);

    expect(agent.welcome.realm).toBe('alpha');
    expect(agent.welcome.peers).toBe(1);

    agent.ws.close();
  });

  it('enforces maxAgents for a shared token', async () => {
    const token = await issueToken('alpha', '*', { maxAgents: 1 });
    const first = await connectViaWebSocket('First', token);

    const second = await buildSignedAgent('Second');
    const ws = new WebSocket(`ws://localhost:${relayPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', async () => {
        const timestamp = Date.now();
        const helloPayload = { did: second.did, card: second.card, timestamp, inviteToken: token };
        const signature = await sign(encodeCBOR(helloPayload), second.keyPair.privateKey);
        const hello: HelloMessage = {
          type: 'HELLO',
          protocolVersion: 1,
          did: second.did,
          card: second.card,
          timestamp,
          signature: Array.from(signature),
          inviteToken: token,
        };
        ws.send(encodeCBOR(hello));
      });

      ws.on('close', (code, reason) => {
        expect(code).toBe(4015);
        expect(reason.toString()).toContain('Token max agents reached');
        resolve();
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    first.ws.close();
  });

  it('hides cards across realms on FETCH_CARD', async () => {
    const alpha = await connectViaWebSocket('Alpha', await issueToken('alpha'));
    const beta = await connectViaWebSocket('Beta', await issueToken('beta'));

    const card = await new Promise<unknown>((resolve, reject) => {
      alpha.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'CARD' && msg.did === beta.did) {
          resolve(msg.card);
        }
      });

      alpha.ws.send(encodeCBOR({ type: 'FETCH_CARD', did: beta.did }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(card).toBeNull();

    alpha.ws.close();
    beta.ws.close();
  });

  it('binds SUBSCRIBE to authenticated realm instead of requested realm', async () => {
    const alpha = await connectViaWebSocket('Alpha', await issueToken('alpha'));

    const ack = await new Promise<{ realm?: string }>((resolve, reject) => {
      alpha.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'SUBSCRIBE_ACK') {
          resolve(msg);
        }
      });

      alpha.ws.send(encodeCBOR({ type: 'SUBSCRIBE', events: ['join'], realm: 'beta' }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(ack.realm).toBe('alpha');
    alpha.ws.close();
  });

  it('allows the shared relay client to connect with inviteToken', async () => {
    const token = await issueToken('alpha');
    const agent = await buildSignedAgent('Protocol Client');

    const relayClient = createRelayClient({
      relayUrls: [`ws://localhost:${relayPort}`],
      inviteToken: token,
      did: agent.did,
      keyPair: importKeyPair({
        publicKey: Buffer.from(agent.keyPair.publicKey).toString('hex'),
        privateKey: Buffer.from(agent.keyPair.privateKey).toString('hex'),
      }),
      card: agent.card,
    });

    await relayClient.start();
    expect(relayClient.isConnected()).toBe(true);
    expect(relayClient.getPeerCount()).toBeGreaterThanOrEqual(1);
    await relayClient.stop();
  });
});
