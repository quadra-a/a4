import { Command } from 'commander';
import { publishAgentCard } from '../services/agent-runtime.js';
import { setPublished } from '../config.js';
import { error, info, success } from '../ui.js';

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publish your local Agent Card for discovery')
    .option('--name <name>', 'Override the published agent name')
    .option('--description <description>', 'Override the published description')
    .option('--capabilities <list>', 'Comma-separated capabilities to publish')
    .option('--relay <url>', 'Relay WebSocket URL')
    .action(async (options) => {
      try {
        const capabilities = options.capabilities
          ? options.capabilities.split(',').map((capability: string) => capability.trim()).filter(Boolean)
          : undefined;

        const result = await publishAgentCard({
          relay: options.relay,
          name: options.name,
          description: options.description,
          capabilities,
        });

        setPublished(true); // Mark as published after successful publication

        success('Agent Card published');
        info(`DID: ${result.did}`);
      } catch (err) {
        error(`Failed to publish Agent Card: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
