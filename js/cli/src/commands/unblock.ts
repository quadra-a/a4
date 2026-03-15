import { Command } from 'commander';
import { resolveTargetDid } from '../services/messaging.js';
import { unblockAgent } from '../services/trust.js';
import { error, success, info } from '../ui.js';

export function registerUnblockCommand(program: Command): void {
  program
    .command('unblock <target>')
    .description('Unblock a previously blocked agent')
    .option('--keep-history', 'Preserve interaction history (by default, history is reset to prevent auto-re-blocking)')
    .option('--relay <url>', 'Relay WebSocket URL for resolving non-alias targets')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const resetTrust = !options.keepHistory;
        await unblockAgent(resolved.did, resetTrust);
        success(`Unblocked ${resolved.did}`);
        if (resetTrust) {
          info('Interaction history reset (use --keep-history to preserve)');
        }
      } catch (err) {
        error(`Failed to unblock agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
