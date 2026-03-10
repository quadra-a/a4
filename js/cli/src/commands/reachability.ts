import { Command } from 'commander';
import {
  DaemonClient,
  getDaemonReachabilityPolicy,
  getDaemonReachabilityStatus,
  getReachabilityPolicy,
  resetDaemonReachabilityPolicy,
  resetReachabilityPolicy,
  setDaemonReachabilityPolicy,
  updateReachabilityPolicy,
  type ReachabilityMode,
  type ReachabilityPolicy,
  type ReachabilityStatus,
} from '@quadra-a/runtime';
import { error, printHeader, printKeyValue, printSection, success } from '../ui.js';

function bootstrapFromInput(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

async function daemonRunning(): Promise<boolean> {
  return new DaemonClient().isDaemonRunning();
}

async function readPolicyAndStatus(): Promise<{ policy: ReachabilityPolicy; status: ReachabilityStatus }> {
  if (await daemonRunning()) {
    const [policyResponse, status] = await Promise.all([
      getDaemonReachabilityPolicy(),
      getDaemonReachabilityStatus(),
    ]);

    return {
      policy: policyResponse.policy,
      status,
    };
  }

  const policy = getReachabilityPolicy();
  return {
    policy,
    status: {
      connectedProviders: [],
      knownProviders: policy.bootstrapProviders,
      lastDiscoveryAt: null,
      providerFailures: [],
      targetProviderCount: policy.targetProviderCount,
      mode: policy.mode,
      autoDiscoverProviders: policy.autoDiscoverProviders,
      operatorLock: policy.operatorLock,
      bootstrapProviders: policy.bootstrapProviders,
    },
  };
}

async function applyPatch(patch: Partial<ReachabilityPolicy>): Promise<{ policy: ReachabilityPolicy; status: ReachabilityStatus }> {
  if (await daemonRunning()) {
    return setDaemonReachabilityPolicy(patch);
  }

  const policy = updateReachabilityPolicy(patch);
  return {
    policy,
    status: {
      connectedProviders: [],
      knownProviders: policy.bootstrapProviders,
      lastDiscoveryAt: null,
      providerFailures: [],
      targetProviderCount: policy.targetProviderCount,
      mode: policy.mode,
      autoDiscoverProviders: policy.autoDiscoverProviders,
      operatorLock: policy.operatorLock,
      bootstrapProviders: policy.bootstrapProviders,
    },
  };
}

async function resetPolicy(): Promise<{ policy: ReachabilityPolicy; status: ReachabilityStatus }> {
  if (await daemonRunning()) {
    return resetDaemonReachabilityPolicy();
  }

  const policy = resetReachabilityPolicy();
  return {
    policy,
    status: {
      connectedProviders: [],
      knownProviders: policy.bootstrapProviders,
      lastDiscoveryAt: null,
      providerFailures: [],
      targetProviderCount: policy.targetProviderCount,
      mode: policy.mode,
      autoDiscoverProviders: policy.autoDiscoverProviders,
      operatorLock: policy.operatorLock,
      bootstrapProviders: policy.bootstrapProviders,
    },
  };
}

function printPolicy(policy: ReachabilityPolicy, status: ReachabilityStatus): void {
  printHeader('Reachability Policy');

  printSection('Policy');
  printKeyValue('Mode', policy.mode);
  printKeyValue('Bootstrap Providers', policy.bootstrapProviders.join(', ') || '(none)');
  printKeyValue('Target Provider Count', String(policy.targetProviderCount));
  printKeyValue('Auto Discovery', policy.autoDiscoverProviders ? 'enabled' : 'disabled');
  printKeyValue('Operator Lock', policy.operatorLock ? 'enabled' : 'disabled');

  printSection('Status');
  printKeyValue('Connected Providers', status.connectedProviders.join(', ') || '(none)');
  printKeyValue('Known Providers', status.knownProviders.join(', ') || '(none)');
  printKeyValue('Last Discovery', status.lastDiscoveryAt ? new Date(status.lastDiscoveryAt).toISOString() : '(never)');
  printKeyValue('Failures', String(status.providerFailures.length));
}

export function registerReachabilityCommand(program: Command): void {
  const reachability = program.command('reachability').description('Manage network reachability policy');

  reachability
    .command('show')
    .description('Show current reachability policy and runtime status')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .action(async (options) => {
      try {
        const { policy, status } = await readPolicyAndStatus();
        if (options.format === 'json') {
          console.log(JSON.stringify({ policy, status }, null, 2));
          return;
        }

        printPolicy(policy, status);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  reachability
    .command('mode <mode>')
    .description('Set reachability mode (adaptive or fixed)')
    .action(async (mode: ReachabilityMode) => {
      try {
        if (!['adaptive', 'fixed'].includes(mode)) {
          throw new Error('Mode must be adaptive or fixed');
        }
        const { policy } = await applyPatch({ mode });
        success(`Reachability mode set to ${policy.mode}`);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  reachability
    .command('set-bootstrap <providers>')
    .description('Set comma-separated bootstrap providers')
    .action(async (providers: string) => {
      try {
        const bootstrapProviders = bootstrapFromInput(providers);
        if (bootstrapProviders.length === 0) {
          throw new Error('At least one bootstrap provider is required');
        }
        const { policy } = await applyPatch({ bootstrapProviders });
        success(`Bootstrap providers updated (${policy.bootstrapProviders.length})`);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  reachability
    .command('set-target <count>')
    .description('Set target provider count in adaptive mode')
    .action(async (count: string) => {
      try {
        const targetProviderCount = Number.parseInt(count, 10);
        if (!Number.isFinite(targetProviderCount) || targetProviderCount < 1) {
          throw new Error('Target provider count must be a positive integer');
        }
        const { policy } = await applyPatch({ targetProviderCount });
        success(`Target provider count set to ${policy.targetProviderCount}`);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  reachability
    .command('reset-default')
    .description('Reset reachability policy to defaults')
    .action(async () => {
      try {
        await resetPolicy();
        success('Reachability policy reset to defaults');
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  reachability
    .command('operator-lock <state>')
    .description('Enable or disable the operator lock')
    .action(async (state: string) => {
      try {
        if (!['on', 'off'].includes(state)) {
          throw new Error('State must be on or off');
        }
        await applyPatch({ operatorLock: state === 'on' });
        success(`Operator lock ${state === 'on' ? 'enabled' : 'disabled'}`);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
