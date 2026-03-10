import { describe, expect, it } from 'vitest';
import {
  normalizeProviderUrls,
  policyToReachabilityStatus,
  resolveReachabilityPolicy,
} from './reachability.js';

describe('reachability policy helpers', () => {
  it('deduplicates bootstrap providers', () => {
    expect(normalizeProviderUrls([' ws://one ', 'ws://one', 'ws://two'])).toEqual([
      'ws://one',
      'ws://two',
    ]);
  });

  it('resolves fixed relay overrides', () => {
    const policy = resolveReachabilityPolicy(
      {
        mode: 'adaptive',
        bootstrapProviders: ['ws://one'],
        targetProviderCount: 3,
        autoDiscoverProviders: true,
        operatorLock: false,
      },
      {
        relay: 'ws://fixed',
        mode: 'fixed',
      },
    );

    expect(policy.mode).toBe('fixed');
    expect(policy.bootstrapProviders).toEqual(['ws://fixed']);
    expect(policy.autoDiscoverProviders).toBe(false);
  });

  it('merges runtime status onto policy defaults', () => {
    const status = policyToReachabilityStatus(
      {
        mode: 'adaptive',
        bootstrapProviders: ['ws://seed'],
        targetProviderCount: 3,
        autoDiscoverProviders: true,
        operatorLock: false,
      },
      {
        connectedProviders: ['ws://seed'],
        knownProviders: ['ws://seed', 'ws://extra'],
      },
    );

    expect(status.connectedProviders).toEqual(['ws://seed']);
    expect(status.knownProviders).toEqual(['ws://seed', 'ws://extra']);
    expect(status.targetProviderCount).toBe(3);
  });
});
