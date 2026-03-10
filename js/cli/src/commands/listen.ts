import { Command } from 'commander';
import {
  ensureBackgroundListener,
  prepareListenerState,
  runDaemonForeground,
  stopDaemon,
} from '../services/daemon-control.js';
import { error, info, success } from '../ui.js';

export function registerListenCommand(program: Command): void {
  program
    .command('listen')
    .description('Start the local daemon and stay online')
    .option('--background', 'Run the listener in the background')
    .option('--relay <url>', 'Relay WebSocket URL (e.g. ws://localhost:8080)')
    .option('--token <token>', 'Invite token for private relays')
    .option('--discoverable', 'Make agent discoverable in the network (requires --name and --description)')
    .option('--name <name>', 'Agent name (required with --discoverable)')
    .option('--description <description>', 'Agent description (required with --discoverable)')
    .option('--capabilities <list>', 'Comma-separated capabilities (optional with --discoverable)')
    .action(async (options) => {
      try {
        const listenerOptions = {
          relay: options.relay,
          token: options.token,
          discoverable: options.discoverable,
          name: options.name,
          description: options.description,
          capabilities: options.capabilities,
        };

        if (options.background) {
          const result = await ensureBackgroundListener(listenerOptions);

          if (result.action === 'restarted') {
            success('Agent listener restarted in background');
          } else if (result.action === 'already_running') {
            success('Agent already listening');
          } else {
            success('Agent now listening in background');
          }

          info(`DID: ${result.did}`);
          if (result.createdIdentity) {
            info('Identity created automatically');
          }
          if (options.discoverable) {
            info('Discovery mode: discoverable');
          }
          return;
        }

        const state = await prepareListenerState(listenerOptions);

        if (state.daemonRunning) {
          if (!state.shouldRestart) {
            success('Agent already listening');
            if (state.daemonStatus?.did) {
              info(`DID: ${state.daemonStatus.did}`);
            }
            return;
          }
          await stopDaemon();
        }

        if (state.createdIdentity) {
          info('Identity created automatically');
        }
        await runDaemonForeground();
      } catch (err) {
        error(`Failed to start listener: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
