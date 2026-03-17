import { beforeEach, describe, expect, it, vi } from 'vitest';

const daemonState = { running: false };
const identityState = {
  current: null as null | { did: string; publicKey: string; privateKey: string },
};
const cardState = {
  current: null as null | { name: string; description: string; capabilities: string[] },
};
const deviceIdentityState = {
  current: null as null | { seed: string; deviceId: string },
};

const sendMock = vi.fn();
const createRelayClientMock = vi.fn();
const createRelayIndexOperationsMock = vi.fn();
const generateAnonymousIdentityMock = vi.fn();
const queryAgentCardMock = vi.fn();
const searchSemanticMock = vi.fn();
const publishPreKeyBundlesMock = vi.fn(async () => undefined);
const publishCardMock = vi.fn(async () => undefined);
const startMock = vi.fn(async () => undefined);
const stopMock = vi.fn(async () => undefined);

vi.mock('./config.js', () => ({
  getAgentCard: vi.fn(() => cardState.current),
  getIdentity: vi.fn(() => identityState.current),
  getReachabilityPolicy: vi.fn((options: { relay?: string } = {}) => ({
    bootstrapProviders: options.relay ? [options.relay] : ['wss://relay.example'],
    mode: options.relay ? 'fixed' : 'adaptive',
    autoDiscoverProviders: false,
    targetProviderCount: 1,
  })),
  getRelayInviteToken: vi.fn(() => undefined),
  getE2EConfig: vi.fn(() => undefined),
  getDeviceIdentity: vi.fn(() => deviceIdentityState.current),
  setE2EConfig: vi.fn(),
  setDeviceIdentity: vi.fn((nextDeviceIdentity) => {
    deviceIdentityState.current = nextDeviceIdentity;
  }),
  setAgentCard: vi.fn((nextCard) => {
    cardState.current = nextCard;
  }),
}));

vi.mock('./daemon-client.js', () => ({
  DaemonClient: vi.fn().mockImplementation(function () {
    return {
      isDaemonRunning: vi.fn(async () => daemonState.running),
      send: sendMock,
    };
  }),
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
  hexToBytes: vi.fn(() => new Uint8Array(32)),
  bytesToHex: vi.fn((value: Uint8Array) => Buffer.from(value).toString('hex')),
  concatBytes: vi.fn((...parts: Uint8Array[]) => {
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }),
  randomBytes: vi.fn((length: number) => new Uint8Array(length).fill(1)),
  createInitialLocalE2EConfig: vi.fn(async () => ({
    currentDeviceId: 'device-anon',
    devices: {
      'device-anon': {
        deviceId: 'device-anon',
        createdAt: 1,
        identityKey: { publicKey: 'aa', privateKey: 'bb' },
        signedPreKey: { signedPreKeyId: 1, publicKey: 'cc', privateKey: 'dd', signature: 'ee', createdAt: 1 },
        oneTimePreKeys: [],
        lastResupplyAt: 1,
        sessions: {},
      },
    },
  })),
  buildPublishedDeviceDirectory: vi.fn(() => ([{
    deviceId: 'device-anon',
    identityKeyPublic: 'aa',
    signedPreKeyPublic: 'cc',
    signedPreKeyId: 1,
    signedPreKeySignature: 'ee',
    oneTimePreKeyCount: 0,
    lastResupplyAt: 1,
  }])),
  buildPublishedPreKeyBundles: vi.fn(() => ([{
    deviceId: 'device-anon',
    identityKeyPublic: 'aa',
    signedPreKeyPublic: 'cc',
    signedPreKeyId: 1,
    signedPreKeySignature: 'ee',
    oneTimePreKeyCount: 1,
    lastResupplyAt: 1,
    oneTimePreKeys: [{ keyId: 1, publicKey: 'otk-1' }],
  }])),
}));

const runtime = await import('./agent-runtime.js');

beforeEach(() => {
  daemonState.running = false;
  identityState.current = null;
  cardState.current = null;
  deviceIdentityState.current = null;
  sendMock.mockReset();
  queryAgentCardMock.mockReset();
  searchSemanticMock.mockReset();
  publishPreKeyBundlesMock.mockClear();
  publishCardMock.mockClear();
  startMock.mockClear();
  stopMock.mockClear();
  createRelayClientMock.mockReset();
  createRelayIndexOperationsMock.mockReset();
  generateAnonymousIdentityMock.mockReset();

  createRelayClientMock.mockImplementation((config: { relayUrls: string[]; did: string }) => ({
    start: startMock,
    stop: stopMock,
    publishPreKeyBundles: publishPreKeyBundlesMock,
    publishCard: publishCardMock,
    unpublishCard: vi.fn(async () => undefined),
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

  it('unwraps Rust-style card query responses from the daemon', async () => {
    sendMock.mockResolvedValue({ card: { did: 'did:agent:target', name: 'Wrapped Agent' } });
    daemonState.running = true;

    const result = await runtime.queryAgentCard('did:agent:target');

    expect(sendMock).toHaveBeenCalledWith('query_agent_card', { did: 'did:agent:target' });
    expect(result).toEqual({ did: 'did:agent:target', name: 'Wrapped Agent' });
  });

  it('uses an anonymous relay session for DID lookups when the daemon is offline', async () => {
    queryAgentCardMock.mockResolvedValue({ did: 'did:agent:target', name: 'Target Agent' });

    const result = await runtime.queryAgentCard('did:agent:target', 'wss://custom-relay.example');

    expect(generateAnonymousIdentityMock).toHaveBeenCalledTimes(1);
    expect(createRelayClientMock).toHaveBeenCalledWith(expect.objectContaining({
      relayUrls: ['wss://custom-relay.example'],
      did: 'did:agent:anonymous-query',
    }));
    expect(publishPreKeyBundlesMock).not.toHaveBeenCalled();
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

describe('agent-runtime pre-key publication', () => {
  it('publishes local pre-key bundles before direct card publication', async () => {
    identityState.current = {
      did: 'did:agent:local',
      publicKey: 'public-local',
      privateKey: 'private-local',
    };

    const result = await runtime.publishAgentCard({
      relay: 'wss://custom-relay.example',
      name: 'Updated Agent',
      description: 'updated description',
      capabilities: ['agent/test'],
    });

    expect(createRelayClientMock).toHaveBeenCalledWith(expect.objectContaining({
      relayUrls: ['wss://custom-relay.example'],
      did: 'did:agent:local',
    }));
    expect(publishPreKeyBundlesMock).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'device-anon' }),
    ]));
    expect(publishCardMock).toHaveBeenCalledWith(expect.objectContaining({
      did: 'did:agent:local',
      name: 'Updated Agent',
    }));
    expect(publishPreKeyBundlesMock.mock.invocationCallOrder[0]).toBeLessThan(
      publishCardMock.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({
      did: 'did:agent:local',
      card: {
        name: 'Updated Agent',
        description: 'updated description',
        capabilities: ['agent/test'],
      },
    });
  });
});
