import { describe, it, expect } from 'vitest';

import { deserializeQueuedEnvelope, serializeQueuedEnvelope } from '../queue.js';

describe('queued envelope serialization', () => {
  it('serializes Uint8Array values as JSON-safe byte arrays', () => {
    const envelope = new Uint8Array([123, 34, 125]);

    expect(serializeQueuedEnvelope(envelope)).toEqual([123, 34, 125]);
  });

  it('deserializes legacy typed-array objects from JSON storage', () => {
    const envelope = deserializeQueuedEnvelope({
      0: 123,
      1: 34,
      2: 105,
      3: 100,
      4: 34,
      5: 58,
      6: 34,
      7: 109,
      8: 115,
      9: 103,
      10: 34,
      11: 125,
    });

    expect(envelope).toEqual([123, 34, 105, 100, 34, 58, 34, 109, 115, 103, 34, 125]);
  });

  it('deserializes empty legacy typed-array objects', () => {
    expect(deserializeQueuedEnvelope({})).toEqual([]);
  });

  it('rejects non-byte object payloads', () => {
    expect(() => deserializeQueuedEnvelope({ foo: 'bar' })).toThrow(/serialized Uint8Array/);
  });
});
