import { Command } from 'commander';
import { unpublishAgentCard } from '../services/agent-runtime.js';
import { setPublished } from '../config.js';
import { error, success } from '../ui.js';

export function registerUnpublishCommand(program: Command): void {
  program
    .command('unpublish')
    .description('Remove your Agent Card from discovery')
    .option('--relay <url>', 'Relay WebSocket URL')
    .action(async (options) => {
      try {
        await unpublishAgentCard({ relay: options.relay });
        setPublished(false); // Mark as unpublished after successful removal
        success('Agent Card unpublished');
      } catch (err) {
        error(`Failed to unpublish Agent Card: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
