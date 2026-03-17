#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MessageStorage,
  getMessageSortTimestamp,
  storedMessageStatus,
} from '../../js/core/protocol/dist/index.js';
import { findMessageOutcome, paginateVisibleInboxMessages } from '../../js/core/runtime/dist/index.js';
import { protocolMatchesCapability } from '../../js/cli/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC_ROOT = resolve(__dirname, '../../spec/conformance');

function parseArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function buildMessage(raw) {
  const direction = raw.direction;
  const timestamp = raw.timestamp ?? 1;
  return {
    envelope: {
      id: raw.id,
      from: raw.from,
      to: raw.to,
      type: raw.type ?? 'message',
      protocol: raw.protocol ?? '/agent/msg/1.0.0',
      payload: raw.payload ?? {},
      timestamp,
      signature: 'sig',
      ...(raw.replyTo ? { replyTo: raw.replyTo } : {}),
      ...(raw.threadId ? { threadId: raw.threadId } : {}),
    },
    direction,
    status: raw.storedStatus ?? 'pending',
    ...(direction === 'inbound' ? { receivedAt: timestamp } : { sentAt: timestamp }),
    ...(raw.read ? { readAt: timestamp + 1 } : {}),
    ...(raw.deliveries?.length
      ? {
          e2e: {
            deliveries: raw.deliveries.map((delivery, index) => ({
              transport: delivery.transport ?? 'session',
              transportMessageId: delivery.transportMessageId ?? `transport-${index + 1}`,
              senderDeviceId: delivery.senderDeviceId ?? 'sender-1',
              receiverDeviceId: delivery.receiverDeviceId ?? 'receiver-1',
              sessionId: delivery.sessionId ?? 'session-1',
              state: delivery.state,
              recordedAt: delivery.recordedAt ?? index + 1,
              ...(delivery.error ? { error: delivery.error } : {}),
            })),
          },
        }
      : {}),
  };
}

function outcomeJson(outcome) {
  if (!outcome) {
    return {
      found: false,
      messageId: null,
      kind: null,
      status: null,
      terminal: false,
    };
  }

  return {
    found: true,
    messageId: outcome.message.envelope.id,
    kind: outcome.kind,
    status: outcome.status,
    terminal: outcome.terminal,
  };
}

async function evaluateMessageStatus(input) {
  return {
    status: storedMessageStatus(buildMessage(input.message)),
  };
}

async function evaluateProtocolMatching(input) {
  return {
    matches: protocolMatchesCapability(input.protocol, input.capability),
  };
}

async function evaluateReplyCorrelation(input) {
  return outcomeJson(findMessageOutcome(input.messages.map(buildMessage), input.requestId));
}

async function evaluateBlockFiltering(input) {
  const page = paginateVisibleInboxMessages(
    input.messages.map(buildMessage),
    new Set(input.blockedDids ?? []),
    { limit: Number.MAX_SAFE_INTEGER, offset: 0 },
  );

  return {
    visibleIds: page.messages.map((message) => message.envelope.id),
  };
}

async function evaluateDaemonPersistence(input) {
  const tempDir = await mkdtemp(join(tmpdir(), 'a4-conformance-js-'));
  const dbPath = join(tempDir, 'messages.db');
  const storage = new MessageStorage(dbPath);

  try {
    await storage.open();
    for (const rawMessage of input.messages) {
      await storage.putMessage(buildMessage(rawMessage));
    }
    await storage.close();

    const reopened = new MessageStorage(dbPath);
    await reopened.open();
    const [inbox, outbox] = await Promise.all([
      reopened.queryMessages('inbound', {}, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }),
      reopened.queryMessages('outbound', {}, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }),
    ]);
    await reopened.close();

    const messages = [...outbox.messages, ...inbox.messages]
      .sort((left, right) => getMessageSortTimestamp(left) - getMessageSortTimestamp(right));
    const messageIds = messages.map((message) => message.envelope.id);
    const outcome = findMessageOutcome(messages, input.requestId);

    return {
      totalMessages: messages.length,
      messageIds,
      outcomeId: outcome?.message.envelope.id ?? null,
      status: outcome?.status ?? null,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function evaluateCase(subject, input) {
  switch (subject) {
    case 'message-status':
      return evaluateMessageStatus(input);
    case 'protocol-matching':
      return evaluateProtocolMatching(input);
    case 'reply-correlation':
      return evaluateReplyCorrelation(input);
    case 'block-filtering':
      return evaluateBlockFiltering(input);
    case 'daemon-persistence':
      return evaluateDaemonPersistence(input);
    default:
      throw new Error(`Unknown conformance subject: ${subject}`);
  }
}

async function run(specRoot) {
  const entries = (await readdir(specRoot)).filter((entry) => entry.endsWith('.json')).sort();
  const results = [];
  let version = 1;

  for (const entry of entries) {
    const spec = JSON.parse(await readFile(join(specRoot, entry), 'utf8'));
    version = spec.version ?? version;

    for (const testCase of spec.cases) {
      const actual = await evaluateCase(spec.subject, testCase.input);
      let passed = true;
      try {
        assert.deepEqual(actual, testCase.expected);
      } catch {
        passed = false;
      }
      results.push({
        subject: spec.subject,
        id: testCase.id,
        description: testCase.description,
        actual,
        expected: testCase.expected,
        passed,
      });
    }
  }

  return {
    version,
    runner: 'js',
    results,
  };
}

const specRoot = resolve(parseArg('--spec-root') ?? DEFAULT_SPEC_ROOT);
const outputPath = parseArg('--out');
const report = await run(specRoot);
const reportJson = JSON.stringify(report, null, 2);

if (outputPath) {
  await writeFile(outputPath, reportJson);
} else {
  process.stdout.write(`${reportJson}\n`);
}

const failures = report.results.filter((result) => !result.passed);
if (failures.length > 0) {
  const summary = failures.map((result) => `${result.subject} ${result.id}`).join(', ');
  throw new Error(`Conformance failures: ${summary}`);
}
