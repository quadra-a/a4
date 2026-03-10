import { Command } from 'commander';
import { getAgentCard, setAgentCard } from '../config.js';
import { success, error, printHeader } from '../ui.js';
import inquirer from 'inquirer';

export function registerCardCommand(program: Command): void {
  const card = program.command('card').description('Manage Agent Card');

  card
    .command('show')
    .description('Show current Agent Card')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .action(async (options) => {
      try {
        const agentCard = getAgentCard();

        if (!agentCard) {
          error('No Agent Card found. Run "agent listen" to create one.');
          process.exit(1);
        }

        if (options.format === 'json') {
          console.log(JSON.stringify(agentCard, null, 2));
          return;
        }

        printHeader('Agent Card');
        console.log(JSON.stringify(agentCard, null, 2));
      } catch (err) {
        error(`Failed to show card: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  card
    .command('edit')
    .description('Edit Agent Card')
    .option('--name <name>', 'Agent name')
    .option('--description <description>', 'Agent description')
    .option('--capabilities <capabilities>', 'Capabilities (comma-separated)')
    .action(async (options) => {
      try {
        printHeader('Edit Agent Card');

        const currentCard = getAgentCard();

        if (!currentCard) {
          error('No Agent Card found. Run "agent listen" to create one.');
          process.exit(1);
        }

        let updatedCard;

        // If any options provided, use non-interactive mode
        if (options.name || options.description || options.capabilities) {
          updatedCard = {
            name: options.name || currentCard.name,
            description: options.description || currentCard.description,
            capabilities: options.capabilities
              ? options.capabilities.split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 0)
              : currentCard.capabilities,
          };
        } else {
          // Interactive mode
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Agent name:',
              default: currentCard.name,
            },
            {
              type: 'input',
              name: 'description',
              message: 'Agent description:',
              default: currentCard.description,
            },
            {
              type: 'input',
              name: 'capabilities',
              message: 'Capabilities (comma-separated):',
              default: currentCard.capabilities.join(', '),
            },
          ]);

          updatedCard = {
            name: answers.name,
            description: answers.description,
            capabilities: answers.capabilities
              .split(',')
              .map((c: string) => c.trim())
              .filter((c: string) => c.length > 0),
          };
        }

        setAgentCard(updatedCard);

        success('Agent Card updated successfully!');
      } catch (err) {
        error(`Failed to edit card: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
