#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';
import {
  createAgentCard,
  deriveDID,
  generateKeyPair,
  sign,
  signAgentCard,
} from '@quadra-a/protocol';

interface RelayMessage {
  type: string;
  [key: string]: unknown;
}

interface HelloMessage extends RelayMessage {
  type: 'HELLO';
  protocolVersion: number;
  did: string;
  card: Record<string, unknown>;
  timestamp: number;
  signature: number[];
}

interface WelcomeMessage extends RelayMessage {
  type: 'WELCOME';
  relayId: string;
  peers: number;
}

interface DeliverMessage extends RelayMessage {
  type: 'DELIVER';
  from: string;
  envelope: Uint8Array | number[];
}

interface DeliveryReportMessage extends RelayMessage {
  type: 'DELIVERY_REPORT';
  status: string;
}

interface PongMessage extends RelayMessage {
  type: 'PONG';
  peers: number;
  relayInfo?: Record<string, unknown>;
}

interface SmokeOptions {
  port: number;
  publicEndpoint: string;
  storagePath?: string;
  keepData: boolean;
  timeoutMs: number;
  json: boolean;
  skipBuild: boolean;
}

interface SmokeClient {
  ws: WebSocket;
  did: string;
  welcome: WelcomeMessage;
}

function printUsage(): void {
  console.log(`Usage: node --experimental-strip-types scripts/smoke-relay.ts [options]

Options:
  --port <number>             Relay port to listen on (default: 8091)
  --public-endpoint <ws-url>  Advertised relay endpoint (default: ws://127.0.0.1:<port>)
  --storage-path <path>       Use a specific relay data directory instead of a temp dir
  --keep-data                 Keep the auto-created temp data directory after the run
  --timeout-ms <number>       Per-step timeout in milliseconds (default: 5000)
  --skip-build                Reuse the current dist/ output instead of rebuilding first
  --json                      Print only the JSON summary
  -h, --help                  Show this help
`);
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = {
    port: 8091,
    publicEndpoint: '',
    keepData: false,
    timeoutMs: 5000,
    json: false,
    skipBuild: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--keep-data') {
      options.keepData = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--skip-build') {
      options.skipBuild = true;
      continue;
    }

    const nextValue = argv[index + 1];
    if (!nextValue) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case '--port':
        options.port = parseInt(nextValue, 10);
        index += 1;
        break;
      case '--public-endpoint':
        options.publicEndpoint = nextValue;
        index += 1;
        break;
      case '--storage-path':
        options.storagePath = nextValue;
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = parseInt(nextValue, 10);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error(`Invalid --port value: ${options.port}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }

  options.publicEndpoint ||= `ws://127.0.0.1:${options.port}`;
  return options;
}

function getPnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function toUint8Array(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function runBuild(cwd: string, options: SmokeOptions): Promise<void> {
  if (options.skipBuild) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(getPnpmCommand(), ['run', 'build'], {
      cwd,
      stdio: options.json ? 'pipe' : 'inherit',
    });

    let stderr = '';
    if (options.json && child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `Build failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function startRelayProcess(cwd: string, storagePath: string, options: SmokeOptions): Promise<ChildProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'dist/index.js',
      '--port', String(options.port),
      '--landing-port', 'false',
      '--data-dir', storagePath,
      '--public-endpoint', options.publicEndpoint,
      '--no-federation',
    ], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for relay startup\n${stdout}${stderr}`.trim()));
    }, options.timeoutMs * 2);

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      handler();
    };

    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) => {
      finish(() => reject(new Error(
        `Relay exited before becoming ready (code=${code ?? 'null'} signal=${signal ?? 'null'})\n${stdout}${stderr}`.trim(),
      )));
    });

    const onOutput = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      const text = chunk.toString();
      if (target === 'stdout') {
        stdout += text;
        if (!options.json) {
          process.stdout.write(text);
        }
        if (stdout.includes('✓ Relay agent started')) {
          finish(() => resolve(child));
        }
        return;
      }

      stderr += text;
      if (!options.json) {
        process.stderr.write(text);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => onOutput(chunk, 'stderr'));
  });
}

async function stopRelayProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGINT');
  });
}

function waitForEvent(ws: WebSocket, event: 'open' | 'close', timeoutMs: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    ws.once(event, (...args) => {
      clearTimeout(timeout);
      resolve(args);
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function waitForMessage<T extends RelayMessage>(
  ws: WebSocket,
  predicate: (message: RelayMessage) => message is T,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      reject(new Error(`Timeout waiting for ${label}`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }

    function onError(err: Error): void {
      cleanup();
      reject(err);
    }

    function onMessage(data: Buffer): void {
      const message = decodeCBOR(data) as RelayMessage;
      if (!predicate(message)) {
        return;
      }

      cleanup();
      resolve(message);
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

async function closeSocket(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    return;
  }

  ws.close();
  try {
    await waitForEvent(ws, 'close', timeoutMs);
  } catch {
    ws.terminate();
  }
}

async function createClient(name: string, endpoint: string, timeoutMs: number): Promise<SmokeClient> {
  const keyPair = await generateKeyPair();
  const did = deriveDID(keyPair.publicKey);
  const card = createAgentCard(did, name, `${name} integration client`, [], []);
  const signedCard = await signAgentCard(card, (data) => sign(data, keyPair.privateKey));

  const timestamp = Date.now();
  const helloPayload = { did, card: signedCard, timestamp };
  const helloSignature = await sign(encodeCBOR(helloPayload), keyPair.privateKey);

  const ws = new WebSocket(endpoint);
  await waitForEvent(ws, 'open', timeoutMs);

  const hello: HelloMessage = {
    type: 'HELLO',
    protocolVersion: 1,
    did,
    card: signedCard,
    timestamp,
    signature: Array.from(helloSignature),
  };

  ws.send(encodeCBOR(hello));
  const welcome = await waitForMessage(
    ws,
    (message): message is WelcomeMessage => message.type === 'WELCOME',
    timeoutMs,
    `${name} WELCOME`,
  );

  return { ws, did, welcome };
}

function isDeliveryReport(message: RelayMessage): message is DeliveryReportMessage {
  return message.type === 'DELIVERY_REPORT';
}

function isDeliverMessage(message: RelayMessage): message is DeliverMessage {
  return message.type === 'DELIVER';
}

function isPongMessage(message: RelayMessage): message is PongMessage {
  return message.type === 'PONG';
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const tempStoragePath = options.storagePath
    ? undefined
    : await mkdtemp(join(tmpdir(), 'relay-smoke-'));
  const storagePath = options.storagePath ?? tempStoragePath!;
  const clients: SmokeClient[] = [];
  let relayProcess: ChildProcess | undefined;

  const log = (message: string): void => {
    if (!options.json) {
      console.log(message);
    }
  };

  try {
    log(`Preparing relay smoke test for ${options.publicEndpoint}`);
    log(`Storage path: ${storagePath}`);
    await runBuild(cwd, options);
    relayProcess = await startRelayProcess(cwd, storagePath, options);

    const clientA = await createClient('Smoke Client A', options.publicEndpoint, options.timeoutMs);
    clients.push(clientA);
    const clientB = await createClient('Smoke Client B', options.publicEndpoint, options.timeoutMs);
    clients.push(clientB);

    log(`Connected client A: ${clientA.did}`);
    log(`Connected client B: ${clientB.did}`);

    const directPayload = { type: 'message', body: 'hello from smoke test' };
    clientA.ws.send(encodeCBOR({
      type: 'SEND',
      to: clientB.did,
      envelope: encodeCBOR(directPayload),
    }));

    const deliveredToB = await waitForMessage(
      clientB.ws,
      isDeliverMessage,
      options.timeoutMs,
      'DELIVER to client B',
    );
    const deliveryReportToA = await waitForMessage(
      clientA.ws,
      isDeliveryReport,
      options.timeoutMs,
      'DELIVERY_REPORT to client A',
    );

    clientA.ws.send(encodeCBOR({ type: 'PING' }));
    const pongToA = await waitForMessage(clientA.ws, isPongMessage, options.timeoutMs, 'PONG to client A');

    clientA.ws.send(encodeCBOR({
      type: 'SEND',
      to: clientA.welcome.relayId,
      envelope: encodeCBOR({ type: 'PING' }),
    }));
    const relayDeliver = await waitForMessage(
      clientA.ws,
      (message): message is DeliverMessage => message.type === 'DELIVER' && message.from === clientA.welcome.relayId,
      options.timeoutMs,
      'relay-directed DELIVER',
    );
    const relayPong = decodeCBOR(toUint8Array(relayDeliver.envelope)) as PongMessage;

    const summary = {
      relayDid: clientA.welcome.relayId,
      endpoint: options.publicEndpoint,
      storagePath,
      buildExecuted: !options.skipBuild,
      directDelivery: {
        from: deliveredToB.from,
        decodedEnvelope: decodeCBOR(toUint8Array(deliveredToB.envelope)),
        reportStatus: deliveryReportToA.status,
      },
      directPing: pongToA,
      relayDirectedPing: {
        outerType: relayDeliver.type,
        outerFrom: relayDeliver.from,
        inner: relayPong,
      },
      clients: [
        { did: clientA.did, peersAtWelcome: clientA.welcome.peers },
        { did: clientB.did, peersAtWelcome: clientB.welcome.peers },
      ],
    };

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log('Smoke test passed.');
      console.log(JSON.stringify(summary, null, 2));
    }
  } finally {
    for (const client of clients) {
      await closeSocket(client.ws, options.timeoutMs);
    }

    if (relayProcess) {
      await stopRelayProcess(relayProcess, options.timeoutMs);
    }

    if (tempStoragePath && !options.keepData) {
      await rm(tempStoragePath, { recursive: true, force: true });
    }
  }
}

main().catch((error: Error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
});
