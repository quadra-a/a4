import type { LocalE2EConfig } from '@quadra-a/protocol';
import Conf from 'conf';
import { QUADRA_A_HOME } from './constants.js';
import {
  resolveReachabilityPolicy,
  type ReachabilityPolicy,
  type ReachabilityPolicyOverrides,
} from './reachability.js';

/**
 * Persistent local configuration shared by the CLI, MCP server, and daemon-backed tooling.
 */
export interface QuadraAConfig {
  identity?: {
    did: string;
    publicKey: string;
    privateKey: string;
  };
  deviceIdentity?: {
    seed: string;
    deviceId: string;
  };
  agentCard?: {
    name: string;
    description: string;
    capabilities: string[];
  };
  e2e?: LocalE2EConfig;
  published?: boolean;
  relayInviteToken?: string;
  reachabilityPolicy?: Partial<ReachabilityPolicy>;
  aliases?: {
    [alias: string]: string;
  };
}

const config = new Conf<QuadraAConfig>({
  projectName: 'quadra-a',
  cwd: QUADRA_A_HOME,
});

/**
 * Return the singleton config store rooted in the quadra-a home directory.
 */
export function getConfig(): Conf<QuadraAConfig> {
  return config;
}

/**
 * Check whether local identity material has been initialized.
 */
export function hasIdentity(): boolean {
  return config.has('identity');
}

/**
 * Read the persisted local identity record.
 */
export function getIdentity(): QuadraAConfig['identity'] {
  return config.get('identity');
}

/**
 * Persist the local identity record used by operator-facing surfaces.
 */
export function setIdentity(identity: QuadraAConfig['identity']): void {
  config.set('identity', identity);
}

/**
 * Read the persisted stable local device identity metadata.
 */
export function getDeviceIdentity(): QuadraAConfig['deviceIdentity'] {
  return config.get('deviceIdentity');
}

/**
 * Persist the stable local device identity metadata.
 */
export function setDeviceIdentity(deviceIdentity: QuadraAConfig['deviceIdentity']): void {
  config.set('deviceIdentity', deviceIdentity);
}

/**
 * Read the locally configured Agent Card fields.
 */
export function getAgentCard(): QuadraAConfig['agentCard'] {
  return config.get('agentCard');
}

/**
 * Persist local Agent Card fields for later publish and status workflows.
 */
export function setAgentCard(card: QuadraAConfig['agentCard']): void {
  config.set('agentCard', card);
}

/**
 * Read the persisted local E2E device state.
 */
export function getE2EConfig(): QuadraAConfig['e2e'] {
  return config.get('e2e');
}

/**
 * Persist the local E2E device state.
 */
export function setE2EConfig(e2e: QuadraAConfig['e2e']): void {
  config.set('e2e', e2e);
}

/**
 * Read the local alias map.
 */
export function getAliases(): { [alias: string]: string } {
  return config.get('aliases') || {};
}

/**
 * Upsert a local alias that resolves to a DID.
 */
export function setAlias(alias: string, did: string): void {
  const aliases = getAliases();
  aliases[alias] = did;
  config.set('aliases', aliases);
}

/**
 * Resolve one locally configured alias.
 */
export function getAlias(alias: string): string | undefined {
  const aliases = getAliases();
  return aliases[alias];
}

/**
 * Delete one alias from the local config store.
 */
export function removeAlias(alias: string): boolean {
  const aliases = getAliases();
  if (!(alias in aliases)) {
    return false;
  }
  delete aliases[alias];
  config.set('aliases', aliases);
  return true;
}

/**
 * Report whether the local Agent Card is currently marked as published.
 */
export function isPublished(): boolean {
  return config.get('published') || false;
}

/**
 * Persist the local publish marker used by CLI and daemon status flows.
 */
export function setPublished(published: boolean): void {
  config.set('published', published);
}

/**
 * Read the relay invite token currently stored in local config.
 */
export function getRelayInviteToken(): string | undefined {
  return config.get('relayInviteToken');
}

/**
 * Persist or clear the relay invite token used for bootstrap and listen flows.
 */
export function setRelayInviteToken(inviteToken: string | undefined): void {
  if (!inviteToken) {
    config.delete('relayInviteToken');
    return;
  }

  config.set('relayInviteToken', inviteToken);
}

/**
 * Read the locally persisted reachability policy fragment.
 */
export function getStoredReachabilityPolicy(): Partial<ReachabilityPolicy> | undefined {
  return config.get('reachabilityPolicy');
}

/**
 * Resolve the effective reachability policy with env and optional runtime overrides.
 */
export function getReachabilityPolicy(
  overrides: ReachabilityPolicyOverrides = {},
): ReachabilityPolicy {
  return resolveReachabilityPolicy(getStoredReachabilityPolicy(), overrides);
}

/**
 * Persist one complete reachability policy.
 */
export function setReachabilityPolicy(policy: ReachabilityPolicy): ReachabilityPolicy {
  const normalized = resolveReachabilityPolicy(undefined, policy);
  config.set('reachabilityPolicy', normalized);
  return normalized;
}

/**
 * Merge one partial reachability policy onto the current effective policy and persist it.
 */
export function updateReachabilityPolicy(
  patch: ReachabilityPolicyOverrides,
): ReachabilityPolicy {
  const current = getReachabilityPolicy();
  const next = resolveReachabilityPolicy(current, patch);
  config.set('reachabilityPolicy', next);
  return next;
}

/**
 * Reset reachability policy back to defaults + environment.
 */
export function resetReachabilityPolicy(): ReachabilityPolicy {
  config.delete('reachabilityPolicy');
  return getReachabilityPolicy();
}
