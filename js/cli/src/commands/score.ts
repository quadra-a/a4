import { Command } from 'commander';
import { resolveTargetDid } from '../services/messaging.js';
import { getTrustScore } from '../services/trust.js';
import { error, info, printHeader } from '../ui.js';

export function registerScoreCommand(program: Command): void {
  program
    .command('score <target>')
    .description('Show the local trust score for an agent')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--human', 'Human-friendly output with colors')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const { score, endorsements } = await getTrustScore(resolved.did);

        if (options.format === 'json') {
          console.log(JSON.stringify({
            target,
            resolvedDid: resolved.did,
            matchedBy: resolved.matchedBy,
            score,
            endorsements,
          }, null, 2));
          return;
        }

        if (options.human) {
          printHeader('Local Trust Score');
        }

        info(`Target: ${resolved.did}`);
        info(`Interaction Score: ${(score.interactionScore * 100).toFixed(1)}%`);
        info(`Endorsements: ${score.endorsements}`);
        info(`Completion Rate: ${(score.completionRate * 100).toFixed(1)}%`);
        info(`Response Time: ${score.responseTime.toFixed(0)}ms`);
        info(`Uptime: ${(score.uptime * 100).toFixed(1)}%`);
        info(`Last Updated: ${new Date(score.lastUpdated).toLocaleString()}`);

        if (endorsements.length > 0) {
          console.log();
          console.log('Endorsements:');
          for (const endorsement of endorsements) {
            console.log(`- ${endorsement.from} ${(endorsement.score * 100).toFixed(0)}% ${endorsement.reason}`);
          }
        }
      } catch (err) {
        error(`Failed to show score: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
