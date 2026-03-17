import { Command } from 'commander';
import {
  getE2EConfig,
  getIdentity,
} from '@quadra-a/runtime';
import {
  buildPublishedDeviceDirectory,
  type LocalDeviceState,
  type LocalE2EConfig,
} from '@quadra-a/protocol';
import {
  error,
  llmKeyValue,
  llmSection,
  printHeader,
  printKeyValue,
  printSection,
} from '../ui.js';

const LOW_ONE_TIME_PREKEY_THRESHOLD = 4;
const STALE_SIGNED_PREKEY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface PrekeyWarning {
  code: 'current-device-missing' | 'low-one-time-prekeys' | 'stale-signed-prekey';
  severity: 'warning';
  deviceId?: string;
  message: string;
}

export interface LocalDevicePrekeySummary {
  current: boolean;
  deviceId: string;
  createdAt: number;
  signedPreKeyId: number;
  signedPreKeyCreatedAt: number;
  signedPreKeyAgeMs: number;
  oneTimePreKeysTotal: number;
  oneTimePreKeysRemaining: number;
  oneTimePreKeysClaimed: number;
  lastResupplyAt: number;
  sessionCount: number;
}

export interface PublishedDevicePrekeySummary {
  deviceId: string;
  signedPreKeyId: number;
  oneTimePreKeyCount: number;
  lastResupplyAt: number;
}

export interface PrekeysReport {
  available: boolean;
  currentDeviceId: string | null;
  localDeviceCount: number;
  publishedDeviceCount: number;
  warnings: PrekeyWarning[];
  localDevices: LocalDevicePrekeySummary[];
  publishedDevices: PublishedDevicePrekeySummary[];
}

function summarizeLocalDevice(
  device: LocalDeviceState,
  currentDeviceId: string,
  now: number,
): LocalDevicePrekeySummary {
  const oneTimePreKeysTotal = device.oneTimePreKeys.length;
  const oneTimePreKeysRemaining = device.oneTimePreKeys.filter((key) => !key.claimedAt).length;

  return {
    current: device.deviceId === currentDeviceId,
    deviceId: device.deviceId,
    createdAt: device.createdAt,
    signedPreKeyId: device.signedPreKey.signedPreKeyId,
    signedPreKeyCreatedAt: device.signedPreKey.createdAt,
    signedPreKeyAgeMs: Math.max(now - device.signedPreKey.createdAt, 0),
    oneTimePreKeysTotal,
    oneTimePreKeysRemaining,
    oneTimePreKeysClaimed: oneTimePreKeysTotal - oneTimePreKeysRemaining,
    lastResupplyAt: device.lastResupplyAt,
    sessionCount: Object.keys(device.sessions ?? {}).length,
  };
}

export function buildPrekeysReport(
  e2eConfig: LocalE2EConfig | undefined,
  now = Date.now(),
): PrekeysReport {
  const currentDeviceId = e2eConfig?.currentDeviceId || null;
  const localDevices = Object.values(e2eConfig?.devices ?? {})
    .map((device) => summarizeLocalDevice(device, currentDeviceId ?? '', now))
    .sort((left, right) => {
      if (left.current !== right.current) {
        return left.current ? -1 : 1;
      }
      return left.deviceId.localeCompare(right.deviceId);
    });
  const publishedDevices = e2eConfig
    ? buildPublishedDeviceDirectory(e2eConfig).map((device) => ({
        deviceId: device.deviceId,
        signedPreKeyId: device.signedPreKeyId,
        oneTimePreKeyCount: device.oneTimePreKeyCount,
        lastResupplyAt: device.lastResupplyAt,
      }))
    : [];
  const warnings: PrekeyWarning[] = [];

  if (currentDeviceId && !localDevices.some((device) => device.deviceId === currentDeviceId)) {
    warnings.push({
      code: 'current-device-missing',
      severity: 'warning',
      deviceId: currentDeviceId,
      message: `Current device ${currentDeviceId} is missing from local E2E state.`,
    });
  }

  for (const device of localDevices) {
    if (device.oneTimePreKeysRemaining <= LOW_ONE_TIME_PREKEY_THRESHOLD) {
      warnings.push({
        code: 'low-one-time-prekeys',
        severity: 'warning',
        deviceId: device.deviceId,
        message: `${device.deviceId} has ${device.oneTimePreKeysRemaining} one-time pre-keys remaining.`,
      });
    }

    if (device.signedPreKeyAgeMs >= STALE_SIGNED_PREKEY_AGE_MS) {
      warnings.push({
        code: 'stale-signed-prekey',
        severity: 'warning',
        deviceId: device.deviceId,
        message: `${device.deviceId} signed pre-key is ${formatAge(device.signedPreKeyAgeMs)} old.`,
      });
    }
  }

  return {
    available: Boolean(currentDeviceId && localDevices.length > 0),
    currentDeviceId,
    localDeviceCount: localDevices.length,
    publishedDeviceCount: publishedDevices.length,
    warnings,
    localDevices,
    publishedDevices,
  };
}

function formatAge(ageMs: number): string {
  const totalSeconds = Math.max(Math.floor(ageMs / 1000), 0);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h`;
  }

  return `${Math.floor(totalHours / 24)}d`;
}

function formatTimestamp(timestampMs: number): string {
  if (!timestampMs) {
    return 'unknown';
  }

  return new Date(timestampMs).toISOString();
}

function renderTextReport(report: PrekeysReport): void {
  printHeader('Pre-Key Health');
  printKeyValue('Current Device', report.currentDeviceId ?? 'None');
  printKeyValue('Local Devices', String(report.localDeviceCount));
  printKeyValue('Published Devices', String(report.publishedDeviceCount));
  printKeyValue('Warnings', String(report.warnings.length));

  if (report.warnings.length > 0) {
    printSection('Warnings');
    for (const warning of report.warnings) {
      printKeyValue(
        warning.deviceId ?? warning.code,
        `[${warning.severity}] ${warning.message}`,
      );
    }
  }

  printSection('Local Devices');
  if (report.localDevices.length === 0) {
    printKeyValue('State', 'No local E2E devices');
  } else {
    for (const device of report.localDevices) {
      console.log();
      printKeyValue('Device', `${device.deviceId}${device.current ? ' (current)' : ''}`);
      printKeyValue(
        '  Signed Pre-Key',
        `#${device.signedPreKeyId} created ${formatTimestamp(device.signedPreKeyCreatedAt)} (${formatAge(device.signedPreKeyAgeMs)} old)`,
      );
      printKeyValue(
        '  One-Time Pre-Keys',
        `${device.oneTimePreKeysRemaining}/${device.oneTimePreKeysTotal} remaining (${device.oneTimePreKeysClaimed} claimed)`,
      );
      printKeyValue('  Sessions', String(device.sessionCount));
      printKeyValue('  Device Created', formatTimestamp(device.createdAt));
      printKeyValue('  Last Resupply', formatTimestamp(device.lastResupplyAt));
    }
  }

  printSection('Published Device Directory');
  if (report.publishedDevices.length === 0) {
    printKeyValue('State', 'No published device directory entries');
    return;
  }

  for (const device of report.publishedDevices) {
    console.log();
    printKeyValue('Device', device.deviceId);
    printKeyValue('  Signed Pre-Key', `#${device.signedPreKeyId}`);
    printKeyValue('  One-Time Pre-Keys', String(device.oneTimePreKeyCount));
    printKeyValue('  Last Resupply', formatTimestamp(device.lastResupplyAt));
  }
}

function renderLlmReport(report: PrekeysReport): void {
  llmSection('Pre-Key Health');
  llmKeyValue('Current Device', report.currentDeviceId ?? '(none)');
  llmKeyValue('Local Devices', String(report.localDeviceCount));
  llmKeyValue('Published Devices', String(report.publishedDeviceCount));
  llmKeyValue('Warnings', String(report.warnings.length));

  if (report.warnings.length > 0) {
    console.log();
    llmKeyValue('Warnings', '');
    for (const warning of report.warnings) {
      llmKeyValue(
        `  ${warning.deviceId ?? warning.code}`,
        `[${warning.severity}] ${warning.message}`,
      );
    }
  }

  console.log();
  llmKeyValue('Local Devices', '');
  if (report.localDevices.length === 0) {
    llmKeyValue('  State', 'none');
  } else {
    for (const device of report.localDevices) {
      llmKeyValue('  Device', `${device.deviceId}${device.current ? ' (current)' : ''}`);
      llmKeyValue('    Signed Pre-Key', `#${device.signedPreKeyId}`);
      llmKeyValue('    Signed Pre-Key Age', formatAge(device.signedPreKeyAgeMs));
      llmKeyValue('    One-Time Pre-Keys Remaining', String(device.oneTimePreKeysRemaining));
      llmKeyValue('    One-Time Pre-Keys Total', String(device.oneTimePreKeysTotal));
      llmKeyValue('    Sessions', String(device.sessionCount));
      llmKeyValue('    Last Resupply', formatTimestamp(device.lastResupplyAt));
    }
  }

  console.log();
  llmKeyValue('Published Device Directory', '');
  if (report.publishedDevices.length === 0) {
    llmKeyValue('  State', 'none');
    return;
  }

  for (const device of report.publishedDevices) {
    llmKeyValue('  Device', device.deviceId);
    llmKeyValue('    Signed Pre-Key', `#${device.signedPreKeyId}`);
    llmKeyValue('    One-Time Pre-Keys', String(device.oneTimePreKeyCount));
    llmKeyValue('    Last Resupply', formatTimestamp(device.lastResupplyAt));
  }
}

export function registerPrekeysCommand(program: Command): void {
  program
    .command('prekeys')
    .description('Show E2E pre-key and device-directory health')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .action(async (options) => {
      try {
        if (options.json) {
          options.format = 'json';
        }

        const identity = getIdentity();
        if (!identity) {
          error('No identity found. Run "a4 listen" to initialize.');
          process.exit(1);
        }

        const report = buildPrekeysReport(getE2EConfig());

        if (options.format === 'json') {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        if (options.format === 'text') {
          renderTextReport(report);
          return;
        }

        if (options.format === 'llm') {
          renderLlmReport(report);
          return;
        }

        throw new Error(`Unsupported format "${options.format}". Use text or json.`);
      } catch (err) {
        error(`Failed to show pre-key health: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
