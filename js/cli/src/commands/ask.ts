import { Command } from 'commander';

export function registerAskCommand(program: Command): void {
  program
    .command('ask [target] [message]', { hidden: true })
    .description('Removed command')
    .action(() => {
      console.error('Error: "ask" has been removed. Use: agent tell <target> <message> --wait');
      process.exit(1);
    });
}
