/**
 * CVP-0011: Relay-backed discovery operations
 * Keeps a legacy discovery-operations shape, but is fully backed by relay queries.
 */

import type { AgentCard } from './agent-card-types.js';
import type { RelayClient } from '../transport/relay-client.js';
import { createLogger } from '../utils/logger.js';
import { DiscoveryError } from '../utils/errors.js';

const logger = createLogger('relay-index');


function matchesCapability(card: AgentCard, capability: string): boolean {
  const normalized = capability.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return card.capabilities.some((entry) => {
    const id = entry.id?.toLowerCase() ?? '';
    return id === normalized || id.startsWith(`${normalized}/`);
  });
}

export interface SemanticQuery {
  text?: string;
  capability?: string;
  filters?: {
    language?: string;
    minTrustScore?: number;
    maxCost?: number;
    tags?: string[];
  };
  limit?: number;
}

export interface RelayIndexOperations {
  publishAgentCard: (card: AgentCard) => Promise<void>;
  queryAgentCard: (did: string) => Promise<AgentCard | null>;
  queryByCapability: (capability: string) => Promise<AgentCard[]>;
  searchSemantic: (query: SemanticQuery) => Promise<AgentCard[]>;
  resolveDID: (did: string) => Promise<{ relayUrl: string } | null>;
  queryRelayPeers: () => Promise<string[]>;
}

/**
 * Create relay-backed discovery operations
 */
export function createRelayIndexOperations(client: RelayClient): RelayIndexOperations {
  return {
    publishAgentCard: async (card: AgentCard) => {
      // No-op: Agent Card is published via HELLO message when connecting to relay
      logger.debug('Agent Card published via HELLO', { did: card.did });
    },

    queryAgentCard: async (did: string) => {
      try {
        const card = await client.fetchCard(did);
        if (card) {
          logger.debug('Found Agent Card via relay', { did });
        } else {
          logger.debug('Agent Card not found via relay', { did });
        }
        return card;
      } catch (error) {
        logger.warn('Failed to query Agent Card', { did, error });
        return null;
      }
    },

    queryByCapability: async (capability: string) => {
      try {
        const results = await client.discover({ capability });
        const cards = results.map((r) => r.card);
        logger.debug('Query by capability', { capability, count: cards.length });
        return cards;
      } catch (error) {
        throw new DiscoveryError('Failed to query by capability', error);
      }
    },

    searchSemantic: async (query: SemanticQuery) => {
      try {
        const queryText = query.text?.trim();
        const capability = query.capability?.trim();
        const minTrust = query.filters?.minTrustScore;
        const limit = query.limit || 10;

        const discoverInput = queryText
          ? { query: queryText }
          : capability
            ? { capability }
            : { query: '' };

        const results = await client.discover(discoverInput, minTrust, limit);
        const cards = results.map((r) => r.card);
        const filteredCards = queryText && capability
          ? cards.filter((card) => matchesCapability(card, capability))
          : cards;

        logger.debug('Semantic search', {
          query: queryText,
          capability,
          count: filteredCards.length,
        });
        return filteredCards;
      } catch (error) {
        throw new DiscoveryError('Failed to perform semantic search', error);
      }
    },

    resolveDID: async (did: string) => {
      try {
        // In relay architecture, we don't need peer resolution
        // The relay handles routing, so we just return the relay URL
        const relays = client.getConnectedRelays();
        if (relays.length === 0) {
          logger.debug('DID resolution failed: no connected relays', { did });
          return null;
        }

        logger.debug('Resolved DID to relay', { did, relay: relays[0] });
        return { relayUrl: relays[0] };
      } catch (error) {
        logger.warn('Failed to resolve DID', { did, error });
        return null;
      }
    },

    queryRelayPeers: async () => {
      // Return connected relay URLs
      return client.getConnectedRelays();
    },
  };
}
