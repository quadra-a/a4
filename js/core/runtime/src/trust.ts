import {
  createRelayClient,
  createTrustSystem,
  createAgentCard,
  extractPublicKey,
  importKeyPair,
  MessageStorage,
  sign,
  signAgentCard,
} from '@quadra-a/protocol';
import { join } from 'node:path';
import { DaemonClient } from './daemon-client.js';
import { getReachabilityPolicy } from './config.js';
import { requireIdentity, resolveRelayInviteToken } from './agent-runtime.js';

import { QUADRA_A_HOME } from './constants.js';

const TRUST_DB_PATH = join(QUADRA_A_HOME, 'trust');
const INBOX_DB_PATH = join(QUADRA_A_HOME, 'inbox');

type TrustSystemInstance = ReturnType<typeof createTrustSystem>;
type LocalTrustScore = Awaited<ReturnType<TrustSystemInstance['getTrustScore']>>;
type LocalEndorsement = Awaited<ReturnType<TrustSystemInstance['getEndorsements']>>[number];

interface NormalizedNetworkEndorsement {
  version: number;
  from: string;
  to: string;
  score: number;
  reason: string;
  timestamp: number;
  domain?: string;
  expires?: number;
  signature: string;
}

interface NormalizedNetworkTrustResult {
  target: string;
  endorsements: NormalizedNetworkEndorsement[];
  endorsementCount: number;
  averageScore: number;
  nextCursor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeNetworkEndorsement(value: unknown): NormalizedNetworkEndorsement | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.from === 'string' && typeof value.to === 'string' && typeof value.score === 'number') {
    return {
      version: asFiniteNumber(value.version, 2),
      from: value.from,
      to: value.to,
      score: value.score,
      reason: typeof value.reason === 'string' ? value.reason : '',
      timestamp: asFiniteNumber(value.timestamp, Date.now()),
      domain: typeof value.domain === 'string' ? value.domain : undefined,
      expires: typeof value.expires === 'number' ? value.expires : undefined,
      signature: typeof value.signature === 'string' ? value.signature : '',
    };
  }

  if (
    typeof value.endorser === 'string'
    && typeof value.endorsee === 'string'
    && typeof value.strength === 'number'
  ) {
    const endorsementType = typeof value.type === 'string'
      ? value.type
      : typeof value.endorsement_type === 'string'
        ? value.endorsement_type
        : 'general';
    const comment = typeof value.comment === 'string' && value.comment.trim().length > 0
      ? value.comment
      : `${endorsementType} endorsement`;

    return {
      version: asFiniteNumber(value.version, 2),
      from: value.endorser,
      to: value.endorsee,
      score: value.strength,
      reason: comment,
      timestamp: asFiniteNumber(value.timestamp, Date.now()),
      domain: typeof value.domain === 'string' ? value.domain : undefined,
      expires: typeof value.expires === 'number' ? value.expires : undefined,
      signature: typeof value.signature === 'string' ? value.signature : '',
    };
  }

  return null;
}

function normalizeNetworkTrustResult(target: string, value: unknown): NormalizedNetworkTrustResult {
  if (!isRecord(value)) {
    throw new Error('Unsupported query_endorsements response from daemon');
  }

  const endorsements = Array.isArray(value.endorsements)
    ? value.endorsements
      .map((endorsement) => normalizeNetworkEndorsement(endorsement))
      .filter((endorsement): endorsement is NormalizedNetworkEndorsement => endorsement !== null)
    : [];
  const endorsementCount = asFiniteNumber(
    value.endorsementCount,
    asFiniteNumber(value.totalCount, endorsements.length),
  );
  const averageScore = typeof value.averageScore === 'number'
    ? value.averageScore
    : endorsements.length > 0
      ? endorsements.reduce((sum, endorsement) => sum + endorsement.score, 0) / endorsements.length
      : 0;
  const nextCursor = typeof value.nextCursor === 'string' ? value.nextCursor : undefined;

  return {
    target: typeof value.target === 'string' ? value.target : target,
    endorsements,
    endorsementCount,
    averageScore,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function normalizeTrustScoreResponse(
  value: unknown,
): { score: LocalTrustScore; endorsements: LocalEndorsement[] | NormalizedNetworkEndorsement[] } {
  if (isRecord(value) && isRecord(value.score) && typeof value.score.interactionScore === 'number') {
    const endorsements = Array.isArray(value.endorsements)
      ? value.endorsements
        .map((endorsement) => normalizeNetworkEndorsement(endorsement) ?? endorsement)
        .filter((endorsement): endorsement is LocalEndorsement | NormalizedNetworkEndorsement => endorsement != null)
      : [];

    return {
      score: value.score as unknown as LocalTrustScore,
      endorsements,
    };
  }

  if (isRecord(value) && typeof value.score === 'number') {
    const interactionScore = value.score;
    const localTrust = asFiniteNumber(value.localTrust, interactionScore);
    const networkTrust = asFiniteNumber(value.networkTrust, interactionScore);
    const endorsementCount = asFiniteNumber(value.endorsementCount);
    const interactionCount = asFiniteNumber(value.interactionCount);

    return {
      score: {
        interactionScore,
        endorsements: endorsementCount,
        endorsementScore: networkTrust,
        completionRate: localTrust,
        responseTime: 0,
        uptime: interactionCount > 0 ? 1 : 0,
        lastUpdated: Date.now(),
        totalInteractions: interactionCount,
        recentSuccessRate: localTrust,
        status: interactionCount === 0 && endorsementCount === 0 ? 'unknown' : 'known',
      },
      endorsements: Array.isArray(value.endorsements)
        ? value.endorsements
          .map((endorsement) => normalizeNetworkEndorsement(endorsement))
          .filter((endorsement): endorsement is NormalizedNetworkEndorsement => endorsement !== null)
        : [],
    };
  }

  throw new Error('Unsupported trust_score response from daemon');
}

export async function withTrustSystem<T>(
  callback: (trustSystem: ReturnType<typeof createTrustSystem>) => Promise<T>,
): Promise<T> {
  const trustSystem = createTrustSystem({
    dbPath: TRUST_DB_PATH,
    getPublicKey: async (did: string) => extractPublicKey(did),
  });

  await trustSystem.start();

  try {
    return await callback(trustSystem);
  } finally {
    await trustSystem.stop();
  }
}

export async function getTrustScore(did: string) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    const result = await client.send('trust_score', { did });
    return normalizeTrustScoreResponse(result);
  }

  return withTrustSystem(async (trustSystem) => {
    const [score, endorsements] = await Promise.all([
      trustSystem.getTrustScore(did),
      trustSystem.getEndorsements(did),
    ]);

    return { score, endorsements };
  });
}

export async function endorseAgent(did: string, score: number, reason: string) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    const result = await client.send('create_endorsement', { did, score, reason });
    return normalizeNetworkEndorsement(result) ?? result;
  }

  return withTrustSystem(async (trustSystem) => {
    const identity = requireIdentity();
    const keyPair = importKeyPair({
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
    });

    return trustSystem.endorse(identity.did, did, score, reason, (data) => sign(data, keyPair.privateKey));
  });
}

export async function getTrustHistory(did: string, limit: number) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    return await client.send('query_endorsements', { did, limit });
  }

  return withTrustSystem((trustSystem) => trustSystem.getHistory(did, limit));
}

export async function getTrustStats() {
  const { InteractionHistory } = await import('@quadra-a/protocol');

  return withTrustSystem(async (trustSystem) => {
    const history = new InteractionHistory(join(TRUST_DB_PATH, 'interactions'));
    await history.open();

    try {
      const agents = await history.getAllAgents();
      const scores = await Promise.all(
        agents.map(async (did) => ({
          did,
          score: await trustSystem.getTrustScore(did),
        })),
      );

      scores.sort((left, right) => right.score.interactionScore - left.score.interactionScore);

      return {
        agents,
        scores,
      };
    } finally {
      await history.close();
    }
  });
}

export async function queryNetworkEndorsements(
  did: string,
  options: { domain?: string; relay?: string } = {},
) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    const result = await client.send('query_endorsements', { did, domain: options.domain });
    return normalizeNetworkTrustResult(did, result);
  }

  const identity = requireIdentity();
  const keyPair = importKeyPair({
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  });

  const signedCard = await signAgentCard(
    createAgentCard(identity.did, 'agent-cli', 'CLI trust query', [], []),
    (data) => sign(data, keyPair.privateKey),
  );
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
    inviteToken: resolveRelayInviteToken(),
    did: identity.did,
    keyPair,
    card: signedCard,
    autoDiscoverRelays: reachabilityPolicy.mode === 'adaptive' && reachabilityPolicy.autoDiscoverProviders,
    targetRelayCount: reachabilityPolicy.mode === 'adaptive'
      ? reachabilityPolicy.targetProviderCount
      : reachabilityPolicy.bootstrapProviders.length,
  });

  await relayClient.start();

  try {
    return await relayClient.queryTrust(did, options.domain);
  } finally {
    await relayClient.stop();
  }
}

export async function blockAgent(did: string, reason: string) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    await client.send('block', { did, reason });
    return;
  }

  const storage = new MessageStorage(INBOX_DB_PATH);
  await storage.open();

  try {
    await storage.putBlock({ did, reason, blockedAt: Date.now(), blockedBy: 'local' });
  } finally {
    await storage.close();
  }
}

export async function unblockAgent(did: string, resetTrust = true) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    await client.send('unblock', { did, resetTrust });
    return;
  }

  const storage = new MessageStorage(INBOX_DB_PATH);
  await storage.open();

  try {
    await storage.deleteBlock(did);

    // Reset interaction history by default to prevent immediate re-blocking
    if (resetTrust) {
      await withTrustSystem(async (trustSystem) => {
        await trustSystem.resetInteractionHistory(did);
      });
    }
  } finally {
    await storage.close();
  }
}

export async function listBlockedAgents() {
  const storage = new MessageStorage(INBOX_DB_PATH);
  await storage.open();

  try {
    return await storage.listBlocked();
  } finally {
    await storage.close();
  }
}

export async function allowAgent(did: string, note?: string) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    await client.send('allowlist', { action: 'add', did, note });
    return;
  }

  const storage = new MessageStorage(INBOX_DB_PATH);
  await storage.open();

  try {
    await storage.putAllow({ did, addedAt: Date.now(), note });
  } finally {
    await storage.close();
  }
}

export async function listAllowedAgents() {
  const storage = new MessageStorage(INBOX_DB_PATH);
  await storage.open();

  try {
    return await storage.listAllowed();
  } finally {
    await storage.close();
  }
}
