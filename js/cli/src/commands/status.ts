import { Command } from 'commander';
import { DaemonClient, getDaemonStatus } from '@quadra-a/runtime';
import { getIdentity, getAgentCard, isPublished } from '../config.js';
import { error, printHeader, printKeyValue, printSection, llmSection, llmKeyValue } from '../ui.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current status')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--human', 'Human-friendly output with colors')
    .action(async (options) => {
      try {
        const identity = getIdentity();
        const card = getAgentCard();
        const published = isPublished();
        const daemonRunning = await new DaemonClient().isDaemonRunning();
        const daemon = daemonRunning ? await getDaemonStatus() : null;

        if (!identity) {
          error('No identity configured. Run "agent listen" to create one.');
          process.exit(1);
        }

        if (options.format === 'json') {
          console.log(JSON.stringify({
            identity: {
              did: identity.did,
              publicKey: identity.publicKey,
            },
            agentCard: card || null,
            published,
            daemon: daemon ?? null,
          }, null, 2));
          return;
        }

        const isHuman = options.human;

        if (isHuman) {
          printHeader('Agent Status');

          printSection('Identity');
          printKeyValue('DID', identity.did);
          printKeyValue('Public Key', identity.publicKey.substring(0, 16) + '...');
          printKeyValue('Discovery Status', published ? 'Discoverable' : 'Anonymous');

          printSection('Runtime');
          printKeyValue('Daemon', daemonRunning ? 'Running' : 'Stopped');
          printKeyValue('Reply Wait', daemonRunning ? 'Available' : 'Unavailable');
          if (daemon) {
            printKeyValue('Connected Relays', daemon.connectedRelays.join(', ') || 'None');
            printKeyValue('Known Relays', daemon.knownRelays?.join(', ') || 'None');
            printKeyValue('Peer Count', String(daemon.peerCount));
            if (daemon.reachabilityPolicy) {
              printKeyValue('Reachability Mode', daemon.reachabilityPolicy.mode);
              printKeyValue('Target Providers', String(daemon.reachabilityPolicy.targetProviderCount));
              printKeyValue('Auto Discovery', daemon.reachabilityPolicy.autoDiscoverProviders ? 'Enabled' : 'Disabled');
              printKeyValue('Operator Lock', daemon.reachabilityPolicy.operatorLock ? 'Enabled' : 'Disabled');
            }
          }

          if (card) {
            printSection('Agent Card');
            printKeyValue('Name', card.name);
            printKeyValue('Description', card.description);
            printKeyValue('Capabilities', card.capabilities.join(', ') || 'None');
          }

          console.log();
        } else {
          // LLM-friendly format
          llmSection('Agent Status');

          llmKeyValue('Identity', '');
          llmKeyValue('  DID', identity.did);
          llmKeyValue('  Public Key', identity.publicKey);
          llmKeyValue('  Discovery Status', published ? 'discoverable' : 'anonymous');
          console.log();
          llmKeyValue('Runtime', '');
          llmKeyValue('  Daemon', daemonRunning ? 'running' : 'stopped');
          llmKeyValue('  Reply Wait', daemonRunning ? 'available' : 'unavailable');
          if (daemon) {
            llmKeyValue('  Connected Relays', daemon.connectedRelays.join(', ') || '(none)');
            llmKeyValue('  Known Relays', daemon.knownRelays?.join(', ') || '(none)');
            llmKeyValue('  Peer Count', String(daemon.peerCount));
            if (daemon.reachabilityPolicy) {
              llmKeyValue('  Reachability Mode', daemon.reachabilityPolicy.mode);
              llmKeyValue('  Target Providers', String(daemon.reachabilityPolicy.targetProviderCount));
              llmKeyValue('  Auto Discovery', daemon.reachabilityPolicy.autoDiscoverProviders ? 'enabled' : 'disabled');
              llmKeyValue('  Operator Lock', daemon.reachabilityPolicy.operatorLock ? 'enabled' : 'disabled');
            }
          }

          if (card) {
            console.log();
            llmKeyValue('Agent Card', '');
            llmKeyValue('  Name', card.name);
            llmKeyValue('  Description', card.description);
            llmKeyValue('  Capabilities', card.capabilities.join(', ') || '(none)');
          }

          console.log();
        }
      } catch (err) {
        error(`Failed to show status: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
