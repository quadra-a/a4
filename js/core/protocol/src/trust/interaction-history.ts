/**
 * Interaction History Tracker
 *
 * Records and queries agent interaction history for trust scoring
 */

import { Level } from 'level';
import type { Interaction, InteractionStats } from './trust-score.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('interaction-history');

/**
 * Interaction History Manager
 */
export class InteractionHistory {
  private db: Level<string, Interaction>;

  constructor(dbPath: string) {
    this.db = new Level(dbPath, { valueEncoding: 'json' });
  }

  /**
   * Open database connection
   */
  async open(): Promise<void> {
    await this.db.open();
    logger.info('Interaction history database opened', { path: this.db.location });
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.db.close();
    logger.info('Interaction history database closed');
  }

  /**
   * Record an interaction
   */
  async record(interaction: Interaction): Promise<void> {
    const key = `interaction:${interaction.agentDid}:${interaction.timestamp}`;
    await this.db.put(key, interaction);
    logger.debug('Recorded interaction', { agentDid: interaction.agentDid, type: interaction.type });
  }

  /**
   * Get interaction history for an agent
   */
  async getHistory(agentDid: string, limit = 100): Promise<Interaction[]> {
    const interactions: Interaction[] = [];
    const prefix = `interaction:${agentDid}:`;

    try {
      for await (const [_, value] of this.db.iterator({
        gte: prefix,
        lte: prefix + '\xff',
        limit,
        reverse: true, // Most recent first
      })) {
        interactions.push(value);
      }
    } catch (error) {
      logger.error('Failed to get interaction history', { agentDid, error });
    }

    return interactions;
  }

  /**
   * Get interaction statistics for an agent
   */
  async getStats(agentDid: string): Promise<InteractionStats> {
    const history = await this.getHistory(agentDid, 1000); // Last 1000 interactions

    if (history.length === 0) {
      return {
        totalInteractions: 0,
        successRate: 0,
        recentSuccessRate: 1, // No history → assume good (don't penalize new agents)
        avgResponseTime: 0,
        lastInteraction: 0,
      };
    }

    const successCount = history.filter(i => i.success).length;
    const totalResponseTime = history.reduce((sum, i) => sum + i.responseTime, 0);

    // Sliding window: last 20 interactions (history is newest-first)
    const recent = history.slice(0, 20);
    const recentSuccessCount = recent.filter(i => i.success).length;
    const recentSuccessRate = recentSuccessCount / recent.length;

    return {
      totalInteractions: history.length,
      successRate: successCount / history.length,
      recentSuccessRate,
      avgResponseTime: totalResponseTime / history.length,
      lastInteraction: history[0].timestamp,
    };
  }

  /**
   * Get all agents with interaction history
   */
  async getAllAgents(): Promise<string[]> {
    const agents = new Set<string>();
    const prefix = 'interaction:';

    try {
      for await (const [key] of this.db.iterator()) {
        if (!key.startsWith(prefix)) {
          continue;
        }

        const timestampSeparator = key.lastIndexOf(':');
        if (timestampSeparator <= prefix.length) {
          continue;
        }

        agents.add(key.slice(prefix.length, timestampSeparator));
      }
    } catch (error) {
      logger.error('Failed to get all agents', { error });
    }

    return Array.from(agents);
  }

  /**
   * Delete all interactions for an agent
   */
  async deleteAgent(agentDid: string): Promise<void> {
    const prefix = `interaction:${agentDid}:`;
    const keysToDelete: string[] = [];

    for await (const [key] of this.db.iterator({
      gte: prefix,
      lte: prefix + '\xff',
    })) {
      keysToDelete.push(key);
    }

    await this.db.batch(keysToDelete.map(key => ({ type: 'del', key })));
    logger.info('Deleted interaction history', { agentDid, count: keysToDelete.length });
  }

  /**
   * Clean up old interactions (older than 90 days)
   */
  async cleanup(maxAge = 90 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAge;
    const keysToDelete: string[] = [];

    for await (const [key, value] of this.db.iterator()) {
      if (value.timestamp < cutoff) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      await this.db.batch(keysToDelete.map(key => ({ type: 'del', key })));
      logger.info('Cleaned up old interactions', { count: keysToDelete.length });
    }

    return keysToDelete.length;
  }
}
