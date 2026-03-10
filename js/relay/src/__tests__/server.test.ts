/**
 * CVP-0011: Relay server tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import { RelayServer } from '../server.js';
import type { HelloMessage, WelcomeMessage, RelayMessage } from '../types.js';

describe('RelayServer', () => {
  let server: RelayServer;
  const TEST_PORT = 8888;
  let testCounter = 0;

  beforeEach(async () => {
    testCounter++;
    const storagePath = `./test-relay-data-${testCounter}-${Date.now()}`;
    server = new RelayServer({ port: TEST_PORT, storagePath });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    // Give the server time to fully close
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  it('should start and accept connections', async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  });

  it('should reject unauthenticated messages', async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Send SEND message without HELLO first (CBOR-encoded)
        const msg = { type: 'SEND', to: 'did:test', envelope: new Uint8Array(0) };
        ws.send(encodeCBOR(msg));
      });

      ws.on('close', (code, reason) => {
        expect(code).toBe(1008);
        expect(reason.toString()).toContain('Must send HELLO first');
        resolve();
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 5000);
    });
  });

  it('should handle HELLO with invalid timestamp', async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', async () => {
        const { generateKeyPair, sign, createAgentCard, signAgentCard } = await import('@quadra-a/protocol');
        const keyPair = await generateKeyPair();
        const { deriveDID } = await import('@quadra-a/protocol');
        const did = deriveDID(keyPair.publicKey);

        const card = createAgentCard(did, 'Test Agent', 'Test', [], []);
        const signedCard = await signAgentCard(card, (data) => sign(data, keyPair.privateKey));

        const hello: HelloMessage = {
          type: 'HELLO',
          protocolVersion: 1,
          did,
          card: signedCard,
          timestamp: Date.now() - 360_000, // 6 minutes old (> 5min threshold)
          signature: Array.from(new Uint8Array(64)),
        };

        ws.send(encodeCBOR(hello));
      });

      ws.on('close', (code, reason) => {
        expect(code).toBe(1008);
        expect(reason.toString()).toContain('Timestamp too old');
        resolve();
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 5000);
    });
  });

  it('should accept valid HELLO and send WELCOME', async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', async () => {
        const { generateKeyPair, sign, createAgentCard, signAgentCard, deriveDID } = await import('@quadra-a/protocol');
        const keyPair = await generateKeyPair();
        const did = deriveDID(keyPair.publicKey);

        const card = createAgentCard(did, 'Test Agent', 'Test', [], []);
        const signedCard = await signAgentCard(card, (data) => sign(data, keyPair.privateKey));

        const timestamp = Date.now();
        const helloData = encodeCBOR({ did, card: signedCard, timestamp });
        const signature = await sign(helloData, keyPair.privateKey);

        const hello: HelloMessage = {
          type: 'HELLO',
          protocolVersion: 1,
          did,
          card: signedCard,
          timestamp,
          signature: Array.from(signature),
        };

        ws.send(encodeCBOR(hello));
      });

      ws.on('message', (data: Buffer) => {
        const msg: RelayMessage = decodeCBOR(data);
        if (msg.type === 'WELCOME') {
          const welcome = msg as WelcomeMessage;
          expect(welcome.protocolVersion).toBe(1);
          expect(welcome.relayId).toBeDefined();
          expect(welcome.peers).toBeGreaterThanOrEqual(0);
          ws.close();
          resolve();
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 5000);
    });
  });

  it('should handle PING/PONG', async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    await new Promise<void>((resolve, reject) => {
      let authenticated = false;

      ws.on('open', async () => {
        const { generateKeyPair, sign, createAgentCard, signAgentCard, deriveDID } = await import('@quadra-a/protocol');
        const keyPair = await generateKeyPair();
        const did = deriveDID(keyPair.publicKey);

        const card = createAgentCard(did, 'Test Agent', 'Test', [], []);
        const signedCard = await signAgentCard(card, (data) => sign(data, keyPair.privateKey));

        const timestamp = Date.now();
        const helloData = encodeCBOR({ did, card: signedCard, timestamp });
        const signature = await sign(helloData, keyPair.privateKey);

        const hello: HelloMessage = {
          type: 'HELLO',
          protocolVersion: 1,
          did,
          card: signedCard,
          timestamp,
          signature: Array.from(signature),
        };

        ws.send(encodeCBOR(hello));
      });

      ws.on('message', (data: Buffer) => {
        const msg: RelayMessage = decodeCBOR(data);

        if (msg.type === 'WELCOME') {
          authenticated = true;
          // Send PING (CBOR-encoded)
          ws.send(encodeCBOR({ type: 'PING' }));
        } else if (msg.type === 'PONG') {
          if (authenticated) {
            expect(msg.peers).toBeGreaterThanOrEqual(0);
            ws.close();
            resolve();
          }
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 5000);
    });
  });
});
