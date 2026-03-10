/**
 * CVP-0017: Trust Computation Engine
 *
 * Implements EigenTrust-lite algorithm with:
 * - Recursive endorser weighting (endorsements from trusted agents count more)
 * - Domain-aware time decay (fast/slow/default domains)
 * - Collusion detection (Tarjan's SCC algorithm)
 * - Configurable recursion depth (default 3, max 6)
 * - Seed peer bootstrapping
 */

import { createLogger } from '../utils/logger.js';
import type { EndorsementV2 } from './endorsement.js';
import { FAST_DOMAINS, SLOW_DOMAINS } from './endorsement.js';

const logger = createLogger('trust-computer');

/**
 * Trust computation configuration
 */
export interface TrustConfig {
  seedPeers?: string[];              // DIDs that have inherent trust (weight 1.0)
  maxRecursionDepth?: number;        // Default 3, max 6
  decayHalfLife?: {                  // Domain-specific decay half-life (in days)
    default?: number;
    [domain: string]: number | undefined;
  };
  localInteractionWeight?: number;   // Weight for local interactions (default 0.6)
  networkEndorsementWeight?: number; // Weight for network endorsements (default 0.4)
}

/**
 * Trust computation result
 */
export interface TrustResult {
  score: number;                     // Overall trust score (0-1)
  localScore: number;                // Score from direct interactions
  networkScore: number;              // Score from network endorsements
  endorsementCount: number;          // Total endorsements considered
  collusionDetected: boolean;        // True if target is in collusion cluster
  computedAt: number;                // Timestamp
}

/**
 * Endorsement graph node
 */
interface GraphNode {
  did: string;
  endorsements: EndorsementV2[];
  index?: number;                    // Tarjan's algorithm index
  lowlink?: number;                  // Tarjan's algorithm lowlink
  onStack?: boolean;                 // Tarjan's algorithm stack flag
}

/**
 * Strongly connected component
 */
interface SCC {
  nodes: string[];                   // DIDs in this component
  internalEdges: number;             // Endorsements within component
  externalEdges: number;             // Endorsements from outside
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<TrustConfig> = {
  seedPeers: [],
  maxRecursionDepth: 3,
  decayHalfLife: {
    default: 90,
    translation: 30,
    transcription: 30,
    'data-entry': 30,
    moderation: 30,
    research: 180,
    architecture: 180,
    'security-audit': 180,
    'legal-review': 180,
  },
  localInteractionWeight: 0.6,
  networkEndorsementWeight: 0.4,
};

/**
 * Trust Computer
 */
export class TrustComputer {
  private config: Required<TrustConfig>;
  private cache = new Map<string, { result: TrustResult; expiresAt: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  // Cached SCC results: endorser DID → penalty factor (1.0 = no penalty, 0.1 = collusion)
  private sccPenaltyCache = new Map<string, number>();
  private sccCacheExpiresAt = 0;
  private readonly SCC_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  // Endorsements by target DID, used for recursive weight lookup
  private endorsementsByTarget = new Map<string, EndorsementV2[]>();

  constructor(config: TrustConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      decayHalfLife: {
        ...DEFAULT_CONFIG.decayHalfLife,
        ...config.decayHalfLife,
      },
    };

    // Validate max recursion depth
    if (this.config.maxRecursionDepth > 6) {
      logger.warn('Max recursion depth capped at 6', { requested: this.config.maxRecursionDepth });
      this.config.maxRecursionDepth = 6;
    }
  }

  /**
   * Compute trust score for a target DID.
   * allEndorsements: flat list of all endorsements known to the caller (used for recursive weight lookup).
   */
  compute(
    target: string,
    endorsements: EndorsementV2[],
    localInteractionScore: number = 0,
    localInteractionCount: number = 0,
    domain?: string,
    allEndorsements?: EndorsementV2[]
  ): TrustResult {
    // Check cache
    const cached = this.cache.get(this.getCacheKey(target, domain));
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug('Trust score cache hit', { target, domain });
      return cached.result;
    }

    // Build endorsement lookup map for recursive weight computation
    if (allEndorsements && allEndorsements.length > 0) {
      this.endorsementsByTarget.clear();
      for (const e of allEndorsements) {
        if (!this.endorsementsByTarget.has(e.to)) {
          this.endorsementsByTarget.set(e.to, []);
        }
        this.endorsementsByTarget.get(e.to)!.push(e);
      }
    }

    // Rebuild SCC penalty cache if stale (uses all endorsements for full graph)
    const allEnds = allEndorsements ?? endorsements;
    if (Date.now() > this.sccCacheExpiresAt) {
      this.rebuildSccPenaltyCache(allEnds);
    }

    // Filter endorsements by domain
    const filteredEndorsements = this.filterByDomain(endorsements, domain);

    // Compute network trust score
    const networkScore = this.computeNetworkTrust(target, filteredEndorsements, domain);

    // Blend local and network scores
    // α = min(directInteractions / 20, 0.8)
    const alpha = Math.min(localInteractionCount / 20, 0.8);
    const score = alpha * localInteractionScore + (1 - alpha) * networkScore;

    // Detect collusion
    const collusionDetected = this.detectCollusion(target, allEnds);

    const result: TrustResult = {
      score,
      localScore: localInteractionScore,
      networkScore,
      endorsementCount: filteredEndorsements.length,
      collusionDetected,
      computedAt: Date.now(),
    };

    // Cache result
    this.cache.set(this.getCacheKey(target, domain), {
      result,
      expiresAt: Date.now() + this.CACHE_TTL,
    });

    logger.debug('Computed trust score', { target, domain, score, networkScore, collusionDetected });
    return result;
  }

  /**
   * Compute network trust score using EigenTrust-lite
   */
  private computeNetworkTrust(
    target: string,
    endorsements: EndorsementV2[],
    domain?: string,
    depth: number = 0,
    visited: Set<string> = new Set()
  ): number {
    if (endorsements.length === 0) {
      return 0;
    }

    // Prevent infinite recursion
    if (depth >= this.config.maxRecursionDepth) {
      return 0.1; // Neutral prior
    }

    // Prevent cycles
    if (visited.has(target)) {
      return 0.1;
    }
    visited.add(target);

    const now = Date.now();
    let weightedSum = 0;
    let totalWeight = 0;

    for (const endorsement of endorsements) {
      // Skip expired endorsements
      if (endorsement.expires && endorsement.expires < now) {
        continue;
      }

      // Compute endorser weight (recursive)
      const endorserWeight = this.getEndorserWeight(
        endorsement.from,
        domain,
        depth + 1,
        visited
      );

      // Compute time decay
      const timeDecay = this.computeTimeDecay(endorsement, domain);

      // Compute collusion penalty
      const collusionPenalty = this.getCollusionPenalty(endorsement.from);

      const baseWeight = endorserWeight * collusionPenalty;
      // timeDecay multiplies the score contribution, not the normalizing weight
      // This ensures decay reduces networkScore even with a single endorser
      weightedSum += endorsement.score * timeDecay * baseWeight;
      totalWeight += baseWeight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Get endorser weight (recursive EigenTrust-lite).
   * Uses endorsementsByTarget populated by compute() for local graph traversal.
   */
  private getEndorserWeight(
    endorser: string,
    domain: string | undefined,
    depth: number,
    visited: Set<string>
  ): number {
    // Seed peers have weight 1.0
    if (this.config.seedPeers.includes(endorser)) {
      return 1.0;
    }

    // Max depth reached — use neutral prior
    if (depth >= this.config.maxRecursionDepth) {
      return 0.1;
    }

    // Prevent cycles
    if (visited.has(endorser)) {
      return 0.1;
    }

    // Look up endorsements for this endorser in the local graph
    const endorserEndorsements = this.endorsementsByTarget.get(endorser);
    if (!endorserEndorsements || endorserEndorsements.length === 0) {
      return 0.1; // No data — neutral prior
    }

    // Recursively compute the endorser's own trust score
    const endorserScore = this.computeNetworkTrust(
      endorser,
      this.filterByDomain(endorserEndorsements, domain),
      domain,
      depth,
      new Set(visited) // copy so sibling branches don't share state
    );

    // Map [0,1] score to weight range [0.1, 1.0]
    return 0.1 + endorserScore * 0.9;
  }

  /**
   * Compute time decay for an endorsement
   */
  private computeTimeDecay(endorsement: EndorsementV2, domain?: string): number {
    const age = Date.now() - endorsement.timestamp;
    const ageDays = age / (24 * 60 * 60 * 1000);

    // Get domain-specific half-life
    const halfLife = this.getDecayHalfLife(endorsement.domain || domain);

    // Exponential decay: exp(-age / halfLife)
    return Math.exp(-ageDays / halfLife);
  }

  /**
   * Get decay half-life for a domain
   */
  private getDecayHalfLife(domain?: string): number {
    if (!domain) {
      return this.config.decayHalfLife.default || 90;
    }

    // Check if domain is in fast/slow categories
    if (FAST_DOMAINS.includes(domain)) {
      return this.config.decayHalfLife[domain] || 30;
    }
    if (SLOW_DOMAINS.includes(domain)) {
      return this.config.decayHalfLife[domain] || 180;
    }

    // Check custom configuration
    return this.config.decayHalfLife[domain] || this.config.decayHalfLife.default || 90;
  }

  /**
   * Detect collusion using Tarjan's SCC algorithm
   */
  private detectCollusion(target: string, endorsements: EndorsementV2[]): boolean {
    // Build endorsement graph
    const graph = this.buildGraph(endorsements);

    // Find strongly connected components
    const sccs = this.findSCCs(graph);

    // Check if target is in a collusion cluster
    for (const scc of sccs) {
      if (scc.nodes.includes(target) && scc.nodes.length > 3) {
        // Compute external connectivity ratio
        const ratio = scc.externalEdges / (scc.internalEdges || 1);
        if (ratio < 0.2) {
          logger.warn('Collusion detected', {
            target,
            sccSize: scc.nodes.length,
            ratio,
          });
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Build endorsement graph
   */
  private buildGraph(endorsements: EndorsementV2[]): Map<string, GraphNode> {
    const graph = new Map<string, GraphNode>();

    for (const endorsement of endorsements) {
      // Add nodes
      if (!graph.has(endorsement.from)) {
        graph.set(endorsement.from, { did: endorsement.from, endorsements: [] });
      }
      if (!graph.has(endorsement.to)) {
        graph.set(endorsement.to, { did: endorsement.to, endorsements: [] });
      }

      // Add edge
      graph.get(endorsement.from)!.endorsements.push(endorsement);
    }

    return graph;
  }

  /**
   * Find strongly connected components using Tarjan's algorithm
   */
  private findSCCs(graph: Map<string, GraphNode>): SCC[] {
    const sccs: SCC[] = [];
    const stack: string[] = [];
    let index = 0;

    const strongConnect = (node: GraphNode) => {
      node.index = index;
      node.lowlink = index;
      index++;
      stack.push(node.did);
      node.onStack = true;

      // Visit successors
      for (const endorsement of node.endorsements) {
        const successor = graph.get(endorsement.to);
        if (!successor) continue;

        if (successor.index === undefined) {
          strongConnect(successor);
          node.lowlink = Math.min(node.lowlink!, successor.lowlink!);
        } else if (successor.onStack) {
          node.lowlink = Math.min(node.lowlink!, successor.index);
        }
      }

      // Root of SCC
      if (node.lowlink === node.index) {
        const sccNodes: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          graph.get(w)!.onStack = false;
          sccNodes.push(w);
        } while (w !== node.did);

        if (sccNodes.length > 1) {
          // Compute internal/external edges
          let internalEdges = 0;
          let externalEdges = 0;

          for (const did of sccNodes) {
            const n = graph.get(did)!;
            for (const endorsement of n.endorsements) {
              if (sccNodes.includes(endorsement.to)) {
                internalEdges++;
              } else {
                externalEdges++;
              }
            }
          }

          sccs.push({ nodes: sccNodes, internalEdges, externalEdges });
        }
      }
    };

    // Run Tarjan's algorithm on all nodes
    for (const node of graph.values()) {
      if (node.index === undefined) {
        strongConnect(node);
      }
    }

    return sccs;
  }

  /**
   * Rebuild the SCC penalty cache from a full endorsement graph.
   * Called lazily when the cache is stale.
   */
  private rebuildSccPenaltyCache(endorsements: EndorsementV2[]): void {
    this.sccPenaltyCache.clear();
    const graph = this.buildGraph(endorsements);
    const sccs = this.findSCCs(graph);

    for (const scc of sccs) {
      if (scc.nodes.length > 3) {
        const ratio = scc.externalEdges / (scc.internalEdges || 1);
        if (ratio < 0.2) {
          // Collusion cluster — penalise all members
          for (const did of scc.nodes) {
            this.sccPenaltyCache.set(did, 0.1);
          }
        }
      }
    }

    this.sccCacheExpiresAt = Date.now() + this.SCC_CACHE_TTL;
  }

  /**
   * Get collusion penalty for an endorser.
   * Returns 0.1 if the endorser is in a detected collusion cluster, 1.0 otherwise.
   */
  private getCollusionPenalty(endorser: string): number {
    return this.sccPenaltyCache.get(endorser) ?? 1.0;
  }

  /**
   * Filter endorsements by domain
   */
  private filterByDomain(endorsements: EndorsementV2[], domain?: string): EndorsementV2[] {
    if (!domain) {
      return endorsements;
    }

    return endorsements.filter(
      e => e.domain === domain || e.domain === undefined || e.domain === '*'
    );
  }

  /**
   * Get cache key
   */
  private getCacheKey(target: string, domain?: string): string {
    return `${target}:${domain || '*'}`;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug('Trust score cache cleared');
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TrustConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      decayHalfLife: {
        ...this.config.decayHalfLife,
        ...config.decayHalfLife,
      },
    };

    // Clear cache when config changes
    this.clearCache();
    logger.info('Trust config updated', { config });
  }
}
