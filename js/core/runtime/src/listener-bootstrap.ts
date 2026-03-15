import { generateAnonymousIdentity } from '@quadra-a/protocol';
import {
  getAgentCard,
  getIdentity,
  getReachabilityPolicy,
  getRelayInviteToken,
  isPublished,
  updateReachabilityPolicy,
  setAgentCard,
  setIdentity,
  setPublished,
  setRelayInviteToken,
} from './config.js';
import { ensurePersistedE2EConfig } from './e2e-config.js';
import {
  getDaemonStatus,
  restartDaemon,
  startDaemonInBackground,
  type DaemonStatus,
} from './daemon-control.js';

export interface ListenerBootstrapOptions {
  relay?: string;
  token?: string;
  discoverable?: boolean;
  name?: string;
  description?: string;
  capabilities?: string[] | string;
}

export interface PreparedListenerState {
  createdIdentity: boolean;
  configChanged: boolean;
  daemonRunning: boolean;
  relayChanged: boolean;
  shouldRestart: boolean;
  daemonStatus?: DaemonStatus;
}

export interface BackgroundListenerResult extends PreparedListenerState {
  action: 'started' | 'restarted' | 'already_running';
  did: string;
  connectedRelays: string[];
}

function normalizeCapabilities(input?: string[] | string): string[] {
  if (Array.isArray(input)) {
    return input.map((capability) => capability.trim()).filter(Boolean);
  }

  return input
    ? input.split(',').map((capability) => capability.trim()).filter(Boolean)
    : [];
}

function normalizeToken(token?: string): string | undefined {
  const normalized = token?.trim();
  return normalized ? normalized : undefined;
}

export function applyListenerEnv(options: { relay?: string; token?: string }): void {
  if (options.relay) {
    process.env.QUADRA_A_RELAY_URLS = options.relay;
  }

  if (options.token) {
    process.env.QUADRA_A_INVITE_TOKEN = options.token;
  }
}

export async function prepareListenerState(
  options: ListenerBootstrapOptions,
): Promise<PreparedListenerState> {
  let createdIdentity = false;
  let configChanged = false;

  if (options.discoverable && !options.name) {
    throw new Error('--name is required when using --discoverable');
  }

  if (options.discoverable && !options.description) {
    throw new Error('--description is required when using --discoverable');
  }

  let identity = getIdentity();
  if (!identity) {
    const anonymousIdentity = await generateAnonymousIdentity();
    setIdentity({
      did: anonymousIdentity.did,
      publicKey: anonymousIdentity.publicKey,
      privateKey: anonymousIdentity.privateKey,
    });
    setAgentCard(anonymousIdentity.agentCard);
    setPublished(false);
    identity = getIdentity();
    createdIdentity = true;
    configChanged = true;
  }

  if (!identity) {
    throw new Error('Failed to create local identity');
  }

  const { created: createdE2EConfig } = await ensurePersistedE2EConfig(identity);
  if (createdE2EConfig) {
    configChanged = true;
  }

  if (options.discoverable) {
    const nextCard = {
      name: options.name!,
      description: options.description!,
      capabilities: normalizeCapabilities(options.capabilities),
    };
    const currentCard = getAgentCard();
    const needsCardUpdate = !currentCard
      || currentCard.name !== nextCard.name
      || currentCard.description !== nextCard.description
      || JSON.stringify(currentCard.capabilities) !== JSON.stringify(nextCard.capabilities);

    if (needsCardUpdate) {
      setAgentCard(nextCard);
      configChanged = true;
    }

    if (!isPublished()) {
      setPublished(true);
      configChanged = true;
    }
  }

  const nextToken = normalizeToken(options.token);
  if (nextToken && nextToken !== getRelayInviteToken()) {
    setRelayInviteToken(nextToken);
    configChanged = true;
  }

  if (options.relay) {
    const currentPolicy = getReachabilityPolicy();
    if (currentPolicy.bootstrapProviders[0] !== options.relay || currentPolicy.bootstrapProviders.length !== 1) {
      updateReachabilityPolicy({ bootstrapProviders: [options.relay] });
      configChanged = true;
    }
  }

  const daemonStatus = await getDaemonStatus().catch(() => undefined);
  const daemonRunning = Boolean(daemonStatus);
  const relayChanged = Boolean(
    options.relay && !(daemonStatus?.connectedRelays ?? []).includes(options.relay),
  );
  const shouldRestart = daemonRunning && (configChanged || relayChanged);

  applyListenerEnv({ relay: options.relay, token: nextToken ?? getRelayInviteToken() });

  return {
    createdIdentity,
    configChanged,
    daemonRunning,
    relayChanged,
    shouldRestart,
    daemonStatus,
  };
}

export async function ensureBackgroundListener(
  options: ListenerBootstrapOptions,
): Promise<BackgroundListenerResult> {
  const state = await prepareListenerState(options);
  const action = state.shouldRestart
    ? 'restarted'
    : (await startDaemonInBackground()).status === 'already_running'
      ? 'already_running'
      : 'started';

  if (state.shouldRestart) {
    await restartDaemon();
  }

  const status = await getDaemonStatus();

  return {
    ...state,
    action,
    did: status.did,
    connectedRelays: status.connectedRelays ?? [],
  };
}
