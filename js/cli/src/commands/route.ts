import { Command } from 'commander';

export function registerRouteCommand(program: Command): void {
  program
    .command('route [capability] [message]', { hidden: true })
    .description('Removed command')
    .action(() => {
      console.error('Error: "route" has been removed. Use: agent find <capability>, then agent tell <target> <message>');
      process.exit(1);
    });
}
