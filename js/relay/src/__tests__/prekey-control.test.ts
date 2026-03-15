import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decode as decodeCBOR, encode as encodeCBOR } from 'cbor-x';
import { rmSync } from 'fs';
import { WebSocket } from 'ws';
import { RelayServer } from '../server.js';
import type { RelayMessage } from '../types.js';

async function connectAuthenticatedClient(relayPort: number): Promise<{ ws: WebSocket; did: string }> {
  const ws = new WebSocket(`ws://localhost:${relayPort}`);

  return new Promise((resolve, reject) => {
    let did = '';
    const timeout = setTimeout(() => reject(new Error('Authentication timeout')), 5000);

    ws.on('open', async () => {
      try {
        const { createAgentCard, deriveDID, generateKeyPair, sign, signAgentCard } = await import('@quadra-a/protocol');
        const keyPair = await generateKeyPair();
        did = deriveDID(keyPair.publicKey);
        const card = createAgentCard(did, 'Test Agent', 'Test', [], []);
        const signedCard = await signAgentCard(card, (data) => sign(data, keyPair.privateKey));
        const timestamp = Date.now();
        const helloData = encodeCBOR({ did, card: signedCard, timestamp });
        const signature = await sign(helloData, keyPair.privateKey);
        ws.send(encodeCBOR({
          type: 'HELLO',
          protocolVersion: 1,
          did,
          card: signedCard,
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
        resolve({ ws, did });
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

describe('relay pre-key control plane', () => {
  let server: RelayServer;
  let storagePath: string;
  let relayPort = 0;

  beforeEach(async () => {
    storagePath = `./test-relay-prekeys-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    relayPort = 10000 + Math.floor(Math.random() * 20000);
    server = new RelayServer({ port: relayPort, storagePath });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('publishes bundles and atomically claims one-time pre-keys over relay messages', async () => {
    const publisher = await connectAuthenticatedClient(relayPort);
    const requester = await connectAuthenticatedClient(relayPort);

    publisher.ws.send(encodeCBOR({
      type: 'PUBLISH_PREKEYS',
      bundles: [{
        deviceId: 'device-1',
        identityKeyPublic: 'identity-1',
        signedPreKeyPublic: 'signed-1',
        signedPreKeyId: 1,
        signedPreKeySignature: 'signature-1',
        oneTimePreKeyCount: 2,
        lastResupplyAt: 123,
        oneTimePreKeys: [
          { keyId: 1, publicKey: 'otk-1' },
          { keyId: 2, publicKey: 'otk-2' },
        ],
      }],
    }));

    const published = await waitForMessage(publisher.ws, (message): message is RelayMessage & { type: 'PREKEYS_PUBLISHED'; did: string; deviceCount: number } => message.type === 'PREKEYS_PUBLISHED');
    expect(published.did).toBe(publisher.did);
    expect(published.deviceCount).toBe(1);

    requester.ws.send(encodeCBOR({
      type: 'FETCH_PREKEY_BUNDLE',
      did: publisher.did,
      deviceId: 'device-1',
    }));
    const first = await waitForMessage(requester.ws, (message): message is RelayMessage & { type: 'PREKEY_BUNDLE'; bundle: Record<string, unknown> | null } => message.type === 'PREKEY_BUNDLE');
    expect(first.did).toBe(publisher.did);
    expect(first.bundle).toMatchObject({
      deviceId: 'device-1',
      oneTimePreKey: { keyId: 1, publicKey: 'otk-1' },
      remainingOneTimePreKeyCount: 1,
      oneTimePreKeyCount: 1,
    });

    requester.ws.send(encodeCBOR({
      type: 'FETCH_PREKEY_BUNDLE',
      did: publisher.did,
      deviceId: 'device-1',
    }));
    const second = await waitForMessage(requester.ws, (message): message is RelayMessage & { type: 'PREKEY_BUNDLE'; bundle: Record<string, unknown> | null } => message.type === 'PREKEY_BUNDLE');
    expect(second.bundle).toMatchObject({
      deviceId: 'device-1',
      oneTimePreKey: { keyId: 2, publicKey: 'otk-2' },
      remainingOneTimePreKeyCount: 0,
      oneTimePreKeyCount: 0,
    });

    requester.ws.send(encodeCBOR({
      type: 'FETCH_PREKEY_BUNDLE',
      did: publisher.did,
      deviceId: 'device-1',
    }));
    const exhausted = await waitForMessage(requester.ws, (message): message is RelayMessage & { type: 'PREKEY_BUNDLE'; bundle: Record<string, unknown> | null } => message.type === 'PREKEY_BUNDLE');
    expect(exhausted.bundle).toMatchObject({
      deviceId: 'device-1',
      remainingOneTimePreKeyCount: 0,
      oneTimePreKeyCount: 0,
    });
    expect((exhausted.bundle as { oneTimePreKey?: unknown } | null)?.oneTimePreKey).toBeUndefined();

    publisher.ws.close();
    requester.ws.close();
  });
});
