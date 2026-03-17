import { createServer, Socket } from 'net';
import type { Server } from 'net';
import { join } from 'path';
import {
  createRelayClient,
  createRelayIndexOperations,
  importKeyPair,
  createMessageRouter,
  sign,
  verify,
  extractPublicKey,
  createEnvelope,
  signEnvelope,
  createTrustSystem,
  createAgentCard,
  signAgentCard,
  getMessageSortTimestamp,
  MessageQueue,
  DefenseMiddleware,
  type E2EDeliveryMetadata,
  type RelayClient,
  type MessageRouter,
  type RelayIndexOperations,
  type TrustSystem,
  type LocalE2EConfig,
  type MessageEnvelope,
  type SemanticQuery,
  type StoredMessage,
} from '@quadra-a/protocol';
import { createLogger } from '@quadra-a/protocol';
import type {
  DaemonRequest,
  DaemonResponse,
  DaemonSubscriptionEvent,
  E2EResetNotifyParams,
  ListPeersParams,
  PublishCardParams,
  ReachabilityPolicyResponse,
  SetReachabilityPolicyParams,
} from './daemon-types.js';
import { DaemonClient } from './daemon-client.js';
import {
  DAEMON_SOCKET_PATH,
  PEER_DAEMON_SOCKET_PATH,
  QUADRA_A_HOME,
  getLegacyDaemonSocketPath,
} from './constants.js';
import {
  getAgentCard,
  getIdentity,
  getReachabilityPolicy,
  getRelayInviteToken,
  isPublished,
  resetReachabilityPolicy,
  setAgentCard,
  updateReachabilityPolicy,
} from './config.js';
import { policyToReachabilityStatus, type ReachabilityPolicy } from './reachability.js';
import { resolvePublishedDevices, resolvePublishedPreKeyBundles } from './e2e-config.js';
import { prepareEncryptedSends } from './e2e-send.js';
import { prepareEncryptedReceive } from './e2e-receive.js';
import { withLocalE2EStateTransaction } from './e2e-state.js';
import { paginateVisibleInboxMessages } from './inbox-visibility.js';

const logger = createLogger('daemon');
const PEER_RECOVERY_DEBOUNCE_MS = 500;
const MAX_SESSION_REPLAY_ATTEMPTS = 3;

interface PendingReplayRequest {
  lookupMessageId: string;
  reason: string;
  requestedAt: number;
}

interface PendingDecryptFailure {
  transportMessageId: string;
  reason: string;
  requestedAt: number;
  threadId?: string;
}

interface PendingPeerBatch<T> {
  items: Map<string, T>;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

interface PeerRecoveryState {
  epoch: number;
  startedAt: number;
  reason: string;
  awaitingAck: boolean;
}

type RemoteRecoveryAction = 'ack' | 'resend-reset';

interface RemoteRecoveryDecision {
  action: RemoteRecoveryAction;
  state: PeerRecoveryState;
  clearAfterSend: boolean;
  cancelled: { replayRequests: number; retryNotifications: number };
  clearedCount: number;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function getInviteToken(): string | undefined {
  return process.env.QUADRA_A_INVITE_TOKEN
    ?? process.env.HW1_INVITE_TOKEN
    ?? getRelayInviteToken();
}

export class ClawDaemon {
  private relayClient: RelayClient | null = null;
  private relayIndex: RelayIndexOperations | null = null;
  private router: MessageRouter | null = null;
  private server: Server | null = null;
  private socketPath: string;
  private identity: NonNullable<ReturnType<typeof getIdentity>>;

  // Persistent queue + defense
  private queue: MessageQueue | null = null;
  private defense: DefenseMiddleware | null = null;
  private trustSystem: TrustSystem | null = null;
  private socketSubscriptions = new Map<Socket, Set<string>>();
  private peerSendLocks = new Map<string, AsyncMutex>();
  private peerSessionLocks = new Map<string, AsyncMutex>();
  private pendingReplayBatches = new Map<string, PendingPeerBatch<PendingReplayRequest>>();
  private pendingRetryNotifications = new Map<string, PendingPeerBatch<PendingDecryptFailure>>();
  private peerRecoveryStates = new Map<string, PeerRecoveryState>();
  private peerRecoveryEpochFloors = new Map<string, number>();

  constructor(socketPath: string = DAEMON_SOCKET_PATH) {
    this.socketPath = socketPath;
    const identity = getIdentity();

    if (!identity) {
      throw new Error('No identity found. Run "agent listen" to create one.');
    }

    this.identity = identity;
  }

  private getKeyPair() {
    return importKeyPair({
      publicKey: this.identity.publicKey,
      privateKey: this.identity.privateKey,
    });
  }

  private getPeerSendLock(peerDid: string): AsyncMutex {
    let mutex = this.peerSendLocks.get(peerDid);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.peerSendLocks.set(peerDid, mutex);
    }
    return mutex;
  }

  private withPeerSendLock<T>(peerDid: string, operation: () => Promise<T>): Promise<T> {
    return this.getPeerSendLock(peerDid).runExclusive(operation);
  }

  private getPeerSessionLock(peerDid: string): AsyncMutex {
    let mutex = this.peerSessionLocks.get(peerDid);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.peerSessionLocks.set(peerDid, mutex);
    }
    return mutex;
  }

  private withPeerSessionLock<T>(peerDid: string, operation: () => Promise<T>): Promise<T> {
    return this.getPeerSessionLock(peerDid).runExclusive(operation);
  }

  private getOrCreatePeerBatch<T>(
    batches: Map<string, PendingPeerBatch<T>>,
    peerDid: string,
  ): PendingPeerBatch<T> {
    let batch = batches.get(peerDid);
    if (!batch) {
      batch = {
        items: new Map<string, T>(),
        timer: null,
        running: false,
      };
      batches.set(peerDid, batch);
    }
    return batch;
  }

  private clearPendingPeerBatch<T>(
    batches: Map<string, PendingPeerBatch<T>>,
    peerDid: string,
  ): number {
    const batch = batches.get(peerDid);
    if (!batch) {
      return 0;
    }

    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    const pendingCount = batch.items.size;
    batch.items.clear();
    batches.delete(peerDid);
    return pendingCount;
  }

  private clearPendingPeerRecovery(peerDid: string): { replayRequests: number; retryNotifications: number } {
    return {
      replayRequests: this.clearPendingPeerBatch(this.pendingReplayBatches, peerDid),
      retryNotifications: this.clearPendingPeerBatch(this.pendingRetryNotifications, peerDid),
    };
  }

  private clearAllPendingRecovery(): { replayPeers: number; retryPeers: number } {
    const replayPeers = this.pendingReplayBatches.size;
    const retryPeers = this.pendingRetryNotifications.size;
    for (const batch of this.pendingReplayBatches.values()) {
      if (batch.timer) {
        clearTimeout(batch.timer);
      }
      batch.items.clear();
    }
    for (const batch of this.pendingRetryNotifications.values()) {
      if (batch.timer) {
        clearTimeout(batch.timer);
      }
      batch.items.clear();
    }
    this.pendingReplayBatches.clear();
    this.pendingRetryNotifications.clear();
    return { replayPeers, retryPeers };
  }

  private notePeerRecoveryEpoch(peerDid: string, epoch: number): void {
    const currentFloor = this.peerRecoveryEpochFloors.get(peerDid) ?? 0;
    if (epoch > currentFloor) {
      this.peerRecoveryEpochFloors.set(peerDid, epoch);
    }
  }

  private nextPeerRecoveryEpoch(peerDid: string): number {
    const floor = this.peerRecoveryEpochFloors.get(peerDid) ?? 0;
    const epoch = Math.max(Date.now(), floor + 1);
    this.peerRecoveryEpochFloors.set(peerDid, epoch);
    return epoch;
  }

  private getPeerRecoveryState(peerDid: string): PeerRecoveryState | undefined {
    return this.peerRecoveryStates.get(peerDid);
  }

  private clearPeerRecoveryState(peerDid: string, epoch?: number): boolean {
    const current = this.peerRecoveryStates.get(peerDid);
    if (!current) {
      return false;
    }
    if (epoch != null && current.epoch !== epoch) {
      return false;
    }
    this.peerRecoveryStates.delete(peerDid);
    this.notePeerRecoveryEpoch(peerDid, current.epoch);
    return true;
  }

  private clearAllPeerRecoveryStates(): number {
    const count = this.peerRecoveryStates.size;
    for (const [peerDid, recovery] of this.peerRecoveryStates.entries()) {
      this.notePeerRecoveryEpoch(peerDid, recovery.epoch);
    }
    this.peerRecoveryStates.clear();
    return count;
  }

  private async clearPersistedPeerSessions(peerDid: string): Promise<number> {
    return withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
      const cleared = this.clearPeerSessions(e2eConfig, peerDid);
      if (cleared.clearedCount > 0) {
        setE2EConfig(cleared.e2eConfig);
      }
      return cleared.clearedCount;
    });
  }

  private async beginLocalPeerRecovery(
    peerDid: string,
    reason: string,
    requestedAt = Date.now(),
  ): Promise<{
    state: PeerRecoveryState;
    started: boolean;
    cancelled: { replayRequests: number; retryNotifications: number };
    clearedCount: number;
  }> {
    const existing = this.getPeerRecoveryState(peerDid);
    if (existing) {
      return {
        state: existing,
        started: false,
        cancelled: { replayRequests: 0, retryNotifications: 0 },
        clearedCount: 0,
      };
    }

    const state: PeerRecoveryState = {
      epoch: this.nextPeerRecoveryEpoch(peerDid),
      startedAt: requestedAt,
      reason,
      awaitingAck: true,
    };
    this.peerRecoveryStates.set(peerDid, state);

    const cancelled = this.clearPendingPeerRecovery(peerDid);
    let clearedCount = 0;
    try {
      clearedCount = await this.clearPersistedPeerSessions(peerDid);
    } catch (error) {
      logger.warn('Failed to clear local E2E sessions while starting peer recovery', {
        peerDid,
        epoch: state.epoch,
        error: (error as Error).message,
      });
    }

    return {
      state,
      started: true,
      cancelled,
      clearedCount,
    };
  }

  private async handleRemotePeerRecovery(
    peerDid: string,
    epoch: number,
    reason: string,
    requestedAt = Date.now(),
  ): Promise<RemoteRecoveryDecision> {
    this.notePeerRecoveryEpoch(peerDid, epoch);
    const current = this.getPeerRecoveryState(peerDid);

    if (current && current.epoch > epoch) {
      return {
        action: current.awaitingAck ? 'resend-reset' : 'ack',
        state: current,
        clearAfterSend: !current.awaitingAck,
        cancelled: { replayRequests: 0, retryNotifications: 0 },
        clearedCount: 0,
      };
    }

    if (current && current.epoch === epoch) {
      return {
        action: 'ack',
        state: current,
        clearAfterSend: true,
        cancelled: { replayRequests: 0, retryNotifications: 0 },
        clearedCount: 0,
      };
    }

    const state: PeerRecoveryState = {
      epoch,
      startedAt: requestedAt,
      reason,
      awaitingAck: false,
    };
    this.peerRecoveryStates.set(peerDid, state);

    const cancelled = this.clearPendingPeerRecovery(peerDid);
    let clearedCount = 0;
    try {
      clearedCount = await this.clearPersistedPeerSessions(peerDid);
    } catch (error) {
      logger.warn('Failed to clear local E2E sessions while applying peer reset', {
        peerDid,
        epoch,
        error: (error as Error).message,
      });
    }

    return {
      action: 'ack',
      state,
      clearAfterSend: true,
      cancelled,
      clearedCount,
    };
  }

  private formatPeerRecoveryError(peerDid: string, recovery: PeerRecoveryState): string {
    return `Peer ${peerDid} is recovering E2E session (epoch ${recovery.epoch}, reason ${recovery.reason}); retry after session-reset-ack`;
  }

  private async commitAcceptedE2EConfig(nextE2EConfig: LocalE2EConfig): Promise<void> {
    await withLocalE2EStateTransaction(this.identity, async ({ setE2EConfig }) => {
      setE2EConfig(nextE2EConfig);
    });
  }

  private async prepareEncryptedSendsWithoutCommit(input: {
    to: string;
    protocol: string;
    payload: Record<string, unknown>;
    type?: MessageEnvelope['type'];
    replyTo?: string;
    threadId?: string;
    applicationEnvelope?: MessageEnvelope;
    baseE2EConfig?: LocalE2EConfig;
  }) {
    const keyPair = this.getKeyPair();

    if (input.baseE2EConfig) {
      return prepareEncryptedSends({
        identity: this.identity,
        keyPair,
        relayClient: this.relayClient!,
        e2eConfig: input.baseE2EConfig,
        to: input.to,
        protocol: input.protocol,
        payload: input.payload,
        type: input.type,
        replyTo: input.replyTo,
        threadId: input.threadId,
        applicationEnvelope: input.applicationEnvelope,
      });
    }

    return withLocalE2EStateTransaction(this.identity, async ({ e2eConfig }) => {
      return prepareEncryptedSends({
        identity: this.identity,
        keyPair,
        relayClient: this.relayClient!,
        e2eConfig,
        to: input.to,
        protocol: input.protocol,
        payload: input.payload,
        type: input.type,
        replyTo: input.replyTo,
        threadId: input.threadId,
        applicationEnvelope: input.applicationEnvelope,
      });
    });
  }

  private async sendEnvelopeAwaitAccepted(
    to: string,
    envelopeBytes: Uint8Array,
  ): Promise<void> {
    if (!this.relayClient) {
      throw new Error('Relay client not initialized');
    }

    if (typeof this.relayClient.sendEnvelopeAwaitAccepted === 'function') {
      await this.relayClient.sendEnvelopeAwaitAccepted(to, envelopeBytes);
      return;
    }

    await this.relayClient.sendEnvelope(to, envelopeBytes);
  }

  private async buildSignedAgentCard(cardConfig = getAgentCard()) {
    const keyPair = this.getKeyPair();
    const capabilities = (cardConfig?.capabilities ?? []).map((capability: string) => ({
      id: capability,
      name: capability,
      description: `Capability: ${capability}`,
    }));

    const devices = await resolvePublishedDevices(this.identity);

    const baseCard = createAgentCard(
      this.identity.did,
      cardConfig?.name ?? 'quadra-a Agent',
      cardConfig?.description ?? '',
      capabilities,
      [],
    );
    const agentCard = devices.length > 0
      ? { ...baseCard, devices }
      : baseCard;

    return signAgentCard(agentCard as any, (data) => sign(data, keyPair.privateKey));
  }

  private getReachabilityPolicy(): ReachabilityPolicy {
    return getReachabilityPolicy();
  }

  private buildReachabilityStatus() {
    const policy = this.getReachabilityPolicy();
    const relayStatus = this.relayClient?.getReachabilityStatus();

    return policyToReachabilityStatus(policy, relayStatus ? {
      connectedProviders: relayStatus.connectedRelays,
      knownProviders: relayStatus.knownRelays,
      lastDiscoveryAt: relayStatus.lastDiscoveryAt,
      providerFailures: relayStatus.relayFailures.map((failure) => ({
        provider: failure.provider,
        attempts: failure.attempts,
        lastFailureAt: failure.lastFailureAt,
        lastError: failure.lastError,
      })),
    } : undefined);
  }

  private clearPeerSessions(
    e2eConfig: LocalE2EConfig,
    peerDid: string,
  ): { e2eConfig: LocalE2EConfig; clearedCount: number } {
    const currentDevice = e2eConfig.devices[e2eConfig.currentDeviceId];
    if (!currentDevice) {
      return { e2eConfig, clearedCount: 0 };
    }

    const nextSessions = Object.fromEntries(
      Object.entries(currentDevice.sessions ?? {})
        .filter(([sessionKey]) => !sessionKey.startsWith(`${peerDid}:`)),
    );
    const clearedCount = Object.keys(currentDevice.sessions ?? {}).length - Object.keys(nextSessions).length;
    if (clearedCount === 0) {
      return { e2eConfig, clearedCount: 0 };
    }

    return {
      e2eConfig: {
        ...e2eConfig,
        devices: {
          ...e2eConfig.devices,
          [e2eConfig.currentDeviceId]: {
            ...currentDevice,
            sessions: nextSessions,
          },
        },
      },
      clearedCount,
    };
  }

  private buildLocalDiagnosticEnvelope(
    from: string,
    protocol: string,
    payload: Record<string, unknown>,
    timestamp = Date.now(),
  ): MessageEnvelope {
    const envelope = createEnvelope(
      from,
      this.identity.did,
      'message',
      protocol,
      payload,
    );

    return {
      ...envelope,
      timestamp,
      signature: 'local-diagnostic',
    };
  }

  private async sendSessionReset(
    to: string,
    reason: string,
    epoch: number,
    timestamp = Date.now(),
  ): Promise<void> {
    if (!this.router) {
      throw new Error('Router not initialized');
    }

    await this.withPeerSendLock(to, async () => {
      const resetEnvelope = createEnvelope(
        this.identity.did,
        to,
        'message',
        'e2e/session-reset',
        {
          from: this.identity.did,
          to,
          reason,
          epoch,
          timestamp,
        },
      );
      const signedEnvelope = await signEnvelope(resetEnvelope, (data) => sign(data, this.getKeyPair().privateKey));
      await this.router!.sendMessage(signedEnvelope);
    });
  }

  private async sendSessionResetAck(
    to: string,
    epoch: number,
    reason: string,
    timestamp = Date.now(),
  ): Promise<void> {
    if (!this.router) {
      throw new Error('Router not initialized');
    }

    await this.withPeerSendLock(to, async () => {
      const ackEnvelope = createEnvelope(
        this.identity.did,
        to,
        'message',
        'e2e/session-reset-ack',
        {
          from: this.identity.did,
          to,
          reason,
          epoch,
          timestamp,
        },
      );
      const signedEnvelope = await signEnvelope(ackEnvelope, (data) => sign(data, this.getKeyPair().privateKey));
      await this.router!.sendMessage(signedEnvelope);
    });
  }

  private async sendSessionRetry(
    to: string,
    messageId: string,
    reason: string,
    failedTransport: 'session',
    timestamp = Date.now(),
    threadId?: string,
  ): Promise<void> {
    if (!this.router) {
      throw new Error('Router not initialized');
    }

    const retryEnvelope = createEnvelope(
      this.identity.did,
      to,
      'message',
      'e2e/session-retry',
      {
        from: this.identity.did,
        to,
        messageId,
        reason,
        failedTransport,
        timestamp,
        ...(threadId ? { threadId } : {}),
      },
    );
    const signedEnvelope = await signEnvelope(retryEnvelope, (data) => sign(data, this.getKeyPair().privateKey));
    await this.router.sendMessage(signedEnvelope);
  }

  private shouldFallbackToPlaintext(error: unknown): boolean {
    const message = (error as Error)?.message ?? String(error);
    return (
      message.startsWith('No Agent Card found for ')
      || message.includes('does not publish any E2E devices')
      || message.includes('No claimed pre-key bundle available')
    );
  }

  private async lookupOutboundMessageForRecovery(
    peerDid: string,
    lookupMessageId: string,
  ): Promise<StoredMessage | null> {
    if (!this.queue || !this.relayClient) {
      return null;
    }

    const directMatch = await this.queue.getOutboundMessage(lookupMessageId);
    if (directMatch?.envelope.to === peerDid) {
      return directMatch;
    }

    if (typeof this.queue.getOutboundMessageByTransportMessageId === 'function') {
      const transportMatch = await this.queue.getOutboundMessageByTransportMessageId(lookupMessageId);
      if (transportMatch?.envelope.to === peerDid) {
        return transportMatch;
      }
    }

    return null;
  }

  private schedulePeerReplay(peerDid: string, request: PendingReplayRequest): void {
    const batch = this.getOrCreatePeerBatch(this.pendingReplayBatches, peerDid);
    batch.items.set(request.lookupMessageId, request);
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    batch.timer = setTimeout(() => {
      void this.flushPeerReplay(peerDid);
    }, PEER_RECOVERY_DEBOUNCE_MS);
  }

  // @ts-ignore TS6133 — reserved for future use in peer recovery flow
  private schedulePeerRetryNotification(peerDid: string, failure: PendingDecryptFailure): void {
    const batch = this.getOrCreatePeerBatch(this.pendingRetryNotifications, peerDid);
    batch.items.set(failure.transportMessageId, failure);
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    batch.timer = setTimeout(() => {
      void this.flushPeerRetryNotification(peerDid);
    }, PEER_RECOVERY_DEBOUNCE_MS);
  }

  private async flushPeerReplay(peerDid: string): Promise<void> {
    const batch = this.pendingReplayBatches.get(peerDid);
    if (!batch || batch.running) {
      return;
    }

    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    const requests = [...batch.items.values()]
      .sort((left, right) => left.requestedAt - right.requestedAt);
    batch.items.clear();
    batch.running = true;

    try {
      await this.replayOutboundMessages(peerDid, requests);
    } catch (error) {
      logger.warn('Failed to replay outbound batch after session retry', {
        peerDid,
        requestCount: requests.length,
        error: (error as Error).message,
      });
    } finally {
      batch.running = false;
      if (batch.items.size > 0) {
        batch.timer = setTimeout(() => {
          void this.flushPeerReplay(peerDid);
        }, PEER_RECOVERY_DEBOUNCE_MS);
      } else if (!batch.timer) {
        this.pendingReplayBatches.delete(peerDid);
      }
    }
  }

  private async flushPeerRetryNotification(peerDid: string): Promise<void> {
    const batch = this.pendingRetryNotifications.get(peerDid);
    if (!batch || batch.running) {
      return;
    }

    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    const failures = [...batch.items.values()]
      .sort((left, right) => left.requestedAt - right.requestedAt);
    batch.items.clear();
    batch.running = true;

    try {
      await this.sendPeerRetryNotifications(peerDid, failures);
    } catch (error) {
      logger.warn('Failed to send batched session retry notifications', {
        peerDid,
        failureCount: failures.length,
        error: (error as Error).message,
      });
    } finally {
      batch.running = false;
      if (batch.items.size > 0) {
        batch.timer = setTimeout(() => {
          void this.flushPeerRetryNotification(peerDid);
        }, PEER_RECOVERY_DEBOUNCE_MS);
      } else if (!batch.timer) {
        this.pendingRetryNotifications.delete(peerDid);
      }
    }
  }

  private async replayOutboundMessages(
    peerDid: string,
    requests: PendingReplayRequest[],
  ): Promise<void> {
    if (!this.queue || !this.relayClient || requests.length === 0) {
      return;
    }

    const queue = this.queue; // Capture for type narrowing in nested callbacks

    await this.withPeerSessionLock(peerDid, async () => {
      await this.withPeerSendLock(peerDid, async () => {
        let recoveryBaseE2EConfig = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
          const cleared = this.clearPeerSessions(e2eConfig, peerDid);
          if (cleared.clearedCount > 0) {
            setE2EConfig(cleared.e2eConfig);
          }
          return cleared.e2eConfig;
        });

        for (const request of requests) {
          const original = await this.lookupOutboundMessageForRecovery(peerDid, request.lookupMessageId);
          if (!original) {
            logger.info('Ignoring session retry for unknown outbound message', {
              peerDid,
              messageId: request.lookupMessageId,
            });
            continue;
          }

          const storedMessageId = original.envelope.id;
          const replayCount = original.e2e?.retry?.replayCount ?? 0;
          await queue.appendE2ERetry(storedMessageId, {
            replayCount,
            lastRequestedAt: request.requestedAt,
            lastReason: request.reason,
          });
          if (replayCount >= MAX_SESSION_REPLAY_ATTEMPTS) {
            logger.info('Ignoring repeated session retry for replay budget exhaustion', {
              peerDid,
              messageId: storedMessageId,
              replayCount,
            });
            continue;
          }

          const applicationEnvelope = original.envelope;
          const prepared = await this.prepareEncryptedSendsWithoutCommit({
            to: applicationEnvelope.to,
            protocol: applicationEnvelope.protocol,
            payload: (applicationEnvelope.payload ?? {}) as Record<string, unknown>,
            type: applicationEnvelope.type,
            replyTo: applicationEnvelope.replyTo,
            threadId: applicationEnvelope.threadId,
            applicationEnvelope,
            baseE2EConfig: recoveryBaseE2EConfig,
          });

          let lastReplayedAt: number | undefined;
          let sentAny = false;

          for (const target of prepared.targets) {
            const recordedAt = Date.now();
            const delivery: E2EDeliveryMetadata = {
              transport: target.transport,
              transportMessageId: target.outerEnvelope.id,
              senderDeviceId: target.senderDeviceId,
              receiverDeviceId: target.recipientDeviceId,
              sessionId: target.sessionId,
              state: 'pending',
              recordedAt,
            };
            await queue.appendE2EDelivery(storedMessageId, delivery);
            try {
              await this.sendEnvelopeAwaitAccepted(peerDid, target.outerEnvelopeBytes);
              if (target.configAfterSend) {
                await this.commitAcceptedE2EConfig(target.configAfterSend);
                recoveryBaseE2EConfig = target.configAfterSend;
              }
              await queue.appendE2EDelivery(storedMessageId, {
                ...delivery,
                state: 'sent',
                recordedAt: Date.now(),
                error: undefined,
              });
              lastReplayedAt = recordedAt;
              sentAny = true;
            } catch (error) {
              await queue.appendE2EDelivery(storedMessageId, {
                ...delivery,
                state: 'failed',
                recordedAt: Date.now(),
                error: (error as Error).message,
              });
              throw error;
            }
          }

          if (sentAny) {
            await queue.appendE2ERetry(storedMessageId, {
              replayCount: replayCount + 1,
              lastRequestedAt: request.requestedAt,
              lastReplayedAt,
              lastReason: request.reason,
            });
            recoveryBaseE2EConfig = prepared.e2eConfig;
          }

          logger.info('Replayed outbound message after signed session retry', {
            peerDid,
            messageId: storedMessageId,
            targetCount: prepared.targets.length,
          });
        }
      });
    });
  }

  private async sendPeerRetryNotifications(
    peerDid: string,
    failures: PendingDecryptFailure[],
  ): Promise<void> {
    if (!this.router || failures.length === 0) {
      return;
    }

    await this.withPeerSessionLock(peerDid, async () => {
      await this.withPeerSendLock(peerDid, async () => {
        const clearedCount = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
          const cleared = this.clearPeerSessions(e2eConfig, peerDid);
          if (cleared.clearedCount > 0) {
            setE2EConfig(cleared.e2eConfig);
          }
          return cleared.clearedCount;
        });

        for (const failure of failures) {
          await this.sendSessionRetry(
            peerDid,
            failure.transportMessageId,
            failure.reason,
            'session',
            failure.requestedAt,
            failure.threadId,
          );
        }

        logger.warn('Batched E2E session retry notifications after decrypt failure', {
          peerDid,
          clearedCount,
          failureCount: failures.length,
        });
      });
    });
  }

  private async stopRelayStack(): Promise<void> {
    if (this.router) {
      await this.router.stop();
      this.router = null;
    }

    if (this.relayClient) {
      await this.relayClient.stop();
      this.relayClient = null;
    }

    this.relayIndex = null;
  }

  private async publishDiscoveryState(signedCard: Awaited<ReturnType<ClawDaemon['buildSignedAgentCard']>>): Promise<void> {
    if (!this.relayClient) {
      throw new Error('Relay client not initialized');
    }

    const preKeyBundles = await resolvePublishedPreKeyBundles(this.identity);
    if (preKeyBundles.length > 0) {
      await this.relayClient.publishPreKeyBundles(preKeyBundles);
    }

    await this.relayClient.publishCard(signedCard);
  }

  private async startRelayStack(): Promise<void> {
    const keyPair = this.getKeyPair();
    const signedCard = await this.buildSignedAgentCard();
    const policy = this.getReachabilityPolicy();

    this.relayClient = createRelayClient({
      relayUrls: policy.bootstrapProviders,
      inviteToken: getInviteToken(),
      did: this.identity.did,
      keyPair,
      card: signedCard,
      autoDiscoverRelays: policy.mode === 'adaptive' && policy.autoDiscoverProviders,
      targetRelayCount: policy.mode === 'adaptive' ? policy.targetProviderCount : policy.bootstrapProviders.length,
    });

    await this.relayClient.start();
    logger.info('Relay client started', {
      relays: this.relayClient.getConnectedRelays(),
      knownRelays: this.relayClient.getKnownRelays(),
      mode: policy.mode,
    });

    if (isPublished()) {
      await this.publishDiscoveryState(signedCard);
      logger.info('Agent card published on daemon start', { did: this.identity.did });
    }

    this.relayIndex = createRelayIndexOperations(this.relayClient);

    const verifyFn = async (signature: Uint8Array, data: Uint8Array): Promise<boolean> => {
      try {
        const decoded = JSON.parse(new TextDecoder().decode(data)) as { from?: string };
        if (!decoded.from || typeof decoded.from !== 'string') return false;
        const senderPublicKey = extractPublicKey(decoded.from);
        return verify(signature, data, senderPublicKey);
      } catch {
        return false;
      }
    };

    this.router = createMessageRouter(this.relayClient, verifyFn);
    await this.router.start();
    logger.info('Router started');

    this.router.registerCatchAllHandler(async (envelope) => {
      return await this.handleIncomingMessage(envelope);
    });
  }

  private async restartRelayStack(): Promise<void> {
    await this.stopRelayStack();
    await this.startRelayStack();
  }

  private cleanupSocketSubscriptions(socket: Socket): void {
    if (!this.queue) {
      this.socketSubscriptions.delete(socket);
      return;
    }

    const subscriptionIds = this.socketSubscriptions.get(socket);
    if (!subscriptionIds) {
      return;
    }

    for (const subscriptionId of subscriptionIds) {
      this.queue.unsubscribe(subscriptionId);
    }

    this.socketSubscriptions.delete(socket);
  }

  private async searchAgents(params: Record<string, unknown> = {}) {
    if (!this.relayIndex) {
      throw new Error('Relay index not initialized');
    }

    const queryValue = params.query;
    const queryObject = typeof queryValue === 'object' && queryValue !== null
      ? queryValue as Record<string, unknown>
      : undefined;

    const semanticQuery: SemanticQuery = typeof queryValue === 'string'
      ? {
          text: queryValue,
          capability: typeof params.capability === 'string' ? params.capability : undefined,
          filters: typeof params.filters === 'object' && params.filters !== null
            ? params.filters as SemanticQuery['filters']
            : undefined,
          limit: typeof params.limit === 'number' ? params.limit : undefined,
        }
      : {
          ...(queryObject ?? {}),
          text: typeof queryObject?.text === 'string' ? queryObject.text : undefined,
          capability: typeof queryObject?.capability === 'string'
            ? queryObject.capability
            : typeof params.capability === 'string'
              ? params.capability
              : undefined,
          filters: typeof queryObject?.filters === 'object' && queryObject.filters !== null
            ? queryObject.filters as SemanticQuery['filters']
            : typeof params.filters === 'object' && params.filters !== null
              ? params.filters as SemanticQuery['filters']
              : undefined,
          limit: typeof queryObject?.limit === 'number'
            ? queryObject.limit
            : typeof params.limit === 'number'
              ? params.limit
              : undefined,
        };

    return this.relayIndex.searchSemantic(semanticQuery);
  }

  async start(): Promise<void> {
    try {
      logger.info('Starting quadra-a daemon', { socketPath: this.socketPath });

      // Clean up stale socket file
      const { existsSync, unlinkSync } = await import('fs');
      for (const peerSocketPath of [PEER_DAEMON_SOCKET_PATH, getLegacyDaemonSocketPath('rs')]) {
        if (existsSync(peerSocketPath)) {
          const peerClient = new DaemonClient(peerSocketPath);
          if (await peerClient.isDaemonRunning()) {
            throw new Error(
              `Another a4 daemon is already running at ${peerSocketPath}. ` +
              `Set a different QUADRA_A_HOME or stop the existing daemon first.`,
            );
          }
        }
      }
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }

      await this.startRelayStack();

      // Initialize trust system
      const dataDir = QUADRA_A_HOME;
      this.trustSystem = createTrustSystem({
        dbPath: join(dataDir, 'trust'),
        getPublicKey: async (did: string) => extractPublicKey(did),
      });
      await this.trustSystem.start();
      logger.info('Trust system started');

      // Initialize message queue (LevelDB persistence per CVP-0010 §2.3)
      this.queue = new MessageQueue({
        dbPath: join(dataDir, 'inbox'),
      });
      await this.queue.start();
      logger.info('Message queue started');

      // Initialize defense middleware
      this.defense = new DefenseMiddleware({
        trustSystem: this.trustSystem,
        storage: this.queue.store,
        minTrustScore: 0,
      });
      logger.info('Defense middleware initialized');

      // Create IPC server
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.listen(this.socketPath);
      logger.info('Daemon listening', { socketPath: this.socketPath });

      console.log(`✓ quadra-a daemon started`);
      console.log(`  Socket: ${this.socketPath}`);
      console.log(`  Relays: ${this.relayClient?.getConnectedRelays().join(', ') ?? ''}`);
      console.log(`  DID: ${this.identity.did}`);
    } catch (error) {
      logger.error('Failed to start daemon', error);
      throw error;
    }
  }

  private async handleIncomingMessage(envelope: MessageEnvelope): Promise<MessageEnvelope | void> {
    if (
      envelope.protocol === 'e2e/session-reset'
      || envelope.protocol === 'e2e/session-reset-ack'
      || envelope.protocol === 'e2e/session-retry'
      || envelope.protocol === '/agent/e2e/1.0.0'
    ) {
      return await this.withPeerSessionLock(envelope.from, async () => {
        return await this.handleIncomingMessageWithPeerLock(envelope);
      });
    }

    return await this.handleIncomingMessageWithPeerLock(envelope);
  }

  private async handleIncomingMessageWithPeerLock(envelope: MessageEnvelope): Promise<MessageEnvelope | void> {
    if (!this.defense || !this.queue || !this.trustSystem) return;

    if (envelope.protocol === 'e2e/session-reset') {
      const payload = typeof envelope.payload === 'object' && envelope.payload !== null
        ? envelope.payload as Record<string, unknown>
        : null;
      const reason = typeof payload?.reason === 'string' ? payload.reason : 'decrypt-failed';
      const timestamp = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now();
      const epoch = typeof payload?.epoch === 'number'
        ? payload.epoch
        : timestamp;
      const decision = await this.handleRemotePeerRecovery(envelope.from, epoch, reason, timestamp);

      try {
        if (decision.action === 'resend-reset') {
          await this.sendSessionReset(
            envelope.from,
            decision.state.reason,
            decision.state.epoch,
            Date.now(),
          );
        } else {
          await this.sendSessionResetAck(
            envelope.from,
            decision.state.epoch,
            decision.state.reason,
            Date.now(),
          );
        }
        if (decision.clearAfterSend) {
          this.clearPeerRecoveryState(envelope.from, decision.state.epoch);
        }
      } catch (error) {
        logger.warn('Failed to respond to peer E2E session reset', {
          from: envelope.from,
          epoch: decision.state.epoch,
          error: (error as Error).message,
        });
      }

      if (decision.clearedCount > 0 || decision.cancelled.replayRequests > 0 || decision.cancelled.retryNotifications > 0) {
        logger.info('E2E session reset by peer', {
          from: envelope.from,
          epoch: decision.state.epoch,
          clearedCount: decision.clearedCount,
          cancelledReplayRequests: decision.cancelled.replayRequests,
          cancelledRetryNotifications: decision.cancelled.retryNotifications,
          action: decision.action,
        });
      }
      return;
    }

    if (envelope.protocol === 'e2e/session-reset-ack') {
      const payload = typeof envelope.payload === 'object' && envelope.payload !== null
        ? envelope.payload as Record<string, unknown>
        : null;
      const timestamp = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now();
      const epoch = typeof payload?.epoch === 'number'
        ? payload.epoch
        : timestamp;
      const cleared = this.clearPeerRecoveryState(envelope.from, epoch);
      if (cleared) {
        logger.info('Peer acknowledged E2E session reset', {
          from: envelope.from,
          epoch,
        });
      } else {
        logger.info('Ignoring stale E2E session reset acknowledgement', {
          from: envelope.from,
          epoch,
        });
      }
      return;
    }

    if (envelope.protocol === 'e2e/session-retry') {
      if (this.getPeerRecoveryState(envelope.from)) {
        logger.info('Ignoring session retry while peer recovery barrier is active', {
          from: envelope.from,
        });
        return;
      }

      const payload = typeof envelope.payload === 'object' && envelope.payload !== null
        ? envelope.payload as Record<string, unknown>
        : null;
      const messageId = typeof payload?.messageId === 'string' ? payload.messageId : null;
      const reason = typeof payload?.reason === 'string' ? payload.reason : 'decrypt-failed';
      const failedTransport = typeof payload?.failedTransport === 'string' ? payload.failedTransport : 'session';
      const timestamp = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now();
      if (!messageId || failedTransport !== 'session') {
        logger.warn('Ignoring malformed session retry envelope', {
          from: envelope.from,
          id: envelope.id,
        });
        return;
      }

      this.schedulePeerReplay(envelope.from, {
        lookupMessageId: messageId,
        reason,
        requestedAt: timestamp,
      });
      return;
    }

    // Attempt E2E decryption if this is an encrypted transport envelope
    let decryptedEnvelope = envelope;
    let inboundE2EDelivery: E2EDeliveryMetadata | undefined;
    if (envelope.protocol === '/agent/e2e/1.0.0') {
      const recovery = this.getPeerRecoveryState(envelope.from);
      if (recovery) {
        logger.warn('Dropping inbound E2E transport while peer recovery barrier is active', {
          id: envelope.id,
          from: envelope.from,
          epoch: recovery.epoch,
          awaitingAck: recovery.awaitingAck,
        });
        return;
      }

      try {
        const result = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
          const decrypted = await prepareEncryptedReceive({
            receiverDid: this.identity.did,
            e2eConfig,
            transportEnvelope: envelope,
          });
          setE2EConfig(decrypted.e2eConfig);
          return decrypted;
        });
        decryptedEnvelope = result.applicationEnvelope;
        inboundE2EDelivery = {
          transport: result.transport,
          senderDeviceId: result.senderDeviceId,
          receiverDeviceId: result.receiverDeviceId,
          sessionId: result.sessionId,
          state: 'received',
          recordedAt: Date.now(),
          usedSkippedMessageKey: result.usedSkippedMessageKey,
        };
        logger.info('E2E decrypted inbound message', {
          id: decryptedEnvelope.id,
          from: decryptedEnvelope.from,
          transport: result.transport,
        });
      } catch (error) {
        const requestedAt = Date.now();
        const recovery = await this.beginLocalPeerRecovery(
          envelope.from,
          'decrypt-failed',
          requestedAt,
        );
        await this.queue.enqueueInbound(
          this.buildLocalDiagnosticEnvelope(
            envelope.from,
            'e2e/decrypt-failed',
            {
              error: (error as Error).message,
              epoch: recovery.state.epoch,
              hint: 'Peer moved to explicit session recovery. Normal sends are blocked until reset-ack arrives.',
            },
          ),
        );

        if (recovery.started) {
          try {
            await this.sendSessionReset(
              envelope.from,
              recovery.state.reason,
              recovery.state.epoch,
              requestedAt,
            );
          } catch (sendError) {
            logger.warn('Failed to send E2E session reset after decrypt failure', {
              from: envelope.from,
              epoch: recovery.state.epoch,
              error: (sendError as Error).message,
            });
          }
        }

        logger.warn('E2E decrypt failed, entered explicit recovery barrier', {
          id: envelope.id,
          from: envelope.from,
          epoch: recovery.state.epoch,
          startedRecovery: recovery.started,
          error: (error as Error).message,
        });
        return;
      }
    }

    const solicitedReply = await this.isSolicitedReply(decryptedEnvelope);
    const checkMessage = this.defense.checkMessage.bind(this.defense) as (
      envelope: MessageEnvelope,
      options?: { solicitedReply?: boolean },
    ) => ReturnType<DefenseMiddleware['checkMessage']>;
    const result = await checkMessage(decryptedEnvelope, { solicitedReply });
    if (!result.allowed) {
      if (result.reason === 'duplicate' && inboundE2EDelivery) {
        const merged = await this.queue.appendE2EDelivery(decryptedEnvelope.id, inboundE2EDelivery);
        if (merged) {
          logger.info('Merged duplicate inbound E2E delivery metadata', {
            id: decryptedEnvelope.id,
            from: decryptedEnvelope.from,
            receiverDeviceId: inboundE2EDelivery.receiverDeviceId,
          });
          return;
        }

        await this.queue.enqueueInbound(
          decryptedEnvelope,
          result.trustScore,
          result.trustStatus,
          inboundE2EDelivery,
        );
        logger.info('Queued duplicate inbound E2E message before base record was visible', {
          id: decryptedEnvelope.id,
          from: decryptedEnvelope.from,
          receiverDeviceId: inboundE2EDelivery.receiverDeviceId,
        });
        return;
      }

      logger.warn('Message rejected by defense', {
        id: envelope.id,
        reason: result.reason,
        solicitedReply,
        replyTo: decryptedEnvelope.replyTo,
      });

      // Record interaction failures for all meaningful rejection reasons
      if (result.reason === 'rate_limited' || result.reason === 'blocked' || result.reason === 'trust_too_low') {
        await this.trustSystem.recordInteraction({
          agentDid: envelope.from,
          timestamp: Date.now(),
          type: 'message',
          success: false,
          responseTime: 0,
          failureReason: result.reason,
        });
      }
      return;
    }

    await this.queue.enqueueInbound(
      decryptedEnvelope,
      result.trustScore,
      result.trustStatus,
      inboundE2EDelivery,
    );

    await this.trustSystem.recordInteraction({
      agentDid: decryptedEnvelope.from,
      timestamp: Date.now(),
      type: 'message',
      success: true,
      responseTime: 0,
    });

    logger.info('Message queued', { id: decryptedEnvelope.id, from: decryptedEnvelope.from });
  }

  private async isSolicitedReply(envelope: MessageEnvelope): Promise<boolean> {
    if (!this.queue || !envelope.replyTo) {
      return false;
    }

    const outbound = await this.queue.getOutboundMessage(envelope.replyTo);
    if (!outbound) {
      return false;
    }

    return outbound.envelope.to === envelope.from;
  }

  private handleConnection(socket: Socket): void {
    let buffer = '';

    socket.on('close', () => {
      this.cleanupSocketSubscriptions(socket);
    });

    socket.on('data', async (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request: DaemonRequest = JSON.parse(line);
          logger.debug('Received request', { command: request.command, id: request.id });
          const response = await this.handleRequest(request, socket);
          if (!socket.destroyed) {
            socket.write(JSON.stringify(response) + '\n');
          }
        } catch (error) {
          const errorResponse: DaemonResponse = {
            id: 'unknown',
            success: false,
            error: (error as Error).message,
          };
          if (!socket.destroyed) {
            socket.write(JSON.stringify(errorResponse) + '\n');
          }
        }
      }

      if (buffer.trim()) {
        try {
          const request: DaemonRequest = JSON.parse(buffer);
          buffer = '';
          logger.debug('Received request', { command: request.command, id: request.id });
          const response = await this.handleRequest(request, socket);
          if (!socket.destroyed) {
            socket.write(JSON.stringify(response) + '\n');
          }
        } catch {
          // Not complete JSON yet, keep buffering
        }
      }
    });

    socket.on('error', (error) => {
      this.cleanupSocketSubscriptions(socket);
      logger.warn('Socket error', { error: error.message });
    });
  }

  private async handleRequest(req: DaemonRequest, socket: Socket): Promise<DaemonResponse> {
    try {
      switch (req.command) {
        case 'send':       return await this.handleSend(req);
        case 'discover':   return await this.handleDiscover(req);
        case 'status':     return await this.handleStatus(req);
        case 'messages':   return await this.handleMessages(req);
        case 'get_card':   return this.handleGetCard(req);
        case 'query_agent_card': return await this.handleQueryAgentCard(req);
        case 'query-card': return await this.handleQueryCard(req);
        case 'publish_card': return await this.handlePublishCard(req);
        case 'list_peers': return await this.handleListPeers(req);
        case 'peers': return await this.handlePeers(req);
        case 'shutdown':
        case 'stop':
          await this.shutdown();
          return { id: req.id, success: true };

        case 'inbox':        return await this.handleInbox(req);
        case 'get_message':  return await this.handleGetMessage(req);
        case 'mark_read':    return await this.handleMarkRead(req);
        case 'delete_message': return await this.handleDeleteMessage(req);
        case 'outbox':       return await this.handleOutbox(req);
        case 'retry_message': return await this.handleRetryMessage(req);

        case 'block':      return await this.handleBlock(req);
        case 'unblock':    return await this.handleUnblock(req);
        case 'block_agent': return await this.handleBlockAgent(req);
        case 'allowlist':  return await this.handleAllowlist(req);

        case 'queue_stats': return await this.handleQueueStats(req);

        case 'sessions':         return await this.handleSessions(req);
        case 'session_messages': return await this.handleSessionMessages(req);
        case 'archive_session':  return await this.handleArchiveSession(req);
        case 'unarchive_session': return await this.handleUnarchiveSession(req);
        case 'search_sessions':  return await this.handleSearchSessions(req);
        case 'export_session':   return await this.handleExportSession(req);
        case 'session_stats':    return await this.handleSessionStats(req);
        case 'subscribe_inbox': return await this.handleSubscribeInbox(req, socket);
        case 'unsubscribe': return this.handleUnsubscribe(req, socket);

        case 'trust_score': return await this.handleTrustScore(req);
        case 'create_endorsement': return await this.handleCreateEndorsement(req);
        case 'query_endorsements': return await this.handleQueryEndorsements(req);
        case 'endorsements': return await this.handleQueryEndorsements(req);
        case 'get_reachability_policy': return this.handleGetReachabilityPolicy(req);
        case 'set_reachability_policy': return await this.handleSetReachabilityPolicy(req);
        case 'reset_reachability_policy': return await this.handleResetReachabilityPolicy(req);
        case 'get_reachability_status': return this.handleGetReachabilityStatus(req);
        case 'e2e-reset-notify':
          return await this.handleE2EResetNotify(req as DaemonRequest<E2EResetNotifyParams>);
        case 'reload-e2e': return await this.handleReloadE2E(req);

        default:
          return { id: req.id, success: false, error: 'Unknown command' };
      }
    } catch (error) {
      logger.error('Request handler error', { command: req.command, error });
      return { id: req.id, success: false, error: (error as Error).message };
    }
  }

  private async handleSend(req: DaemonRequest): Promise<DaemonResponse> {
    const { to, protocol, payload, type, replyTo, threadId } = req.params;

    if (!this.relayClient) {
      return { id: req.id, success: false, error: 'Relay client not initialized' };
    }

    const keyPair = this.getKeyPair();

    try {
      return await this.withPeerSessionLock(to, async () => {
        return await this.withPeerSendLock(to, async () => {
          const recovery = this.getPeerRecoveryState(to);
          if (recovery) {
            return {
              id: req.id,
              success: false,
              error: this.formatPeerRecoveryError(to, recovery),
            };
          }

          try {
            const encrypted = await this.prepareEncryptedSendsWithoutCommit({
              to,
              protocol: protocol ?? '/agent/msg/1.0.0',
              payload,
              type: type || 'message',
              replyTo,
              threadId,
            });

            const applicationEnvelope = encrypted.applicationEnvelope;

            const e2eDeliveries: E2EDeliveryMetadata[] = encrypted.targets.map((target) => ({
              transport: target.transport,
              transportMessageId: target.outerEnvelope.id,
              senderDeviceId: target.senderDeviceId,
              receiverDeviceId: target.recipientDeviceId,
              sessionId: target.sessionId,
              state: 'pending',
              recordedAt: Date.now(),
            }));

            if (this.queue) {
              await this.queue.enqueueOutbound(applicationEnvelope, e2eDeliveries);
            }

            for (const target of encrypted.targets) {
              const pendingDelivery: E2EDeliveryMetadata = {
                transport: target.transport,
                transportMessageId: target.outerEnvelope.id,
                senderDeviceId: target.senderDeviceId,
                receiverDeviceId: target.recipientDeviceId,
                sessionId: target.sessionId,
                state: 'pending',
                recordedAt: Date.now(),
              };

              try {
                await this.sendEnvelopeAwaitAccepted(to, target.outerEnvelopeBytes);
                if (target.configAfterSend) {
                  await this.commitAcceptedE2EConfig(target.configAfterSend);
                }
                if (this.queue) {
                  await this.queue.appendE2EDelivery(applicationEnvelope.id, {
                    ...pendingDelivery,
                    state: 'sent',
                    recordedAt: Date.now(),
                    error: undefined,
                  });
                }
              } catch (error) {
                if (this.queue) {
                  await this.queue.appendE2EDelivery(applicationEnvelope.id, {
                    ...pendingDelivery,
                    state: 'failed',
                    recordedAt: Date.now(),
                    error: (error as Error).message,
                  });
                  await this.queue.markOutboundFailed(applicationEnvelope.id, (error as Error).message);
                }
                throw error;
              }
            }

            if (this.queue) {
              await this.queue.markOutboundDelivered(applicationEnvelope.id);
            }

            return {
              id: req.id,
              success: true,
              data: { id: applicationEnvelope.id },
            };
          } catch (e2eError) {
            if (!this.shouldFallbackToPlaintext(e2eError)) {
              return {
                id: req.id,
                success: false,
                error: (e2eError as Error).message,
              };
            }

            const envelope = createEnvelope(
              this.identity.did,
              to,
              type || 'message',
              protocol,
              payload,
              replyTo,
              threadId,
            );

            const signedEnvelope = await signEnvelope(envelope, (data) =>
              sign(data, keyPair.privateKey)
            );

            if (this.queue) {
              await this.queue.enqueueOutbound(signedEnvelope);
            }

            if (this.router) {
              await this.router.sendMessage(signedEnvelope);
            }

            if (this.queue) {
              await this.queue.markOutboundDelivered(signedEnvelope.id);
            }

            return {
              id: req.id,
              success: true,
              data: { id: signedEnvelope.id },
            };
          }
        });
      });
    } catch (e2eError) {
      return {
        id: req.id,
        success: false,
        error: (e2eError as Error).message,
      };
    }
  }

  private async handleReloadE2E(req: DaemonRequest): Promise<DaemonResponse> {
    const cancelled = this.clearAllPendingRecovery();
    const clearedRecoveringPeers = this.clearAllPeerRecoveryStates();
    const result = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig }) => {
      const currentDevice = e2eConfig.devices[e2eConfig.currentDeviceId];
      return {
        deviceId: e2eConfig.currentDeviceId,
        sessionCount: Object.keys(currentDevice?.sessions ?? {}).length,
        cancelledReplayPeers: cancelled.replayPeers,
        cancelledRetryPeers: cancelled.retryPeers,
        clearedRecoveringPeers,
      };
    });

    return {
      id: req.id,
      success: true,
      data: result,
    };
  }

  private async handleE2EResetNotify(
    req: DaemonRequest<E2EResetNotifyParams>,
  ): Promise<DaemonResponse<{ notified: string[]; failed: Array<{ peer: string; error: string }> }>> {
    const peers = Array.isArray(req.params?.peers)
      ? [...new Set(req.params.peers.map((peer) => peer.trim()).filter(Boolean))]
      : [];
    const notified: string[] = [];
    const failed: Array<{ peer: string; error: string }> = [];

    for (const peer of peers) {
      await this.withPeerSessionLock(peer, async () => {
        const recovery = await this.beginLocalPeerRecovery(peer, 'manual-reset');
        try {
          await this.sendSessionReset(peer, 'manual-reset', recovery.state.epoch);
          notified.push(peer);
        } catch (error) {
          failed.push({
            peer,
            error: (error as Error).message,
          });
        }
      });
    }

    return {
      id: req.id,
      success: true,
      data: {
        notified,
        failed,
      },
    };
  }

  private async handleDiscover(req: DaemonRequest): Promise<DaemonResponse> {
    const results = await this.searchAgents(req.params || {});
    return { id: req.id, success: true, data: results };
  }

  private handleGetCard(req: DaemonRequest): DaemonResponse {
    return {
      id: req.id,
      success: true,
      data: getAgentCard() ?? null,
    };
  }

  private async handleQueryAgentCard(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.relayIndex) {
      return { id: req.id, success: false, error: 'Relay index not initialized' };
    }

    const did = typeof req.params?.did === 'string' ? req.params.did : undefined;
    if (!did) {
      return { id: req.id, success: false, error: 'Missing did parameter' };
    }

    const card = await this.relayIndex.queryAgentCard(did);
    return {
      id: req.id,
      success: true,
      data: card,
    };
  }

  private async handleQueryCard(req: DaemonRequest): Promise<DaemonResponse> {
    const response = await this.handleQueryAgentCard(req);
    if (!response.success) {
      return response;
    }

    return {
      id: req.id,
      success: true,
      data: {
        card: response.data ?? null,
      },
    };
  }

  private async handlePublishCard(req: DaemonRequest<PublishCardParams>): Promise<DaemonResponse> {
    if (!this.relayClient) {
      return { id: req.id, success: false, error: 'Relay client not initialized' };
    }

    const currentCard = getAgentCard();
    const capabilities = Array.isArray(req.params?.capabilities)
      ? req.params.capabilities.map((capability) => capability.trim()).filter(Boolean)
      : currentCard?.capabilities ?? [];

    const nextCard = {
      name: req.params?.name ?? currentCard?.name ?? 'quadra-a Agent',
      description: req.params?.description ?? currentCard?.description ?? '',
      capabilities,
    };

    setAgentCard(nextCard);

    const signedCard = await this.buildSignedAgentCard(nextCard);
    await this.publishDiscoveryState(signedCard);

    return {
      id: req.id,
      success: true,
      data: {
        did: this.identity.did,
        card: nextCard,
      },
    };
  }

  private async handleListPeers(req: DaemonRequest<ListPeersParams>): Promise<DaemonResponse> {
    const params = req.params || {};
    const limit = params.limit ?? 20;
    const minTrust = params.minTrust;
    const results = await this.searchAgents({
      query: params.query,
      capability: params.capability,
      filters: minTrust != null ? { minTrustScore: minTrust } : undefined,
      limit,
    });

    return {
      id: req.id,
      success: true,
      data: results.slice(0, limit),
    };
  }

  private async handlePeers(req: DaemonRequest<ListPeersParams>): Promise<DaemonResponse> {
    const response = await this.handleListPeers(req);
    if (!response.success) {
      return response;
    }

    return {
      id: req.id,
      success: true,
      data: {
        peers: response.data ?? [],
      },
    };
  }

  private async handleStatus(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.relayClient) return { id: req.id, success: false, error: 'Relay client not initialized' };
    const reachabilityPolicy = this.getReachabilityPolicy();
    const reachabilityStatus = this.buildReachabilityStatus();
    const connectedRelays = this.relayClient.getConnectedRelays();
    const stats = this.queue ? await this.queue.getStats() : null;

    return {
      id: req.id,
      success: true,
      data: {
        running: true,
        connected: connectedRelays.length > 0,
        relay: connectedRelays[0] || null,
        connectedRelays,
        knownRelays: this.relayClient.getKnownRelays(),
        peerCount: this.relayClient.getPeerCount(),
        messages: stats?.inboxTotal ?? 0,
        did: this.identity.did,
        reachabilityPolicy,
        reachabilityStatus,
      },
    };
  }

  private handleGetReachabilityPolicy(req: DaemonRequest): DaemonResponse<ReachabilityPolicyResponse> {
    return {
      id: req.id,
      success: true,
      data: {
        policy: this.getReachabilityPolicy(),
        status: this.buildReachabilityStatus(),
      },
    };
  }

  private handleGetReachabilityStatus(req: DaemonRequest): DaemonResponse {
    return {
      id: req.id,
      success: true,
      data: this.buildReachabilityStatus(),
    };
  }

  private async handleSetReachabilityPolicy(
    req: DaemonRequest<SetReachabilityPolicyParams>,
  ): Promise<DaemonResponse<ReachabilityPolicyResponse>> {
    const policyPatch = (req.params?.policy ?? {}) as Partial<ReachabilityPolicy>;
    const currentConnectedRelays = this.relayClient?.getConnectedRelays() ?? [];

    if (policyPatch.mode === 'fixed' && !policyPatch.bootstrapProviders?.length && currentConnectedRelays.length > 0) {
      policyPatch.bootstrapProviders = currentConnectedRelays;
    }

    if (policyPatch.mode === 'fixed' && policyPatch.autoDiscoverProviders == null) {
      policyPatch.autoDiscoverProviders = false;
    }

    if (policyPatch.mode === 'adaptive' && policyPatch.autoDiscoverProviders == null) {
      policyPatch.autoDiscoverProviders = true;
    }

    const nextPolicy = updateReachabilityPolicy(policyPatch);
    await this.restartRelayStack();

    return {
      id: req.id,
      success: true,
      data: {
        policy: nextPolicy,
        status: this.buildReachabilityStatus(),
      },
    };
  }

  private async handleResetReachabilityPolicy(
    req: DaemonRequest,
  ): Promise<DaemonResponse<ReachabilityPolicyResponse>> {
    const policy = resetReachabilityPolicy();
    await this.restartRelayStack();

    return {
      id: req.id,
      success: true,
      data: {
        policy,
        status: this.buildReachabilityStatus(),
      },
    };
  }

  private async handleMessages(req: DaemonRequest): Promise<DaemonResponse> {
    const { limit = 10 } = req.params || {};
    if (this.queue) {
      const page = await this.queue.getInbox({}, { limit });
      return {
        id: req.id,
        success: true,
        data: {
          messages: page.messages.map((m) => ({ ...m.envelope, receivedAt: m.receivedAt })),
          total: page.total,
        },
      };
    }
    return { id: req.id, success: true, data: { messages: [], total: 0 } };
  }

  // ─── Queue Handlers ───────────────────────────────────────────────────────

  private async handleInbox(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { filter, pagination } = req.params || {};
    const allMessages = await this.queue.store.queryMessages('inbound', filter ?? {}, {
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });
    const blockedDids = new Set((await this.queue.store.listBlocked()).map((entry) => entry.did));
    const page = paginateVisibleInboxMessages(allMessages.messages, blockedDids, pagination ?? {});
    return { id: req.id, success: true, data: page };
  }

  private async handleGetMessage(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { id } = req.params;
    const msg = await this.queue.getMessage(id);
    if (!msg) return { id: req.id, success: false, error: 'Message not found' };
    return { id: req.id, success: true, data: msg };
  }

  private async handleMarkRead(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    await this.queue.markAsRead(req.params.id);
    return { id: req.id, success: true };
  }

  private async handleDeleteMessage(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    await this.queue.deleteMessage(req.params.id);
    return { id: req.id, success: true };
  }

  private async handleOutbox(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const page = await this.queue.getOutbox(req.params?.pagination);
    return { id: req.id, success: true, data: page };
  }

  private async handleRetryMessage(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    await this.queue.retryMessage(req.params.id);
    return { id: req.id, success: true };
  }

  // ─── Defense Handlers ─────────────────────────────────────────────────────

  private async handleBlock(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.defense) return { id: req.id, success: false, error: 'Defense not initialized' };
    const { did, reason = 'Blocked by user' } = req.params;
    await this.defense.blockAgent(did, reason, this.identity.did);
    return { id: req.id, success: true };
  }

  private async handleUnblock(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.defense) return { id: req.id, success: false, error: 'Defense not initialized' };
    const { did, resetTrust = true } = req.params;
    await this.defense.unblockAgent(did);

    // Reset interaction history by default to prevent immediate re-blocking
    if (resetTrust && this.trustSystem) {
      await this.trustSystem.resetInteractionHistory(did);
      logger.info('Reset interaction history for unblocked agent', { did });
    }

    return { id: req.id, success: true };
  }

  private async handleBlockAgent(req: DaemonRequest): Promise<DaemonResponse> {
    const did = typeof req.params?.did === 'string'
      ? req.params.did
      : typeof req.params?.targetDid === 'string'
        ? req.params.targetDid
        : undefined;
    if (!did) {
      return { id: req.id, success: false, error: 'Missing did parameter' };
    }

    const action = req.params?.action === 'unblock' ? 'unblock' : 'block';
    const normalized = {
      ...req.params,
      did,
    };

    const response = action === 'unblock'
      ? await this.handleUnblock({ ...req, params: normalized })
      : await this.handleBlock({ ...req, params: normalized });
    if (!response.success) {
      return response;
    }

    return {
      id: req.id,
      success: true,
      data: {
        blocked: action === 'block',
        targetDid: did,
      },
    };
  }

  private async handleAllowlist(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.defense || !this.queue) return { id: req.id, success: false, error: 'Defense not initialized' };
    const { action, did, note } = req.params;
    switch (action) {
      case 'add':
        await this.defense.allowAgent(did, note);
        return { id: req.id, success: true };
      case 'remove':
        await this.defense.removeFromAllowlist(did);
        return { id: req.id, success: true };
      case 'list': {
        const entries = await this.queue.store.listAllowed();
        return { id: req.id, success: true, data: entries };
      }
      default:
        return { id: req.id, success: false, error: `Unknown allowlist action: ${action}` };
    }
  }

  private async handleQueueStats(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const stats = await this.queue.getStats();
    return { id: req.id, success: true, data: stats };
  }

  private async handleSubscribeInbox(req: DaemonRequest, socket: Socket): Promise<DaemonResponse> {
    if (!this.queue) {
      return { id: req.id, success: false, error: 'Queue not initialized' };
    }

    const filter = req.params?.filter ?? {};
    const subscriptionId = this.queue.subscribe(filter, async (message) => {
      if (socket.destroyed) {
        return;
      }

      const event: DaemonSubscriptionEvent = {
        type: 'event',
        event: 'inbox',
        subscriptionId,
        data: message,
      };

      socket.write(JSON.stringify(event) + '\n');
    });

    if (!this.socketSubscriptions.has(socket)) {
      this.socketSubscriptions.set(socket, new Set());
    }
    this.socketSubscriptions.get(socket)!.add(subscriptionId);

    return {
      id: req.id,
      success: true,
      data: { subscriptionId },
    };
  }

  private handleUnsubscribe(req: DaemonRequest, socket: Socket): DaemonResponse {
    if (!this.queue) {
      return { id: req.id, success: false, error: 'Queue not initialized' };
    }

    const subscriptionId = req.params?.subscriptionId;
    if (!subscriptionId) {
      return { id: req.id, success: false, error: 'Missing subscriptionId parameter' };
    }

    this.queue.unsubscribe(subscriptionId);
    this.socketSubscriptions.get(socket)?.delete(subscriptionId);

    return { id: req.id, success: true };
  }

  // ─── Session Handlers (CVP-0014) ─────────────────────────────────────────

  private async handleSessions(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { peerDid, limit, includeArchived } = req.params || {};
    const sessions = await this.queue.store.listSessions(peerDid, limit, includeArchived ?? false);
    return { id: req.id, success: true, data: { sessions, total: sessions.length } };
  }

  private async handleSessionMessages(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { threadId, limit, before } = req.params || {};
    const page = await this.queue.store.queryMessagesByThread(threadId, { limit, offset: before ? 1 : 0 });
    return { id: req.id, success: true, data: page };
  }

  private async handleArchiveSession(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { threadId } = req.params || {};
    if (!threadId) return { id: req.id, success: false, error: 'Missing threadId parameter' };
    await this.queue.store.archiveSession(threadId);
    return { id: req.id, success: true };
  }

  private async handleUnarchiveSession(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { threadId } = req.params || {};
    if (!threadId) return { id: req.id, success: false, error: 'Missing threadId parameter' };
    await this.queue.store.unarchiveSession(threadId);
    return { id: req.id, success: true };
  }

  private async handleSearchSessions(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { query, limit } = req.params || {};
    if (!query) return { id: req.id, success: false, error: 'Missing query parameter' };
    const sessions = await this.queue.store.searchSessions(query, limit);
    return { id: req.id, success: true, data: { sessions, total: sessions.length } };
  }

  private async handleExportSession(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { threadId, format } = req.params || {};
    if (!threadId) return { id: req.id, success: false, error: 'Missing threadId parameter' };

    const session = await this.queue.store.getSession(threadId);
    if (!session) return { id: req.id, success: false, error: 'Session not found' };

    const messages = await this.queue.store.queryMessagesByThread(threadId, { limit: 1000 });

    let exported: string;
    switch (format) {
      case 'json':
        exported = JSON.stringify({ session, messages: messages.messages }, null, 2);
        break;
      case 'markdown':
        exported = this.exportToMarkdown(session, messages.messages);
        break;
      case 'text':
      default:
        exported = this.exportToText(session, messages.messages);
        break;
    }

    return { id: req.id, success: true, data: { content: exported, format } };
  }

  private async handleSessionStats(req: DaemonRequest): Promise<DaemonResponse> {
    if (!this.queue) return { id: req.id, success: false, error: 'Queue not initialized' };
    const { threadId } = req.params || {};
    if (!threadId) return { id: req.id, success: false, error: 'Missing threadId parameter' };

    const session = await this.queue.store.getSession(threadId);
    if (!session) return { id: req.id, success: false, error: 'Session not found' };

    const messages = await this.queue.store.queryMessagesByThread(threadId, { limit: 1000 });

    // Calculate statistics
    const startedAt = session.startedAt ?? session.lastMessageAt;
    const duration = session.lastMessageAt - startedAt;
    const inboundCount = messages.messages.filter(m => m.direction === 'inbound').length;
    const outboundCount = messages.messages.filter(m => m.direction === 'outbound').length;

    // Calculate average response time (time between inbound and next outbound)
    let totalResponseTime = 0;
    let responseCount = 0;
    for (let i = 0; i < messages.messages.length - 1; i++) {
      const current = messages.messages[i];
      const next = messages.messages[i + 1];
      if (current.direction === 'inbound' && next.direction === 'outbound') {
        const responseTime = getMessageSortTimestamp(next) - getMessageSortTimestamp(current);
        totalResponseTime += responseTime;
        responseCount++;
      }
    }
    const avgResponseTime = responseCount > 0 ? totalResponseTime / responseCount : 0;

    const stats = {
      threadId,
      peerDid: session.peerDid,
      messageCount: session.messageCount,
      inboundCount,
      outboundCount,
      duration,
      avgResponseTime,
      startedAt: session.startedAt,
      lastMessageAt: session.lastMessageAt,
    };

    return { id: req.id, success: true, data: stats };
  }

  private exportToMarkdown(
    session: { threadId?: string; peerDid: string; messageCount: number; startedAt?: number; lastMessageAt: number },
    messages: StoredMessage[],
  ): string {
    let md = `# Conversation Thread\n\n`;
    md += `**Thread ID:** ${session.threadId}\n`;
    md += `**Peer:** ${session.peerDid}\n`;
    md += `**Started:** ${new Date(session.startedAt ?? session.lastMessageAt).toISOString()}\n`;
    md += `**Last Activity:** ${new Date(session.lastMessageAt).toISOString()}\n`;
    md += `**Messages:** ${session.messageCount}\n\n`;
    md += `---\n\n`;

    for (const msg of messages) {
      const timestamp = new Date(getMessageSortTimestamp(msg)).toISOString();
      const from = msg.direction === 'outbound' ? 'You' : msg.envelope.from;
      const payload = msg.envelope.payload as Record<string, unknown>;
      const text = payload?.text || payload?.message || JSON.stringify(payload);

      md += `## ${from}\n`;
      md += `*${timestamp}*\n\n`;
      md += `${text}\n\n`;
    }

    return md;
  }

  private exportToText(
    session: { threadId?: string; peerDid: string; messageCount: number; startedAt?: number; lastMessageAt: number },
    messages: StoredMessage[],
  ): string {
    let txt = `Conversation Thread\n`;
    txt += `==================\n\n`;
    txt += `Thread ID: ${session.threadId}\n`;
    txt += `Peer: ${session.peerDid}\n`;
    txt += `Started: ${new Date(session.startedAt ?? session.lastMessageAt).toISOString()}\n`;
    txt += `Last Activity: ${new Date(session.lastMessageAt).toISOString()}\n`;
    txt += `Messages: ${session.messageCount}\n\n`;
    txt += `--------------------------------------------------\n\n`;

    for (const msg of messages) {
      const timestamp = new Date(getMessageSortTimestamp(msg)).toISOString();
      const from = msg.direction === 'outbound' ? 'You' : msg.envelope.from;
      const payload = msg.envelope.payload as Record<string, unknown>;
      const text = payload?.text || payload?.message || JSON.stringify(payload);

      txt += `[${timestamp}] ${from}\n`;
      txt += `${text}\n\n`;
    }

    return txt;
  }

  // ─── Trust System Handlers ───────────────────────────────────────────────

  private async handleTrustScore(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const { did } = req.params;
      if (!did) {
        return { id: req.id, success: false, error: 'Missing did parameter' };
      }
      if (!this.trustSystem) {
        return { id: req.id, success: false, error: 'Trust system not initialized' };
      }

      const [score, endorsements] = await Promise.all([
        this.trustSystem.getTrustScore(did),
        this.trustSystem.getEndorsements(did),
      ]);
      return { id: req.id, success: true, data: { score, endorsements } };
    } catch (error) {
      return { id: req.id, success: false, error: (error as Error).message };
    }
  }

  private async handleCreateEndorsement(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const { did, score, reason } = req.params;
      if (!did || typeof score !== 'number') {
        return { id: req.id, success: false, error: 'Missing did or score parameter' };
      }
      if (!this.trustSystem) {
        return { id: req.id, success: false, error: 'Trust system not initialized' };
      }

      const keyPair = this.getKeyPair();
      const result = await this.trustSystem.endorse(
        this.identity.did,
        did,
        score,
        reason || '',
        (data) => sign(data, keyPair.privateKey),
      );
      return { id: req.id, success: true, data: result };
    } catch (error) {
      return { id: req.id, success: false, error: (error as Error).message };
    }
  }

  private async handleQueryEndorsements(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const did = typeof req.params?.did === 'string'
        ? req.params.did
        : typeof req.params?.targetDid === 'string'
          ? req.params.targetDid
          : undefined;
      if (!did) {
        return { id: req.id, success: false, error: 'Missing did parameter' };
      }
      if (!this.relayClient) {
        return { id: req.id, success: false, error: 'Relay client not initialized' };
      }

      const domain = typeof req.params?.domain === 'string'
        ? req.params.domain
        : typeof req.params?.options?.domain === 'string'
          ? req.params.options.domain
          : undefined;
      const createdBy = typeof req.params?.createdBy === 'string'
        ? req.params.createdBy
        : typeof req.params?.endorser === 'string'
          ? req.params.endorser
          : undefined;
      const limit = typeof req.params?.limit === 'number' ? req.params.limit : undefined;

      const result = await this.relayClient.queryTrust(did, domain);
      const endorsements = createdBy
        ? result.endorsements.filter((endorsement) => endorsement.from === createdBy)
        : result.endorsements;
      const page = typeof limit === 'number' ? endorsements.slice(0, limit) : endorsements;

      return {
        id: req.id,
        success: true,
        data: {
          ...result,
          endorsements: page,
          endorsementCount: page.length,
        },
      };
    } catch (error) {
      return { id: req.id, success: false, error: (error as Error).message };
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down daemon');

    for (const socket of this.socketSubscriptions.keys()) {
      this.cleanupSocketSubscriptions(socket);
    }

    if (this.queue) {
      await this.queue.stop();
      this.queue = null;
    }

    if (this.trustSystem) {
      await this.trustSystem.stop();
      this.trustSystem = null;
    }

    await this.stopRelayStack();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    logger.info('Daemon stopped');
  }
}

export { ClawDaemon as QuadraADaemon };
