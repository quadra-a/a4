/**
 * Peers Command - CVP-0010 §2.4
 *
 * quadra-a peers                         - List online agents
 * quadra-a peers --capability translate  - Filter by capability
 * quadra-a peers --format json
 */

import { Command } from 'commander';
import { DaemonClient } from '../daemon/client.js';
import { createLogger } from '@quadra-a/protocol';

const logger = createLogger('cli:peers');

export function registerPeersCommand(program: Command): void {
  program
    .command('peers')
    .description('List agents on the network')
    .option('--capability <cap>', 'Filter by capability')
    .option('--query <text>', 'Natural language search')
    .option('--min-trust <score>', 'Minimum trust score (0-1)')
    .option('--limit <n>', 'Max results', '20')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .action(async (options) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      try {
        const params: { query?: string; capability?: string; filters?: { minTrustScore: number } } = {};
        if (options.query) {
          params.query = options.query;
        }
        if (options.capability) {
          params.capability = options.capability;
        }
        if (options.minTrust) {
          params.filters = { minTrustScore: parseFloat(options.minTrust) };
        }

        const results = await client.send('discover', params);
        const agents: Array<{ did: string; card?: { name?: string; description?: string; capabilities?: string[] } }> = results ?? [];
        const limited = agents.slice(0, parseInt(options.limit, 10));

        if (options.format === 'json') {
          console.log(JSON.stringify(limited, null, 2));
          return;
        }

        if (limited.length === 0) {
          console.log('No agents found.');
          return;
        }

        console.log(`\nPeers (${limited.length} found)\n`);
        for (const agent of limited) {
          const trust = agent.trust?.interactionScore ?? 0;
          const trustStr = `${(trust * 100).toFixed(0)}%`;
          const caps = (agent.card?.capabilities ?? [])
            .map((c) => typeof c === 'string' ? c : c.name ?? c.id ?? '')
            .filter(Boolean)
            .slice(0, 3)
            .join(', ');
          const shortDid = agent.did?.slice(0, 30) + '…';
          console.log(`  ${agent.name ?? shortDid}  trust:${trustStr}`);
          if (caps) console.log(`    capabilities: ${caps}`);
          console.log(`    did: ${agent.did}`);
        }
        console.log();
      } catch (err) {
        logger.error('Peers failed', err);
        console.error('Error:', (err as Error).message);
        process.exit(1);
      }
    });
}
