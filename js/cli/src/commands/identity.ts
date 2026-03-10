import { Command } from 'commander';
import { getIdentity, getAgentCard } from '../config.js';
import { error, printHeader, printKeyValue } from '../ui.js';

export function registerIdentityCommand(program: Command): void {
  program
    .command('identity')
    .description('Show current identity information')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .action(async (options) => {
      try {
        const identity = getIdentity();
        const card = getAgentCard();

        if (!identity) {
          error('No identity found. Run "agent listen" to create one.');
          process.exit(1);
        }

        if (options.format === 'json') {
          console.log(JSON.stringify({
            did: identity.did,
            publicKey: identity.publicKey,
            agentCard: card || null,
          }, null, 2));
          return;
        }

        printHeader('Agent Identity');
        printKeyValue('DID', identity.did);
        printKeyValue('Public Key', identity.publicKey.substring(0, 16) + '...');

        if (card) {
          console.log();
          printKeyValue('Name', card.name);
          printKeyValue('Description', card.description);
          printKeyValue('Capabilities', card.capabilities.join(', ') || 'None');
        }

        console.log();
      } catch (err) {
        error(`Failed to show identity: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
