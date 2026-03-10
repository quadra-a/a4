/**
 * Relay Status and Metrics Manager
 *
 * Provides comprehensive status reporting and metrics for relay agents:
 * - Real-time performance metrics
 * - Federation health monitoring
 * - Network topology information
 * - Trust system statistics
 */

import type { RelayIdentity } from './relay-identity.js';
import type { AgentRegistry } from './registry.js';
import type { FederationManager } from './federation-manager.js';
import type { BootstrapManager } from './bootstrap-manager.js';
import type { EndorsementIndex } from './endorsement-index.js';
import type { MessageQueue } from './queue.js';

export interface RelayMetrics {
  // Basic relay info
  identity: {
    did: string;
    name: string;
    version: string;
    networkId: string;
    mode: 'genesis' | 'federated';
  };

  // Performance metrics
  performance: {
    uptime: number;
    startTime: number;
    messagesRouted: number;
    messagesQueued: number;
    averageLatency: number;
    peakConnections: number;
  };

  // Agent statistics
  agents: {
    connected: number;
    published: number;
    totalSeen: number;
    byRealm: Record<string, number>;
    topCapabilities: Array<{ capability: string; count: number }>;
  };

  // Federation status
  federation: {
    enabled: boolean;
    connectedRelays: number;
    totalRelaysKnown: number;
    crossRelayMessages: number;
    federationUptime: number;
    peerRelays: Array<{
      did: string;
      name: string;
      uptime: number;
      agentCount: number;
      lastSeen: number;
    }>;
  };

  // Trust system metrics
  trust: {
    totalEndorsements: number;
    uniqueEndorsers: number;
    averageTrustScore: number;
    endorsementsByDomain: Record<string, number>;
    recentEndorsements: number; // Last 24h
  };

  // Network health
  health: {
    status: 'healthy' | 'degraded' | 'critical';
    issues: string[];
    lastHealthCheck: number;
    queueHealth: 'normal' | 'high' | 'critical';
    federationHealth: 'connected' | 'partial' | 'isolated';
  };
}

export class RelayStatusManager {
  private relayIdentity: RelayIdentity;
  private registry: AgentRegistry;
  private federationManager: FederationManager | null;
  private bootstrapManager: BootstrapManager | null;
  private endorsements: EndorsementIndex;
  private queue: MessageQueue | null;

  // Metrics tracking
  private startTime = Date.now();
  private messagesRouted = 0;
  private messagesQueued = 0;
  private peakConnections = 0;
  private latencySum = 0;
  private latencyCount = 0;
  private crossRelayMessages = 0;

  constructor(
    relayIdentity: RelayIdentity,
    registry: AgentRegistry,
    federationManager: FederationManager | null,
    bootstrapManager: BootstrapManager | null,
    endorsements: EndorsementIndex,
    queue: MessageQueue | null
  ) {
    this.relayIdentity = relayIdentity;
    this.registry = registry;
    this.federationManager = federationManager;
    this.bootstrapManager = bootstrapManager;
    this.endorsements = endorsements;
    this.queue = queue;
  }

  /**
   * Get comprehensive relay metrics
   */
  async getMetrics(): Promise<RelayMetrics> {
    const identity = this.relayIdentity.getIdentity();
    const bootstrapStatus = this.bootstrapManager?.getBootstrapStatus();
    const federationStatus = this.federationManager?.getFederationStatus();

    // Agent statistics
    const agentStats = await this.getAgentStatistics();
    const trustStats = await this.getTrustStatistics();
    const healthStatus = await this.getHealthStatus();

    return {
      identity: {
        did: identity.did,
        name: identity.agentCard.name,
        version: identity.agentCard.version,
        networkId: bootstrapStatus?.networkId || 'unknown',
        mode: bootstrapStatus?.mode || 'federated',
      },

      performance: {
        uptime: Date.now() - this.startTime,
        startTime: this.startTime,
        messagesRouted: this.messagesRouted,
        messagesQueued: this.messagesQueued,
        averageLatency: this.latencyCount > 0 ? this.latencySum / this.latencyCount : 0,
        peakConnections: this.peakConnections,
      },

      agents: agentStats,

      federation: {
        enabled: !!this.federationManager,
        connectedRelays: federationStatus?.relayCount || 0,
        totalRelaysKnown: federationStatus?.relayCount || 0,
        crossRelayMessages: this.crossRelayMessages,
        federationUptime: Date.now() - this.startTime, // Simplified
        peerRelays: [], // TODO: Get from federation manager
      },

      trust: trustStats,
      health: healthStatus,
    };
  }

  /**
   * Get agent statistics
   */
  private async getAgentStatistics(): Promise<RelayMetrics['agents']> {
    const connected = this.registry.getOnlineCount();
    this.peakConnections = Math.max(this.peakConnections, connected);

    // Get published agents
    const { agents: publishedAgents } = this.registry.search('', undefined, 1000);
    const published = publishedAgents.length;

    // Count by realm
    const byRealm: Record<string, number> = {};
    const capabilityCounts: Record<string, number> = {};

    for (const agent of publishedAgents) {
      // Count by realm (simplified - would need to track realm info)
      const realm = 'public'; // Simplified
      byRealm[realm] = (byRealm[realm] || 0) + 1;

      // Count capabilities
      for (const capability of agent.card.capabilities) {
        const capId = capability.id;
        capabilityCounts[capId] = (capabilityCounts[capId] || 0) + 1;
      }
    }

    // Top capabilities
    const topCapabilities = Object.entries(capabilityCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([capability, count]) => ({ capability, count }));

    return {
      connected,
      published,
      totalSeen: published, // Simplified
      byRealm,
      topCapabilities,
    };
  }

  /**
   * Get trust system statistics
   */
  private async getTrustStatistics(): Promise<RelayMetrics['trust']> {
    // Use the endorsements index to get actual statistics
    // For now, return placeholder values but keep the endorsements reference
    if (this.endorsements) {
      // TODO: Implement actual endorsement statistics
      // const stats = this.endorsements.getStatistics();
    }

    return {
      totalEndorsements: 0,
      uniqueEndorsers: 0,
      averageTrustScore: 0,
      endorsementsByDomain: {},
      recentEndorsements: 0,
    };
  }

  /**
   * Get health status
   */
  private async getHealthStatus(): Promise<RelayMetrics['health']> {
    const issues: string[] = [];
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

    // Check queue health
    let queueHealth: 'normal' | 'high' | 'critical' = 'normal';
    if (this.queue) {
      const queueStats = await this.queue.getStats();
      if (queueStats.queued > 1000) {
        queueHealth = 'high';
        issues.push('High message queue backlog');
        status = 'degraded';
      }
      if (queueStats.queued > 5000) {
        queueHealth = 'critical';
        issues.push('Critical message queue backlog');
        status = 'critical';
      }
    }

    // Check federation health
    let federationHealth: 'connected' | 'partial' | 'isolated' = 'isolated';
    if (this.federationManager) {
      const federationStatus = this.federationManager.getFederationStatus();
      if (federationStatus.relayCount > 0) {
        federationHealth = 'connected';
      } else {
        federationHealth = 'isolated';
        issues.push('No federated relays connected');
        if (status === 'healthy') status = 'degraded';
      }
    }

    return {
      status,
      issues,
      lastHealthCheck: Date.now(),
      queueHealth,
      federationHealth,
    };
  }

  /**
   * Record message routing metrics
   */
  recordMessageRouted(latencyMs?: number): void {
    this.messagesRouted++;
    if (latencyMs !== undefined) {
      this.latencySum += latencyMs;
      this.latencyCount++;
    }
  }

  /**
   * Record message queuing metrics
   */
  recordMessageQueued(): void {
    this.messagesQueued++;
  }

  /**
   * Record cross-relay message
   */
  recordCrossRelayMessage(): void {
    this.crossRelayMessages++;
  }

  /**
   * Get simple status summary
   */
  async getStatusSummary(): Promise<{
    status: string;
    uptime: number;
    agents: number;
    federation: number;
    health: string;
  }> {
    const metrics = await this.getMetrics();

    return {
      status: metrics.identity.mode,
      uptime: metrics.performance.uptime,
      agents: metrics.agents.connected,
      federation: metrics.federation.connectedRelays,
      health: metrics.health.status,
    };
  }

  /**
   * Generate status report for logging
   */
  async generateStatusReport(): Promise<string> {
    const metrics = await this.getMetrics();

    const report = [
      `=== Relay Status Report ===`,
      `Identity: ${metrics.identity.name} (${metrics.identity.did})`,
      `Network: ${metrics.identity.networkId} (${metrics.identity.mode} mode)`,
      `Uptime: ${Math.floor(metrics.performance.uptime / 1000)}s`,
      ``,
      `Agents: ${metrics.agents.connected} connected, ${metrics.agents.published} published`,
      `Messages: ${metrics.performance.messagesRouted} routed, ${metrics.performance.messagesQueued} queued`,
      `Federation: ${metrics.federation.connectedRelays} relays connected`,
      `Trust: ${metrics.trust.totalEndorsements} endorsements`,
      ``,
      `Health: ${metrics.health.status.toUpperCase()}`,
      ...(metrics.health.issues.length > 0 ? [`Issues: ${metrics.health.issues.join(', ')}`] : []),
      `========================`,
    ];

    return report.join('\n');
  }
}