import { afterEach, describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import { decode as decodeCBOR } from 'cbor-x';
import { FederationManager } from '../federation-manager.js';

const REQUIRED_RELAY_CAPABILITIES = [
  'relay/message-routing',
  'relay/discovery',
  'relay/health-check',
  'relay/federation',
];

function createCard(did: string, metadata: Record<string, unknown> = {}) {
  return {
    did,
    name: did,
    description: did,
    version: '1.0.0',
    capabilities: [],
    endpoints: ['ws://example.test'],
    metadata,
    timestamp: Date.now(),
    signature: 'sig',
  };
}

function createRelayCard(did: string, metadata: Record<string, unknown> = {}) {
  return {
    ...createCard(did, metadata),
    capabilities: REQUIRED_RELAY_CAPABILITIES.map((id) => ({ id, name: id, description: id })),
  };
}

function createFakeWs(onSend?: (message: any) => void) {
  const sent: any[] = [];
  return {
    sent,
    readyState: WebSocket.OPEN,
    send(payload: Buffer) {
      const message = decodeCBOR(payload);
      sent.push(message);
      onSend?.(message);
    },
    close() {},
    on() {},
    off() {},
  };
}

function createManager(config: Record<string, unknown> = {}, registryOverrides: Record<string, unknown> = {}) {
  const relayIdentity = {
    getIdentity: () => ({
      did: 'did:agent:relay-local',
      agentCard: createCard('did:agent:relay-local'),
    }),
    sign: async () => new Uint8Array([1, 2, 3]),
  } as any;

  const registry = {
    search: () => ({ agents: [] }),
    listAgents: () => [],
    getOnlineCount: () => 0,
    get: () => undefined,
    ...registryOverrides,
  } as any;

  return new FederationManager(relayIdentity, registry, config as any);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('FederationManager export policy', () => {
  it('does not broadcast joined agents when export policy is none', () => {
    const manager = createManager({ exportPolicy: 'none' });
    const peerWs = createFakeWs();

    (manager as any).federatedRelays.set('did:agent:relay-peer', {
      did: 'did:agent:relay-peer',
      endpoints: ['ws://peer.test'],
      ws: peerWs,
      connected: true,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    manager.notifyAgentJoined('did:agent:a1', createCard('did:agent:a1'), 'private-realm');

    expect(peerWs.sent).toHaveLength(0);
  });

  it('broadcasts selectively exported agents with public visibility metadata', () => {
    const manager = createManager({ exportPolicy: 'selective', selectiveVisibilityValue: 'public' });
    const peerWs = createFakeWs();

    (manager as any).federatedRelays.set('did:agent:relay-peer', {
      did: 'did:agent:relay-peer',
      endpoints: ['ws://peer.test'],
      ws: peerWs,
      connected: true,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    manager.notifyAgentJoined('did:agent:private', createCard('did:agent:private', { visibility: 'private' }), 'alpha');
    manager.notifyAgentJoined('did:agent:public', createCard('did:agent:public', { visibility: 'public' }), 'alpha');

    expect(peerWs.sent).toHaveLength(1);
    expect(peerWs.sent[0]).toMatchObject({ type: 'AGENT_JOINED', agentDid: 'did:agent:public', realm: 'alpha' });
  });

  it('routes to the relay that advertised the target agent', async () => {
    const manager = createManager({ exportPolicy: 'full' });
    const relayA = createFakeWs();
    const relayB = createFakeWs();

    (manager as any).federatedRelays.set('did:agent:relay-a', {
      did: 'did:agent:relay-a',
      endpoints: ['ws://relay-a.test'],
      ws: relayA,
      connected: true,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });
    (manager as any).federatedRelays.set('did:agent:relay-b', {
      did: 'did:agent:relay-b',
      endpoints: ['ws://relay-b.test'],
      ws: relayB,
      connected: true,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    await manager.handleIncomingMessage(relayB as any, 'did:agent:relay-b', {
      type: 'AGENT_JOINED',
      agentDid: 'did:agent:target',
      agentCard: createCard('did:agent:target', { visibility: 'public' }),
      realm: 'alpha',
      timestamp: Date.now(),
    } as any);

    const routed = await manager.routeToFederation('did:agent:target', new Uint8Array([1, 2, 3]), 'did:agent:sender');

    expect(routed).toBe(true);
    expect(relayA.sent).toHaveLength(0);
    expect(relayB.sent).toHaveLength(1);
    expect(relayB.sent[0]).toMatchObject({ type: 'ROUTE_REQUEST', targetDid: 'did:agent:target' });
  });

  
  it('applies per-realm export policy overrides over the relay default', () => {
    const manager = createManager({
      exportPolicy: 'none',
      realmPolicies: {
        alpha: { exportPolicy: 'full' },
        beta: { exportPolicy: 'selective', selectiveVisibilityValue: 'public' },
      },
    });
    const peerWs = createFakeWs();

    (manager as any).federatedRelays.set('did:agent:relay-peer', {
      did: 'did:agent:relay-peer',
      endpoints: ['ws://peer.test'],
      ws: peerWs,
      connected: true,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    manager.notifyAgentJoined('did:agent:alpha-full', createCard('did:agent:alpha-full', { visibility: 'private' }), 'alpha');
    manager.notifyAgentJoined('did:agent:beta-private', createCard('did:agent:beta-private', { visibility: 'private' }), 'beta');
    manager.notifyAgentJoined('did:agent:beta-public', createCard('did:agent:beta-public', { visibility: 'public' }), 'beta');
    manager.notifyAgentJoined('did:agent:gamma-default', createCard('did:agent:gamma-default', { visibility: 'public' }), 'gamma');

    expect(peerWs.sent).toHaveLength(2);
    expect(peerWs.sent[0]).toMatchObject({ type: 'AGENT_JOINED', agentDid: 'did:agent:alpha-full', realm: 'alpha' });
    expect(peerWs.sent[1]).toMatchObject({ type: 'AGENT_JOINED', agentDid: 'did:agent:beta-public', realm: 'beta' });
  });

  it('advertises only realms allowed by per-realm snapshot policy', () => {
    const peerWs = createFakeWs();
    const manager = createManager(
      {
        exportPolicy: 'none',
        realmPolicies: {
          alpha: { exportPolicy: 'full' },
          beta: { exportPolicy: 'selective', selectiveVisibilityValue: 'public' },
        },
      },
      {
        listAgents: () => [
          { did: 'did:agent:alpha-1', card: createCard('did:agent:alpha-1'), realm: 'alpha', online: true },
          { did: 'did:agent:beta-private', card: createCard('did:agent:beta-private', { visibility: 'private' }), realm: 'beta', online: true },
          { did: 'did:agent:beta-public', card: createCard('did:agent:beta-public', { visibility: 'public' }), realm: 'beta', online: true },
          { did: 'did:agent:gamma-1', card: createCard('did:agent:gamma-1', { visibility: 'public' }), realm: 'gamma', online: true },
        ],
      }
    );

    (manager as any).advertiseCurrentAgentsToRelay(peerWs as any);

    expect(peerWs.sent).toHaveLength(2);
    expect(peerWs.sent[0]).toMatchObject({ type: 'AGENT_JOINED', agentDid: 'did:agent:alpha-1', realm: 'alpha' });
    expect(peerWs.sent[1]).toMatchObject({ type: 'AGENT_JOINED', agentDid: 'did:agent:beta-public', realm: 'beta' });
  });

  it('allows inbound federated routing when the target realm is explicitly exported', async () => {
    const targetWs = createFakeWs();
    const targetAgent = {
      did: 'did:agent:alpha-visible',
      card: createCard('did:agent:alpha-visible', { visibility: 'private' }),
      realm: 'alpha',
      online: true,
      ws: targetWs,
    };
    const manager = createManager(
      {
        exportPolicy: 'none',
        realmPolicies: {
          alpha: { exportPolicy: 'full' },
        },
      },
      { get: (did: string) => did === 'did:agent:alpha-visible' ? targetAgent : undefined }
    );
    const inboundWs = createFakeWs();

    await (manager as any).handleRouteRequest(inboundWs as any, 'did:agent:relay-peer', {
      type: 'ROUTE_REQUEST',
      targetDid: 'did:agent:alpha-visible',
      envelope: [1, 2, 3],
      fromRelay: 'did:agent:relay-peer',
      hopCount: 0,
      messageId: 'msg-allow',
    });

    expect(targetWs.sent).toHaveLength(1);
    expect(targetWs.sent[0]).toMatchObject({ type: 'DELIVER', messageId: 'msg-allow' });
    expect(inboundWs.sent).toHaveLength(1);
    expect(inboundWs.sent[0]).toMatchObject({ type: 'ROUTE_RESPONSE', status: 'delivered', messageId: 'msg-allow' });
  });

  it('rejects inbound routing to non-exported local agents', async () => {
    const targetWs = createFakeWs();
    const targetAgent = {
      did: 'did:agent:hidden',
      card: createCard('did:agent:hidden', { visibility: 'private' }),
      realm: 'alpha',
      online: true,
      ws: targetWs,
    };
    const manager = createManager(
      { exportPolicy: 'selective', selectiveVisibilityValue: 'public' },
      { get: (did: string) => did === 'did:agent:hidden' ? targetAgent : undefined }
    );
    const inboundWs = createFakeWs();

    await (manager as any).handleRouteRequest(inboundWs as any, 'did:agent:relay-peer', {
      type: 'ROUTE_REQUEST',
      targetDid: 'did:agent:hidden',
      envelope: [1, 2, 3],
      fromRelay: 'did:agent:relay-peer',
      hopCount: 0,
      messageId: 'msg-1',
    });

    expect(targetWs.sent).toHaveLength(0);
    expect(inboundWs.sent).toHaveLength(1);
    expect(inboundWs.sent[0]).toMatchObject({ type: 'ROUTE_RESPONSE', status: 'not_found', messageId: 'msg-1' });
  });

  it('deduplicates reconnect scheduling for the same disconnected relay', async () => {
    vi.useFakeTimers();

    const relayDid = 'did:agent:relay-peer';
    const manager = createManager({ reconnectDelay: 100, maxReconnectDelay: 100, maxReconnectAttempts: 3 });
    const connectSpy = vi.spyOn(manager as any, 'connectToRelay').mockResolvedValue(false);

    (manager as any).federatedRelays.set(relayDid, {
      did: relayDid,
      endpoints: ['ws://peer.test'],
      card: createCard(relayDid),
      ws: null,
      connected: true,
      connecting: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    (manager as any).handleRelayDisconnection(relayDid);
    (manager as any).handleRelayDisconnection(relayDid);

    await vi.advanceTimersByTimeAsync(100);

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });



  it('exposes remote agent routes as discoverable directory entries', async () => {
    const manager = createManager({ exportPolicy: 'full' });

    (manager as any).federatedRelays.set('did:agent:relay-b', {
      did: 'did:agent:relay-b',
      endpoints: ['ws://relay-b.test'],
      ws: createFakeWs(),
      connected: true,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    await manager.handleIncomingMessage(createFakeWs() as any, 'did:agent:relay-b', {
      type: 'AGENT_JOINED',
      agentDid: 'did:agent:gpu-remote',
      agentCard: createCard('did:agent:gpu-remote', { visibility: 'public' }),
      realm: 'public',
      timestamp: Date.now(),
    } as any);

    expect(manager.listRemoteDirectoryEntries()).toEqual([
      expect.objectContaining({
        did: 'did:agent:gpu-remote',
        online: true,
        discoverable: true,
        visibilityRealm: 'public',
        homeRelay: 'did:agent:relay-b',
      }),
    ]);
  });

  it('normalizes routed envelopes to Uint8Array before local delivery', async () => {
    const targetWs = createFakeWs();
    const targetAgent = {
      did: 'did:agent:target',
      card: createCard('did:agent:target', { visibility: 'public' }),
      realm: 'public',
      online: true,
      ws: targetWs,
    };
    const manager = createManager({ exportPolicy: 'full' }, {
      get: (did: string) => did === 'did:agent:target' ? targetAgent : undefined,
    });
    const inboundWs = createFakeWs();

    await (manager as any).handleRouteRequest(inboundWs as any, 'did:agent:relay-peer', {
      type: 'ROUTE_REQUEST',
      targetDid: 'did:agent:target',
      envelope: [1, 2, 3, 4],
      fromRelay: 'did:agent:relay-peer',
      hopCount: 0,
      messageId: 'msg-bytes',
    });

    expect(targetWs.sent).toHaveLength(1);
    expect(targetWs.sent[0]).toMatchObject({ type: 'DELIVER', messageId: 'msg-bytes' });
    expect(targetWs.sent[0].envelope).toBeInstanceOf(Uint8Array);
  });

  it('stops auto-reconnecting after the configured retry limit', async () => {
    vi.useFakeTimers();

    const relayDid = 'did:agent:relay-peer';
    const manager = createManager({ reconnectDelay: 100, maxReconnectDelay: 100, maxReconnectAttempts: 2 });
    const connectSpy = vi.spyOn(manager as any, 'connectToRelay').mockResolvedValue(false);

    (manager as any).federatedRelays.set(relayDid, {
      did: relayDid,
      endpoints: ['ws://peer.test'],
      card: createCard(relayDid),
      ws: null,
      connected: true,
      connecting: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    (manager as any).handleRelayDisconnection(relayDid);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);

    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect((manager as any).federatedRelays.has(relayDid)).toBe(false);
  });

  it('rejects discovered relays that do not satisfy federation eligibility', async () => {
    const manager = createManager();
    const openSpy = vi.spyOn(manager as any, 'openFederationConnection').mockResolvedValue(true);

    const connected = await (manager as any).connectToRelay('did:agent:relay-peer', createCard('did:agent:relay-peer'));

    expect(connected).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('rate limits inbound federation handshakes before verification work', () => {
    const manager = createManager({ handshakeRateLimitWindowMs: 60000, handshakeRateLimitMaxAttempts: 2 });
    const context = { remoteIp: '203.0.113.10', userAgent: 'RelayProbe/1.0' };

    expect((manager as any).guardIncomingFederationHandshake(context, 'did:agent:relay-peer')).toEqual({ ok: true });
    expect((manager as any).guardIncomingFederationHandshake(context, 'did:agent:relay-peer')).toEqual({ ok: true });
    expect((manager as any).guardIncomingFederationHandshake(context, 'did:agent:relay-peer')).toEqual({
      ok: false,
      error: 'Federation handshake rate limit exceeded',
      closeCode: 1013,
    });
  });

  it('quarantines repeated failed inbound federation attempts', () => {
    const manager = createManager({ failedHandshakeWindowMs: 60000, failedHandshakeThreshold: 2, failedHandshakeQuarantineMs: 300000 });
    const context = { remoteIp: '203.0.113.11', userAgent: 'RelayProbe/1.0' };
    const relayDid = 'did:agent:relay-peer';

    (manager as any).recordIncomingFederationFailure(relayDid, context.remoteIp, 'Invalid federation hello signature');
    expect((manager as any).guardIncomingFederationHandshake(context, relayDid)).toEqual({ ok: true });

    (manager as any).recordIncomingFederationFailure(relayDid, context.remoteIp, 'Invalid federation hello signature');
    expect((manager as any).guardIncomingFederationHandshake(context, relayDid)).toEqual({
      ok: false,
      error: 'Federation handshake temporarily quarantined',
      closeCode: 1013,
    });
  });

  it('ignores remote agent updates from relays that are still in probation', async () => {
    const manager = createManager({ exportPolicy: 'full' });
    const relayWs = createFakeWs();

    (manager as any).federatedRelays.set('did:agent:relay-b', {
      did: 'did:agent:relay-b',
      endpoints: ['ws://relay-b.test'],
      ws: relayWs,
      connected: true,
      admissionState: 'probation',
      admittedByPeer: false,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
    });

    await manager.handleIncomingMessage(relayWs as any, 'did:agent:relay-b', {
      type: 'AGENT_JOINED',
      agentDid: 'did:agent:gpu-remote',
      agentCard: createCard('did:agent:gpu-remote', { visibility: 'public' }),
      realm: 'public',
      timestamp: Date.now(),
    } as any);

    expect(manager.listRemoteDirectoryEntries()).toEqual([]);
  });

  it('promotes a relay to admitted only after health and card probes succeed', async () => {
    const relayDid = 'did:agent:relay-peer';
    const relayCard = createRelayCard(relayDid);
    const manager = createManager({ exportPolicy: 'full' });
    const verifySpy = vi.spyOn(manager as any, 'verifyRelayCard').mockResolvedValue(true);

    const relayWs = createFakeWs((message) => {
      if (message.type === 'FEDERATION_HEALTH_CHECK') {
        queueMicrotask(() => {
          void manager.handleIncomingMessage(relayWs as any, relayDid, {
            type: 'FEDERATION_HEALTH_RESPONSE',
            uptime: 100,
            connectedAgents: 2,
            queuedMessages: 0,
            timestamp: Date.now(),
          } as any);
        });
      }

      if (message.type === 'FETCH_CARD') {
        queueMicrotask(() => {
          void manager.handleIncomingMessage(relayWs as any, relayDid, {
            type: 'CARD',
            did: relayDid,
            card: relayCard,
          } as any);
        });
      }
    });

    (manager as any).federatedRelays.set(relayDid, {
      did: relayDid,
      endpoints: ['ws://relay-peer.test'],
      card: relayCard,
      ws: relayWs,
      connected: true,
      admissionState: 'authenticated',
      admittedByPeer: false,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
      pendingPeerDids: [],
      admissionError: null,
    });

    const admitted = await (manager as any).beginAdmission(relayDid);
    const relay = (manager as any).federatedRelays.get(relayDid);

    expect(admitted).toBe(true);
    expect(relay.admissionState).toBe('admitted');
    expect(relay.admissionError).toBeNull();
    expect(relayWs.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'FEDERATION_HEALTH_CHECK' }),
      expect.objectContaining({ type: 'FETCH_CARD', did: relayDid }),
      expect.objectContaining({ type: 'FEDERATION_ADMITTED', relayDid: 'did:agent:relay-local' }),
    ]));

    verifySpy.mockRestore();
  });

  it('waits for peer admission before broadcasting local federation updates', async () => {
    const manager = createManager({ exportPolicy: 'full' });
    const relayWs = createFakeWs();

    (manager as any).federatedRelays.set('did:agent:relay-peer', {
      did: 'did:agent:relay-peer',
      endpoints: ['ws://relay-peer.test'],
      card: createRelayCard('did:agent:relay-peer'),
      ws: relayWs,
      connected: true,
      admissionState: 'admitted',
      admittedByPeer: false,
      lastSeen: Date.now(),
      agentCount: 0,
      uptime: 0,
      pendingPeerDids: [],
    });

    manager.notifyAgentJoined('did:agent:before-active', createCard('did:agent:before-active'), 'public');
    expect(relayWs.sent).toHaveLength(0);

    await manager.handleIncomingMessage(relayWs as any, 'did:agent:relay-peer', {
      type: 'FEDERATION_ADMITTED',
      relayDid: 'did:agent:relay-peer',
      protocolVersion: 1,
      timestamp: Date.now(),
    } as any);

    manager.notifyAgentJoined('did:agent:after-active', createCard('did:agent:after-active'), 'public');

    expect(relayWs.sent).toHaveLength(1);
    expect(relayWs.sent[0]).toMatchObject({ type: 'AGENT_JOINED', agentDid: 'did:agent:after-active' });
  });
});
