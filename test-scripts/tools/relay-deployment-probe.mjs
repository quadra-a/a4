#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function printUsage() {
  console.error(`Usage:
  relay-deployment-probe.mjs federation --relay-dir <dir> --endpoint-a <ws://...> --endpoint-b <ws://...> [--timeout-ms <ms>]
  relay-deployment-probe.mjs quarantine --relay-dir <dir> --endpoint <ws://...> [--timeout-ms <ms>] [--attempts <n>] [--delay-ms <ms>] [--quarantine-attempt <n>]
  relay-deployment-probe.mjs summary [--smoke-file <file>] [--federation-file <file>] [--quarantine-file <file>]`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }

  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value) {
    throw new Error(`missing required option --${key}`);
  }
  return value;
}

function readIntOption(options, key, fallback) {
  const value = options[key];
  if (value == null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid numeric value for --${key}: ${value}`);
  }
  return parsed;
}

function loadRelayRequire(relayDir) {
  return createRequire(pathToFileURL(join(relayDir, 'package.json')));
}

async function loadProbeDependencies(relayDir) {
  const relayRequire = loadRelayRequire(relayDir);
  const { WebSocket } = relayRequire('ws');
  const { encode, decode } = relayRequire('cbor-x');
  const protocolEntry = join(relayDir, 'node_modules', '@quadra-a', 'protocol', 'dist', 'index.js');
  const protocol = await import(pathToFileURL(protocolEntry).href);
  return {
    WebSocket,
    encodeCBOR: encode,
    decodeCBOR: decode,
    protocol,
  };
}

async function loadRelayIdentity(relayDir) {
  const moduleUrl = pathToFileURL(join(relayDir, 'src', 'relay-identity.ts')).href;
  const module = await import(moduleUrl);
  return module.RelayIdentity;
}

async function waitForEvent(ws, event, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    ws.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForMessage(ws, decodeCBOR, predicate, timeoutMs, label) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onMessage(buffer) {
      const message = decodeCBOR(buffer);
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

async function connectClient({ endpoint, name, timeoutMs, deps }) {
  const { WebSocket, encodeCBOR, protocol, decodeCBOR } = deps;
  const { createAgentCard, deriveDID, generateKeyPair, sign, signAgentCard } = protocol;

  const keyPair = await generateKeyPair();
  const did = deriveDID(keyPair.publicKey);
  const card = createAgentCard(did, name, `${name} deployment federation test`, [], []);
  const signedCard = await signAgentCard(card, (data) => sign(data, keyPair.privateKey));
  const timestamp = Date.now();
  const helloSignature = await sign(encodeCBOR({ did, card: signedCard, timestamp }), keyPair.privateKey);

  const ws = new WebSocket(endpoint);
  await waitForEvent(ws, 'open', timeoutMs);
  ws.send(encodeCBOR({
    type: 'HELLO',
    protocolVersion: 1,
    did,
    card: signedCard,
    timestamp,
    signature: Array.from(helloSignature),
  }));
  const welcome = await waitForMessage(ws, decodeCBOR, (message) => message.type === 'WELCOME', timeoutMs, `${name} welcome`);
  return { ws, welcome };
}

async function relayDirectedPing({ endpoint, name, timeoutMs, deps }) {
  const { encodeCBOR, decodeCBOR } = deps;
  const { ws, welcome } = await connectClient({ endpoint, name, timeoutMs, deps });

  ws.send(encodeCBOR({
    type: 'SEND',
    to: welcome.relayId,
    envelope: encodeCBOR({ type: 'PING' }),
  }));

  const deliver = await waitForMessage(ws, decodeCBOR, (message) => message.type === 'DELIVER', timeoutMs, `${name} deliver`);
  ws.close();
  return {
    relayId: welcome.relayId,
    pong: decodeCBOR(deliver.envelope),
  };
}

async function runFederationProbe(options) {
  const relayDir = requireOption(options, 'relay-dir');
  const endpointA = requireOption(options, 'endpoint-a');
  const endpointB = requireOption(options, 'endpoint-b');
  const timeoutMs = readIntOption(options, 'timeout-ms', 5000);
  const deps = await loadProbeDependencies(relayDir);

  const relayA = await relayDirectedPing({ endpoint: endpointA, name: 'deploy-relay-a', timeoutMs, deps });
  const relayB = await relayDirectedPing({ endpoint: endpointB, name: 'deploy-relay-b', timeoutMs, deps });

  if ((relayA.pong?.relayInfo?.federatedRelays ?? 0) < 1) {
    throw new Error(`relay A did not report an active federated peer: ${JSON.stringify(relayA)}`);
  }
  if ((relayB.pong?.relayInfo?.federatedRelays ?? 0) < 1) {
    throw new Error(`relay B did not report an active federated peer: ${JSON.stringify(relayB)}`);
  }

  console.log(JSON.stringify({ relayA, relayB }, null, 2));
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runQuarantineProbe(options) {
  const relayDir = requireOption(options, 'relay-dir');
  const endpoint = requireOption(options, 'endpoint');
  const timeoutMs = readIntOption(options, 'timeout-ms', 5000);
  const attempts = readIntOption(options, 'attempts', 4);
  const delayMs = readIntOption(options, 'delay-ms', 200);
  const quarantineAttempt = readIntOption(options, 'quarantine-attempt', attempts);
  const expectedCode = readIntOption(options, 'expected-code', 1013);
  const expectedReason = options['expected-reason'] ?? 'Federation handshake temporarily quarantined';
  const relayRequire = loadRelayRequire(relayDir);
  const { encode } = relayRequire('cbor-x');
  const { WebSocket } = relayRequire('ws');
  const RelayIdentity = await loadRelayIdentity(relayDir);
  const tempDir = await mkdtemp(join(tmpdir(), 'relay-quarantine-client-'));

  try {
    const identity = new RelayIdentity(tempDir);
    const originalConsoleLog = console.log;
    console.log = () => {};
    const relayIdentity = await identity.initialize('quarantine-probe', ['ws://127.0.0.1:9999']);
    console.log = originalConsoleLog;

    async function attempt(index) {
      return await new Promise((resolve) => {
        const ws = new WebSocket(endpoint);
        const timer = setTimeout(() => {
          resolve({ index, error: `timeout after ${timeoutMs}ms` });
          ws.terminate();
        }, timeoutMs);

        ws.on('open', async () => {
          const now = Date.now();
          const hello = {
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
          hello.signature[0] = (hello.signature[0] + 1) % 255;
          ws.send(encode(hello));
        });

        ws.on('close', (code, reason) => {
          clearTimeout(timer);
          resolve({ index, code, reason: reason.toString() });
        });

        ws.on('error', (error) => {
          clearTimeout(timer);
          resolve({ index, error: error.message });
        });
      });
    }

    const results = [];
    for (let index = 1; index <= attempts; index += 1) {
      results.push(await attempt(index));
      if (index < attempts) {
        await sleep(delayMs);
      }
    }

    const quarantinedAttempt = results[quarantineAttempt - 1];
    if (quarantinedAttempt?.code !== expectedCode || quarantinedAttempt?.reason !== expectedReason) {
      throw new Error(`expected attempt ${quarantineAttempt} to be quarantined, got ${JSON.stringify(results)}`);
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runSummary(options) {
  const summary = {};
  const files = {
    smoke: options['smoke-file'],
    federation: options['federation-file'],
    quarantine: options['quarantine-file'],
  };

  for (const [key, file] of Object.entries(files)) {
    if (file) {
      summary[key] = JSON.parse(readFileSync(file, 'utf8'));
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === '--help' || command === '-h' || options.help) {
    printUsage();
    process.exit(command === '--help' || command === '-h' || options.help ? 0 : 1);
  }

  switch (command) {
    case 'federation':
      await runFederationProbe(options);
      break;
    case 'quarantine':
      await runQuarantineProbe(options);
      break;
    case 'summary':
      await runSummary(options);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
