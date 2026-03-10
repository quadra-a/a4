import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayAgent, getRelayStartupWarnings } from '../relay-agent.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getRelayStartupWarnings', () => {
  it('warns when PUBLIC_ENDPOINT is not configured', () => {
    const warnings = getRelayStartupWarnings({
      port: 8080,
      configuredPublicEndpoints: [],
      publishedEndpoints: ['ws://localhost:8080'],
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('No PUBLIC_ENDPOINT configured');
    expect(warnings[0]).toContain('ws://localhost:8080');
    expect(warnings[1]).toContain('loopback-only');
  });

  it('warns when a configured endpoint is still loopback-only', () => {
    const warnings = getRelayStartupWarnings({
      port: 8080,
      configuredPublicEndpoints: ['ws://127.0.0.1:8080'],
      publishedEndpoints: ['ws://127.0.0.1:8080'],
    });

    expect(warnings).toEqual([
      'Published endpoint ws://127.0.0.1:8080 is loopback-only. External peers cannot reach localhost, 127.0.0.1, ::1, or 0.0.0.0 from another machine.',
    ]);
  });

  it('does not warn for a reachable public endpoint', () => {
    const warnings = getRelayStartupWarnings({
      port: 8080,
      configuredPublicEndpoints: ['wss://relay.example.com'],
      publishedEndpoints: ['wss://relay.example.com'],
    });

    expect(warnings).toEqual([]);
  });
});

describe('RelayAgent HELLO UX', () => {
  it('rejects invalid DIDs without logging an internal error stack', async () => {
    const relay = new RelayAgent({ federationEnabled: false });
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await (relay as any).handleHello(ws as any, {
      type: 'HELLO',
      protocolVersion: 1,
      did: 'not-a-did',
      card: {
        did: 'not-a-did',
        name: 'Broken Client',
        description: 'invalid did test',
        version: '1.0',
        capabilities: [],
        endpoints: [],
        timestamp: Date.now(),
        signature: 'sig',
      },
      timestamp: Date.now(),
      signature: [],
    }, {
      remoteIp: '203.0.113.7',
      userAgent: 'CodexProbe/1.0',
    });

    expect(result).toEqual({ success: false, error: 'Invalid DID format' });
    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid DID format');
    expect(warnSpy).toHaveBeenCalledWith('Rejected HELLO: Invalid DID format ip=203.0.113.7 ua="CodexProbe/1.0"');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects HELLO when card DID does not match message DID', async () => {
    const relay = new RelayAgent({ federationEnabled: false });
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deriveDID, generateKeyPair } = await import('@quadra-a/protocol');
    const keyPair = await generateKeyPair();
    const did = deriveDID(keyPair.publicKey);

    const result = await (relay as any).handleHello(ws as any, {
      type: 'HELLO',
      protocolVersion: 1,
      did,
      card: {
        did: 'did:agent:zDifferentClient',
        name: 'Mismatched Client',
        description: 'did mismatch test',
        version: '1.0',
        capabilities: [],
        endpoints: [],
        timestamp: Date.now(),
        signature: 'sig',
      },
      timestamp: Date.now(),
      signature: [],
    });

    expect(result).toEqual({ success: false, error: 'HELLO DID mismatch' });
    expect(ws.close).toHaveBeenCalledWith(1008, 'HELLO DID mismatch');
    expect(warnSpy).toHaveBeenCalledWith('Rejected HELLO: HELLO DID mismatch ip=unknown ua="unknown"');
  });
});
