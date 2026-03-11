import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import {
  createAgentCard,
  createQuickAgentGroupManager,
  createQuickAgentGroupMessageRouter,
  createRelayClient,
  createRelayIndexOperations,
  deriveDID,
  discoverQuickAgentGroupMembers,
  generateKeyPair,
  sign,
  signAgentCard,
  verify,
  type QuickAgentGroupManager,
} from '@quadra-a/protocol';
import { RelayServer } from '../server.js';
import { createInviteToken } from '../token.js';
import type { HelloMessage, WelcomeMessage } from '../types.js';

const canBindLocalRelayPort = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(0, () => {
    server.close(() => resolve(true));
  });
});

const relayIt = canBindLocalRelayPort ? it : it.skip;

async function buildClientAgent(name: string, manager?: QuickAgentGroupManager) {
  const keyPair = await generateKeyPair();
  const did = deriveDID(keyPair.publicKey);
  const unsignedCard = createAgentCard(did, name, 'group overlay compat test', [], []);
  const cardWithGroups = manager ? manager.augmentCard(unsignedCard) : unsignedCard;
  const signedCard = await signAgentCard(cardWithGroups, (data) => sign(data, keyPair.privateKey));

  return {
    did,
    keyPair,
    card: signedCard,
  };
}

describe('Quick agent group overlay compatibility', () => {
  const tempDirs: string[] = [];
  const relays: RelayServer[] = [];

  afterEach(async () => {
    for (const relay of relays.splice(0)) {
      await relay.stop();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  relayIt('supports overlay discovery and client-side message filtering on a public relay', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'group-overlay-public-'));
    tempDirs.push(storagePath);
    const relayPort = 9700 + Math.floor(Math.random() * 200);
    const relay = new RelayServer({ port: relayPort, storagePath });
    relays.push(relay);
    await relay.start();

    const creatorKeys = await generateKeyPair();
    const creatorDid = deriveDID(creatorKeys.publicKey);
    const inviteManager = createQuickAgentGroupManager();
    const invite = await inviteManager.createInvite(
      {
        issuedBy: creatorDid,
        expiresAt: Date.now() + 60_000,
      },
      (data) => sign(data, creatorKeys.privateKey),
    );

    const managerA = createQuickAgentGroupManager();
    const managerB = createQuickAgentGroupManager();
    const managerC = createQuickAgentGroupManager();
    await managerA.joinGroup(invite, (signature, data) => verify(signature, data, creatorKeys.publicKey));
    await managerB.joinGroup(invite, (signature, data) => verify(signature, data, creatorKeys.publicKey));

    const agentA = await buildClientAgent('Alpha', managerA);
    const agentB = await buildClientAgent('Beta', managerB);
    const agentC = await buildClientAgent('Gamma', managerC);

    const relayUrl = `ws://localhost:${relayPort}`;
    const clientA = createRelayClient({ relayUrls: [relayUrl], did: agentA.did, keyPair: agentA.keyPair, card: agentA.card, autoDiscoverRelays: false });
    const clientB = createRelayClient({ relayUrls: [relayUrl], did: agentB.did, keyPair: agentB.keyPair, card: agentB.card, autoDiscoverRelays: false });
    const clientC = createRelayClient({ relayUrls: [relayUrl], did: agentC.did, keyPair: agentC.keyPair, card: agentC.card, autoDiscoverRelays: false });

    await Promise.all([clientA.start(), clientB.start(), clientC.start()]);
    await Promise.all([clientA.publishCard(agentA.card), clientB.publishCard(agentB.card), clientC.publishCard(agentC.card)]);

    const routerA = createQuickAgentGroupMessageRouter(clientA, async () => true, managerA);
    const routerB = createQuickAgentGroupMessageRouter(clientB, async () => true, managerB);
    const routerC = createQuickAgentGroupMessageRouter(clientC, async () => true, managerC);
    await Promise.all([routerA.start(), routerB.start(), routerC.start()]);

    const receivedByB: string[] = [];
    const receivedByC: string[] = [];
    routerB.registerHandler('/quick/group/1.0.0', async (envelope) => {
      receivedByB.push(envelope.id);
    });
    routerC.registerHandler('/quick/group/1.0.0', async (envelope) => {
      receivedByC.push(envelope.id);
    });

    const relayIndexA = createRelayIndexOperations(clientA);
    await expect
      .poll(
        async () => (await discoverQuickAgentGroupMembers(relayIndexA, managerA, invite.groupId)).map((card) => card.did).sort(),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual([agentA.did, agentB.did].sort());

    await expect(discoverQuickAgentGroupMembers(createRelayIndexOperations(clientC), managerC, invite.groupId)).rejects.toThrow('Not a member');

    const groupMessageToB = managerA.decorateEnvelope(
      createAgentCardEnvelope(agentA.did, agentB.did, '/quick/group/1.0.0', { text: 'hello beta' }),
      invite.groupId,
    );
    const groupMessageToC = managerA.decorateEnvelope(
      createAgentCardEnvelope(agentA.did, agentC.did, '/quick/group/1.0.0', { text: 'hello gamma' }),
      invite.groupId,
    );

    await routerA.sendMessage(await signAgentEnvelope(groupMessageToB, agentA.keyPair.privateKey));
    await routerA.sendMessage(await signAgentEnvelope(groupMessageToC, agentA.keyPair.privateKey));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(receivedByB).toHaveLength(1);
    expect(receivedByC).toHaveLength(0);

    await Promise.all([routerA.stop(), routerB.stop(), routerC.stop()]);
    await Promise.all([clientA.stop(), clientB.stop(), clientC.stop()]);
  });

  relayIt('does not let overlay group metadata bypass private relay realm isolation', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'group-overlay-private-'));
    tempDirs.push(storagePath);
    const relayPort = 9900 + Math.floor(Math.random() * 200);
    const operatorKeyPair = await generateKeyPair();
    const relay = new RelayServer({
      port: relayPort,
      storagePath,
      federationEnabled: false,
      privateRelay: true,
      operatorPublicKey: Buffer.from(operatorKeyPair.publicKey).toString('hex'),
    });
    relays.push(relay);
    await relay.start();

    const creatorKeys = await generateKeyPair();
    const creatorDid = deriveDID(creatorKeys.publicKey);
    const creatorManager = createQuickAgentGroupManager();
    const invite = await creatorManager.createInvite(
      {
        issuedBy: creatorDid,
        expiresAt: Date.now() + 60_000,
      },
      (data) => sign(data, creatorKeys.privateKey),
    );

    const managerAlpha = createQuickAgentGroupManager();
    const managerBeta = createQuickAgentGroupManager();
    await managerAlpha.joinGroup(invite, (signature, data) => verify(signature, data, creatorKeys.publicKey));
    await managerBeta.joinGroup(invite, (signature, data) => verify(signature, data, creatorKeys.publicKey));

    const alpha = await buildSignedWsAgent('Alpha', managerAlpha);
    const beta = await buildSignedWsAgent('Beta', managerBeta);
    const tokenAlpha = await issueToken(operatorKeyPair.privateKey, 'alpha');
    const tokenBeta = await issueToken(operatorKeyPair.privateKey, 'beta');
    const relayUrl = `ws://localhost:${relayPort}`;

    const alphaConnection = await connectViaWebSocket(relayUrl, alpha, tokenAlpha);
    const betaConnection = await connectViaWebSocket(relayUrl, beta, tokenBeta);

    const card = await new Promise<unknown>((resolve, reject) => {
      alphaConnection.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'CARD' && msg.did === beta.did) {
          resolve(msg.card);
        }
      });

      alphaConnection.ws.send(encodeCBOR({ type: 'FETCH_CARD', did: beta.did }));
      setTimeout(() => reject(new Error('Timeout')), 5_000);
    });

    expect(alphaConnection.welcome.realm).toBe('alpha');
    expect(betaConnection.welcome.realm).toBe('beta');
    expect(card).toBeNull();

    alphaConnection.ws.close();
    betaConnection.ws.close();
  });
});

function createAgentCardEnvelope(from: string, to: string, protocol: string, payload: Record<string, unknown>) {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from,
    to,
    type: 'message' as const,
    protocol,
    payload,
    timestamp: Date.now(),
  };
}

async function signAgentEnvelope(
  envelope: ReturnType<typeof createAgentCardEnvelope> & { groupId?: string },
  privateKey: Uint8Array,
) {
  const signature = await sign(new TextEncoder().encode(JSON.stringify(envelope)), privateKey);
  return {
    ...envelope,
    signature: Buffer.from(signature).toString('hex'),
  };
}

async function buildSignedWsAgent(name: string, manager: QuickAgentGroupManager) {
  const keyPair = await generateKeyPair();
  const did = deriveDID(keyPair.publicKey);
  const unsignedCard = manager.augmentCard(createAgentCard(did, name, 'private relay quick group test', [], []));
  const card = await signAgentCard(unsignedCard, (data) => sign(data, keyPair.privateKey));
  return { did, keyPair, card };
}

async function issueToken(privateKey: Uint8Array, realm: string) {
  const now = Math.floor(Date.now() / 1000);
  return createInviteToken(
    {
      iss: 'did:agent:operator',
      sub: '*',
      realm,
      exp: now + 3600,
      iat: now,
      jti: randomUUID(),
    },
    privateKey,
  );
}

async function connectViaWebSocket(
  relayUrl: string,
  agent: Awaited<ReturnType<typeof buildSignedWsAgent>>,
  inviteToken: string,
): Promise<{ ws: WebSocket; welcome: WelcomeMessage }> {
  const ws = new WebSocket(relayUrl);

  const welcome = await new Promise<WelcomeMessage>((resolve, reject) => {
    ws.on('open', async () => {
      const timestamp = Date.now();
      const helloPayload = { did: agent.did, card: agent.card, timestamp, inviteToken };
      const signature = await sign(encodeCBOR(helloPayload), agent.keyPair.privateKey);
      const hello: HelloMessage = {
        type: 'HELLO',
        protocolVersion: 1,
        did: agent.did,
        card: agent.card,
        timestamp,
        signature: Array.from(signature),
        inviteToken,
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
    setTimeout(() => reject(new Error('Timeout')), 5_000);
  });

  return { ws, welcome };
}
