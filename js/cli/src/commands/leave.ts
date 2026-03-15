import { Command } from 'commander';
import { stopDaemon } from '../services/daemon-control.js';
import { error, info, success } from '../ui.js';

export function registerLeaveCommand(program: Command): void {
  program
    .command('leave')
    .description('Disconnect from the network and stop the local daemon')
    .action(async () => {
      try {
        const stopped = await stopDaemon();
        if (!stopped) {
          info('Listener not running');
          return;
        }

        success('Left the network');
      } catch (err) {
        error(`Failed to leave the network: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
