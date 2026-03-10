import { Command } from 'commander';
import { resolveTargetDid } from '../services/messaging.js';
import { blockAgent } from '../services/trust.js';
import { error, success } from '../ui.js';

export function registerBlockCommand(program: Command): void {
  program
    .command('block <target>')
    .description('Block an agent from sending you messages')
    .option('--reason <reason>', 'Reason for blocking', 'Blocked by user')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        await blockAgent(resolved.did, options.reason);
        success(`Blocked ${resolved.did}`);
      } catch (err) {
        error(`Failed to block agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
