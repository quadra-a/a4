import { Command } from 'commander';
import { generateKeyPair, exportKeyPair, deriveDID } from '@quadra-a/protocol';
import { hasIdentity, setIdentity, setAgentCard, setPublished } from '../config.js';
import { success, error, spinner, printHeader, printKeyValue, info } from '../ui.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new agent identity')
    .option('--name <name>', 'Agent name', 'My Agent')
    .option('--description <description>', 'Agent description', 'A quadra-a agent')
    .option('--force', 'Overwrite existing identity')
    .action(async (options) => {
      try {
        // Show deprecation warning
        console.log();
        info('⚠️  DEPRECATION WARNING: The "init" command is deprecated.');
        info('   Use "agent listen" instead - it will automatically create an identity if needed.');
        info('   For discoverable agents: "agent listen --discoverable --name "..." --description "..."');
        console.log();

        printHeader('Initialize Agent Identity');

        if (hasIdentity() && !options.force) {
          error('Identity already exists. Use --force to overwrite.');
          process.exit(1);
        }

        const spin = spinner('Generating key pair...');

        const keyPair = await generateKeyPair();
        const exported = exportKeyPair(keyPair);
        const did = deriveDID(keyPair.publicKey);

        setIdentity({
          did,
          publicKey: exported.publicKey,
          privateKey: exported.privateKey,
        });

        setAgentCard({
          name: options.name,
          description: options.description,
          capabilities: [],
        });

        setPublished(false); // Not published by default

        spin.succeed('Identity created successfully!');

        console.log();
        printKeyValue('DID', did);
        printKeyValue('Name', options.name);
        printKeyValue('Description', options.description);
        console.log();

        success('Run "agent listen" to connect to the network');
      } catch (err) {
        error(`Failed to initialize: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
