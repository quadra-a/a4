import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildServeHandlers,
  claimServeMessage,
  handlerFilenameToCapability,
  extractExecArgsFromArgv,
  processServeInboxPage,
  protocolMatchesCapability,
  releaseServeMessage,
} from '../dist/index.js';

test('protocolMatchesCapability accepts prefixed and bare capability protocols', () => {
  assert.equal(protocolMatchesCapability('/capability/gpu/compute', 'gpu/compute'), true);
  assert.equal(protocolMatchesCapability('/capability/gpu', 'gpu'), true);
  assert.equal(protocolMatchesCapability('gpu/compute', 'gpu/compute'), true);
  assert.equal(protocolMatchesCapability('/capability/gpu/compute/v2', 'gpu/compute'), false);
  assert.equal(protocolMatchesCapability('/capability/gpu-compute', 'gpu/compute'), false);
});

test('extractExecArgsFromArgv returns args after --', () => {
  assert.deepEqual(
    extractExecArgsFromArgv([
      'node',
      'a4',
      'serve',
      '--on',
      'gpu',
      '--exec',
      'python',
      '--',
      'gpu_handler.py',
      '--json',
    ]),
    ['gpu_handler.py', '--json']
  );
});

test('buildServeHandlers keeps exec args separate', async () => {
  const handlers = await buildServeHandlers(
    { on: 'gpu', exec: 'python' },
    [
      'node',
      'a4',
      'serve',
      '--on',
      'gpu',
      '--exec',
      'python',
      '--',
      'gpu_handler.py',
      '--json',
    ]
  );

  assert.deepEqual(handlers, [
    {
      capability: 'gpu',
      exec: 'python',
      args: ['gpu_handler.py', '--json'],
    },
  ]);
});

test('buildServeHandlers rejects unsplit multi-word exec values', async () => {
  await assert.rejects(
    buildServeHandlers(
      { on: 'gpu', exec: 'python gpu_handler.py' },
      ['node', 'a4', 'serve', '--on', 'gpu', '--exec', 'python gpu_handler.py']
    ),
    /Pass handler arguments after --/
  );
});

test('handlerFilenameToCapability maps double underscore to slash', () => {
  assert.equal(handlerFilenameToCapability('gpu__compute.py'), 'gpu/compute');
});

test('buildServeHandlers maps handler filenames to slash capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a4-serve-test-'));
  await writeFile(join(dir, 'gpu__compute.py'), '#!/usr/bin/env python3\n');

  const handlers = await buildServeHandlers({ handlers: dir });

  assert.deepEqual(handlers, [
    {
      capability: 'gpu/compute',
      exec: join(dir, 'gpu__compute.py'),
      args: [],
    },
  ]);
});

test('claimServeMessage prevents duplicate claims until released', () => {
  const claimed = new Set();
  assert.equal(claimServeMessage(claimed, 'msg-1'), true);
  assert.equal(claimServeMessage(claimed, 'msg-1'), false);
  releaseServeMessage(claimed, 'msg-1');
  assert.equal(claimServeMessage(claimed, 'msg-1'), true);
});

test('processServeInboxPage sends BUSY for overflow and delays mark_read until reply', async () => {
  let resolveFirst;
  const firstReply = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const calls = [];
  const client = {
    async send(command, params) {
      calls.push({ command, params });
      return {};
    },
  };

  let handlerCalls = 0;
  const activeCountRef = { value: 0 };
  const claimedMessageIds = new Set();
  const handlers = [{ capability: 'test/echo', exec: '/bin/cat', args: [] }];
  const page = {
    messages: [
      {
        direction: 'inbound',
        envelope: {
          id: 'msg-1',
          from: 'did:agent:first',
          protocol: '/capability/test/echo',
          payload: { value: 1 },
          type: 'message',
        },
      },
      {
        direction: 'inbound',
        envelope: {
          id: 'msg-2',
          from: 'did:agent:second',
          protocol: '/capability/test/echo',
          payload: { value: 2 },
          type: 'message',
        },
      },
    ],
  };

  await processServeInboxPage(page, {
    client,
    handlers,
    claimedMessageIds,
    activeCountRef,
    maxConcurrency: 1,
    timeoutMs: 1000,
    format: 'json',
    log: { log() {}, error() {} },
    execute: async () => {
      handlerCalls += 1;
      return firstReply;
    },
  });

  assert.equal(handlerCalls, 1);
  assert.equal(activeCountRef.value, 1);
  assert.deepEqual([...claimedMessageIds], ['msg-1']);
  assert.deepEqual(calls, [
    {
      command: 'send',
      params: {
        to: 'did:agent:second',
        protocol: '/capability/test/echo',
        payload: { error: 'BUSY', message: 'Server at capacity, try again later' },
        type: 'reply',
        replyTo: 'msg-2',
      },
    },
    {
      command: 'mark_read',
      params: { id: 'msg-2' },
    },
  ]);

  resolveFirst({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(activeCountRef.value, 0);
  assert.deepEqual([...claimedMessageIds], []);
  assert.deepEqual(calls.slice(2), [
    {
      command: 'send',
      params: {
        to: 'did:agent:first',
        protocol: '/capability/test/echo',
        payload: { ok: true },
        type: 'reply',
        replyTo: 'msg-1',
      },
    },
    {
      command: 'mark_read',
      params: { id: 'msg-1' },
    },
  ]);
});

test('processServeInboxPage does not reprocess claimed unread messages across polls', async () => {
  let resolveFirst;
  const firstReply = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const calls = [];
  const client = {
    async send(command, params) {
      calls.push({ command, params });
      return {};
    },
  };

  let handlerCalls = 0;
  const activeCountRef = { value: 0 };
  const claimedMessageIds = new Set();
  const page = {
    messages: [
      {
        direction: 'inbound',
        envelope: {
          id: 'msg-1',
          from: 'did:agent:first',
          protocol: '/capability/test/echo',
          payload: { value: 1 },
          type: 'message',
        },
      },
    ],
  };

  const options = {
    client,
    handlers: [{ capability: 'test/echo', exec: '/bin/cat', args: [] }],
    claimedMessageIds,
    activeCountRef,
    maxConcurrency: 2,
    timeoutMs: 1000,
    format: 'json',
    log: { log() {}, error() {} },
    execute: async () => {
      handlerCalls += 1;
      return firstReply;
    },
  };

  await processServeInboxPage(page, options);
  await processServeInboxPage(page, options);

  assert.equal(handlerCalls, 1);
  assert.equal(activeCountRef.value, 1);
  assert.deepEqual(calls, []);

  resolveFirst({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(activeCountRef.value, 0);
  assert.deepEqual([...claimedMessageIds], []);
  assert.deepEqual(calls, [
    {
      command: 'send',
      params: {
        to: 'did:agent:first',
        protocol: '/capability/test/echo',
        payload: { ok: true },
        type: 'reply',
        replyTo: 'msg-1',
      },
    },
    {
      command: 'mark_read',
      params: { id: 'msg-1' },
    },
  ]);
});
