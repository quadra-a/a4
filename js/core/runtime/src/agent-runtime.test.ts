import { beforeEach, describe, expect, it, vi } from 'vitest';

const daemonState = { running: false };
const sendMock = vi.fn();
const createRelayClientMock = vi.fn();
const createRelayIndexOperationsMock = vi.fn();
const generateAnonymousIdentityMock = vi.fn();
const queryAgentCardMock = vi.fn();
const searchSemanticMock = vi.fn();
const startMock = vi.fn(async () => undefined);
const stopMock = vi.fn(async () => undefined);

vi.mock('./config.js', () => ({
  getAgentCard: vi.fn(() => null),
  getIdentity: vi.fn(() => null),
  getReachabilityPolicy: vi.fn((options: { relay?: string } = {}) => ({
    bootstrapProviders: options.relay ? [options.relay] : ['wss://relay.example'],
    mode: options.relay ? 'fixed' : 'adaptive',
    autoDiscoverProviders: false,
    targetProviderCount: 1,
  })),
  getRelayInviteToken: vi.fn(() => undefined),
  setAgentCard: vi.fn(),
}));

vi.mock('./daemon-client.js', () => ({
  DaemonClient: vi.fn().mockImplementation(() => ({
    isDaemonRunning: vi.fn(async () => daemonState.running),
    send: sendMock,
  })),
}));

vi.mock('./reachability.js', () => ({
  DEFAULT_BOOTSTRAP_PROVIDERS: ['wss://relay.example'],
}));

vi.mock('@quadra-a/protocol', () => ({
  createAgentCard: vi.fn((did: string, name: string, description: string, capabilities: unknown[], endpoints: string[]) => ({
    did,
    name,
    description,
    capabilities,
    endpoints,
    version: '1.0.0',
    timestamp: Date.now(),
    signature: 'sig',
  })),
  createRelayClient: createRelayClientMock,
  createRelayIndexOperations: createRelayIndexOperationsMock,
  generateAnonymousIdentity: generateAnonymousIdentityMock,
  importKeyPair: vi.fn(() => ({
    publicKey: new Uint8Array([1]),
    privateKey: new Uint8Array([2]),
  })),
  sign: vi.fn(async () => new Uint8Array([3])),
  signAgentCard: vi.fn(async (card: unknown) => card),
}));

const runtime = await import('./agent-runtime.js');

beforeEach(() => {
  daemonState.running = false;
  sendMock.mockReset();
  queryAgentCardMock.mockReset();
  searchSemanticMock.mockReset();
  startMock.mockClear();
  stopMock.mockClear();
  createRelayClientMock.mockReset();
  createRelayIndexOperationsMock.mockReset();
  generateAnonymousIdentityMock.mockReset();

  createRelayClientMock.mockImplementation((config: { relayUrls: string[]; did: string }) => ({
    start: startMock,
    stop: stopMock,
    getConnectedRelays: vi.fn(() => config.relayUrls),
    getKnownRelays: vi.fn(() => config.relayUrls),
    getReachabilityStatus: vi.fn(() => ({
      connectedRelays: config.relayUrls,
      knownRelays: config.relayUrls,
      lastDiscoveryAt: null,
      relayFailures: [],
      targetRelayCount: config.relayUrls.length,
      autoDiscoverRelays: false,
    })),
    getPeerCount: vi.fn(() => 0),
  }));

  createRelayIndexOperationsMock.mockImplementation(() => ({
    queryAgentCard: queryAgentCardMock,
    searchSemantic: searchSemanticMock,
  }));

  generateAnonymousIdentityMock.mockResolvedValue({
    did: 'did:agent:anonymous-query',
    publicKey: 'public',
    privateKey: 'private',
    agentCard: {
      name: 'Anonymous Query Agent',
      description: 'Temporary read-only session',
      capabilities: [],
    },
  });
});

describe('agent-runtime read-only sessions', () => {
  it('prefers the daemon for card queries when available', async () => {
    sendMock.mockResolvedValue({ did: 'did:agent:target', name: 'Target Agent' });
    daemonState.running = true;

    const result = await runtime.queryAgentCard('did:agent:target');

    expect(sendMock).toHaveBeenCalledWith('query_agent_card', { did: 'did:agent:target' });
    expect(createRelayClientMock).not.toHaveBeenCalled();
    expect(result).toEqual({ did: 'did:agent:target', name: 'Target Agent' });
  });

  it('uses an anonymous relay session for DID lookups when the daemon is offline', async () => {
    queryAgentCardMock.mockResolvedValue({ did: 'did:agent:target', name: 'Target Agent' });

    const result = await runtime.queryAgentCard('did:agent:target', 'wss://custom-relay.example');

    expect(generateAnonymousIdentityMock).toHaveBeenCalledTimes(1);
    expect(createRelayClientMock).toHaveBeenCalledWith(expect.objectContaining({
      relayUrls: ['wss://custom-relay.example'],
      did: 'did:agent:anonymous-query',
    }));
    expect(queryAgentCardMock).toHaveBeenCalledWith('did:agent:target');
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ did: 'did:agent:target', name: 'Target Agent' });
  });

  it('uses an anonymous relay session for discovery when the daemon is offline', async () => {
    searchSemanticMock.mockResolvedValue([{ did: 'did:agent:compute', name: 'GPU Agent' }]);

    const result = await runtime.searchAgents(
      { text: 'gpu', capability: 'compute', limit: 5 },
      'wss://custom-relay.example',
    );

    expect(sendMock).not.toHaveBeenCalled();
    expect(generateAnonymousIdentityMock).toHaveBeenCalledTimes(1);
    expect(createRelayClientMock).toHaveBeenCalledWith(expect.objectContaining({
      relayUrls: ['wss://custom-relay.example'],
      did: 'did:agent:anonymous-query',
    }));
    expect(searchSemanticMock).toHaveBeenCalledWith({
      text: 'gpu',
      capability: 'compute',
      filters: undefined,
      limit: 5,
    });
    expect(result).toEqual([{ did: 'did:agent:compute', name: 'GPU Agent' }]);
  });
});
