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
  return withTrustSystem(async (trustSystem) => {
    const [score, endorsements] = await Promise.all([
      trustSystem.getTrustScore(did),
      trustSystem.getEndorsements(did),
    ]);

    return { score, endorsements };
  });
}

export async function endorseAgent(did: string, score: number, reason: string) {
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

  const client = createRelayClient({
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

  await client.start();

  try {
    return await client.queryTrust(did, options.domain);
  } finally {
    await client.stop();
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

export async function unblockAgent(did: string) {
  const client = new DaemonClient();
  if (await client.isDaemonRunning()) {
    await client.send('unblock', { did });
    return;
  }

  const storage = new MessageStorage(INBOX_DB_PATH);
  await storage.open();

  try {
    await storage.deleteBlock(did);
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
