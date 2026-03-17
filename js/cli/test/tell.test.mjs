import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPrimaryProtocol } from '../dist/index.js';

test('extractPrimaryProtocol prefers capability metadata.protocol', () => {
  const protocol = extractPrimaryProtocol([
    {
      id: 'custom/echo',
      name: 'Echo',
      description: 'Echo protocol',
      metadata: { protocol: '/echo/1.0.0' },
    },
    {
      id: 'gpu/compute',
      name: 'GPU',
      description: 'GPU compute',
    },
  ]);

  assert.equal(protocol, '/echo/1.0.0');
});

test('extractPrimaryProtocol returns null when no unique declared protocol exists', () => {
  const protocol = extractPrimaryProtocol([
    {
      id: 'gpu/compute',
      name: 'GPU',
      description: 'GPU compute',
    },
  ]);

  assert.equal(protocol, null);
});

test('extractPrimaryProtocol returns null for ambiguous protocol metadata', () => {
  const protocol = extractPrimaryProtocol([
    {
      id: 'shell/exec',
      name: 'Shell',
      description: 'Shell execution',
      metadata: { protocol: '/shell/exec/1.0.0' },
    },
    {
      id: 'gpu/compute',
      name: 'GPU',
      description: 'GPU compute',
      metadata: { protocol: '/capability/gpu/compute' },
    },
  ]);

  assert.equal(protocol, null);
});
