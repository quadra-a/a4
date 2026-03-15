import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalE2EConfig } from '@quadra-a/protocol';

const state: {
  identity?: { did: string; publicKey: string; privateKey: string };
  e2e?: LocalE2EConfig;
  deviceIdentity?: { seed: string; deviceId: string };
} = {};

vi.mock('./config.js', () => ({
  getIdentity: vi.fn(() => state.identity),
  getE2EConfig: vi.fn(() => state.e2e),
  getDeviceIdentity: vi.fn(() => state.deviceIdentity),
  setE2EConfig: vi.fn((value: LocalE2EConfig) => {
    state.e2e = value;
  }),
  setDeviceIdentity: vi.fn((value: { seed: string; deviceId: string }) => {
    state.deviceIdentity = value;
  }),
}));

const runtimeE2E = await import('./e2e-config.js');

describe('runtime e2e config', () => {
  beforeEach(() => {
    state.identity = {
      did: 'did:agent:zLocalAgent',
      publicKey: '11'.repeat(32),
      privateKey: '22'.repeat(32),
    };
    state.e2e = undefined;
    state.deviceIdentity = undefined;
  });

  it('persists one local E2E device config for the active identity', async () => {
    const { e2eConfig, created } = await runtimeE2E.ensurePersistedE2EConfig(state.identity!);

    expect(created).toBe(true);
    expect(e2eConfig.currentDeviceId).toMatch(/^device-/);
    expect(Object.keys(e2eConfig.devices)).toHaveLength(1);
    expect(state.e2e?.currentDeviceId).toBe(e2eConfig.currentDeviceId);
    expect(state.deviceIdentity?.deviceId).toBe(e2eConfig.currentDeviceId);
  });

  it('backfills device identity from an existing persisted device id', async () => {
    const persisted = await runtimeE2E.ensurePersistedE2EConfig(state.identity!);
    state.deviceIdentity = undefined;

    const backfilled = runtimeE2E.ensurePersistedDeviceIdentity();

    expect(backfilled.created).toBe(true);
    expect(backfilled.deviceIdentity.deviceId).toBe(persisted.e2eConfig.currentDeviceId);
    expect(state.deviceIdentity?.deviceId).toBe(persisted.e2eConfig.currentDeviceId);
  });

  it('reuses the persisted device identity when rebuilding missing E2E state', async () => {
    const persistedDeviceIdentity = runtimeE2E.createDeviceIdentity(new Uint8Array(32).fill(7));
    state.deviceIdentity = persistedDeviceIdentity;

    const { e2eConfig } = await runtimeE2E.ensurePersistedE2EConfig(state.identity!);

    expect(e2eConfig.currentDeviceId).toBe(persistedDeviceIdentity.deviceId);
    expect(state.e2e?.currentDeviceId).toBe(persistedDeviceIdentity.deviceId);
  });

  it('does not publish ephemeral device metadata for transient identities', async () => {
    await runtimeE2E.ensurePersistedE2EConfig(state.identity!);
    const published = await runtimeE2E.resolvePublishedDevices({
      did: 'did:agent:zEphemeral',
      privateKey: '33'.repeat(32),
    });

    expect(published).toHaveLength(0);
    expect(state.e2e?.currentDeviceId).toBe(state.deviceIdentity?.deviceId);
  });

  it('derives a stable device id from a seed', () => {
    expect(
      runtimeE2E.deriveDeviceId('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
    ).toBe('device-f2f59669be519c02');
  });
});
