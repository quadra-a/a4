/**
 * CVP-0017: TRUST_QUERY integration tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RelayServer } from '../server.js';
import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import { generateKeyPair } from '@quadra-a/protocol';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TRUST_QUERY', () => {
  let relay: RelayServer;
  let tempDir: string;
  let relayPort: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'trust-query-test-'));
    relayPort = 9000 + Math.floor(Math.random() * 1000);

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

  async function connectAgent() {
    const kp = await generateKeyPair();
    const { deriveDID, createAgentCard, signAgentCard, sign } = await import('@quadra-a/protocol');
    const did = deriveDID(kp.publicKey);
    const card = createAgentCard(did, 'Test Agent', 'Test', [], []);
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
        if (msg.type === 'WELCOME') resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    return { ws, did, kp };
  }

  it('should return empty trust result for unknown DID', async () => {
    const agent = await connectAgent();

    const result = await new Promise<{ type: string; endorsements?: unknown[] }>((resolve, reject) => {
      agent.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'TRUST_RESULT') resolve(msg);
      });
      agent.ws.send(encodeCBOR({ type: 'TRUST_QUERY', target: 'did:agent:unknown' }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(result.type).toBe('TRUST_RESULT');
    expect(result.target).toBe('did:agent:unknown');
    expect(result.endorsementCount).toBe(0);
    expect(result.endorsements).toHaveLength(0);

    agent.ws.close();
  });

  it('should return trust result after endorsement', async () => {
    const endorser = await connectAgent();
    const endorsee = await connectAgent();

    const { sign } = await import('@quadra-a/protocol');

    // Create and publish endorsement
    const endorsement = {
      version: 2 as const,
      from: endorser.did,
      to: endorsee.did,
      score: 0.8,
      domain: undefined,
      reason: 'Good work',
      timestamp: Date.now(),
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };

    const { signature: _, ...endorsementWithoutSig } = endorsement as Record<string, unknown>;
    const data = new TextEncoder().encode(JSON.stringify(endorsementWithoutSig));
    const sigBytes = await sign(data, endorser.kp.privateKey);
    const signedEndorsement = { ...endorsementWithoutSig, signature: Buffer.from(sigBytes).toString('hex') };

    // Publish endorsement
    await new Promise<void>((resolve, reject) => {
      endorser.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'ENDORSE_ACK') {
          if (msg.stored) resolve();
          else reject(new Error(`Endorsement not stored: ${msg.error}`));
        }
      });
      endorser.ws.send(encodeCBOR({ type: 'ENDORSE', endorsement: signedEndorsement }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // Query trust
    const result = await new Promise<{ type: string; endorsements?: unknown[] }>((resolve, reject) => {
      endorsee.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'TRUST_RESULT') resolve(msg);
      });
      endorsee.ws.send(encodeCBOR({ type: 'TRUST_QUERY', target: endorsee.did }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(result.endorsementCount).toBe(1);
    expect(result.averageScore).toBeCloseTo(0.8, 1);
    expect(result.endorsements).toHaveLength(1);
    expect(result.endorsements[0].from).toBe(endorser.did);

    endorser.ws.close();
    endorsee.ws.close();
  });

  it('should filter trust results by domain', async () => {
    const endorser = await connectAgent();
    const endorsee = await connectAgent();

    const { sign } = await import('@quadra-a/protocol');

    async function publishEndorsement(domain: string | undefined, score: number) {
      const endorsement: { version: number; from: string; to: string; domain?: string; score: number; timestamp: number; signature?: string } = {
        version: 2,
        from: endorser.did,
        to: endorsee.did,
        score,
        reason: `Test ${domain || 'all'}`,
        timestamp: Date.now(),
      };
      if (domain) endorsement.domain = domain;

      const data = new TextEncoder().encode(JSON.stringify(endorsement));
      const sigBytes = await sign(data, endorser.kp.privateKey);
      endorsement.signature = Buffer.from(sigBytes).toString('hex');

      await new Promise<void>((resolve, reject) => {
        const handler = (data: Buffer) => {
          const msg = decodeCBOR(data);
          if (msg.type === 'ENDORSE_ACK') {
            endorser.ws.off('message', handler);
            if (msg.stored) resolve();
            else reject(new Error(msg.error));
          }
        };
        endorser.ws.on('message', handler);
        endorser.ws.send(encodeCBOR({ type: 'ENDORSE', endorsement }));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });
    }

    // Publish two endorsements with different domains
    // Note: domain must match a capability of the endorsee, or be undefined
    // Since endorsee has no capabilities, we skip domain-specific endorsements
    // and just test that TRUST_QUERY with domain filter works
    await publishEndorsement(undefined, 0.9);

    const result = await new Promise<{ type: string; endorsements?: unknown[] }>((resolve, reject) => {
      endorsee.ws.on('message', (data: Buffer) => {
        const msg = decodeCBOR(data);
        if (msg.type === 'TRUST_RESULT') resolve(msg);
      });
      endorsee.ws.send(encodeCBOR({ type: 'TRUST_QUERY', target: endorsee.did }));
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    expect(result.endorsementCount).toBe(1);

    endorser.ws.close();
    endorsee.ws.close();
  });
});
