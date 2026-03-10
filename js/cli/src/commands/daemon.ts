import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import {
  getDaemonStatus,
  restartDaemon,
  runDaemonForeground,
  startDaemonInBackground,
  stopDaemon,
} from '../services/daemon-control.js';
import { error, info, success } from '../ui.js';

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Legacy daemon management commands')
    .configureHelp({ visibleCommands: () => [] });

  daemon
    .command('start')
    .description('Start daemon in background')
    .action(async () => {
      try {
        const result = await startDaemonInBackground(process.argv[1]);
        success(result.status === 'already_running' ? 'Daemon already running' : 'Daemon started');
        info(`DID: ${result.did}`);
      } catch (err) {
        error(`Failed to start daemon: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  daemon
    .command('run')
    .description('Run daemon in foreground (internal use)')
    .action(async () => {
      try {
        await runDaemonForeground();
      } catch (err) {
        error(`Failed to run daemon: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  daemon
    .command('stop')
    .description('Stop daemon')
    .action(async () => {
      try {
        const stopped = await stopDaemon();
        if (!stopped) {
          info('Daemon not running');
          return;
        }
        success('Daemon stopped');
      } catch (err) {
        error(`Failed to stop daemon: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  daemon
    .command('status')
    .description('Check daemon status')
    .action(async () => {
      try {
        const status = await getDaemonStatus();
        success('Daemon running');
        info(`DID: ${status.did}`);
        info(`Relays: ${(status.connectedRelays ?? []).join(', ') || '(none)'}`);
        info(`Known Relays: ${(status.knownRelays ?? []).join(', ') || '(none)'}`);
        info(`Peers: ${status.peerCount ?? 0}`);
        if (status.reachabilityPolicy) {
          info(`Reachability: ${status.reachabilityPolicy.mode} / target=${status.reachabilityPolicy.targetProviderCount}`);
        }
      } catch {
        info('Daemon not running');
        info('Start daemon with: agent listen --background');
      }
    });

  daemon
    .command('restart')
    .description('Restart daemon')
    .action(async () => {
      try {
        const result = await restartDaemon(process.argv[1]);
        success('Daemon restarted');
        info(`DID: ${result.did}`);
      } catch (err) {
        error(`Failed to restart daemon: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  daemon
    .command('install')
    .description('Install daemon as a system service (survives reboots)')
    .action(async () => {
      try {
        const binPath = process.argv[1];
        const os = platform();

        if (os === 'darwin') {
          const plistDir = join(homedir(), 'Library', 'LaunchAgents');
          const plistPath = join(plistDir, 'com.quadra-a.daemon.plist');
          mkdirSync(plistDir, { recursive: true });

          const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.quadra-a.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binPath}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.quadra-a', 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.quadra-a', 'daemon.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
</dict>
</plist>`;

          writeFileSync(plistPath, plist, 'utf-8');
          success(`LaunchAgent installed: ${plistPath}`);
          info(`Activate with: launchctl load ${plistPath}`);
          return;
        }

        if (os === 'linux') {
          const systemdDir = join(homedir(), '.config', 'systemd', 'user');
          const servicePath = join(systemdDir, 'quadra-a-daemon.service');
          mkdirSync(systemdDir, { recursive: true });

          const service = `[Unit]
Description=quadra-a Agent Daemon
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${binPath} daemon run
Restart=on-failure
RestartSec=5
StandardOutput=append:${join(homedir(), '.quadra-a', 'daemon.log')}
StandardError=append:${join(homedir(), '.quadra-a', 'daemon.log')}
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;

          writeFileSync(servicePath, service, 'utf-8');
          success(`systemd user service installed: ${servicePath}`);
          info('Activate with: systemctl --user daemon-reload && systemctl --user enable --now quadra-a-daemon');
          return;
        }

        throw new Error(`Unsupported platform: ${os}`);
      } catch (err) {
        error(`Failed to install daemon service: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
