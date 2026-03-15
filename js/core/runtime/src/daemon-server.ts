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
import { DAEMON_SOCKET_PATH, QUADRA_A_HOME } from './constants.js';
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
import { getTrustScore, endorseAgent, queryNetworkEndorsements } from './trust.js';
import { resolvePublishedDevices, resolvePublishedPreKeyBundles } from './e2e-config.js';
import { prepareEncryptedSends } from './e2e-send.js';
import { prepareEncryptedReceive } from './e2e-receive.js';
import { withLocalE2EStateTransaction } from './e2e-state.js';

const logger = createLogger('daemon');

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

  private async sendSessionReset(to: string, reason: string, timestamp = Date.now()): Promise<void> {
    if (!this.router) {
      throw new Error('Router not initialized');
    }

    const resetEnvelope = createEnvelope(
      this.identity.did,
      to,
      'message',
      'e2e/session-reset',
      {
        from: this.identity.did,
        to,
        reason,
        timestamp,
      },
    );
    const signedEnvelope = await signEnvelope(resetEnvelope, (data) => sign(data, this.getKeyPair().privateKey));
    await this.router.sendMessage(signedEnvelope);
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

  private async replayOutboundMessage(
    peerDid: string,
    messageId: string,
    reason: string,
    requestedAt: number,
  ): Promise<boolean> {
    if (!this.queue || !this.relayClient) {
      return false;
    }

    const original = await this.queue.getOutboundMessage(messageId);
    if (!original || original.envelope.to !== peerDid) {
      logger.info('Ignoring session retry for unknown outbound message', { peerDid, messageId });
      return false;
    }

    const replayCount = original.e2e?.retry?.replayCount ?? 0;
    await this.queue.appendE2ERetry(messageId, {
      replayCount,
      lastRequestedAt: requestedAt,
      lastReason: reason,
    });
    if (replayCount > 0) {
      logger.info('Ignoring repeated session retry for already replayed message', {
        peerDid,
        messageId,
        replayCount,
      });
      return false;
    }

    const keyPair = this.getKeyPair();
    const applicationEnvelope = original.envelope;
    const prepared = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
      const cleared = this.clearPeerSessions(e2eConfig, peerDid);
      const nextE2EConfig = cleared.clearedCount > 0 ? cleared.e2eConfig : e2eConfig;
      const encrypted = await prepareEncryptedSends({
        identity: this.identity,
        keyPair,
        relayClient: this.relayClient!,
        e2eConfig: nextE2EConfig,
        to: applicationEnvelope.to,
        protocol: applicationEnvelope.protocol,
        payload: (applicationEnvelope.payload ?? {}) as Record<string, unknown>,
        type: applicationEnvelope.type,
        replyTo: applicationEnvelope.replyTo,
        threadId: applicationEnvelope.threadId,
        applicationEnvelope,
      });
      setE2EConfig(encrypted.e2eConfig);
      return encrypted;
    });

    const recordedAt = Date.now();
    await this.queue.appendE2ERetry(messageId, {
      replayCount: replayCount + 1,
      lastRequestedAt: requestedAt,
      lastReplayedAt: recordedAt,
      lastReason: reason,
    });

    for (const target of prepared.targets) {
      const delivery: E2EDeliveryMetadata = {
        transport: target.transport,
        senderDeviceId: target.senderDeviceId,
        receiverDeviceId: target.recipientDeviceId,
        sessionId: target.sessionId,
        state: 'sent',
        recordedAt,
      };
      await this.queue.appendE2EDelivery(messageId, delivery);
      try {
        await this.relayClient.sendEnvelope(peerDid, target.outerEnvelopeBytes);
      } catch (error) {
        await this.queue.appendE2EDelivery(messageId, {
          ...delivery,
          state: 'failed',
          recordedAt: Date.now(),
          error: (error as Error).message,
        });
        throw error;
      }
    }

    logger.info('Replayed outbound message after signed session retry', {
      peerDid,
      messageId,
      targetCount: prepared.targets.length,
    });
    return true;
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
    if (!this.defense || !this.queue || !this.trustSystem) return;

    if (envelope.protocol === 'e2e/session-reset') {
      const clearedCount = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
        const cleared = this.clearPeerSessions(e2eConfig, envelope.from);
        if (cleared.clearedCount > 0) {
          setE2EConfig(cleared.e2eConfig);
        }
        return cleared.clearedCount;
      });
      if (clearedCount > 0) {
        logger.info('E2E session reset by peer', { from: envelope.from, clearedCount });
      }
      return;
    }

    if (envelope.protocol === 'e2e/session-retry') {
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

      try {
        await this.replayOutboundMessage(envelope.from, messageId, reason, timestamp);
      } catch (error) {
        logger.warn('Failed to replay outbound message after session retry', {
          from: envelope.from,
          messageId,
          error: (error as Error).message,
        });
      }
      return;
    }

    // Attempt E2E decryption if this is an encrypted transport envelope
    let decryptedEnvelope = envelope;
    let inboundE2EDelivery: E2EDeliveryMetadata | undefined;
    if (envelope.protocol === '/agent/e2e/1.0.0') {
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
        await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
          const cleared = this.clearPeerSessions(e2eConfig, envelope.from);
          if (cleared.clearedCount > 0) {
            setE2EConfig(cleared.e2eConfig);
          }
        });

        try {
          await this.sendSessionRetry(
            envelope.from,
            envelope.id,
            'decrypt-failed',
            'session',
            Date.now(),
          );
        } catch (retryError) {
          logger.warn('Failed to send E2E session retry', {
            to: envelope.from,
            messageId: envelope.id,
            error: (retryError as Error).message,
          });
        }
        await this.queue.enqueueInbound(
          this.buildLocalDiagnosticEnvelope(
            envelope.from,
            'e2e/decrypt-failed',
            {
              error: (error as Error).message,
              hint: 'Session cleared. Sender was asked to replay the message once.',
            },
          ),
        );

        logger.warn('E2E decrypt failed, cleared stale session', {
          id: envelope.id,
          from: envelope.from,
          error: (error as Error).message,
        });
        return;
      }
    }

    const result = await this.defense.checkMessage(decryptedEnvelope);
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

      logger.warn('Message rejected by defense', { id: envelope.id, reason: result.reason });

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
        case 'publish_card': return await this.handlePublishCard(req);
        case 'list_peers': return await this.handleListPeers(req);
        case 'shutdown':
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
      const encrypted = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig, setE2EConfig }) => {
        const prepared = await prepareEncryptedSends({
          identity: this.identity,
          keyPair,
          relayClient: this.relayClient!,
          e2eConfig,
          to,
          protocol: protocol ?? '/agent/msg/1.0.0',
          payload,
          type: type || 'message',
          replyTo,
          threadId,
        });
        setE2EConfig(prepared.e2eConfig);
        return prepared;
      });

      const applicationEnvelope = encrypted.applicationEnvelope;

      const e2eDeliveries: E2EDeliveryMetadata[] = encrypted.targets.map((target) => ({
          transport: target.transport,
          senderDeviceId: target.senderDeviceId,
          receiverDeviceId: target.recipientDeviceId,
          sessionId: target.sessionId,
          state: 'sent',
          recordedAt: Date.now(),
      }));

      if (this.queue) {
        await this.queue.enqueueOutbound(applicationEnvelope, e2eDeliveries);
      }

      for (const target of encrypted.targets) {
        await this.relayClient.sendEnvelope(to, target.outerEnvelopeBytes);
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

      // Fallback: send without E2E if encryption fails (e.g. no card/devices)
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
  }

  private async handleReloadE2E(req: DaemonRequest): Promise<DaemonResponse> {
    const result = await withLocalE2EStateTransaction(this.identity, async ({ e2eConfig }) => {
      const currentDevice = e2eConfig.devices[e2eConfig.currentDeviceId];
      return {
        deviceId: e2eConfig.currentDeviceId,
        sessionCount: Object.keys(currentDevice?.sessions ?? {}).length,
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
      try {
        await this.sendSessionReset(peer, 'manual-reset');
        notified.push(peer);
      } catch (error) {
        failed.push({
          peer,
          error: (error as Error).message,
        });
      }
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
    const page = await this.queue.getInbox(filter, pagination);
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
      const result = await getTrustScore(did);
      return { id: req.id, success: true, data: result };
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
      const result = await endorseAgent(did, score, reason || '');
      return { id: req.id, success: true, data: result };
    } catch (error) {
      return { id: req.id, success: false, error: (error as Error).message };
    }
  }

  private async handleQueryEndorsements(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const { did, options } = req.params;
      if (!did) {
        return { id: req.id, success: false, error: 'Missing did parameter' };
      }
      const result = await queryNetworkEndorsements(did, options || {});
      return { id: req.id, success: true, data: result };
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
