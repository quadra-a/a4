import { Command } from 'commander';
import { getIdentity } from '../config.js';
import { error, printHeader, printKeyValue } from '../ui.js';

export function registerIdentityCommand(program: Command): void {
  const identity = program
    .command('identity')
    .description('Manage identity information');

  identity
    .command('show')
    .description('Show current identity information')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .action(async (options) => {
      try {
        if (options.json) options.format = 'json';
        const currentIdentity = getIdentity();

        if (!currentIdentity) {
          error('No identity found. Run "agent listen" to create one.');
          process.exit(1);
        }

        if (options.format === 'json') {
          console.log(JSON.stringify({
            did: currentIdentity.did,
            publicKey: currentIdentity.publicKey,
          }, null, 2));
          return;
        }

        printHeader('Agent Identity');
        printKeyValue('DID', currentIdentity.did);
        printKeyValue('Public Key', currentIdentity.publicKey.substring(0, 16) + '...');

        console.log();
      } catch (err) {
        error(`Failed to show identity: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
