import { Command } from 'commander';
import {
  DaemonClient,
  ensurePersistedE2EConfig,
  getAlias,
  getIdentity,
  setE2EConfig,
} from '@quadra-a/runtime';
import type { LocalE2EConfig } from '@quadra-a/protocol';
import { error, info, printHeader, printKeyValue, success, warn } from '../ui.js';

function sessionPeerDid(sessionKey: string): string | undefined {
  const delimiter = sessionKey.lastIndexOf(':');
  if (delimiter <= 0) {
    return undefined;
  }

  return sessionKey.slice(0, delimiter) || undefined;
}

function collectResetPeers(sessionKeys: string[], onlyPeer?: string): string[] {
  const peers = new Set<string>();
  const exactPrefix = onlyPeer ? `${onlyPeer}:` : undefined;

  for (const sessionKey of sessionKeys) {
    if (exactPrefix && !sessionKey.startsWith(exactPrefix)) {
      continue;
    }

    const peerDid = sessionPeerDid(sessionKey);
    if (peerDid) {
      peers.add(peerDid);
    }
  }

  return [...peers].sort();
}

function isValidLocalE2EConfig(config: LocalE2EConfig | undefined): config is LocalE2EConfig {
  return Boolean(config?.currentDeviceId && config.devices?.[config.currentDeviceId]);
}

export function registerE2ECommand(program: Command): void {
  const e2e = program
    .command('e2e')
    .description('Manage local E2E session state');

  e2e
    .command('status')
    .description('Show E2E session status')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const identity = getIdentity();
        if (!identity) {
          error('No identity found. Run "a4 listen" to initialize.');
          process.exit(1);
        }

        const { e2eConfig } = await ensurePersistedE2EConfig(identity);
        const currentDevice = e2eConfig.devices[e2eConfig.currentDeviceId];
        if (!currentDevice) {
          error('Current device not found in E2E config.');
          process.exit(1);
        }

        const sessions = Object.keys(currentDevice.sessions ?? {}).map((key) => ({
          key,
          peer: sessionPeerDid(key) ?? 'unknown',
        }));

        if (options.json) {
          console.log(JSON.stringify({
            deviceId: e2eConfig.currentDeviceId,
            sessionCount: sessions.length,
            sessions,
          }, null, 2));
          return;
        }

        printHeader('E2E Status');
        printKeyValue('Device ID', e2eConfig.currentDeviceId);
        printKeyValue('Sessions', String(sessions.length));

        if (sessions.length > 0) {
          console.log();
          for (const session of sessions) {
            printKeyValue(session.peer, session.key);
          }
        }
      } catch (err) {
        error(`Failed to show E2E status: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  e2e
    .command('reset [peer]')
    .description('Clear E2E sessions for one peer or all peers')
    .action(async (peer?: string) => {
      try {
        const identity = getIdentity();
        if (!identity) {
          error('No identity found. Run "a4 listen" to initialize.');
          process.exit(1);
        }

        const resolvedPeer = peer ? (getAlias(peer) ?? peer) : undefined;
        const { e2eConfig } = await ensurePersistedE2EConfig(identity);

        if (!isValidLocalE2EConfig(e2eConfig)) {
          error('Invalid E2E configuration. Run "a4 listen" to reinitialize.');
          process.exit(1);
        }

        const currentDeviceId = e2eConfig.currentDeviceId;
        const currentDevice = e2eConfig.devices[currentDeviceId];
        const currentSessions = currentDevice.sessions ?? {};
        const sessionKeys = Object.keys(currentSessions);
        const peersToNotify = collectResetPeers(sessionKeys, resolvedPeer);

        const nextSessions = resolvedPeer
          ? Object.fromEntries(
            Object.entries(currentSessions).filter(([sessionKey]) => !sessionKey.startsWith(`${resolvedPeer}:`)),
          )
          : {};
        const removedCount = sessionKeys.length - Object.keys(nextSessions).length;

        setE2EConfig({
          ...e2eConfig,
          devices: {
            ...e2eConfig.devices,
            [currentDeviceId]: {
              ...currentDevice,
              sessions: nextSessions,
            },
          },
        });

        if (resolvedPeer) {
          success(`Cleared ${removedCount} session(s) for peer ${resolvedPeer}`);
        } else {
          success(`Cleared all ${removedCount} session(s)`);
        }

        const client = new DaemonClient();
        if (await client.isDaemonRunning()) {
          try {
            await client.send('reload-e2e', {});
            info('Daemon E2E config reloaded.');
          } catch {
            warn('Daemon not responding. Changes will apply on next daemon start.');
          }

          if (peersToNotify.length > 0) {
            try {
              const result = await client.send<{
                notified?: string[];
                failed?: Array<{ peer: string; error: string }>;
              }>('e2e-reset-notify', { peers: peersToNotify });
              const notified = result.notified?.length ?? 0;
              const failed = result.failed?.length ?? 0;
              info(
                `Sent session reset notification to ${notified} peer(s)${
                  failed > 0 ? ` (${failed} failed)` : ''
                }.`,
              );
            } catch {
              warn('Could not notify peer(s) about the reset. Remote sessions will recover on next decrypt failure.');
            }
          }
        } else if (peersToNotify.length > 0) {
          warn('Daemon is not running, so peers were not notified about the reset. Remote sessions will recover on next decrypt failure.');
        }
      } catch (err) {
        error(`Failed to reset E2E sessions: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
