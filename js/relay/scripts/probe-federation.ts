import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { encode, decode } from 'cbor-x';
import { RelayIdentity } from '../src/relay-identity.ts';
import type { FederationHelloMessage, RelayMessage } from '../src/types.ts';

const endpoint = process.argv[2];
if (!endpoint) {
  console.error('Usage: node --experimental-strip-types scripts/probe-federation.ts ws://host:port');
  process.exit(1);
}

const tempDir = await mkdtemp(join(tmpdir(), 'relay-probe-'));

try {
  const identity = new RelayIdentity(tempDir);
  const relayIdentity = await identity.initialize('probe', ['ws://probe.invalid:8080']);
  const ws = new WebSocket(endpoint);
  const timeout = setTimeout(() => {
    console.error('TIMEOUT: no federation response within 10s');
    ws.close();
  }, 10_000);

  ws.on('open', async () => {
    const now = Date.now();
    const hello: FederationHelloMessage = {
      type: 'FEDERATION_HELLO',
      relayDid: relayIdentity.did,
      relayCard: relayIdentity.agentCard,
      endpoints: relayIdentity.agentCard.endpoints,
      timestamp: now,
      signature: [],
    };

    const helloData = encode({
      relayDid: hello.relayDid,
      relayCard: hello.relayCard,
      endpoints: hello.endpoints,
      timestamp: hello.timestamp,
    });

    hello.signature = Array.from(await identity.sign(helloData));
    ws.send(encode(hello));
    console.log(`SENT FEDERATION_HELLO to ${endpoint}`);
  });

  ws.on('message', (buffer) => {
    try {
      const msg = decode(buffer as Buffer) as RelayMessage;
      console.log('RECV', JSON.stringify(msg, null, 2));
    } catch (error) {
      console.error('RECV NON-CBOR', error);
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(timeout);
    console.log(`CLOSE code=${code} reason=${reason.toString()}`);
  });

  ws.on('error', (error) => {
    clearTimeout(timeout);
    console.error('ERROR', error.message);
  });

  await new Promise<void>((resolve) => {
    ws.on('close', () => resolve());
    ws.on('error', () => resolve());
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
