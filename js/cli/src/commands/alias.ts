/**
 * Alias Command - CVP-0014 Part 1
 *
 * quadra-a alias set <name> <did>    - Create or update an alias
 * quadra-a alias list                - List all aliases
 * quadra-a alias get <name>          - Show DID for an alias
 * quadra-a alias remove <name>       - Remove an alias
 */

import { Command } from 'commander';
import { validateAliasName } from '@quadra-a/protocol';
import { setAlias, getAlias, removeAlias, getAliases } from '../config.js';
import { error, llmSection, llmKeyValue, llmTable } from '../ui.js';

export function createAliasCommand(): Command {
  const alias = new Command('alias')
    .description('Manage agent aliases (CVP-0014)')
    .option('--human', 'Human-friendly output with colors');

  // quadra-a alias set <name> <did>
  alias
    .command('set <name> <did>')
    .description('Create or update an alias')
    .action(async (name: string, did: string, options) => {
      const isHuman = options.parent?.opts().human;

      try {
        const validation = validateAliasName(name);
        if (!validation.valid) {
          error(validation.error!);
          process.exit(1);
        }

        if (!did.startsWith('did:')) {
          error('Invalid DID format. Must start with "did:"');
          process.exit(1);
        }

        setAlias(name, did);

        if (isHuman) {
          console.log(`✓ Alias set: ${name} → ${did}`);
        } else {
          llmSection('Alias Set');
          llmKeyValue('Name', name);
          llmKeyValue('DID', did);
          console.log();
        }
      } catch (err) {
        error(`Failed to set alias: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // quadra-a alias list
  alias
    .command('list')
    .description('List all aliases')
    .action(async (options) => {
      const isHuman = options.parent?.opts().human;

      try {
        const aliases = getAliases();
        const entries = Object.entries(aliases);

        if (entries.length === 0) {
          if (isHuman) {
            console.log('No aliases configured.');
          } else {
            llmSection('Aliases');
            llmKeyValue('Total', '0');
            console.log();
          }
          return;
        }

        if (isHuman) {
          console.log(`\n${entries.length} alias(es):\n`);
          const maxNameLen = Math.max(...entries.map(([name]) => name.length));
          for (const [name, did] of entries) {
            const truncated = did.length > 50 ? did.substring(0, 47) + '...' : did;
            console.log(`  ${name.padEnd(maxNameLen)}  ${truncated}`);
          }
          console.log();
        } else {
          llmSection('Aliases');
          llmKeyValue('Total', entries.length.toString());
          console.log();

          const rows = entries.map(([name, did]) => [name, did]);
          llmTable(['Name', 'DID'], rows);
          console.log();
        }
      } catch (err) {
        error(`Failed to list aliases: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // quadra-a alias get <name>
  alias
    .command('get <name>')
    .description('Show DID for an alias')
    .action(async (name: string, options) => {
      const isHuman = options.parent?.opts().human;

      try {
        const did = getAlias(name);

        if (!did) {
          error(`Alias not found: ${name}`);
          process.exit(1);
        }

        if (isHuman) {
          console.log(`${name} → ${did}`);
        } else {
          llmSection('Alias');
          llmKeyValue('Name', name);
          llmKeyValue('DID', did);
          console.log();
        }
      } catch (err) {
        error(`Failed to get alias: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // quadra-a alias remove <name>
  alias
    .command('remove <name>')
    .description('Remove an alias')
    .action(async (name: string, options) => {
      const isHuman = options.parent?.opts().human;

      try {
        const removed = removeAlias(name);

        if (!removed) {
          error(`Alias not found: ${name}`);
          process.exit(1);
        }

        if (isHuman) {
          console.log(`✓ Alias removed: ${name}`);
        } else {
          llmSection('Alias Removed');
          llmKeyValue('Name', name);
          console.log();
        }
      } catch (err) {
        error(`Failed to remove alias: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return alias;
}
