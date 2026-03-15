import Ajv, { JSONSchemaType } from 'ajv';
import { DiscoveryError } from '../utils/errors.js';
import { encodeCanonicalJson, encodeJsonSignaturePayloads } from '../utils/canonical-json.js';

// Re-export Phase 2 types
export type { AgentCard, Capability, CapabilityParameter, LegacyAgentCard } from './agent-card-types.js';
export { isLegacyCard, upgradeLegacyCard, downgradeToLegacyCard } from './agent-card-types.js';

// Import for internal use
import type { AgentCard, Capability, LegacyAgentCard } from './agent-card-types.js';
import { isLegacyCard } from './agent-card-types.js';

// Legacy schema for backward compatibility
const legacyAgentCardSchema: JSONSchemaType<Omit<LegacyAgentCard, 'signature'>> = {
  type: 'object',
  properties: {
    did: { type: 'string', pattern: '^did:agent:[1-9A-HJ-NP-Za-km-z]+$' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', maxLength: 500 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      minItems: 0,
      maxItems: 50,
    },
    endpoints: {
      type: 'array',
      items: { type: 'string' },
      minItems: 0,
      maxItems: 10,
    },
    peerId: { type: 'string', nullable: true },
    metadata: {
      type: 'object',
      nullable: true,
      required: [],
    },
    timestamp: { type: 'number' },
  },
  required: ['did', 'name', 'description', 'version', 'capabilities', 'endpoints', 'timestamp'],
  additionalProperties: false,
};

const ajv = new Ajv();
const validateLegacySchema = ajv.compile(legacyAgentCardSchema);

/**
 * Create a new Agent Card (Phase 2 format with structured capabilities)
 */
export function createAgentCard(
  did: string,
  name: string,
  description: string,
  capabilities: Capability[],
  endpoints: string[] = [],
  peerId?: string,
  metadata?: Record<string, unknown>
): Omit<AgentCard, 'signature'> {
  return {
    did,
    name,
    description,
    version: '1.0.0',
    capabilities,
    endpoints,
    peerId,
    metadata,
    timestamp: Date.now(),
  };
}

/**
 * Create a legacy Agent Card (Phase 1 format with string capabilities)
 * For backward compatibility
 */
export function createLegacyAgentCard(
  did: string,
  name: string,
  description: string,
  capabilities: string[],
  endpoints: string[] = [],
  peerId?: string,
  metadata?: Record<string, unknown>
): Omit<LegacyAgentCard, 'signature'> {
  return {
    did,
    name,
    description,
    version: '1.0.0',
    capabilities,
    endpoints,
    peerId,
    metadata,
    timestamp: Date.now(),
  };
}

/**
 * Validate an Agent Card structure (supports both Phase 1 and Phase 2 formats)
 */
export function validateAgentCard(card: unknown): card is AgentCard | LegacyAgentCard {
  if (typeof card !== 'object' || card === null) {
    return false;
  }

  const c = card as Partial<AgentCard | LegacyAgentCard>;

  // Check signature exists
  if (typeof c.signature !== 'string') {
    return false;
  }

  // Check if it's legacy format
  if (isLegacyCard(c as AgentCard | LegacyAgentCard)) {
    return validateLegacySchema(c);
  }

  // Phase 2 format - basic validation
  // (Full JSON-LD validation would be more complex)
  return (
    typeof c.did === 'string' &&
    typeof c.name === 'string' &&
    typeof c.description === 'string' &&
    typeof c.version === 'string' &&
    Array.isArray(c.capabilities) &&
    Array.isArray(c.endpoints) &&
    typeof c.timestamp === 'number'
  );
}

/**
 * Sign an Agent Card
 */
export async function signAgentCard(
  card: Omit<AgentCard, 'signature'>,
  signFn: (data: Uint8Array) => Promise<Uint8Array>
): Promise<AgentCard> {
  try {
    const signature = await signFn(encodeCanonicalJson(card));

    return {
      ...card,
      signature: Buffer.from(signature).toString('hex'),
    };
  } catch (error) {
    throw new DiscoveryError('Failed to sign Agent Card', error);
  }
}

/**
 * Verify an Agent Card signature
 */
export async function verifyAgentCard(
  card: AgentCard,
  verifyFn: (signature: Uint8Array, data: Uint8Array) => Promise<boolean>
): Promise<boolean> {
  try {
    const { signature, ...cardWithoutSig } = card;
    const signatureBytes = Buffer.from(signature, 'hex');

    for (const payloadBytes of encodeJsonSignaturePayloads(cardWithoutSig)) {
      if (await verifyFn(signatureBytes, payloadBytes)) {
        return true;
      }
    }

    return false;
  } catch (error) {
    throw new DiscoveryError('Failed to verify Agent Card', error);
  }
}

/**
 * Check if an Agent Card matches a capability query
 * Supports both Phase 1 (string[]) and Phase 2 (Capability[]) formats
 */
export function matchesCapability(
  card: AgentCard | LegacyAgentCard,
  capability: string
): boolean {
  if (isLegacyCard(card)) {
    return card.capabilities.some((cap) =>
      cap.toLowerCase().includes(capability.toLowerCase())
    );
  }

  return card.capabilities.some((cap) =>
    cap.id.toLowerCase().includes(capability.toLowerCase()) ||
    cap.name.toLowerCase().includes(capability.toLowerCase()) ||
    cap.description.toLowerCase().includes(capability.toLowerCase())
  );
}
