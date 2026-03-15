/**
 * Enhanced Agent Card Types for Phase 2
 *
 * Adds structured capabilities, JSON-LD support, trust metrics,
 * and device-directory publication for E2E messaging.
 */

import type { PublishedDeviceDirectoryEntry } from '../e2e/types.js';
import type { TrustScore } from '../trust/trust-score.js';

/**
 * Capability Parameter Definition
 */
export interface CapabilityParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description?: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Structured Capability Definition
 */
export interface Capability {
  '@type'?: string;
  id: string;
  name: string;
  description: string;
  parameters?: CapabilityParameter[];
  metadata?: Record<string, unknown>;
}

/**
 * Enhanced Agent Card with JSON-LD support
 */
export interface AgentCard {
  '@context'?: string[];
  did: string;
  name: string;
  description: string;
  version: string;
  capabilities: Capability[];
  endpoints: string[];
  devices?: PublishedDeviceDirectoryEntry[];
  peerId?: string;
  trust?: TrustScore;
  metadata?: Record<string, unknown>;
  timestamp: number;
  signature: string;
}

/**
 * Legacy Agent Card (Phase 1 compatibility)
 */
export interface LegacyAgentCard {
  did: string;
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  endpoints: string[];
  peerId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  signature: string;
}

/**
 * Check if card is legacy format
 */
export function isLegacyCard(card: AgentCard | LegacyAgentCard): card is LegacyAgentCard {
  return Array.isArray(card.capabilities)
    && card.capabilities.length > 0
    && typeof card.capabilities[0] === 'string';
}

/**
 * Convert legacy card to new format
 */
export function upgradeLegacyCard(legacy: LegacyAgentCard): AgentCard {
  return {
    ...legacy,
    capabilities: legacy.capabilities.map((cap) => ({
      id: cap,
      name: cap,
      description: `Capability: ${cap}`,
    })),
  };
}

/**
 * Convert new card to legacy format (for backward compatibility)
 */
export function downgradeToLegacyCard(card: AgentCard): LegacyAgentCard {
  const { '@context': _, trust: __, devices: ___, ...rest } = card;
  return {
    ...rest,
    capabilities: card.capabilities.map((cap) => cap.id),
  };
}
