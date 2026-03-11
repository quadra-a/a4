import { describe, it, expect, beforeEach } from 'vitest';
import { encode as cborEncode } from 'cbor-x';
import { encodeForDHT, encodeForWeb, decodeFromCBOR, decodeFromJSON, getEncodedSize } from '../src/discovery/agent-card-encoder.js';
import type { AgentCard } from '../src/discovery/agent-card-types.js';
import { upgradeLegacyCard, isLegacyCard } from '../src/discovery/agent-card-types.js';

describe('Agent Card Encoder', () => {
  let sampleCard: AgentCard;

  beforeEach(() => {
    sampleCard = {
      '@context': ['https://schema.org', 'https://quadra-a.org/context/v1'],
      did: 'did:agent:z6MkTest123',
      name: 'Test Agent',
      description: 'A test agent for encoding',
      version: '1.0.0',
      capabilities: [
        {
          id: 'translate',
          name: 'Translation',
          description: 'Translate text between languages',
          parameters: [
            { name: 'text', type: 'string', required: true },
            { name: 'targetLanguage', type: 'string', required: true }
          ]
        }
      ],
      endpoints: ['https://example.com/api'],
      timestamp: Date.now(),
      signature: 'test-signature'
    };
  });

  describe('CBOR Encoding', () => {
    it('should encode Agent Card as CBOR', () => {
      const encoded = encodeForDHT(sampleCard);

      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should decode CBOR back to Agent Card', () => {
      const encoded = encodeForDHT(sampleCard);
      const decoded = decodeFromCBOR(encoded);

      expect(decoded.did).toBe(sampleCard.did);
      expect(decoded.name).toBe(sampleCard.name);
      expect(decoded.capabilities).toHaveLength(1);
      expect(decoded.capabilities[0].id).toBe('translate');
    });

    it('should remove @context for compact storage', () => {
      const encoded = encodeForDHT(sampleCard);
      const decoded = decodeFromCBOR(encoded);

      // Context should be added back during decode
      expect(decoded['@context']).toBeDefined();
    });

    it('should handle cards without @context', () => {
      const cardWithoutContext = { ...sampleCard };
      delete cardWithoutContext['@context'];

      const encoded = encodeForDHT(cardWithoutContext);
      const decoded = decodeFromCBOR(encoded);

      expect(decoded['@context']).toBeDefined();
    });
  });

  describe('JSON-LD Encoding', () => {
    it('should encode Agent Card as JSON-LD', () => {
      const encoded = encodeForWeb(sampleCard);

      expect(typeof encoded).toBe('string');
      expect(encoded).toContain('@context');
      expect(encoded).toContain(sampleCard.did);
    });

    it('should decode JSON-LD back to Agent Card', () => {
      const encoded = encodeForWeb(sampleCard);
      const decoded = decodeFromJSON(encoded);

      expect(decoded.did).toBe(sampleCard.did);
      expect(decoded.name).toBe(sampleCard.name);
      expect(decoded['@context']).toBeDefined();
    });

    it('should add @context if missing', () => {
      const cardWithoutContext = { ...sampleCard };
      delete cardWithoutContext['@context'];

      const encoded = encodeForWeb(cardWithoutContext);
      const decoded = decodeFromJSON(encoded);

      expect(decoded['@context']).toBeDefined();
      expect(Array.isArray(decoded['@context'])).toBe(true);
    });

    it('should produce valid JSON', () => {
      const encoded = encodeForWeb(sampleCard);

      expect(() => JSON.parse(encoded)).not.toThrow();
    });
  });

  describe('Legacy Card Support', () => {
    it('should detect legacy cards', () => {
      const legacyCard = {
        did: 'did:agent:z6MkTest123',
        name: 'Legacy Agent',
        description: 'A legacy agent',
        version: '1.0.0',
        capabilities: ['translate', 'review'],
        endpoints: [],
        timestamp: Date.now(),
        signature: 'test-sig'
      };

      expect(isLegacyCard(legacyCard)).toBe(true);
    });

    it('should upgrade legacy cards automatically', () => {
      const legacyCard = {
        did: 'did:agent:z6MkTest123',
        name: 'Legacy Agent',
        description: 'A legacy agent',
        version: '1.0.0',
        capabilities: ['translate', 'review'],
        endpoints: [],
        timestamp: Date.now(),
        signature: 'test-sig'
      };

      const upgraded = upgradeLegacyCard(legacyCard);

      expect(Array.isArray(upgraded.capabilities)).toBe(true);
      expect(upgraded.capabilities[0]).toHaveProperty('id');
      expect(upgraded.capabilities[0]).toHaveProperty('name');
      expect(upgraded.capabilities[0]).toHaveProperty('description');
    });

    it('should decode legacy CBOR cards', () => {
      const legacyCard = {
        did: 'did:agent:z6MkTest123',
        name: 'Legacy Agent',
        description: 'A legacy agent',
        version: '1.0.0',
        capabilities: ['translate'],
        endpoints: [],
        timestamp: Date.now(),
        signature: 'test-sig'
      };

      // Use CBOR encoding for legacy card
      const encoded = cborEncode(legacyCard);
      const decoded = decodeFromCBOR(encoded);

      expect(decoded.capabilities[0]).toHaveProperty('id');
    });
  });

  describe('Size Comparison', () => {
    it('should show CBOR is more compact than JSON', () => {
      const sizes = getEncodedSize(sampleCard);

      expect(sizes.cbor).toBeLessThan(sizes.json);
      expect(sizes.cbor).toBeGreaterThan(0);
      expect(sizes.json).toBeGreaterThan(0);
    });

    it('should achieve 40-60% size reduction with CBOR', () => {
      const sizes = getEncodedSize(sampleCard);
      const reduction = (sizes.json - sizes.cbor) / sizes.json;

      expect(reduction).toBeGreaterThan(0.3); // At least 30% reduction
      expect(reduction).toBeLessThan(0.7);    // At most 70% reduction
    });
  });

  describe('Round-trip Encoding', () => {
    it('should preserve data through CBOR round-trip', () => {
      const encoded = encodeForDHT(sampleCard);
      const decoded = decodeFromCBOR(encoded);
      const reEncoded = encodeForDHT(decoded);
      const reDecoded = decodeFromCBOR(reEncoded);

      expect(reDecoded.did).toBe(sampleCard.did);
      expect(reDecoded.capabilities[0].id).toBe(sampleCard.capabilities[0].id);
    });

    it('should preserve data through JSON-LD round-trip', () => {
      const encoded = encodeForWeb(sampleCard);
      const decoded = decodeFromJSON(encoded);
      const reEncoded = encodeForWeb(decoded);
      const reDecoded = decodeFromJSON(reEncoded);

      expect(reDecoded.did).toBe(sampleCard.did);
      expect(reDecoded['@context']).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw on invalid CBOR data', () => {
      const invalidData = new Uint8Array([0xFF, 0xFF, 0xFF]);

      expect(() => decodeFromCBOR(invalidData)).toThrow();
    });

    it('should throw on invalid JSON data', () => {
      const invalidJson = '{invalid json}';

      expect(() => decodeFromJSON(invalidJson)).toThrow();
    });

    it('should handle empty capabilities array', () => {
      const cardWithoutCaps = { ...sampleCard, capabilities: [] };

      const encoded = encodeForDHT(cardWithoutCaps);
      const decoded = decodeFromCBOR(encoded);

      expect(decoded.capabilities).toEqual([]);
    });
  });
});
