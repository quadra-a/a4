import { describe, expect, it } from 'vitest';
import { decode as decodeCBOR, encode as encodeCBOR } from 'cbor-x';
import { RelayAgent } from '../relay-agent.js';

function createCard(did: string, capability = 'gpu/matmul') {
  return {
    did,
    name: did,
    description: did,
    version: '1.0.0',
    capabilities: [{ id: capability, name: capability, description: capability }],
    endpoints: ['ws://example.test'],
    timestamp: Date.now(),
    signature: 'sig',
  };
}

function createCaptureWs() {
  const sent: any[] = [];
  return {
    sent,
    send(payload: Uint8Array) {
      sent.push(decodeCBOR(payload));
    },
  };
}

describe('RelayAgent federated directory', () => {
  it('includes federated remote agents in standard discovery', async () => {
    const relay = new RelayAgent({ federationEnabled: false });
    (relay as any).registry = {
      get: (did: string) => did === 'did:agent:requester' ? { realm: 'public' } : undefined,
      listDirectoryEntries: () => [
        {
          did: 'did:agent:local',
          card: createCard('did:agent:local', 'cpu/matmul'),
          online: true,
          discoverable: true,
          visibilityRealm: 'public',
          lastSeen: Date.now(),
        },
      ],
    };
    (relay as any).relayIdentity = {
      getIdentity: () => ({
        did: 'did:agent:relay-local',
        agentCard: createCard('did:agent:relay-local', 'relay/message-routing'),
      }),
    };
    (relay as any).federationManager = {
      listRemoteDirectoryEntries: () => [
        {
          did: 'did:agent:gpu-remote',
          card: createCard('did:agent:gpu-remote'),
          online: true,
          discoverable: true,
          visibilityRealm: 'public',
          lastSeen: Date.now(),
          homeRelay: 'did:agent:relay-remote',
        },
      ],
      getFederationStatus: () => ({ relayCount: 1, connectedRelays: ['did:agent:relay-remote'], totalAgents: 1 }),
    };
    (relay as any).endorsements = {
      getTrustSummary: () => undefined,
    };

    const ws = createCaptureWs();
    await (relay as any).handleDiscover(ws as any, 'did:agent:requester', {
      type: 'DISCOVER',
      query: 'gpu',
      limit: 10,
    });

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'DISCOVERED',
      federationInfo: expect.objectContaining({ crossRelayResults: true }),
    });
    expect(ws.sent[0].agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          did: 'did:agent:gpu-remote',
          homeRelay: 'did:agent:relay-remote',
        }),
      ]),
    );
  });

  it('fetches a federated remote card through both relay surfaces', async () => {
    const relay = new RelayAgent({ federationEnabled: false });
    (relay as any).registry = {
      get: (did: string) => did === 'did:agent:requester' ? { realm: 'public' } : undefined,
    };
    (relay as any).relayIdentity = {
      getIdentity: () => ({
        did: 'did:agent:relay-local',
        agentCard: createCard('did:agent:relay-local', 'relay/message-routing'),
      }),
    };
    (relay as any).federationManager = {
      getRemoteAgentCard: (did: string, realm: string) => did === 'did:agent:gpu-remote' && realm === 'public'
        ? createCard('did:agent:gpu-remote')
        : null,
    };

    const standardWs = createCaptureWs();
    await (relay as any).handleFetchCard(standardWs as any, 'did:agent:requester', {
      type: 'FETCH_CARD',
      did: 'did:agent:gpu-remote',
    });

    expect(standardWs.sent[0]).toMatchObject({
      type: 'CARD',
      did: 'did:agent:gpu-remote',
      card: expect.objectContaining({ did: 'did:agent:gpu-remote' }),
    });

    const relayWs = createCaptureWs();
    await (relay as any).handleRelayFetchCard(relayWs as any, 'did:agent:requester', {
      type: 'FETCH_CARD',
      did: 'did:agent:gpu-remote',
    });

    expect(relayWs.sent[0]).toMatchObject({ type: 'DELIVER' });
    expect(decodeCBOR(relayWs.sent[0].envelope)).toMatchObject({
      type: 'CARD',
      did: 'did:agent:gpu-remote',
      card: expect.objectContaining({ did: 'did:agent:gpu-remote' }),
    });
  });

  it('routes relay-directed envelopes through relay protocol handlers', async () => {
    const relay = new RelayAgent({ federationEnabled: false });
    const senderWs = createCaptureWs();

    (relay as any).registry = {
      get: (did: string) => {
        if (did === 'did:agent:requester') {
          return { realm: 'public', ws: senderWs };
        }
        return undefined;
      },
    };
    (relay as any).relayIdentity = {
      getIdentity: () => ({
        did: 'did:agent:relay-local',
        agentCard: createCard('did:agent:relay-local', 'relay/message-routing'),
      }),
    };
    (relay as any).federationManager = {
      getRemoteAgentCard: (did: string, realm: string) => did === 'did:agent:gpu-remote' && realm === 'public'
        ? createCard('did:agent:gpu-remote')
        : null,
    };

    await (relay as any).routeMessage('did:agent:requester', {
      type: 'SEND',
      to: 'did:agent:relay-local',
      envelope: encodeCBOR({
        type: 'FETCH_CARD',
        did: 'did:agent:gpu-remote',
      }),
    });

    expect(senderWs.sent).toHaveLength(1);
    expect(senderWs.sent[0]).toMatchObject({ type: 'DELIVER' });
    expect(decodeCBOR(senderWs.sent[0].envelope)).toMatchObject({
      type: 'CARD',
      did: 'did:agent:gpu-remote',
      card: expect.objectContaining({ did: 'did:agent:gpu-remote' }),
    });
  });
});
