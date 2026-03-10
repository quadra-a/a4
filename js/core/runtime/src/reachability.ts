export type ReachabilityMode = 'adaptive' | 'fixed';

export interface ReachabilityPolicy {
  mode: ReachabilityMode;
  bootstrapProviders: string[];
  targetProviderCount: number;
  autoDiscoverProviders: boolean;
  operatorLock: boolean;
}

export interface ReachabilityFailureState {
  provider: string;
  attempts: number;
  lastFailureAt: number;
  lastError?: string;
}

export interface ReachabilityStatus {
  connectedProviders: string[];
  knownProviders: string[];
  lastDiscoveryAt: number | null;
  providerFailures: ReachabilityFailureState[];
  targetProviderCount: number;
  mode: ReachabilityMode;
  autoDiscoverProviders: boolean;
  operatorLock: boolean;
  bootstrapProviders: string[];
}

export interface ReachabilityPolicyOverrides extends Partial<ReachabilityPolicy> {
  relay?: string;
}

export const DEFAULT_BOOTSTRAP_PROVIDERS = ['ws://relay-sg-1.quadra-a.com:8080'];
export const DEFAULT_TARGET_PROVIDER_COUNT = 3;

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

function normalizeMode(value: unknown): ReachabilityMode | undefined {
  return value === 'fixed' || value === 'adaptive' ? value : undefined;
}

function normalizeTarget(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(1, Math.round(value));
}

export function normalizeProviderUrls(value?: string[] | string | null): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  return Array.from(new Set(entries.map((entry) => entry.trim()).filter(Boolean)));
}

function getEnvBootstrapProviders(): string[] {
  const envRelays = process.env.QUADRA_A_RELAY_URLS ?? process.env.HW1_RELAY_URLS;
  const relays = normalizeProviderUrls(envRelays);
  return relays.length > 0 ? relays : DEFAULT_BOOTSTRAP_PROVIDERS;
}

function getEnvDefaults(): Partial<ReachabilityPolicy> {
  const autoDiscover = normalizeBoolean(process.env.QUADRA_A_DISABLE_AUTO_RELAY_SUPPLEMENT) === true
    ? false
    : undefined;

  return {
    mode: autoDiscover === false ? 'fixed' : undefined,
    bootstrapProviders: getEnvBootstrapProviders(),
    autoDiscoverProviders: autoDiscover,
  };
}

export function buildDefaultReachabilityPolicy(): ReachabilityPolicy {
  const envDefaults = getEnvDefaults();

  return normalizeReachabilityPolicy({
    mode: 'adaptive',
    bootstrapProviders: DEFAULT_BOOTSTRAP_PROVIDERS,
    targetProviderCount: DEFAULT_TARGET_PROVIDER_COUNT,
    autoDiscoverProviders: true,
    operatorLock: false,
    ...envDefaults,
  });
}

export function normalizeReachabilityPolicy(
  value: Partial<ReachabilityPolicy> = {},
): ReachabilityPolicy {
  const defaults = buildDefaultReachabilityPolicyWithoutEnv();
  const mode = normalizeMode(value.mode) ?? defaults.mode;
  const bootstrapProviders = normalizeProviderUrls(value.bootstrapProviders).length > 0
    ? normalizeProviderUrls(value.bootstrapProviders)
    : defaults.bootstrapProviders;
  const targetProviderCount = normalizeTarget(value.targetProviderCount) ?? defaults.targetProviderCount;
  const operatorLock = normalizeBoolean(value.operatorLock) ?? defaults.operatorLock;
  const explicitAutoDiscover = normalizeBoolean(value.autoDiscoverProviders);
  const autoDiscoverProviders = explicitAutoDiscover ?? (mode === 'adaptive');

  return {
    mode,
    bootstrapProviders,
    targetProviderCount,
    autoDiscoverProviders,
    operatorLock,
  };
}

function buildDefaultReachabilityPolicyWithoutEnv(): ReachabilityPolicy {
  return {
    mode: 'adaptive',
    bootstrapProviders: [...DEFAULT_BOOTSTRAP_PROVIDERS],
    targetProviderCount: DEFAULT_TARGET_PROVIDER_COUNT,
    autoDiscoverProviders: true,
    operatorLock: false,
  };
}

export function resolveReachabilityPolicy(
  stored: Partial<ReachabilityPolicy> | undefined,
  overrides: ReachabilityPolicyOverrides = {},
): ReachabilityPolicy {
  const defaults = buildDefaultReachabilityPolicyWithoutEnv();
  const envDefaults = getEnvDefaults();

  const merged: Partial<ReachabilityPolicy> = {
    ...defaults,
    ...envDefaults,
    ...(stored ?? {}),
    ...overrides,
  };

  if (overrides.relay) {
    merged.bootstrapProviders = [overrides.relay];
  }

  if ((overrides.mode === 'fixed' || overrides.relay) && overrides.autoDiscoverProviders === undefined) {
    merged.autoDiscoverProviders = false;
  }

  return normalizeReachabilityPolicy(merged);
}

export function policyToReachabilityStatus(
  policy: ReachabilityPolicy,
  status: Partial<ReachabilityStatus> = {},
): ReachabilityStatus {
  return {
    connectedProviders: status.connectedProviders ?? [],
    knownProviders: status.knownProviders ?? policy.bootstrapProviders,
    lastDiscoveryAt: status.lastDiscoveryAt ?? null,
    providerFailures: status.providerFailures ?? [],
    targetProviderCount: policy.targetProviderCount,
    mode: policy.mode,
    autoDiscoverProviders: policy.autoDiscoverProviders,
    operatorLock: policy.operatorLock,
    bootstrapProviders: policy.bootstrapProviders,
  };
}
