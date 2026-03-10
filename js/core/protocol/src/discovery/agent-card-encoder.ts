/**
 * Agent Card Encoder - Dual Encoding Support
 *
 * Provides bidirectional conversion between:
 * - CBOR (compact binary) for relay/discovery storage compatibility
 * - JSON-LD (semantic) for Web publishing
 */

import { encode as cborEncode, decode as cborDecode } from 'cbor-x';
import type { AgentCard, LegacyAgentCard } from './agent-card-types.js';
import { isLegacyCard, upgradeLegacyCard } from './agent-card-types.js';
import { getAgentCardContext } from './agent-card-schema.js';
import { DiscoveryError } from '../utils/errors.js';

/**
 * Encode Agent Card as compact CBOR.
 *
 * The helper keeps its historical name because older APIs referenced
 * "DHT encoding", but the current architecture uses relay-backed discovery.
 */
export function encodeForDHT(card: AgentCard): Uint8Array {
  try {
    // Remove JSON-LD context for compact storage
    const { '@context': _, ...cardWithoutContext } = card;
    return cborEncode(cardWithoutContext);
  } catch (error) {
    throw new DiscoveryError('Failed to encode Agent Card as CBOR', error);
  }
}

/**
 * Encode Agent Card as JSON-LD for Web publishing
 */
export function encodeForWeb(card: AgentCard): string {
  try {
    // Ensure JSON-LD context is present
    const cardWithContext: AgentCard = {
      '@context': card['@context'] || getAgentCardContext(),
      ...card,
    };
    return JSON.stringify(cardWithContext, null, 2);
  } catch (error) {
    throw new DiscoveryError('Failed to encode Agent Card as JSON-LD', error);
  }
}

/**
 * Decode Agent Card from CBOR
 */
export function decodeFromCBOR(data: Uint8Array): AgentCard {
  try {
    const decoded = cborDecode(data) as AgentCard | LegacyAgentCard;

    // Handle legacy format
    if (isLegacyCard(decoded)) {
      return upgradeLegacyCard(decoded);
    }

    // Add default context if missing
    if (!decoded['@context']) {
      decoded['@context'] = getAgentCardContext();
    }

    return decoded;
  } catch (error) {
    throw new DiscoveryError('Failed to decode Agent Card from CBOR', error);
  }
}

/**
 * Decode Agent Card from JSON-LD
 */
export function decodeFromJSON(json: string): AgentCard {
  try {
    const decoded = JSON.parse(json) as AgentCard | LegacyAgentCard;

    // Handle legacy format
    if (isLegacyCard(decoded)) {
      return upgradeLegacyCard(decoded);
    }

    // Add default context if missing
    if (!decoded['@context']) {
      decoded['@context'] = getAgentCardContext();
    }

    return decoded;
  } catch (error) {
    throw new DiscoveryError('Failed to decode Agent Card from JSON', error);
  }
}

/**
 * Auto-detect format and decode
 */
export function decodeAgentCard(data: Uint8Array | string): AgentCard {
  if (typeof data === 'string') {
    return decodeFromJSON(data);
  }

  // Try CBOR first, fallback to JSON if it looks like text
  try {
    return decodeFromCBOR(data);
  } catch {
    // Check if it's actually JSON text
    const text = new TextDecoder().decode(data);
    if (text.trim().startsWith('{')) {
      return decodeFromJSON(text);
    }
    throw new DiscoveryError('Unable to decode Agent Card: unknown format');
  }
}

/**
 * Calculate encoded size for comparison
 */
export function getEncodedSize(card: AgentCard): { cbor: number; json: number } {
  return {
    cbor: encodeForDHT(card).length,
    json: encodeForWeb(card).length,
  };
}
