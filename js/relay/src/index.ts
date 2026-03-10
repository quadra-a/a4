#!/usr/bin/env node
/**
 * CVP-0011 / CVP-0015: Relay server CLI entry point
 */

import type { Server } from 'node:http';
import { RelayAgent } from './relay-agent.js';
import { runTokenCLI } from './cli-token.js';
import { startLandingServer } from './landing.js';
import type { FederationExportPolicy, FederationRealmPolicyConfig } from './federation-manager.js';
import { DEFAULT_DOCKER_DATA_DIR, resolveStoragePath } from './storage-path.js';

interface ParsedArgs {
  flags: Map<string, string | boolean | string[]>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.set('help', true);
      continue;
    }

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      const value = argv[++i];
      const existing = flags.get(key);
      if (existing === undefined) {
        flags.set(key, value);
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        flags.set(key, [existing as string, value]);
      }
    } else {
      flags.set(key, true);
    }
  }

  return { flags, positionals };
}

function parseBoolean(value: string | boolean | string[] | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (Array.isArray(value)) return parseBoolean(value[value.length - 1], defaultValue);
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function getString(parsed: ParsedArgs, key: string, envValue?: string): string | undefined {
  const value = parsed.flags.get(key);
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === 'string') return value;
  return envValue;
}

function getBoolean(parsed: ParsedArgs, key: string, envValue: string | undefined, defaultValue: boolean): boolean {
  const value = parsed.flags.get(key);
  if (value !== undefined) return parseBoolean(value, defaultValue);
  return parseBoolean(envValue, defaultValue);
}

function getRepeatedStrings(parsed: ParsedArgs, key: string): string[] {
  const value = parsed.flags.get(key);
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function isFederationPolicy(value: string): value is FederationExportPolicy {
  return value === 'none' || value === 'selective' || value === 'full';
}

function isTopLevelFederationPolicy(value: string): value is FederationExportPolicy | 'auto' {
  return value === 'auto' || isFederationPolicy(value);
}

function normalizeTopLevelFederationPolicy(value: string): FederationExportPolicy | 'auto' {
  if (!isTopLevelFederationPolicy(value)) {
    throw new Error(`Invalid federation policy: ${value}`);
  }
  return value;
}

function extractSelectiveVisibilityValue(value: unknown, defaultVisibility: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : defaultVisibility;
}

function normalizeRealmPolicyEntry(
  realm: string,
  entry: unknown,
  defaultVisibility: string,
): FederationRealmPolicyConfig {
  if (typeof entry === 'string') {
    if (!isFederationPolicy(entry)) {
      throw new Error(`Invalid federation policy for realm ${realm}: ${entry}`);
    }
    return {
      exportPolicy: entry,
      selectiveVisibilityValue: defaultVisibility,
    };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Invalid federation realm policy for realm ${realm}`);
  }

  const record = entry as Record<string, unknown>;
  const rawPolicy = record.exportPolicy ?? record.federationPolicy;
  if (typeof rawPolicy !== 'string' || !isFederationPolicy(rawPolicy)) {
    throw new Error(`Invalid federation policy for realm ${realm}: ${String(rawPolicy)}`);
  }

  const exportFilter = record.exportFilter;
  const visibilityFromFilter = exportFilter && typeof exportFilter === 'object' && !Array.isArray(exportFilter)
    ? (exportFilter as Record<string, unknown>)['metadata.visibility']
      ?? (exportFilter as Record<string, unknown>).visibility
      ?? (exportFilter as Record<string, unknown>).federationVisibility
    : undefined;

  return {
    exportPolicy: rawPolicy,
    selectiveVisibilityValue: extractSelectiveVisibilityValue(
      record.selectiveVisibilityValue ?? visibilityFromFilter,
      defaultVisibility,
    ),
  };
}

function parseFederationRealmPoliciesJson(
  raw: string | undefined,
  defaultVisibility: string,
): Record<string, FederationRealmPolicyConfig> {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid FEDERATION_REALM_POLICIES JSON: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FEDERATION_REALM_POLICIES must be a JSON object');
  }

  const root = parsed as Record<string, unknown>;
  const realms = root.realms && typeof root.realms === 'object' && !Array.isArray(root.realms)
    ? root.realms as Record<string, unknown>
    : root;

  const normalized: Record<string, FederationRealmPolicyConfig> = {};
  for (const [realm, entry] of Object.entries(realms)) {
    normalized[realm] = normalizeRealmPolicyEntry(realm, entry, defaultVisibility);
  }

  return normalized;
}

function parseFederationRealmPolicySpecs(
  specs: string[],
  defaultVisibility: string,
): Record<string, FederationRealmPolicyConfig> {
  const normalized: Record<string, FederationRealmPolicyConfig> = {};

  for (const spec of specs) {
    const separatorIndex = spec.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex === spec.length - 1) {
      throw new Error(`Invalid --federation-realm-policy value: ${spec}`);
    }

    const realm = spec.slice(0, separatorIndex).trim();
    const remainder = spec.slice(separatorIndex + 1).trim();
    const visibilitySeparatorIndex = remainder.indexOf(':');
    const rawPolicy = (visibilitySeparatorIndex >= 0 ? remainder.slice(0, visibilitySeparatorIndex) : remainder).trim();
    const rawVisibility = visibilitySeparatorIndex >= 0 ? remainder.slice(visibilitySeparatorIndex + 1).trim() : '';

    if (!realm) {
      throw new Error(`Invalid --federation-realm-policy value: ${spec}`);
    }
    if (!isFederationPolicy(rawPolicy)) {
      throw new Error(`Invalid federation policy for realm ${realm}: ${rawPolicy}`);
    }

    normalized[realm] = {
      exportPolicy: rawPolicy,
      selectiveVisibilityValue: rawVisibility || defaultVisibility,
    };
  }

  return normalized;
}

function mergeRealmPolicies(
  ...sources: Array<Record<string, FederationRealmPolicyConfig>>
): Record<string, FederationRealmPolicyConfig> {
  const merged: Record<string, FederationRealmPolicyConfig> = {};
  for (const source of sources) {
    for (const [realm, policy] of Object.entries(source)) {
      merged[realm] = { ...merged[realm], ...policy };
    }
  }
  return merged;
}

function printHelp(): void {
  console.log(`quadra-a-relay [options]

OPTIONS
  --port <port>                 WebSocket relay port for agent traffic (default: 8080)
  --landing-port <port|false>   Separate landing-page HTTP port, or false to disable (default: 80)
  --relay-id <id>               Relay identifier
  --data-dir <path>             Data directory (default: ./relay-data)
  --public-endpoint <url>       Reachable ws:// or wss:// endpoint to publish (repeatable)
  --private                     Require invite tokens for agent connections
  --operator-public-key <hex>   Operator Ed25519 public key (32-byte hex)
  --no-federation               Disable federation manager
  --federation-policy <policy>  Federation export policy: auto|none|selective|full
  --federation-export-visibility <value>
                               Default metadata visibility value required for selective export (default: public)
  --federation-realm-policy <realm=policy[:visibility]>
                               Per-realm export override, repeatable (policy: none|selective|full)
  --genesis-mode                Start bootstrap manager in genesis mode
  --network-id <id>             Bootstrap network ID
  --seed-relays <csv>           Comma-separated seed relay URLs
  --seed-relay <url>            Additional seed relay URL (repeatable)
  -h, --help                    Show this help

SUBCOMMANDS
  token <command>               Manage invite tokens (create/list/revoke/rotate)

ENVIRONMENT
  PORT
  LANDING_PORT
  RELAY_ID
  DATA_DIR
  PUBLIC_ENDPOINT / PUBLIC_ENDPOINTS / PUBLIC_WS_URL
  PRIVATE_RELAY / QUADRA_A_PRIVATE_RELAY
  OPERATOR_PUBLIC_KEY / QUADRA_A_OPERATOR_PUBLIC_KEY
  FEDERATION_ENABLED
  FEDERATION_POLICY
  FEDERATION_EXPORT_VISIBILITY
  FEDERATION_REALM_POLICIES      JSON object, or {"realms": {...}} wrapper
  GENESIS_MODE
  NETWORK_ID
  SEED_RELAYS

NOTES
  - If PUBLIC_ENDPOINT is unset, the relay advertises ws://localhost:<PORT>, which is only reachable from the same machine.
  - For public deployments, expose PORT in your security group / firewall and publish a reachable PUBLIC_ENDPOINT.
  - LANDING_PORT is optional and separate from the relay WebSocket port.
`);
}

const argv = process.argv.slice(2);
if (argv[0] === 'token') {
  await runTokenCLI(argv.slice(1));
  process.exit(0);
}

const parsed = parseArgs(argv);
if (parsed.flags.has('help')) {
  printHelp();
  process.exit(0);
}

const port = parseInt(getString(parsed, 'port', process.env.PORT) || '8080', 10);
const landingPortValue = getString(parsed, 'landing-port', process.env.LANDING_PORT) || '80';
const relayId = getString(parsed, 'relay-id', process.env.RELAY_ID) || `relay-${Math.random().toString(36).slice(2, 10)}`;
const storagePathResolution = resolveStoragePath({
  cliDataDir: getString(parsed, 'data-dir'),
  envDataDir: process.env.DATA_DIR,
});
const storagePath = storagePathResolution.storagePath;
const operatorPublicKey = getString(
  parsed,
  'operator-public-key',
  process.env.OPERATOR_PUBLIC_KEY || process.env.QUADRA_A_OPERATOR_PUBLIC_KEY,
) || '';
const privateRelay = getBoolean(
  parsed,
  'private',
  process.env.PRIVATE_RELAY || process.env.QUADRA_A_PRIVATE_RELAY,
  false,
);
const federationEnabled = !parsed.flags.has('no-federation') && getBoolean(
  parsed,
  'federation-enabled',
  process.env.FEDERATION_ENABLED,
  true,
);
const federationPolicy = normalizeTopLevelFederationPolicy(
  getString(parsed, 'federation-policy', process.env.FEDERATION_POLICY) || 'auto',
);
const federationExportVisibility = getString(
  parsed,
  'federation-export-visibility',
  process.env.FEDERATION_EXPORT_VISIBILITY,
) || 'public';
let federationRealmPolicies: Record<string, FederationRealmPolicyConfig>;
try {
  federationRealmPolicies = mergeRealmPolicies(
    parseFederationRealmPoliciesJson(
      process.env.FEDERATION_REALM_POLICIES || process.env.QUADRA_A_FEDERATION_REALM_POLICIES,
      federationExportVisibility,
    ),
    parseFederationRealmPolicySpecs(
      getRepeatedStrings(parsed, 'federation-realm-policy'),
      federationExportVisibility,
    ),
  );
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
const genesisMode = getBoolean(parsed, 'genesis-mode', process.env.GENESIS_MODE, false);
const networkId = getString(parsed, 'network-id', process.env.NETWORK_ID) || 'highway1-mainnet';
const publicEndpoints = [
  ...splitCsv(process.env.PUBLIC_ENDPOINTS),
  ...splitCsv(process.env.PUBLIC_ENDPOINT),
  ...splitCsv(process.env.PUBLIC_WS_URL),
  ...getRepeatedStrings(parsed, 'public-endpoint').map((url) => url.trim()).filter(Boolean),
];
const seedRelays = [
  ...(process.env.SEED_RELAYS ? process.env.SEED_RELAYS.split(',').map((url) => url.trim()).filter(Boolean) : []),
  ...(getString(parsed, 'seed-relays')?.split(',').map((url) => url.trim()).filter(Boolean) || []),
  ...getRepeatedStrings(parsed, 'seed-relay').map((url) => url.trim()).filter(Boolean),
];

if (storagePathResolution.usedLegacyDockerPath) {
  console.warn(
    `Warning: using legacy Docker data directory ${storagePath} because ${DEFAULT_DOCKER_DATA_DIR} has no relay state yet. `
      + `Mount a persistent volume to ${DEFAULT_DOCKER_DATA_DIR} or set DATA_DIR explicitly to keep the relay DID stable across container recreation.`,
  );
}

if ((privateRelay || operatorPublicKey) && !operatorPublicKey) {
  console.error('Error: private relay mode requires --operator-public-key or OPERATOR_PUBLIC_KEY');
  process.exit(1);
}

const server = new RelayAgent({
  port,
  relayId,
  publicEndpoints,
  storagePath,
  operatorPublicKey,
  privateRelay,
  federationEnabled,
  federationPolicy,
  federationExportVisibility,
  federationRealmPolicies,
  genesisMode,
  networkId,
  seedRelays,
});

await server.start();

let landingServer: Server | undefined;
if (landingPortValue !== 'false') {
  try {
    const landingPort = parseInt(landingPortValue, 10);
    landingServer = startLandingServer(landingPort);
  } catch (err) {
    const error = err as Error;
    console.warn(`Warning: Could not start landing server on port ${landingPortValue}:`, error.message);
    console.warn('Relay will continue without landing page.');
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (landingServer) {
    landingServer.close();
  }
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (landingServer) {
    landingServer.close();
  }
  await server.stop();
  process.exit(0);
});

export { RelayAgent, RelayServer } from './server.js';
export { RelayIdentity } from './relay-identity.js';
export { FederationManager } from './federation-manager.js';
export { BootstrapManager } from './bootstrap-manager.js';
export { RelayStatusManager } from './relay-status-manager.js';
