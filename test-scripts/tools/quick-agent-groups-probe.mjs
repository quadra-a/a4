#!/usr/bin/env node

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function printUsage() {
  console.error(`Usage:
  quick-agent-groups-probe.mjs smoke --a4-root <dir> --relay-url <ws://...> [--timeout-ms <ms>]`);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function buildSignedAgent(protocol, name, manager) {
  const keyPair = await protocol.generateKeyPair();
  const did = protocol.deriveDID(keyPair.publicKey);
  const unsignedCard = protocol.createAgentCard(did, name, 'quick agent groups probe', [], []);
  const augmentedCard = manager ? manager.augmentCard(unsignedCard) : unsignedCard;
  const signedCard = await protocol.signAgentCard(augmentedCard, (data) => protocol.sign(data, keyPair.privateKey));

  return {
    did,
    keyPair,
    card: signedCard,
  };
}

async function runSmoke(options) {
  const a4Root = options['a4-root'];
  const relayUrl = options['relay-url'];
  const timeoutMs = Number(options['timeout-ms'] ?? 5000);

  if (!a4Root || !relayUrl) {
    throw new Error('smoke probe requires --a4-root and --relay-url');
  }

  const protocolModule = await import(pathToFileURL(join(a4Root, 'js/core/protocol/dist/index.js')).href);
  const {
    createEnvelope,
    createQuickAgentGroupManager,
    createQuickAgentGroupMessageRouter,
    createRelayClient,
    createRelayIndexOperations,
    discoverQuickAgentGroupMembers,
    deriveDID,
    generateKeyPair,
    sign,
    signEnvelope,
    verify,
  } = protocolModule;

  const creatorKeys = await generateKeyPair();
  const creatorDid = deriveDID(creatorKeys.publicKey);
  const creatorManager = createQuickAgentGroupManager();
  const invite = await creatorManager.createInvite(
    {
      issuedBy: creatorDid,
      expiresAt: Date.now() + 60_000,
      metadata: {
        name: 'probe-room',
        purpose: 'test-scripts smoke validation',
      },
    },
    (data) => sign(data, creatorKeys.privateKey),
  );

  const managerA = createQuickAgentGroupManager();
  const managerB = createQuickAgentGroupManager();
  const managerC = createQuickAgentGroupManager();
  await managerA.joinGroup(invite, (signature, data) => verify(signature, data, creatorKeys.publicKey));
  await managerB.joinGroup(invite, (signature, data) => verify(signature, data, creatorKeys.publicKey));

  const agentA = await buildSignedAgent(protocolModule, 'Probe Alpha', managerA);
  const agentB = await buildSignedAgent(protocolModule, 'Probe Beta', managerB);
  const agentC = await buildSignedAgent(protocolModule, 'Probe Gamma', managerC);

  const clientA = createRelayClient({ relayUrls: [relayUrl], did: agentA.did, keyPair: agentA.keyPair, card: agentA.card, autoDiscoverRelays: false });
  const clientB = createRelayClient({ relayUrls: [relayUrl], did: agentB.did, keyPair: agentB.keyPair, card: agentB.card, autoDiscoverRelays: false });
  const clientC = createRelayClient({ relayUrls: [relayUrl], did: agentC.did, keyPair: agentC.keyPair, card: agentC.card, autoDiscoverRelays: false });

  const routerA = createQuickAgentGroupMessageRouter(clientA, async () => true, managerA);
  const routerB = createQuickAgentGroupMessageRouter(clientB, async () => true, managerB);
  const routerC = createQuickAgentGroupMessageRouter(clientC, async () => true, managerC);

  const receivedByB = [];
  const receivedByC = [];

  try {
    await Promise.all([clientA.start(), clientB.start(), clientC.start()]);
    await Promise.all([clientA.publishCard(agentA.card), clientB.publishCard(agentB.card), clientC.publishCard(agentC.card)]);
    await sleep(200);

    await Promise.all([routerA.start(), routerB.start(), routerC.start()]);
    routerB.registerHandler('/quick/group/1.0.0', async (envelope) => {
      receivedByB.push(envelope.id);
    });
    routerC.registerHandler('/quick/group/1.0.0', async (envelope) => {
      receivedByC.push(envelope.id);
    });

    const discoveryA = await discoverQuickAgentGroupMembers(createRelayIndexOperations(clientA), managerA, invite.groupId);
    let discoveryCBlocked = false;
    try {
      await discoverQuickAgentGroupMembers(createRelayIndexOperations(clientC), managerC, invite.groupId);
    } catch {
      discoveryCBlocked = true;
    }

    const envelopeToB = managerA.decorateEnvelope(
      createEnvelope(agentA.did, agentB.did, 'message', '/quick/group/1.0.0', { text: 'hello beta' }),
      invite.groupId,
    );
    const envelopeToC = managerA.decorateEnvelope(
      createEnvelope(agentA.did, agentC.did, 'message', '/quick/group/1.0.0', { text: 'hello gamma' }),
      invite.groupId,
    );

    await routerA.sendMessage(await signEnvelope(envelopeToB, (data) => sign(data, agentA.keyPair.privateKey)));
    await routerA.sendMessage(await signEnvelope(envelopeToC, (data) => sign(data, agentA.keyPair.privateKey)));
    await waitFor(() => receivedByB.length === 1, timeoutMs, 'group delivery to joined member');
    await sleep(150);

    if (receivedByC.length !== 0) {
      throw new Error('Non-member received quick group message');
    }

    console.log(JSON.stringify({
      status: 'ok',
      relayUrl,
      groupId: invite.groupId,
      discovery: {
        visibleToJoinedMember: discoveryA.map((card) => card.did).sort(),
        blockedForNonMember: discoveryCBlocked,
      },
      messaging: {
        deliveredToJoinedMember: receivedByB.length,
        deliveredToNonMember: receivedByC.length,
      },
    }, null, 2));
  } finally {
    await Promise.allSettled([routerA.stop(), routerB.stop(), routerC.stop()]);
    await Promise.allSettled([clientA.stop(), clientB.stop(), clientC.stop()]);
  }
}

async function main() {
  if (process.argv.length <= 2 || process.argv[2] === '--help' || process.argv[2] === '-h') {
    printUsage();
    process.exit(0);
  }

  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help || !command) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  switch (command) {
    case 'smoke':
      await runSmoke(options);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
