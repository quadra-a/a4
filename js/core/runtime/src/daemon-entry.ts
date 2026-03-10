import { runDaemonForeground } from './daemon-control.js';

void runDaemonForeground().catch((error) => {
  console.error(`Failed to start quadra-a daemon: ${(error as Error).message}`);
  process.exit(1);
});
