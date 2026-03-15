#!/usr/bin/env node

if (!Promise.withResolvers) {
  Promise.withResolvers = function <T>() {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve: resolve!, reject: reject! };
  };
}

import { basename } from 'node:path';
import { Command } from 'commander';
import { createRequire } from 'module';
import { registerFindCommand } from './commands/find.js';
import { registerAskCommand } from './commands/ask.js';
import { registerTellCommand } from './commands/tell.js';
import { registerRouteCommand } from './commands/route.js';
import { registerStatusCommand } from './commands/status.js';
import { registerIdentityCommand } from './commands/identity.js';
import { registerCardCommand } from './commands/card.js';
import { createTrustCommand } from './commands/trust.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { createInboxCommand } from './commands/inbox.js';
import { registerStopCommand } from './commands/stop.js';
import { registerServeCommand } from './commands/serve.js';
import { registerPeersCommand } from './commands/peers.js';
import { createAliasCommand } from './commands/alias.js';
import { createSessionsCommand } from './commands/sessions.js';
import { registerScoreCommand } from './commands/score.js';
import { registerVouchCommand } from './commands/vouch.js';
import { registerEndorsementsCommand } from './commands/endorsements.js';
import { registerBlockCommand } from './commands/block.js';
import { registerUnblockCommand } from './commands/unblock.js';
import { registerListenCommand } from './commands/listen.js';
import { registerLeaveCommand } from './commands/leave.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerUnpublishCommand } from './commands/unpublish.js';
import { registerTraceCommand } from './commands/trace.js';
import { registerReachabilityCommand } from './commands/reachability.js';
import { registerE2ECommand } from './commands/e2e.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();
const invokedAs = basename(process.argv[1] ?? 'a4');
const binName = invokedAs === 'a4' ? invokedAs : 'a4';

program
  .name(binName)
  .description('quadra-a CLI for decentralized agent discovery and messaging')
  .version(version)
  .showHelpAfterError();

registerFindCommand(program);
registerAskCommand(program);
registerTellCommand(program);
registerRouteCommand(program);
registerScoreCommand(program);
registerVouchCommand(program);
registerEndorsementsCommand(program);
registerBlockCommand(program);
registerUnblockCommand(program);
registerListenCommand(program);
registerLeaveCommand(program);
registerPublishCommand(program);
registerUnpublishCommand(program);
registerTraceCommand(program);
registerReachabilityCommand(program);
registerE2ECommand(program);
registerStopCommand(program);
registerServeCommand(program);
registerPeersCommand(program);
registerStatusCommand(program);
registerIdentityCommand(program);
registerCardCommand(program);
program.addCommand(createInboxCommand());
program.addCommand(createAliasCommand());
program.addCommand(createSessionsCommand());

registerDaemonCommand(program);
program.addCommand(createTrustCommand(), { hidden: true });

program.parse();
