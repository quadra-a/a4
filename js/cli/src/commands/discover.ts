import { Command } from 'commander';
import { createFindCommand } from './find.js';

export function registerDiscoverCommand(program: Command): void {
  program.addCommand(createFindCommand({
    name: 'discover',
    hidden: true,
    description: 'Legacy alias for find',
  }));
}
