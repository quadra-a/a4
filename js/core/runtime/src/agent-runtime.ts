import {
  createRelayClient,
  createRelayIndexOperations,
  generateAnonymousIdentity,
  importKeyPair,
  sign,
  signAgentCard,
  type RelayClient,
  type RelayIndexOperations,
} from '@quadra-a/protocol';
import {
  getAgentCard,
  getIdentity,
  getReachabilityPolicy,
  getRelayInviteToken,
  setAgentCard,
} from './config.js';
import { resolvePublishedDevices, resolvePublishedPreKeyBundles } from './e2e-config.js';
import { DaemonClient } from './daemon-client.js';
import { DEFAULT_BOOTSTRAP_PROVIDERS } from './reachability.js';

export const DEFAULT_RELAY_URLS = DEFAULT_BOOTSTRAP_PROVIDERS;

/**
 * The locally initialized runtime identity as persisted by config.
 */
export type RuntimeIdentity = NonNullable<ReturnType<typeof getIdentity>>;

/**
 * Live relay session objects used by higher-level discovery and publish helpers.
 */
export interface RelaySession {
  identity: RuntimeIdentity;
  keyPair: ReturnType<typeof importKeyPair>;
  relayClient: RelayClient;
  relayIndex: RelayIndexOperations;
}

/**
 * Search inputs accepted by runtime-level discovery helpers.
 */
export interface SearchAgentsParams {
  text?: string;
  capability?: string;
  filters?: Record<string, unknown>;
  limit?: number;
}

/**
 * The capability shape returned by runtime-level discovery surfaces.
 */
export type DiscoveryCapability = string | {
  id?: string;
  name?: string;
  description?: string;
};

/**
 * Normalized discovery result shape used by CLI and MCP surfaces.
 */
export interface DiscoveryAgent {
  did: string;
  name?: string;
  description?: string;
  timestamp?: number;
  capabilities?: DiscoveryCapability[];
  trust?: {
    interactionScore?: number;
  };
  online?: boolean;
}

/**
 * Inputs for publishing or updating the local Agent Card.
 */
export interface PublishCardInput {
  relay?: string;
  inviteToken?: string;
  name?: string;
  description?: string;
  capabilities?: string[];
}

interface RelaySessionOptions {
  relay?: string;
  inviteToken?: string;
  identity?: RuntimeIdentity;
  card?: Partial<PublishCardInput>;
}

/**
 * Resolve the relay list for the current operation.
 */
export function getRelayUrls(relay?: string): string[] {
  return getReachabilityPolicy({ relay }).bootstrapProviders;
}

/**
 * Resolve the relay invite token from explicit input, environment, or persisted config.
 */
export function resolveRelayInviteToken(inviteToken?: string): string | undefined {
  return inviteToken
    ?? process.env.QUADRA_A_INVITE_TOKEN
    ?? process.env.HW1_INVITE_TOKEN
    ?? getRelayInviteToken();
}

/**
 * Require a local identity and throw a user-facing error if initialization has not happened yet.
 */
export function requireIdentity(binName: string = 'agent'): RuntimeIdentity {
  const identity = getIdentity();
  if (!identity) {
    throw new Error(`No identity found. Run "${binName} listen" to create one.`);
  }
  return identity;
}

function isPersistedRuntimeIdentity(identity: RuntimeIdentity): boolean {
  const persistedIdentity = getIdentity();
  return persistedIdentity?.did === identity.did && persistedIdentity.privateKey === identity.privateKey;
}

/**
 * Merge persisted Agent Card fields with one publish/update request.
 */
export function buildLocalCardConfig(overrides: Partial<PublishCardInput> = {}) {
  const currentCard = getAgentCard();

  return {
    name: overrides.name ?? currentCard?.name ?? 'quadra-a Agent',
    description: overrides.description ?? currentCard?.description ?? '',
    capabilities: Array.isArray(overrides.capabilities)
      ? overrides.capabilities.map((capability) => capability.trim()).filter(Boolean)
      : currentCard?.capabilities ?? [],
  };
}

/**
 * Build and sign an Agent Card for one publish or session bootstrap flow.
 */
export async function buildSignedAgentCard(
  identity: RuntimeIdentity,
  overrides: Partial<PublishCardInput> = {},
) {
  const cardConfig = buildLocalCardConfig(overrides);
  const keyPair = importKeyPair({
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  });

  const capabilities = cardConfig.capabilities.map((capability) => ({
    id: capability,
    name: capability,
    description: `Capability: ${capability}`,
  }));

  const devices = await resolvePublishedDevices(identity);
  const agentCard = {
    did: identity.did,
    name: cardConfig.name,
    description: cardConfig.description,
    version: '1.0.0',
    capabilities,
    endpoints: [],
    ...(devices.length > 0 ? { devices } : {}),
    timestamp: Date.now(),
  };

  const signedCard = await signAgentCard(agentCard, (data) => sign(data, keyPair.privateKey));

  return {
    keyPair,
    cardConfig,
    signedCard,
  };
}

/**
 * Open one relay session, invoke the callback, and stop the client afterward.
 */
export async function withRelaySession<T>(
  options: RelaySessionOptions = {},
  callback: (session: RelaySession) => Promise<T>,
): Promise<T> {
  const identity = options.identity ?? requireIdentity();
  const { keyPair, signedCard } = await buildSignedAgentCard(identity, options.card);
  const reachabilityPolicy = options.relay
    ? getReachabilityPolicy({
        relay: options.relay,
        mode: 'fixed',
        autoDiscoverProviders: false,
        targetProviderCount: 1,
      })
    : getReachabilityPolicy();

  const relayClient = createRelayClient({
    relayUrls: reachabilityPolicy.bootstrapProviders,
    inviteToken: resolveRelayInviteToken(options.inviteToken),
    did: identity.did,
    keyPair,
    card: signedCard,
    autoDiscoverRelays: reachabilityPolicy.mode === 'adaptive' && reachabilityPolicy.autoDiscoverProviders,
    targetRelayCount: reachabilityPolicy.mode === 'adaptive'
      ? reachabilityPolicy.targetProviderCount
      : reachabilityPolicy.bootstrapProviders.length,
  });

  await relayClient.start();

  if (isPersistedRuntimeIdentity(identity)) {
    const preKeyBundles = await resolvePublishedPreKeyBundles(identity);
    if (preKeyBundles.length > 0) {
      await relayClient.publishPreKeyBundles(preKeyBundles);
    }
  }

  try {
    const relayIndex = createRelayIndexOperations(relayClient);
    return await callback({
      identity,
      keyPair,
      relayClient,
      relayIndex,
    });
  } finally {
    await relayClient.stop();
  }
}

async function withAnonymousQueryRelaySession<T>(
  options: Pick<RelaySessionOptions, 'relay' | 'inviteToken'> = {},
  callback: (session: RelaySession) => Promise<T>,
): Promise<T> {
  const identity = await generateAnonymousIdentity();

  return withRelaySession(
    {
      relay: options.relay,
      inviteToken: options.inviteToken,
      identity,
      card: identity.agentCard,
    },
    callback,
  );
}

/**
 * Query one Agent Card from the active relay-backed discovery surface.
 */
export async function queryAgentCard(did: string, relay?: string): Promise<DiscoveryAgent | null | undefined> {
  const client = new DaemonClient();

  if (await client.isDaemonRunning()) {
    return client.send<DiscoveryAgent | null>('query_agent_card', { did });
  }

  return withAnonymousQueryRelaySession({ relay }, async ({ relayIndex }) => relayIndex.queryAgentCard(did));
}

/**
 * Search agents by text and capability, using the daemon when it is available.
 */
export async function searchAgents(params: SearchAgentsParams, relay?: string): Promise<DiscoveryAgent[]> {
  const client = new DaemonClient();

  if (await client.isDaemonRunning()) {
    return client.send<DiscoveryAgent[]>('discover', {
      query: params.text,
      capability: params.capability,
      filters: params.filters,
      limit: params.limit,
    });
  }

  return withAnonymousQueryRelaySession({ relay }, async ({ relayIndex }) => {
    const query = {
      text: params.text,
      capability: params.capability,
      filters: params.filters,
      limit: params.limit,
    };

    return relayIndex.searchSemantic(query);
  });
}

/**
 * Publish or update the local Agent Card through the daemon or a direct relay session.
 */
export async function publishAgentCard(input: PublishCardInput = {}) {
  const identity = requireIdentity();
  const nextCard = buildLocalCardConfig(input);
  setAgentCard(nextCard);

  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    return client.send<{ did: string; card: typeof nextCard }>('publish_card', nextCard);
  }

  await withRelaySession(
    {
      relay: input.relay,
      inviteToken: input.inviteToken,
      identity,
      card: nextCard,
    },
    async ({ relayClient }) => {
      const { signedCard } = await buildSignedAgentCard(identity, nextCard);
      await relayClient.publishCard(signedCard);
    },
  );

  return {
    did: identity.did,
    card: nextCard,
  };
}

export async function unpublishAgentCard(options: { relay?: string; inviteToken?: string } = {}) {
  const identity = requireIdentity();

  await withRelaySession({ relay: options.relay, inviteToken: options.inviteToken, identity }, async ({ relayClient }) => {
    await relayClient.unpublishCard();
  });

  return { did: identity.did };
}
