import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEnvelope,
  createInitialLocalE2EConfig,
  deriveDID,
  generateKeyPair,
  sign,
  signEnvelope,
  verify,
  verifyEnvelope,
} from '@quadra-a/protocol';

const mocks = vi.hoisted(() => {
  const configState: {
    identity?: {
      did: string;
      publicKey: string;
      privateKey: string;
    };
    e2e?: Awaited<ReturnType<typeof createInitialLocalE2EConfig>>;
  } = {};
  const setE2EConfigMock = vi.fn((value) => {
    configState.e2e = value;
  });

  return {
    configState,
    setE2EConfigMock,
    withLocalE2EStateTransactionMock: vi.fn(async (_identity, callback) => {
      if (!configState.e2e) {
        throw new Error('Missing test E2E config');
      }

      let nextE2E = configState.e2e;
      const result = await callback({
        config: {
          identity: configState.identity,
          e2e: configState.e2e,
          deviceIdentity: configState.e2e
            ? { seed: 'test-seed', deviceId: configState.e2e.currentDeviceId }
            : undefined,
        },
        e2eConfig: configState.e2e,
        deviceIdentity: { seed: 'test-seed', deviceId: configState.e2e.currentDeviceId },
        created: false,
        setE2EConfig(value: typeof nextE2E) {
          nextE2E = value;
        },
      });
      configState.e2e = nextE2E;
      setE2EConfigMock(nextE2E);
      return result;
    }),
    resolveE2EConfigMock: vi.fn(async () => configState.e2e),
    resolvePublishedDevicesMock: vi.fn(async () => []),
    resolvePublishedPreKeyBundlesMock: vi.fn(async () => []),
    prepareEncryptedSendsMock: vi.fn(),
    prepareEncryptedReceiveMock: vi.fn(),
  };
});

vi.mock('./config.js', () => ({
  getIdentity: () => mocks.configState.identity,
  getAgentCard: vi.fn(),
  getReachabilityPolicy: vi.fn(() => ({
    mode: 'adaptive',
    bootstrapProviders: [],
    targetProviderCount: 1,
    autoDiscoverProviders: false,
    operatorLock: false,
  })),
  getRelayInviteToken: vi.fn(),
  isPublished: vi.fn(() => false),
  resetReachabilityPolicy: vi.fn(),
  setAgentCard: vi.fn(),
  setE2EConfig: mocks.setE2EConfigMock,
  updateReachabilityPolicy: vi.fn(),
}));

vi.mock('./e2e-config.js', () => ({
  resolveE2EConfig: mocks.resolveE2EConfigMock,
  resolvePublishedDevices: mocks.resolvePublishedDevicesMock,
  resolvePublishedPreKeyBundles: mocks.resolvePublishedPreKeyBundlesMock,
}));

vi.mock('./e2e-receive.js', () => ({
  prepareEncryptedReceive: mocks.prepareEncryptedReceiveMock,
}));

vi.mock('./e2e-send.js', () => ({
  prepareEncryptedSends: mocks.prepareEncryptedSendsMock,
}));

vi.mock('./e2e-state.js', () => ({
  withLocalE2EStateTransaction: mocks.withLocalE2EStateTransactionMock,
}));

import { ClawDaemon } from './daemon-server.js';

describe('ClawDaemon E2E recovery', () => {
  beforeEach(async () => {
    mocks.setE2EConfigMock.mockClear();
    mocks.withLocalE2EStateTransactionMock.mockClear();
    mocks.resolveE2EConfigMock.mockClear();
    mocks.resolvePublishedDevicesMock.mockClear();
    mocks.resolvePublishedPreKeyBundlesMock.mockClear();
    mocks.prepareEncryptedSendsMock.mockReset();
    mocks.prepareEncryptedReceiveMock.mockReset();

    const selfKeys = await generateKeyPair();
    mocks.configState.identity = {
      did: deriveDID(selfKeys.publicKey),
      publicKey: Buffer.from(selfKeys.publicKey).toString('hex'),
      privateKey: Buffer.from(selfKeys.privateKey).toString('hex'),
    };
    mocks.configState.e2e = await createInitialLocalE2EConfig(selfKeys.privateKey);
  });

  it('clears peer sessions on signed e2e/session-reset messages and replies with reset-ack', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const currentDeviceId = mocks.configState.e2e!.currentDeviceId;
    mocks.configState.e2e = {
      ...mocks.configState.e2e!,
      devices: {
        ...mocks.configState.e2e!.devices,
        [currentDeviceId]: {
          ...mocks.configState.e2e!.devices[currentDeviceId],
          sessions: {
            [`${peerDid}:device-peer`]: { sessionId: 'stale' } as any,
          },
        },
      },
    };

    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-reset-test.sock');
    const router = { sendMessage: vi.fn(async () => undefined) };
    (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true })) };
    (daemon as any).queue = { enqueueInbound: vi.fn(async () => ({})) };
    (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };
    (daemon as any).router = router;

    const resetEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        'e2e/session-reset',
        { reason: 'decrypt-failed', epoch: 100, timestamp: 100 },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(resetEnvelope);

    expect(mocks.setE2EConfigMock).toHaveBeenCalledOnce();
    const nextConfig = mocks.setE2EConfigMock.mock.calls[0]?.[0];
    expect(nextConfig.devices[currentDeviceId].sessions).toEqual({});
    expect((daemon as any).queue.enqueueInbound).not.toHaveBeenCalled();
    expect(router.sendMessage).toHaveBeenCalledOnce();
    const ackEnvelope = router.sendMessage.mock.calls[0]?.[0];
    expect(ackEnvelope).toEqual(expect.objectContaining({
      protocol: 'e2e/session-reset-ack',
      from: mocks.configState.identity!.did,
      to: peerDid,
      payload: expect.objectContaining({
        epoch: 100,
        reason: 'decrypt-failed',
      }),
    }));
    expect(await verifyEnvelope(
      ackEnvelope,
      (signature, data) => verify(
        signature,
        data,
        Buffer.from(mocks.configState.identity!.publicKey, 'hex'),
      ),
    )).toBe(true);
  });

  it('sends a signed session-reset and writes a diagnostic message after decrypt failure', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const currentDeviceId = mocks.configState.e2e!.currentDeviceId;
    mocks.configState.e2e = {
      ...mocks.configState.e2e!,
      devices: {
        ...mocks.configState.e2e!.devices,
        [currentDeviceId]: {
          ...mocks.configState.e2e!.devices[currentDeviceId],
          sessions: {
            [`${peerDid}:device-peer`]: { sessionId: 'stale' } as any,
          },
        },
      },
    };
    mocks.prepareEncryptedReceiveMock.mockRejectedValueOnce(new Error('Missing local E2E session'));

    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-decrypt-test.sock');
    const queue = { enqueueInbound: vi.fn(async () => ({})) };
    const router = { sendMessage: vi.fn(async () => undefined) };
    (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true })) };
    (daemon as any).queue = queue;
    (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };
    (daemon as any).router = router;

    const transportEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        '/agent/e2e/1.0.0',
        {
          kind: 'quadra-a-e2e',
          version: 1,
          encoding: 'hex',
          messageType: 'SESSION_MESSAGE',
          senderDeviceId: 'device-peer',
          receiverDeviceId: currentDeviceId,
          sessionId: 'session-stale',
          wireMessage: '00',
        },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(transportEnvelope);

    expect(queue.enqueueInbound).toHaveBeenCalledOnce();
    expect(queue.enqueueInbound.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      protocol: 'e2e/decrypt-failed',
      from: peerDid,
      payload: expect.objectContaining({
        epoch: expect.any(Number),
      }),
    }));

    expect(mocks.setE2EConfigMock).toHaveBeenCalledOnce();
    expect(router.sendMessage).toHaveBeenCalledOnce();
    const resetEnvelope = router.sendMessage.mock.calls[0]?.[0];
    expect(resetEnvelope).toEqual(expect.objectContaining({
      protocol: 'e2e/session-reset',
      from: mocks.configState.identity!.did,
      to: peerDid,
      payload: expect.objectContaining({
        epoch: expect.any(Number),
        reason: 'decrypt-failed',
      }),
    }));
    expect(await verifyEnvelope(
      resetEnvelope,
      (signature, data) => verify(
        signature,
        data,
        Buffer.from(mocks.configState.identity!.publicKey, 'hex'),
      ),
    )).toBe(true);
  });

  it('records inbound E2E delivery metadata on successful decrypt', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const currentDeviceId = mocks.configState.e2e!.currentDeviceId;
    const applicationEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        '/agent/msg/1.0.0',
        { text: 'hello' },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );
    mocks.prepareEncryptedReceiveMock.mockResolvedValueOnce({
      applicationEnvelope,
      e2eConfig: mocks.configState.e2e!,
      transport: 'prekey',
      senderDeviceId: 'device-peer',
      receiverDeviceId: currentDeviceId,
      sessionId: 'session-1',
      usedSkippedMessageKey: false,
    });

    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-inbound-e2e-test.sock');
    const queue = { enqueueInbound: vi.fn(async () => ({})) };
    (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true, trustScore: 0, trustStatus: 'unknown' })) };
    (daemon as any).queue = queue;
    (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };

    const transportEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        '/agent/e2e/1.0.0',
        {
          kind: 'quadra-a-e2e',
          version: 1,
          encoding: 'hex',
          messageType: 'PREKEY_MESSAGE',
          senderDeviceId: 'device-peer',
          receiverDeviceId: currentDeviceId,
          sessionId: 'session-1',
          wireMessage: '00',
        },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(transportEnvelope);

    expect(queue.enqueueInbound).toHaveBeenCalledOnce();
    expect(queue.enqueueInbound.mock.calls[0]?.[0]).toEqual(applicationEnvelope);
    expect(queue.enqueueInbound.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      transport: 'prekey',
      senderDeviceId: 'device-peer',
      receiverDeviceId: currentDeviceId,
      sessionId: 'session-1',
      state: 'received',
      usedSkippedMessageKey: false,
    }));
  });

  it('replays one outbound message once on signed session-retry messages', async () => {
    vi.useFakeTimers();
    try {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const applicationEnvelope = await signEnvelope(
      createEnvelope(
        mocks.configState.identity!.did,
        peerDid,
        'message',
        '/agent/msg/1.0.0',
        { text: 'hello again' },
      ),
      (data) => sign(data, Buffer.from(mocks.configState.identity!.privateKey, 'hex')),
    );

    mocks.prepareEncryptedSendsMock.mockResolvedValueOnce({
      applicationEnvelope,
      e2eConfig: mocks.configState.e2e!,
      targets: [{
        outerEnvelope: applicationEnvelope,
        outerEnvelopeBytes: new Uint8Array([1, 2, 3]),
        transport: 'prekey',
        senderDeviceId: mocks.configState.e2e!.currentDeviceId,
        recipientDeviceId: 'device-peer',
        sessionId: 'session-replayed',
      }],
    });

    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-retry-test.sock');
    const queue = {
      getOutboundMessage: vi.fn(async () => ({
        envelope: applicationEnvelope,
        e2e: { deliveries: [], retry: { replayCount: 0 } },
      })),
      appendE2ERetry: vi.fn(async () => ({ e2e: { retry: { replayCount: 1 } } })),
      appendE2EDelivery: vi.fn(async () => ({ e2e: { deliveries: [] } })),
    };
    const relayClient = {
      sendEnvelope: vi.fn(async () => undefined),
    };
    (daemon as any).queue = queue;
    (daemon as any).relayClient = relayClient;
    (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true })) };
    (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };

    const retryEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        'e2e/session-retry',
        {
          messageId: applicationEnvelope.id,
          reason: 'decrypt-failed',
          failedTransport: 'session',
          timestamp: 123,
        },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(retryEnvelope);

    expect(queue.getOutboundMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(queue.getOutboundMessage).toHaveBeenCalledWith(applicationEnvelope.id);
    expect(queue.appendE2ERetry).toHaveBeenCalledTimes(2);
    expect(queue.appendE2EDelivery).toHaveBeenCalledWith(
      applicationEnvelope.id,
      expect.objectContaining({
        transport: 'prekey',
        transportMessageId: applicationEnvelope.id,
        receiverDeviceId: 'device-peer',
        sessionId: 'session-replayed',
        state: 'sent',
      }),
    );
    expect(relayClient.sendEnvelope).toHaveBeenCalledWith(peerDid, new Uint8Array([1, 2, 3]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays outbound messages resolved by transport message id', async () => {
    vi.useFakeTimers();
    try {
      const peerKeys = await generateKeyPair();
      const peerDid = deriveDID(peerKeys.publicKey);
      const applicationEnvelope = await signEnvelope(
        createEnvelope(
          mocks.configState.identity!.did,
          peerDid,
          'message',
          '/agent/msg/1.0.0',
          { text: 'recover me' },
        ),
        (data) => sign(data, Buffer.from(mocks.configState.identity!.privateKey, 'hex')),
      );

      mocks.prepareEncryptedSendsMock.mockResolvedValueOnce({
        applicationEnvelope,
        e2eConfig: mocks.configState.e2e!,
        targets: [{
          outerEnvelope: { ...applicationEnvelope, id: 'transport-replayed' },
          outerEnvelopeBytes: new Uint8Array([9, 9, 9]),
          transport: 'prekey',
          senderDeviceId: mocks.configState.e2e!.currentDeviceId,
          recipientDeviceId: 'device-peer',
          sessionId: 'session-replayed',
        }],
      });

      const daemon = new ClawDaemon('/tmp/quadra-a-daemon-retry-transport-test.sock');
      const queue = {
        getOutboundMessage: vi.fn(async () => null),
        getOutboundMessageByTransportMessageId: vi.fn(async () => ({
          envelope: applicationEnvelope,
          e2e: {
            deliveries: [{
              transport: 'session',
              transportMessageId: 'transport-failed',
              senderDeviceId: mocks.configState.e2e!.currentDeviceId,
              receiverDeviceId: 'device-peer',
              sessionId: 'session-old',
              state: 'sent',
              recordedAt: 1,
            }],
            retry: { replayCount: 0 },
          },
        })),
        appendE2ERetry: vi.fn(async () => ({ e2e: { retry: { replayCount: 1 } } })),
        appendE2EDelivery: vi.fn(async () => ({ e2e: { deliveries: [] } })),
      };
      const relayClient = {
        sendEnvelope: vi.fn(async () => undefined),
      };
      (daemon as any).queue = queue;
      (daemon as any).relayClient = relayClient;
      (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true })) };
      (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };

      const retryEnvelope = await signEnvelope(
        createEnvelope(
          peerDid,
          mocks.configState.identity!.did,
          'message',
          'e2e/session-retry',
          {
            messageId: 'transport-failed',
            reason: 'decrypt-failed',
            failedTransport: 'session',
            timestamp: 123,
          },
        ),
        (data) => sign(data, peerKeys.privateKey),
      );

      await (daemon as any).handleIncomingMessage(retryEnvelope);
      await vi.advanceTimersByTimeAsync(500);
      await vi.runAllTimersAsync();

      expect(queue.getOutboundMessage).toHaveBeenCalledWith('transport-failed');
      expect(queue.getOutboundMessageByTransportMessageId).toHaveBeenCalledWith('transport-failed');
      expect(relayClient.sendEnvelope).toHaveBeenCalledWith(peerDid, new Uint8Array([9, 9, 9]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses duplicate recovery resets while a peer is already recovering', async () => {
      const peerKeys = await generateKeyPair();
      const peerDid = deriveDID(peerKeys.publicKey);
      const currentDeviceId = mocks.configState.e2e!.currentDeviceId;
      mocks.configState.e2e = {
        ...mocks.configState.e2e!,
        devices: {
          ...mocks.configState.e2e!.devices,
          [currentDeviceId]: {
            ...mocks.configState.e2e!.devices[currentDeviceId],
            sessions: {
              [`${peerDid}:device-peer`]: { sessionId: 'stale' } as any,
            },
          },
        },
      };
      mocks.prepareEncryptedReceiveMock
        .mockRejectedValueOnce(new Error('Missing local E2E session'))
        .mockRejectedValueOnce(new Error('Missing local E2E session'));

      const daemon = new ClawDaemon('/tmp/quadra-a-daemon-batched-recovery-test.sock');
      const queue = { enqueueInbound: vi.fn(async () => ({})) };
      const router = { sendMessage: vi.fn(async () => undefined) };
      (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true })) };
      (daemon as any).queue = queue;
      (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };
      (daemon as any).router = router;

      const buildTransportEnvelope = async (id: string) => signEnvelope(
        {
          ...createEnvelope(
            peerDid,
            mocks.configState.identity!.did,
            'message',
            '/agent/e2e/1.0.0',
            {
              kind: 'quadra-a-e2e',
              version: 1,
              encoding: 'hex',
              messageType: 'SESSION_MESSAGE',
              senderDeviceId: 'device-peer',
              receiverDeviceId: currentDeviceId,
              sessionId: 'session-stale',
              wireMessage: '00',
            },
          ),
          id,
        },
        (data) => sign(data, peerKeys.privateKey),
      );

      await (daemon as any).handleIncomingMessage(await buildTransportEnvelope('transport-1'));
      await (daemon as any).handleIncomingMessage(await buildTransportEnvelope('transport-2'));

      expect(mocks.setE2EConfigMock).toHaveBeenCalledTimes(1);
      expect(queue.enqueueInbound).toHaveBeenCalledTimes(1);
      expect(router.sendMessage).toHaveBeenCalledTimes(1);
      expect(router.sendMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        protocol: 'e2e/session-reset',
      }));
  });

  it('clears peer recovery state on signed e2e/session-reset-ack messages', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-reset-ack-test.sock');
    (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true })) };
    (daemon as any).queue = { enqueueInbound: vi.fn(async () => ({})) };
    (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };
    (daemon as any).peerRecoveryStates.set(peerDid, {
      epoch: 321,
      startedAt: 321,
      reason: 'decrypt-failed',
      awaitingAck: true,
    });

    const ackEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        'e2e/session-reset-ack',
        { reason: 'decrypt-failed', epoch: 321, timestamp: 321 },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(ackEnvelope);

    expect((daemon as any).peerRecoveryStates.has(peerDid)).toBe(false);
  });

  it('fails fast on send while the peer recovery barrier is active', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-send-gate-test.sock');
    (daemon as any).relayClient = {};
    (daemon as any).peerRecoveryStates.set(peerDid, {
      epoch: 777,
      startedAt: 777,
      reason: 'decrypt-failed',
      awaitingAck: true,
    });

    const response = await (daemon as any).handleRequest(
      {
        id: 'req-send-gated',
        command: 'send',
        params: {
          to: peerDid,
          protocol: '/agent/msg/1.0.0',
          payload: { text: 'blocked' },
        },
      },
      {} as never,
    );

    expect(response).toMatchObject({
      id: 'req-send-gated',
      success: false,
      error: expect.stringContaining(`Peer ${peerDid} is recovering E2E session`),
    });
  });

  it('merges duplicate inbound E2E deliveries onto the existing visible message', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const currentDeviceId = mocks.configState.e2e!.currentDeviceId;
    const applicationEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        '/agent/msg/1.0.0',
        { text: 'hello' },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );
    const secondaryDeviceId = 'device-secondary';

    mocks.prepareEncryptedReceiveMock
      .mockResolvedValueOnce({
        applicationEnvelope,
        e2eConfig: mocks.configState.e2e!,
        transport: 'prekey',
        senderDeviceId: 'device-peer',
        receiverDeviceId: currentDeviceId,
        sessionId: 'session-1',
        usedSkippedMessageKey: false,
      })
      .mockResolvedValueOnce({
        applicationEnvelope,
        e2eConfig: mocks.configState.e2e!,
        transport: 'session',
        senderDeviceId: 'device-peer',
        receiverDeviceId: secondaryDeviceId,
        sessionId: 'session-2',
        usedSkippedMessageKey: true,
      });

    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-duplicate-inbound-e2e-test.sock');
    const queue = {
      enqueueInbound: vi.fn(async () => ({})),
      appendE2EDelivery: vi.fn(async () => ({ e2e: { deliveries: [] } })),
    };
    const trustSystem = { recordInteraction: vi.fn(async () => undefined) };
    (daemon as any).defense = {
      checkMessage: vi.fn(async () => ({ allowed: true, trustScore: 0, trustStatus: 'unknown' }))
        .mockResolvedValueOnce({ allowed: true, trustScore: 0, trustStatus: 'unknown' })
        .mockResolvedValueOnce({ allowed: false, reason: 'duplicate' }),
    };
    (daemon as any).queue = queue;
    (daemon as any).trustSystem = trustSystem;

    const firstTransportEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        '/agent/e2e/1.0.0',
        {
          kind: 'quadra-a-e2e',
          version: 1,
          encoding: 'hex',
          messageType: 'PREKEY_MESSAGE',
          senderDeviceId: 'device-peer',
          receiverDeviceId: currentDeviceId,
          sessionId: 'session-1',
          wireMessage: '00',
        },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    const secondTransportEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        '/agent/e2e/1.0.0',
        {
          kind: 'quadra-a-e2e',
          version: 1,
          encoding: 'hex',
          messageType: 'SESSION_MESSAGE',
          senderDeviceId: 'device-peer',
          receiverDeviceId: secondaryDeviceId,
          sessionId: 'session-2',
          wireMessage: '01',
        },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(firstTransportEnvelope);
    await (daemon as any).handleIncomingMessage(secondTransportEnvelope);

    expect(queue.enqueueInbound).toHaveBeenCalledOnce();
    expect(queue.appendE2EDelivery).toHaveBeenCalledOnce();
    expect(queue.appendE2EDelivery.mock.calls[0]).toEqual([
      applicationEnvelope.id,
      expect.objectContaining({
        transport: 'session',
        senderDeviceId: 'device-peer',
        receiverDeviceId: secondaryDeviceId,
        sessionId: 'session-2',
        state: 'received',
        usedSkippedMessageKey: true,
      }),
    ]);
    expect(trustSystem.recordInteraction).toHaveBeenCalledOnce();
  });

  it('marks correlated inbound replies as solicited for defense checks', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-solicited-reply-test.sock');
    const defense = {
      checkMessage: vi.fn(async () => ({ allowed: true, trustScore: 0.5, trustStatus: 'known' })),
    };
    const queue = {
      getOutboundMessage: vi.fn(async () => ({
        envelope: {
          id: 'msg-request-1',
          from: mocks.configState.identity!.did,
          to: peerDid,
          type: 'message',
          protocol: '/capability/gpu-matmul',
          payload: { size: 64 },
          timestamp: Date.now(),
          signature: 'sig',
        },
      })),
      enqueueInbound: vi.fn(async () => ({})),
    };
    const trustSystem = { recordInteraction: vi.fn(async () => undefined) };
    (daemon as any).defense = defense;
    (daemon as any).queue = queue;
    (daemon as any).trustSystem = trustSystem;

    const replyEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'reply',
        '/capability/gpu-matmul',
        { size: 64, checksum: 123 },
        'msg-request-1',
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(replyEnvelope);

    expect(queue.getOutboundMessage).toHaveBeenCalledWith('msg-request-1');
    expect(defense.checkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: replyEnvelope.id,
        from: peerDid,
        replyTo: 'msg-request-1',
      }),
      { solicitedReply: true },
    );
    expect(queue.enqueueInbound).toHaveBeenCalledOnce();
    expect(trustSystem.recordInteraction).toHaveBeenCalledOnce();
  });

  it('reloads E2E config through daemon request dispatch', async () => {
    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-reload-test.sock');
    const response = await (daemon as any).handleRequest(
      { id: 'req-reload', command: 'reload-e2e', params: {} },
      {} as never,
    );

    expect(response).toMatchObject({
      id: 'req-reload',
      success: true,
      data: {
        deviceId: mocks.configState.e2e!.currentDeviceId,
        sessionCount: 0,
      },
    });
    expect(mocks.setE2EConfigMock).toHaveBeenCalledWith(mocks.configState.e2e);
  });

  it('sends signed manual-reset notifications through daemon request dispatch', async () => {
    const peerKeys = await generateKeyPair();
    const peerDid = deriveDID(peerKeys.publicKey);
    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-notify-test.sock');
    const router = { sendMessage: vi.fn(async () => undefined) };
    (daemon as any).router = router;

    const response = await (daemon as any).handleRequest(
      {
        id: 'req-notify',
        command: 'e2e-reset-notify',
        params: { peers: [peerDid, peerDid, '  '] },
      },
      {} as never,
    );

    expect(response).toMatchObject({
      id: 'req-notify',
      success: true,
      data: {
        notified: [peerDid],
        failed: [],
      },
    });
    expect(router.sendMessage).toHaveBeenCalledOnce();

    const resetEnvelope = router.sendMessage.mock.calls[0]?.[0];
    expect(resetEnvelope).toEqual(expect.objectContaining({
      protocol: 'e2e/session-reset',
      from: mocks.configState.identity!.did,
      to: peerDid,
      payload: expect.objectContaining({
        reason: 'manual-reset',
      }),
    }));
    expect(await verifyEnvelope(
      resetEnvelope,
      (signature, data) => verify(
        signature,
        data,
        Buffer.from(mocks.configState.identity!.publicKey, 'hex'),
      ),
    )).toBe(true);
  });

  it('publishes pre-key bundles before publishing the card through daemon request dispatch', async () => {
    const daemon = new ClawDaemon('/tmp/quadra-a-daemon-publish-card-test.sock');
    const relayClient = {
      publishPreKeyBundles: vi.fn(async () => undefined),
      publishCard: vi.fn(async () => undefined),
    };
    (daemon as any).relayClient = relayClient;
    mocks.resolvePublishedPreKeyBundlesMock.mockResolvedValueOnce([{
      did: mocks.configState.identity!.did,
      deviceId: mocks.configState.e2e!.currentDeviceId,
      identityKeyPublic: 'identity-public',
      signedPreKeyId: 1,
      signedPreKeyPublic: 'signed-prekey-public',
      signedPreKeySignature: 'signed-prekey-signature',
      oneTimePreKey: {
        keyId: 1,
        publicKey: 'one-time-public',
      },
    }]);

    const response = await (daemon as any).handleRequest(
      {
        id: 'req-publish-card',
        command: 'publish_card',
        params: {
          name: 'Daemon Publish Test',
          description: 'publishes prekeys first',
          capabilities: [],
        },
      },
      {} as never,
    );

    expect(response).toMatchObject({
      id: 'req-publish-card',
      success: true,
      data: {
        did: mocks.configState.identity!.did,
        card: {
          name: 'Daemon Publish Test',
          description: 'publishes prekeys first',
          capabilities: [],
        },
      },
    });
    expect(relayClient.publishPreKeyBundles).toHaveBeenCalledOnce();
    expect(relayClient.publishCard).toHaveBeenCalledOnce();
    expect(relayClient.publishPreKeyBundles.mock.invocationCallOrder[0]).toBeLessThan(
      relayClient.publishCard.mock.invocationCallOrder[0],
    );
  });
});
