import { Command } from 'commander';
import { resolveTargetDid } from '../services/messaging.js';
import { endorseAgent } from '../services/trust.js';
import { error, info, printHeader, success } from '../ui.js';

export function registerVouchCommand(program: Command): void {
  program
    .command('vouch <target>')
    .description('Create a signed endorsement for an agent')
    .option('--score <score>', 'Endorsement score (0-1)', '0.8')
    .option('--reason <reason>', 'Reason for endorsement', 'Good collaboration')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const numericScore = parseFloat(options.score);

        if (Number.isNaN(numericScore) || numericScore < 0 || numericScore > 1) {
          throw new Error('Score must be between 0 and 1');
        }

        const endorsement = await endorseAgent(resolved.did, numericScore, options.reason);

        printHeader('Endorsement Created');
        success(`Vouched for ${resolved.did}`);
        info(`Score: ${(endorsement.score * 100).toFixed(0)}%`);
        info(`Reason: ${endorsement.reason}`);
      } catch (err) {
        error(`Failed to vouch for agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
