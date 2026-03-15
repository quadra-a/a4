import { Command } from 'commander';
import { stopDaemon } from '../services/daemon-control.js';
import { error, info, success } from '../ui.js';

export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Stop the local daemon')
    .action(async () => {
      try {
        const stopped = await stopDaemon();
        if (!stopped) {
          info('Listener not running');
          return;
        }

        success('Listener stopped');
      } catch (err) {
        error(`Failed to stop listener: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
