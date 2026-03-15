import { Command } from 'commander';
import { resolveTargetDid } from '../services/messaging.js';
import {
  allowAgent,
  blockAgent,
  endorseAgent,
  getTrustHistory,
  getTrustScore,
  getTrustStats,
  listAllowedAgents,
  listBlockedAgents,
  queryNetworkEndorsements,
  unblockAgent,
} from '../services/trust.js';
import { error, success } from '../ui.js';

export function createTrustCommand(): Command {
  const trust = new Command('trust')
    .description('Legacy trust command group')
    .configureHelp({ visibleCommands: () => [] });

  trust
    .command('show <target>')
    .description('Legacy alias for score')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const { score } = await getTrustScore(resolved.did);
        console.log(`Interaction Score: ${(score.interactionScore * 100).toFixed(1)}%`);
        console.log(`Endorsements: ${score.endorsements}`);
        console.log(`Completion Rate: ${(score.completionRate * 100).toFixed(1)}%`);
        console.log(`Response Time: ${score.responseTime.toFixed(0)}ms`);
      } catch (err) {
        error(`Failed to show trust score: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('endorse <target>')
    .description('Legacy alias for vouch')
    .option('-s, --score <score>', 'Endorsement score (0-1)', '0.8')
    .option('-r, --reason <reason>', 'Reason for endorsement', 'Good collaboration')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const endorsement = await endorseAgent(resolved.did, parseFloat(options.score), options.reason);
        success(`Endorsed ${endorsement.to}`);
      } catch (err) {
        error(`Failed to endorse agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('history <target>')
    .description('Show interaction history with an agent')
    .option('-l, --limit <limit>', 'Number of interactions to show', '10')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .option('--json', 'Output as JSON')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const history = await getTrustHistory(resolved.did, parseInt(options.limit, 10));

        if (options.json) {
          console.log(JSON.stringify(history, null, 2));
          return;
        }

        if (history.length === 0) {
          console.log('No interactions recorded');
          return;
        }

        for (const interaction of history) {
          const status = interaction.success ? '✅' : '❌';
          const failureInfo = interaction.failureReason ? ` (${interaction.failureReason})` : '';
          console.log(`${status} ${interaction.type} - ${new Date(interaction.timestamp).toLocaleString()}${failureInfo}`);
          console.log(`   Response time: ${interaction.responseTime}ms`);
          if (interaction.rating) {
            console.log(`   Rating: ${'⭐'.repeat(interaction.rating)}`);
          }
          if (interaction.feedback) {
            console.log(`   Feedback: ${interaction.feedback}`);
          }
        }
      } catch (err) {
        error(`Failed to show history: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('stats')
    .description('Show local trust statistics')
    .action(async () => {
      try {
        const stats = await getTrustStats();
        console.log(`Total agents tracked: ${stats.agents.length}`);

        if (stats.scores.length > 0) {
          console.log('\nTop agents by trust score:');
          for (const { did, score } of stats.scores.slice(0, 5)) {
            console.log(`  ${(score.interactionScore * 100).toFixed(0)}% - ${did}`);
          }
        }
      } catch (err) {
        error(`Failed to show stats: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('query <target>')
    .description('Legacy alias for endorsements')
    .option('-d, --domain <domain>', 'Filter by capability domain')
    .option('-r, --relay <url>', 'Relay URL')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const result = await queryNetworkEndorsements(resolved.did, {
          relay: options.relay,
          domain: options.domain,
        });

        if (result.endorsementCount === 0) {
          console.log(`NO_ENDORSEMENTS target=${resolved.did}`);
          return;
        }

        console.log(`ENDORSEMENT_COUNT=${result.endorsementCount}`);
        for (const endorsement of result.endorsements) {
          console.log(`FROM=${endorsement.from}`);
          console.log(`SCORE=${endorsement.score.toFixed(3)}`);
          console.log(`REASON=${endorsement.reason}`);
          if (endorsement.domain) console.log(`DOMAIN=${endorsement.domain}`);
          console.log(`DATE=${new Date(endorsement.timestamp).toISOString()}`);
        }
      } catch (err) {
        error(`Failed to query trust: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('block <target>')
    .description('Legacy alias for block')
    .option('-r, --reason <reason>', 'Reason for blocking', 'Blocked by user')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        await blockAgent(resolved.did, options.reason);
        console.log(`Blocked ${resolved.did}`);
      } catch (err) {
        error(`Failed to block agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('unblock <target>')
    .description('Legacy alias for unblock')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        await unblockAgent(resolved.did);
        console.log(`Unblocked ${resolved.did}`);
      } catch (err) {
        error(`Failed to unblock agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('list-blocked')
    .description('List blocked agents')
    .action(async () => {
      try {
        const blocked = await listBlockedAgents();
        if (blocked.length === 0) {
          console.log('No blocked agents.');
          return;
        }

        for (const entry of blocked) {
          console.log(`${entry.did}  ${entry.reason}`);
        }
      } catch (err) {
        error(`Failed to list blocked agents: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('allow <target>')
    .description('Allowlist an agent')
    .option('-n, --note <note>', 'Note about this agent')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        await allowAgent(resolved.did, options.note);
        console.log(`Added ${resolved.did} to allowlist`);
      } catch (err) {
        error(`Failed to allowlist agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  trust
    .command('list-allowed')
    .description('List allowlisted agents')
    .action(async () => {
      try {
        const allowed = await listAllowedAgents();
        if (allowed.length === 0) {
          console.log('No allowlisted agents.');
          return;
        }

        for (const entry of allowed) {
          console.log(entry.note ? `${entry.did}  ${entry.note}` : entry.did);
        }
      } catch (err) {
        error(`Failed to list allowlisted agents: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return trust;
}
