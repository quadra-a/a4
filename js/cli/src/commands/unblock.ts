import { Command } from 'commander';
import { resolveTargetDid } from '../services/messaging.js';
import { unblockAgent } from '../services/trust.js';
import { error, success } from '../ui.js';

export function registerUnblockCommand(program: Command): void {
  program
    .command('unblock <target>')
    .description('Unblock a previously blocked agent')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        await unblockAgent(resolved.did);
        success(`Unblocked ${resolved.did}`);
      } catch (err) {
        error(`Failed to unblock agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
