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

  return {
    configState,
    setE2EConfigMock: vi.fn((value) => {
      configState.e2e = value;
    }),
    resolveE2EConfigMock: vi.fn(async () => configState.e2e),
    resolvePublishedDevicesMock: vi.fn(async () => []),
    resolvePublishedPreKeyBundlesMock: vi.fn(async () => []),
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

import { ClawDaemon } from './daemon-server.js';

describe('ClawDaemon E2E recovery', () => {
  beforeEach(async () => {
    mocks.setE2EConfigMock.mockClear();
    mocks.resolveE2EConfigMock.mockClear();
    mocks.resolvePublishedDevicesMock.mockClear();
    mocks.resolvePublishedPreKeyBundlesMock.mockClear();
    mocks.prepareEncryptedReceiveMock.mockReset();

    const selfKeys = await generateKeyPair();
    mocks.configState.identity = {
      did: deriveDID(selfKeys.publicKey),
      publicKey: Buffer.from(selfKeys.publicKey).toString('hex'),
      privateKey: Buffer.from(selfKeys.privateKey).toString('hex'),
    };
    mocks.configState.e2e = await createInitialLocalE2EConfig(selfKeys.privateKey);
  });

  it('clears peer sessions on signed e2e/session-reset messages', async () => {
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
    (daemon as any).defense = { checkMessage: vi.fn(async () => ({ allowed: true })) };
    (daemon as any).queue = { enqueueInbound: vi.fn(async () => ({})) };
    (daemon as any).trustSystem = { recordInteraction: vi.fn(async () => undefined) };

    const resetEnvelope = await signEnvelope(
      createEnvelope(
        peerDid,
        mocks.configState.identity!.did,
        'message',
        'e2e/session-reset',
        { reason: 'decrypt-failed', timestamp: 100 },
      ),
      (data) => sign(data, peerKeys.privateKey),
    );

    await (daemon as any).handleIncomingMessage(resetEnvelope);

    expect(mocks.setE2EConfigMock).toHaveBeenCalledOnce();
    const nextConfig = mocks.setE2EConfigMock.mock.calls[0]?.[0];
    expect(nextConfig.devices[currentDeviceId].sessions).toEqual({});
    expect((daemon as any).queue.enqueueInbound).not.toHaveBeenCalled();
  });

  it('sends a signed reset envelope and writes a diagnostic message after decrypt failure', async () => {
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

    expect(mocks.setE2EConfigMock).toHaveBeenCalledOnce();
    expect(queue.enqueueInbound).toHaveBeenCalledOnce();
    expect(queue.enqueueInbound.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      protocol: 'e2e/decrypt-failed',
      from: peerDid,
    }));

    expect(router.sendMessage).toHaveBeenCalledOnce();
    const resetEnvelope = router.sendMessage.mock.calls[0]?.[0];
    expect(resetEnvelope).toEqual(expect.objectContaining({
      protocol: 'e2e/session-reset',
      from: mocks.configState.identity!.did,
      to: peerDid,
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
