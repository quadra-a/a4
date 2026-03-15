#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const protocolModuleUrl = pathToFileURL(
  resolve(__dirname, '../../../js/core/protocol/dist/index.js'),
).href;
const protocol = await import(protocolModuleUrl);

const {
  buildClaimedPreKeyBundle,
  buildPublishedDeviceDirectory,
  buildPublishedPreKeyBundles,
  createEnvelope,
  createInitialLocalE2EConfig,
  createLocalDeviceState,
  createRelayClient,
  generateX25519KeyPair,
  decodeMessage,
  decodeSessionMessage,
  decryptApplicationEnvelope,
  encodeMessage,
  encodeSessionMessage,
  decodeEncryptedApplicationEnvelopePayload,
  deriveDID,
  encryptApplicationEnvelope,
  E2E_APPLICATION_ENVELOPE_PROTOCOL,
  generateAnonymousIdentity,
  generateKeyPair,
  hexToBytes,
  importKeyPair,
  loadLocalSession,
  rotateLocalDeviceSignedPreKey,
  sign,
  signAgentCard,
  signEncryptedTransportEnvelope,
  signEnvelope,
} = protocol;

function usage() {
  console.error(`Usage:
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs cross-js-to-rust <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs verify-rust-to-js <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs compare-visible-headers <js-artifact-path> <rust-artifact-path> <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs wait-card <relay-url> <did> <device-id> <artifact-path> [timeout-ms]
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs add-device <config-path> <device-id> <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs replace-device-identity <config-path> <device-id> <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs rotate-prekey <config-path> <device-id> <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs send-encrypted <config-path> <relay-url> <to-did> <protocol> <payload-json> <artifact-path> [thread-id]
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs prepare-encrypted <config-path> <relay-url> <to-did> <protocol> <payload-json> <artifact-path> [thread-id]
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs tamper-envelope <config-path> <source-artifact-path> <mutation> <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs send-raw-envelope <config-path> <relay-url> <envelope-json-path> <artifact-path>
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs send-plaintext <config-path> <relay-url> <to-did> <protocol> <payload-json> <artifact-path> [thread-id]
  node --experimental-strip-types ./test-scripts/e2e/tools/e2e-probe.mjs scan-plaintext <target-path> <artifact-path> <needle> [needle ...]`);
}

async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function canonicalizeEnvelope(envelope) {
  return JSON.parse(JSON.stringify(envelope));
}

function sortedKeys(record) {
  return Object.keys(record).sort();
}

function describeFieldType(value) {
  if (value instanceof Uint8Array) {
    return 'bytes';
  }
  if (Array.isArray(value)) {
    return value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
      ? 'bytes'
      : 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function buildFieldShape(record) {
  return Object.fromEntries(sortedKeys(record).map((key) => [key, describeFieldType(record[key])]));
}

function collectScalarNeedles(value, needles = new Set()) {
  if (typeof value === 'string' && value.length > 0) {
    needles.add(value);
    return needles;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    needles.add(String(value));
    return needles;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectScalarNeedles(item, needles);
    }
    return needles;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectScalarNeedles(nested, needles);
    }
  }
  return needles;
}

function buildHiddenFieldNeedles(applicationEnvelope) {
  const needles = new Set();
  if (typeof applicationEnvelope.protocol === 'string' && applicationEnvelope.protocol.length > 0) {
    needles.add(applicationEnvelope.protocol);
  }
  if (applicationEnvelope.payload !== undefined) {
    needles.add(JSON.stringify(applicationEnvelope.payload));
    collectScalarNeedles(applicationEnvelope.payload, needles);
  }
  return Array.from(needles).filter((needle) => typeof needle === 'string' && needle.length > 0);
}

function assertNoNeedles(serialized, needles, context) {
  for (const needle of needles) {
    assert.equal(
      serialized.includes(needle),
      false,
      `${context} unexpectedly leaked application plaintext field value: ${needle}`,
    );
  }
}

function analyzeVisibleHeader(message, label) {
  const transportEnvelope = canonicalizeEnvelope(message.transportEnvelope);
  const applicationEnvelope = canonicalizeEnvelope(message.applicationEnvelope);
  const decodedWireMessage = canonicalizeEnvelope(
    decodeEncryptedApplicationEnvelopePayload(transportEnvelope.payload),
  );
  const hiddenFieldNeedles = buildHiddenFieldNeedles(applicationEnvelope);

  assert.equal(
    transportEnvelope.protocol,
    E2E_APPLICATION_ENVELOPE_PROTOCOL,
    `${label} must use the encrypted transport protocol`,
  );
  assert.equal(transportEnvelope.type, 'message', `${label} must remain a message envelope`);
  assert.equal(
    transportEnvelope.payload.messageType,
    decodedWireMessage.type,
    `${label} payload messageType must match decoded wire message type`,
  );
  assert.notEqual(
    transportEnvelope.protocol,
    applicationEnvelope.protocol,
    `${label} must not reuse the application protocol in the relay-visible envelope`,
  );

  for (const field of ['replyTo', 'threadId', 'groupId']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(transportEnvelope, field),
      false,
      `${label} transport envelope unexpectedly exposed ${field}`,
    );
  }

  assertNoNeedles(JSON.stringify(transportEnvelope), hiddenFieldNeedles, `${label} transport envelope`);
  assertNoNeedles(JSON.stringify(decodedWireMessage), hiddenFieldNeedles, `${label} decoded wire message`);

  return {
    expectedTransport: message.expectedTransport,
    envelopeKeys: sortedKeys(transportEnvelope),
    envelopeShape: buildFieldShape(transportEnvelope),
    payloadKeys: sortedKeys(transportEnvelope.payload),
    payloadShape: buildFieldShape(transportEnvelope.payload),
    decodedMessageKeys: sortedKeys(decodedWireMessage),
    decodedMessageShape: buildFieldShape(decodedWireMessage),
    protocol: transportEnvelope.protocol,
    envelopeType: transportEnvelope.type,
    payloadKind: transportEnvelope.payload.kind,
    payloadVersion: transportEnvelope.payload.version,
    payloadEncoding: transportEnvelope.payload.encoding,
    payloadMessageType: transportEnvelope.payload.messageType,
    hiddenFieldNeedles,
  };
}

async function compareVisibleHeaders(jsArtifactPath, rustArtifactPath, artifactPath) {
  const jsArtifact = JSON.parse(await readFile(jsArtifactPath, 'utf8'));
  const rustArtifact = JSON.parse(await readFile(rustArtifactPath, 'utf8'));

  assert.equal(jsArtifact.caseId, 'E2E-CROSS-001');
  assert.equal(rustArtifact.caseId, 'E2E-CROSS-002');

  const jsMessages = new Map(jsArtifact.messages.map((message) => [message.expectedTransport, message]));
  const rustMessages = new Map(rustArtifact.messages.map((message) => [message.expectedTransport, message]));
  const comparisons = [];

  for (const transport of ['prekey', 'session']) {
    const jsMessage = jsMessages.get(transport);
    const rustMessage = rustMessages.get(transport);
    assert.ok(jsMessage, `Missing JS ${transport} message in ${jsArtifactPath}`);
    assert.ok(rustMessage, `Missing Rust ${transport} message in ${rustArtifactPath}`);

    const jsVisible = analyzeVisibleHeader(jsMessage, `JS ${transport}`);
    const rustVisible = analyzeVisibleHeader(rustMessage, `Rust ${transport}`);

    assert.deepStrictEqual(jsVisible.envelopeKeys, rustVisible.envelopeKeys, `${transport} envelope keys diverged`);
    assert.deepStrictEqual(jsVisible.envelopeShape, rustVisible.envelopeShape, `${transport} envelope shape diverged`);
    assert.deepStrictEqual(jsVisible.payloadKeys, rustVisible.payloadKeys, `${transport} payload keys diverged`);
    assert.deepStrictEqual(jsVisible.payloadShape, rustVisible.payloadShape, `${transport} payload shape diverged`);
    assert.deepStrictEqual(
      jsVisible.decodedMessageKeys,
      rustVisible.decodedMessageKeys,
      `${transport} decoded wire-message keys diverged`,
    );
    assert.deepStrictEqual(
      jsVisible.decodedMessageShape,
      rustVisible.decodedMessageShape,
      `${transport} decoded wire-message shape diverged`,
    );
    assert.equal(jsVisible.protocol, rustVisible.protocol, `${transport} protocol diverged`);
    assert.equal(jsVisible.envelopeType, rustVisible.envelopeType, `${transport} envelope type diverged`);
    assert.equal(jsVisible.payloadKind, rustVisible.payloadKind, `${transport} payload kind diverged`);
    assert.equal(jsVisible.payloadVersion, rustVisible.payloadVersion, `${transport} payload version diverged`);
    assert.equal(jsVisible.payloadEncoding, rustVisible.payloadEncoding, `${transport} payload encoding diverged`);
    assert.equal(jsVisible.payloadMessageType, rustVisible.payloadMessageType, `${transport} payload messageType diverged`);

    comparisons.push({
      expectedTransport: transport,
      js: jsVisible,
      rust: rustVisible,
      assertions: {
        sameEnvelopeKeys: true,
        samePayloadKeys: true,
        sameDecodedMessageKeys: true,
        sameEnvelopeShape: true,
        samePayloadShape: true,
        sameDecodedMessageShape: true,
        hiddenApplicationFields: true,
      },
    });
  }

  const result = {
    status: 'passed',
    caseId: 'E2E-CROSS-006',
    comparedCases: [jsArtifact.caseId, rustArtifact.caseId],
    hiddenApplicationFields: ['protocol', 'payload', 'replyTo', 'threadId', 'groupId'],
    comparisons,
  };

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Verified E2E-CROSS-006 visible-header parity at ${artifactPath}`);
}

async function createSignedApplicationEnvelope(senderDid, receiverDid, senderPrivateKey, text, threadId) {
  const unsigned = createEnvelope(
    senderDid,
    receiverDid,
    'message',
    '/agent/msg/1.0.0',
    { text },
    undefined,
    threadId,
  );

  return signEnvelope(unsigned, (data) => sign(data, senderPrivateKey));
}

async function createJsToRustArtifact(artifactPath) {
  const aliceKeys = await generateKeyPair();
  const bobKeys = await generateKeyPair();
  const aliceDid = deriveDID(aliceKeys.publicKey);
  const bobDid = deriveDID(bobKeys.publicKey);

  let aliceE2E = await createInitialLocalE2EConfig(aliceKeys.privateKey);
  const bobE2E = await createInitialLocalE2EConfig(bobKeys.privateKey);
  const bobDevice = buildPublishedDeviceDirectory(bobE2E)[0];
  const bobBundle = buildPublishedPreKeyBundles(bobE2E)[0];
  const claimedBundle = buildClaimedPreKeyBundle(bobBundle, bobBundle.oneTimePreKeys[0]);

  const firstApplicationEnvelope = await createSignedApplicationEnvelope(
    aliceDid,
    bobDid,
    aliceKeys.privateKey,
    'hello from js',
    'cross-js-to-rust-1',
  );
  const firstEncrypted = encryptApplicationEnvelope({
    e2eConfig: aliceE2E,
    applicationEnvelope: firstApplicationEnvelope,
    recipientDevice: bobDevice,
    claimedBundle,
  });
  aliceE2E = firstEncrypted.e2eConfig;
  const firstTransportEnvelope = await signEncryptedTransportEnvelope({
    applicationEnvelope: firstApplicationEnvelope,
    payload: firstEncrypted.payload,
    signFn: (data) => sign(data, aliceKeys.privateKey),
  });

  const secondApplicationEnvelope = await createSignedApplicationEnvelope(
    aliceDid,
    bobDid,
    aliceKeys.privateKey,
    'hello again from js',
    'cross-js-to-rust-2',
  );
  const secondEncrypted = encryptApplicationEnvelope({
    e2eConfig: aliceE2E,
    applicationEnvelope: secondApplicationEnvelope,
    recipientDevice: bobDevice,
  });
  const secondTransportEnvelope = await signEncryptedTransportEnvelope({
    applicationEnvelope: secondApplicationEnvelope,
    payload: secondEncrypted.payload,
    signFn: (data) => sign(data, aliceKeys.privateKey),
  });

  const artifact = {
    version: 1,
    caseId: 'E2E-CROSS-001',
    initiatorImpl: 'js',
    responderImpl: 'rust',
    receiverDid: bobDid,
    receiverE2EConfig: bobE2E,
    messages: [
      {
        expectedTransport: 'prekey',
        transportEnvelope: firstTransportEnvelope,
        applicationEnvelope: firstApplicationEnvelope,
      },
      {
        expectedTransport: 'session',
        transportEnvelope: secondTransportEnvelope,
        applicationEnvelope: secondApplicationEnvelope,
      },
    ],
  };

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
  console.log(`Wrote ${artifact.caseId} artifact to ${artifactPath}`);
}

async function verifyRustToJsArtifact(artifactPath) {
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  let e2eConfig = artifact.receiverE2EConfig;

  assert.equal(artifact.caseId, 'E2E-CROSS-002');
  assert.equal(artifact.initiatorImpl, 'rust');
  assert.equal(artifact.responderImpl, 'js');
  assert.equal(Array.isArray(artifact.messages), true);
  assert.equal(artifact.messages.length, 2);

  for (const message of artifact.messages) {
    const decrypted = await decryptApplicationEnvelope({
      e2eConfig,
      receiverDid: artifact.receiverDid,
      transportEnvelope: message.transportEnvelope,
    });

    assert.equal(decrypted.transport, message.expectedTransport);
    assert.deepStrictEqual(
      canonicalizeEnvelope(decrypted.applicationEnvelope),
      canonicalizeEnvelope(message.applicationEnvelope),
    );
    e2eConfig = decrypted.e2eConfig;
  }

  console.log(`Verified ${artifact.caseId} artifact at ${artifactPath}`);
}

async function buildAnonymousSignedCard(identity) {
  const keyPair = importKeyPair({
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  });

  const signedCard = await signAgentCard({
    did: identity.did,
    name: identity.agentCard.name,
    description: identity.agentCard.description,
    version: '1.0.0',
    capabilities: [],
    endpoints: [],
    timestamp: Date.now(),
  }, (data) => sign(data, keyPair.privateKey));

  return { keyPair, signedCard };
}

async function withAnonymousRelayClient(relayUrl, callback) {
  const identity = await generateAnonymousIdentity();
  const { keyPair, signedCard } = await buildAnonymousSignedCard(identity);
  const relayClient = createRelayClient({
    relayUrls: [relayUrl],
    did: identity.did,
    keyPair,
    card: signedCard,
    autoDiscoverRelays: false,
    targetRelayCount: 1,
  });

  await relayClient.start();
  try {
    return await callback(relayClient);
  } finally {
    await relayClient.stop();
  }
}


function parseJsonArgument(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${(error).message}`);
  }
}

function normalizeOptionalThreadId(raw) {
  if (!raw || raw === '-') {
    return undefined;
  }
  return raw;
}

function buildCapabilityRecords(config) {
  return (config?.agentCard?.capabilities ?? []).map((capability) => ({
    id: capability,
    name: capability,
    description: `Capability: ${capability}`,
  }));
}

function selectSingleRecipientDevice(card, did) {
  if (!card) {
    throw new Error(`No Agent Card found for ${did}`);
  }

  const devices = Array.isArray(card.devices) ? [...card.devices] : [];
  if (devices.length === 0) {
    throw new Error(`Target ${did} does not publish any E2E devices`);
  }

  const uniqueDevices = new Map();
  for (const device of devices) {
    if (uniqueDevices.has(device.deviceId)) {
      throw new Error(`Target ${did} publishes duplicate E2E device ${device.deviceId}`);
    }
    uniqueDevices.set(device.deviceId, device);
  }

  const sortedDevices = [...uniqueDevices.values()].sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  if (sortedDevices.length !== 1) {
    throw new Error(`Target ${did} publishes ${sortedDevices.length} E2E devices; this probe command requires exactly 1`);
  }

  return sortedDevices[0];
}

async function loadRelayIdentityFromConfig(configPath) {
  const config = parseJsonArgument(await readFile(configPath, 'utf8'), `config ${configPath}`);
  const identity = config?.identity;
  if (!identity?.did || !identity?.publicKey || !identity?.privateKey) {
    throw new Error(`Config ${configPath} must contain identity.did, identity.publicKey, and identity.privateKey`);
  }

  const keyPair = importKeyPair({
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  });

  const devices = config?.e2e ? buildPublishedDeviceDirectory(config.e2e) : [];
  const signedCard = await signAgentCard({
    did: identity.did,
    name: config?.agentCard?.name ?? 'quadra-a Agent',
    description: config?.agentCard?.description ?? '',
    version: '1.0.0',
    capabilities: buildCapabilityRecords(config),
    endpoints: [],
    ...(devices.length > 0 ? { devices } : {}),
    timestamp: Date.now(),
  }, (data) => sign(data, keyPair.privateKey));

  return {
    config,
    identity,
    keyPair,
    signedCard,
  };
}

async function withConfigRelayClient(configPath, relayUrl, callback) {
  const relayIdentity = await loadRelayIdentityFromConfig(configPath);
  const relayClient = createRelayClient({
    relayUrls: [relayUrl],
    did: relayIdentity.identity.did,
    keyPair: relayIdentity.keyPair,
    card: relayIdentity.signedCard,
    autoDiscoverRelays: false,
    targetRelayCount: 1,
  });

  await relayClient.start();
  try {
    return await callback({
      ...relayIdentity,
      relayClient,
    });
  } finally {
    relayClient.onDeliveryReport(() => {});
    await relayClient.stop();
  }
}

function waitForDeliveryReport(relayClient, messageId, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      relayClient.onDeliveryReport(() => {});
      resolve({
        status: 'timeout',
        messageId,
      });
    }, timeoutMs);

    relayClient.onDeliveryReport((report) => {
      if (report.messageId !== messageId) {
        return;
      }

      clearTimeout(timeout);
      relayClient.onDeliveryReport(() => {});
      resolve({
        status: report.status,
        messageId: report.messageId,
      });
    });
  });
}

async function buildPreparedEncryptedEnvelope(configPath, relayUrl, toDid, protocolId, payloadJson, threadIdRaw) {
  const payload = parseJsonArgument(payloadJson, 'payload-json');
  const threadId = normalizeOptionalThreadId(threadIdRaw);

  return withConfigRelayClient(configPath, relayUrl, async ({ config, identity, keyPair, relayClient }) => {
    if (!config?.e2e?.currentDeviceId || !config?.e2e?.devices) {
      throw new Error(`Config ${configPath} does not contain local E2E device state`);
    }

    const recipientCard = await relayClient.fetchCard(toDid);
    const recipientDevice = selectSingleRecipientDevice(recipientCard, toDid);
    const applicationEnvelope = await signEnvelope(
      createEnvelope(identity.did, toDid, 'message', protocolId, payload, undefined, threadId),
      (data) => sign(data, keyPair.privateKey),
    );

    const existingSession = loadLocalSession(
      config.e2e,
      config.e2e.currentDeviceId,
      toDid,
      recipientDevice.deviceId,
    );
    const claimedBundle = existingSession
      ? undefined
      : await relayClient.fetchPreKeyBundle(toDid, recipientDevice.deviceId);
    if (!existingSession && !claimedBundle) {
      throw new Error(`No claimed pre-key bundle available for ${toDid}:${recipientDevice.deviceId}`);
    }

    const encrypted = encryptApplicationEnvelope({
      e2eConfig: config.e2e,
      applicationEnvelope,
      recipientDevice,
      claimedBundle: claimedBundle ?? undefined,
    });
    const outerEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope,
      payload: encrypted.payload,
      signFn: (data) => sign(data, keyPair.privateKey),
    });
    const outerEnvelopeBytes = encodeMessage(outerEnvelope);

    config.e2e = encrypted.e2eConfig;
    await ensureParent(configPath);
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

    return {
      status: 'prepared',
      relayUrl,
      configPath,
      senderDid: identity.did,
      receiverDid: toDid,
      threadId: threadId ?? null,
      messageId: applicationEnvelope.id,
      transport: encrypted.transport,
      senderDeviceId: encrypted.payload.senderDeviceId,
      receiverDeviceId: encrypted.payload.receiverDeviceId,
      sessionId: encrypted.payload.sessionId,
      claimedOneTimePreKeyId: claimedBundle?.oneTimePreKey?.keyId ?? null,
      applicationEnvelope,
      outerEnvelope,
      outerEnvelopeBytesHex: Buffer.from(outerEnvelopeBytes).toString('hex'),
    };
  });
}

async function sendEncryptedFromConfig(configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadIdRaw) {
  const prepared = await buildPreparedEncryptedEnvelope(configPath, relayUrl, toDid, protocolId, payloadJson, threadIdRaw);

  const result = await withConfigRelayClient(configPath, relayUrl, async ({ relayClient }) => {
    const deliveryReportPromise = waitForDeliveryReport(relayClient, prepared.messageId);
    await relayClient.sendEnvelope(toDid, hexToBytes(prepared.outerEnvelopeBytesHex));
    const deliveryReport = await deliveryReportPromise;
    return {
      ...prepared,
      status: 'sent',
      deliveryReport,
    };
  });

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Sent encrypted envelope ${result.messageId} to ${toDid} via ${relayUrl}`);
}

async function prepareEncryptedFromConfig(configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadIdRaw) {
  const result = await buildPreparedEncryptedEnvelope(configPath, relayUrl, toDid, protocolId, payloadJson, threadIdRaw);
  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Prepared encrypted envelope ${result.messageId} for ${toDid} via ${relayUrl}`);
}

async function tamperEnvelopeFromConfig(configPath, sourceArtifactPath, mutation, artifactPath) {
  const relayIdentity = await loadRelayIdentityFromConfig(configPath);
  const source = parseJsonArgument(await readFile(sourceArtifactPath, 'utf8'), `artifact ${sourceArtifactPath}`);
  const applicationEnvelope = source?.applicationEnvelope;
  const outerEnvelope = source?.outerEnvelope;
  if (!applicationEnvelope || !outerEnvelope) {
    throw new Error(`Artifact ${sourceArtifactPath} must contain applicationEnvelope and outerEnvelope`);
  }

  const payload = structuredClone(outerEnvelope.payload);
  const decodedPayload = decodeEncryptedApplicationEnvelopePayload(payload);
  if (decodedPayload.type !== 'SESSION_MESSAGE') {
    throw new Error(`Artifact ${sourceArtifactPath} must contain a SESSION_MESSAGE transport payload for mutation ${mutation}`);
  }

  const sessionMessage = decodeSessionMessage(hexToBytes(payload.wireMessage));
  if (mutation === 'session-ciphertext') {
    const ciphertext = new Uint8Array(sessionMessage.ciphertext);
    ciphertext[ciphertext.length - 1] ^= 0x01;
    sessionMessage.ciphertext = ciphertext;
  } else if (mutation === 'session-header') {
    sessionMessage.messageNumber += 1;
  } else {
    throw new Error(`Unsupported envelope mutation: ${mutation}`);
  }

  payload.wireMessage = Buffer.from(encodeSessionMessage(sessionMessage)).toString('hex');
  const tamperedOuterEnvelope = await signEncryptedTransportEnvelope({
    applicationEnvelope,
    payload,
    signFn: (data) => sign(data, relayIdentity.keyPair.privateKey),
  });
  const envelopeBytes = encodeMessage(tamperedOuterEnvelope);
  const result = {
    status: 'tampered',
    configPath,
    sourceArtifactPath,
    mutation,
    applicationEnvelope,
    outerEnvelope: tamperedOuterEnvelope,
    outerEnvelopeBytesHex: Buffer.from(envelopeBytes).toString('hex'),
    messageId: tamperedOuterEnvelope.id,
    receiverDid: tamperedOuterEnvelope.to,
  };

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Prepared tampered ${mutation} envelope ${result.messageId}`);
}

async function sendRawEnvelopeFromConfig(configPath, relayUrl, envelopePath, artifactPath) {
  const outerEnvelopeSource = parseJsonArgument(await readFile(envelopePath, 'utf8'), `envelope ${envelopePath}`);
  const outerEnvelope = outerEnvelopeSource?.outerEnvelope ?? outerEnvelopeSource?.envelope ?? outerEnvelopeSource;
  if (!outerEnvelope?.to || !outerEnvelope?.id) {
    throw new Error(`Envelope ${envelopePath} must contain an envelope object with id and to fields`);
  }

  const result = await withConfigRelayClient(configPath, relayUrl, async ({ identity, relayClient }) => {
    const envelopeBytes = encodeMessage(outerEnvelope);
    const deliveryReportPromise = waitForDeliveryReport(relayClient, outerEnvelope.id);
    await relayClient.sendEnvelope(outerEnvelope.to, envelopeBytes);
    const deliveryReport = await deliveryReportPromise;
    return {
      status: 'sent',
      relayUrl,
      configPath,
      senderDid: identity.did,
      receiverDid: outerEnvelope.to,
      messageId: outerEnvelope.id,
      envelope: outerEnvelope,
      envelopeBytesHex: Buffer.from(envelopeBytes).toString('hex'),
      deliveryReport,
    };
  });

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Re-sent raw envelope ${result.messageId} to ${result.receiverDid} via ${relayUrl}`);
}

async function sendPlaintextFromConfig(configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadIdRaw) {
  const payload = parseJsonArgument(payloadJson, 'payload-json');
  const threadId = normalizeOptionalThreadId(threadIdRaw);

  const result = await withConfigRelayClient(configPath, relayUrl, async ({ identity, keyPair, relayClient }) => {
    const envelope = await signEnvelope(
      createEnvelope(identity.did, toDid, 'message', protocolId, payload, undefined, threadId),
      (data) => sign(data, keyPair.privateKey),
    );
    const envelopeBytes = encodeMessage(envelope);
    const deliveryReportPromise = waitForDeliveryReport(relayClient, envelope.id);
    await relayClient.sendEnvelope(toDid, envelopeBytes);
    const deliveryReport = await deliveryReportPromise;
    return {
      status: 'sent',
      relayUrl,
      configPath,
      senderDid: identity.did,
      receiverDid: toDid,
      threadId: threadId ?? null,
      messageId: envelope.id,
      envelope,
      envelopeBytesHex: Buffer.from(envelopeBytes).toString('hex'),
      deliveryReport,
    };
  });

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Sent plaintext envelope ${result.messageId} to ${toDid} via ${relayUrl}`);
}

async function appendDeviceToConfig(configPath, deviceId, artifactPath) {
  const configText = await readFile(configPath, 'utf8');
  const config = JSON.parse(configText);
  const privateKeyHex = config?.identity?.privateKey;
  if (typeof privateKeyHex !== 'string' || privateKeyHex.length === 0) {
    throw new Error(`Config ${configPath} does not contain identity.privateKey`);
  }

  const e2eConfig = config.e2e;
  if (!e2eConfig || typeof e2eConfig !== 'object' || !e2eConfig.devices || typeof e2eConfig.devices !== 'object') {
    throw new Error(`Config ${configPath} does not contain local E2E device state`);
  }

  if (e2eConfig.devices[deviceId]) {
    throw new Error(`Config ${configPath} already contains device ${deviceId}`);
  }

  const nextSignedPreKeyId = Object.values(e2eConfig.devices)
    .map((device) => Number(device?.signedPreKey?.signedPreKeyId ?? 0))
    .reduce((max, value) => Math.max(max, value), 0) + 1;

  const device = await createLocalDeviceState(Buffer.from(privateKeyHex, 'hex'), {
    deviceId,
    signedPreKeyId: nextSignedPreKeyId,
    now: Date.now(),
  });

  config.e2e.devices[deviceId] = device;
  await ensureParent(configPath);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

  const result = {
    status: 'updated',
    configPath,
    deviceId,
    currentDeviceId: config.e2e.currentDeviceId,
    deviceCount: Object.keys(config.e2e.devices).length,
    signedPreKeyId: device.signedPreKey.signedPreKeyId,
  };

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Added device ${deviceId} to ${configPath}`);
}

async function replaceDeviceIdentityInConfig(configPath, deviceId, artifactPath) {
  const configText = await readFile(configPath, 'utf8');
  const config = JSON.parse(configText);
  const device = config?.e2e?.devices?.[deviceId];
  if (!device) {
    throw new Error(`Config ${configPath} does not contain device ${deviceId}`);
  }

  const previousIdentityKeyPublic = device?.identityKey?.publicKey ?? null;
  const nextIdentityKeyPair = generateX25519KeyPair();
  device.identityKey = {
    publicKey: Buffer.from(nextIdentityKeyPair.publicKey).toString('hex'),
    privateKey: Buffer.from(nextIdentityKeyPair.privateKey).toString('hex'),
  };

  await ensureParent(configPath);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

  const result = {
    status: 'updated',
    configPath,
    deviceId,
    previousIdentityKeyPublic,
    identityKeyPublic: device.identityKey.publicKey,
  };

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Replaced device identity key for ${deviceId} in ${configPath}`);
}

async function rotatePreKeyInConfig(configPath, deviceId, artifactPath) {
  const configText = await readFile(configPath, 'utf8');
  const config = JSON.parse(configText);
  const privateKeyHex = config?.identity?.privateKey;
  if (typeof privateKeyHex !== 'string' || privateKeyHex.length === 0) {
    throw new Error(`Config ${configPath} does not contain identity.privateKey`);
  }

  const e2eConfig = config.e2e;
  if (!e2eConfig || typeof e2eConfig !== 'object' || !e2eConfig.devices || typeof e2eConfig.devices !== 'object') {
    throw new Error(`Config ${configPath} does not contain local E2E device state`);
  }

  const existingDevice = e2eConfig.devices[deviceId];
  if (!existingDevice) {
    throw new Error(`Config ${configPath} does not contain device ${deviceId}`);
  }

  const previousSignedPreKeyId = Number(existingDevice?.signedPreKey?.signedPreKeyId ?? 0);
  const previousSessionCount = Object.keys(existingDevice?.sessions ?? {}).length;
  const nextE2EConfig = await rotateLocalDeviceSignedPreKey(
    Buffer.from(privateKeyHex, 'hex'),
    e2eConfig,
    deviceId,
    { now: Date.now() },
  );

  config.e2e = nextE2EConfig;
  await ensureParent(configPath);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

  const rotatedDevice = config.e2e.devices[deviceId];
  const result = {
    status: 'updated',
    configPath,
    deviceId,
    previousSignedPreKeyId,
    signedPreKeyId: rotatedDevice.signedPreKey.signedPreKeyId,
    currentDeviceId: config.e2e.currentDeviceId,
    sessionCount: Object.keys(rotatedDevice.sessions ?? {}).length,
    previousSessionCount,
    oneTimePreKeyCount: Array.isArray(rotatedDevice.oneTimePreKeys) ? rotatedDevice.oneTimePreKeys.length : 0,
    lastResupplyAt: rotatedDevice.lastResupplyAt ?? null,
  };

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Rotated signed pre-key for ${deviceId} in ${configPath}`);
}

async function waitForPublishedCard(relayUrl, did, deviceId, artifactPath, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastObservation = null;

  const result = await withAnonymousRelayClient(relayUrl, async (relayClient) => {
    while (Date.now() - startedAt <= timeoutMs) {
      attempts += 1;
      const card = await relayClient.fetchCard(did);
      const device = Array.isArray(card?.devices)
        ? card.devices.find((entry) => entry?.deviceId === deviceId)
        : undefined;

      lastObservation = {
        foundCard: Boolean(card),
        foundDevice: Boolean(device),
        oneTimePreKeyCount: device?.oneTimePreKeyCount ?? null,
      };

      if (card && device && typeof device.oneTimePreKeyCount === 'number' && device.oneTimePreKeyCount > 0) {
        return {
          status: 'ready',
          relayUrl,
          did,
          deviceId,
          attempts,
          waitedMs: Date.now() - startedAt,
          card,
          device,
        };
      }

      await sleep(250);
    }

    return {
      status: 'timeout',
      relayUrl,
      did,
      deviceId,
      attempts,
      waitedMs: Date.now() - startedAt,
      lastObservation,
    };
  });

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');

  if (result.status !== 'ready') {
    throw new Error(
      `Timed out waiting for published card ${did}:${deviceId} on ${relayUrl} after ${result.waitedMs}ms`,
    );
  }

  console.log(`Observed published card ${did}:${deviceId} on ${relayUrl}`);
}

async function collectFiles(targetPath) {
  const info = await stat(targetPath);
  if (info.isFile()) {
    return [targetPath];
  }

  if (!info.isDirectory()) {
    throw new Error(`Unsupported scan target: ${targetPath}`);
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const nextPath = resolve(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(nextPath));
    } else if (entry.isFile()) {
      files.push(nextPath);
    }
  }
  return files.sort();
}

function countNeedle(buffer, needle) {
  const needleBuffer = Buffer.from(needle, 'utf8');
  if (needleBuffer.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset <= buffer.length - needleBuffer.length) {
    const index = buffer.indexOf(needleBuffer, offset);
    if (index === -1) {
      break;
    }
    count += 1;
    offset = index + needleBuffer.length;
  }
  return count;
}

async function scanPlaintext(targetPath, artifactPath, needles) {
  if (!Array.isArray(needles) || needles.length === 0) {
    throw new Error('scan-plaintext requires at least one forbidden needle');
  }

  const files = await collectFiles(targetPath);
  const hits = [];
  let totalBytes = 0;

  for (const filePath of files) {
    const buffer = await readFile(filePath);
    totalBytes += buffer.length;

    for (const needle of needles) {
      const count = countNeedle(buffer, needle);
      if (count > 0) {
        hits.push({
          path: filePath,
          needle,
          count,
        });
      }
    }
  }

  const result = {
    status: hits.length === 0 ? 'clean' : 'forbidden-plaintext-detected',
    targetPath,
    filesScanned: files.length,
    bytesScanned: totalBytes,
    forbidden: needles,
    hits,
  };

  await ensureParent(artifactPath);
  await writeFile(artifactPath, JSON.stringify(result, null, 2) + '\n');

  if (hits.length > 0) {
    throw new Error(`Forbidden plaintext detected in ${targetPath}`);
  }

  console.log(`Scanned ${files.length} file(s) under ${targetPath} without plaintext hits`);
}

const [, , command, ...args] = process.argv;
if (!command) {
  usage();
  process.exit(1);
}

if (command === 'cross-js-to-rust') {
  const [artifactPath] = args;
  if (!artifactPath) {
    usage();
    process.exit(1);
  }
  await createJsToRustArtifact(artifactPath);
} else if (command === 'verify-rust-to-js') {
  const [artifactPath] = args;
  if (!artifactPath) {
    usage();
    process.exit(1);
  }
  await verifyRustToJsArtifact(artifactPath);
} else if (command === 'compare-visible-headers') {
  const [jsArtifactPath, rustArtifactPath, artifactPath] = args;
  if (!jsArtifactPath || !rustArtifactPath || !artifactPath) {
    usage();
    process.exit(1);
  }
  await compareVisibleHeaders(jsArtifactPath, rustArtifactPath, artifactPath);
} else if (command === 'wait-card') {
  const [relayUrl, did, deviceId, artifactPath, timeoutMsRaw] = args;
  if (!relayUrl || !did || !deviceId || !artifactPath) {
    usage();
    process.exit(1);
  }
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : 20_000;
  await waitForPublishedCard(relayUrl, did, deviceId, artifactPath, timeoutMs);
} else if (command === 'add-device') {
  const [configPath, deviceId, artifactPath] = args;
  if (!configPath || !deviceId || !artifactPath) {
    usage();
    process.exit(1);
  }
  await appendDeviceToConfig(configPath, deviceId, artifactPath);
} else if (command === 'rotate-prekey') {
  const [configPath, deviceId, artifactPath] = args;
  if (!configPath || !deviceId || !artifactPath) {
    usage();
    process.exit(1);
  }
  await rotatePreKeyInConfig(configPath, deviceId, artifactPath);
} else if (command === 'replace-device-identity') {
  const [configPath, deviceId, artifactPath] = args;
  if (!configPath || !deviceId || !artifactPath) {
    usage();
    process.exit(1);
  }
  await replaceDeviceIdentityInConfig(configPath, deviceId, artifactPath);
} else if (command === 'send-encrypted') {
  const [configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadId] = args;
  if (!configPath || !relayUrl || !toDid || !protocolId || !payloadJson || !artifactPath) {
    usage();
    process.exit(1);
  }
  await sendEncryptedFromConfig(configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadId);
} else if (command === 'prepare-encrypted') {
  const [configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadId] = args;
  if (!configPath || !relayUrl || !toDid || !protocolId || !payloadJson || !artifactPath) {
    usage();
    process.exit(1);
  }
  await prepareEncryptedFromConfig(configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadId);
} else if (command === 'tamper-envelope') {
  const [configPath, sourceArtifactPath, mutation, artifactPath] = args;
  if (!configPath || !sourceArtifactPath || !mutation || !artifactPath) {
    usage();
    process.exit(1);
  }
  await tamperEnvelopeFromConfig(configPath, sourceArtifactPath, mutation, artifactPath);
} else if (command === 'send-raw-envelope') {
  const [configPath, relayUrl, envelopePath, artifactPath] = args;
  if (!configPath || !relayUrl || !envelopePath || !artifactPath) {
    usage();
    process.exit(1);
  }
  await sendRawEnvelopeFromConfig(configPath, relayUrl, envelopePath, artifactPath);
} else if (command === 'send-plaintext') {
  const [configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadId] = args;
  if (!configPath || !relayUrl || !toDid || !protocolId || !payloadJson || !artifactPath) {
    usage();
    process.exit(1);
  }
  await sendPlaintextFromConfig(configPath, relayUrl, toDid, protocolId, payloadJson, artifactPath, threadId);
} else if (command === 'scan-plaintext') {
  const [targetPath, artifactPath, ...needles] = args;
  if (!targetPath || !artifactPath || needles.length === 0) {
    usage();
    process.exit(1);
  }
  await scanPlaintext(targetPath, artifactPath, needles);
} else {
  usage();
  process.exit(1);
}
