import { Level } from 'level';
import type { ClaimedPreKeyBundle, PublishedPreKeyBundle, PublishedOneTimePreKey } from './types.js';

interface StoredPreKeyBundleRecord extends PublishedPreKeyBundle {
  did: string;
  realm: string;
  updatedAt: number;
}

function normalizeOneTimePreKeys(keys: PublishedOneTimePreKey[]): PublishedOneTimePreKey[] {
  const seen = new Set<number>();
  return [...keys]
    .filter((key) => Number.isInteger(key.keyId) && key.keyId > 0 && typeof key.publicKey === 'string' && key.publicKey.length > 0)
    .sort((left, right) => left.keyId - right.keyId)
    .filter((key) => {
      if (seen.has(key.keyId)) {
        return false;
      }
      seen.add(key.keyId);
      return true;
    });
}

function normalizeBundle(bundle: PublishedPreKeyBundle): PublishedPreKeyBundle {
  const oneTimePreKeys = normalizeOneTimePreKeys(bundle.oneTimePreKeys ?? []);
  return {
    deviceId: bundle.deviceId,
    identityKeyPublic: bundle.identityKeyPublic,
    signedPreKeyPublic: bundle.signedPreKeyPublic,
    signedPreKeyId: bundle.signedPreKeyId,
    signedPreKeySignature: bundle.signedPreKeySignature,
    oneTimePreKeyCount: oneTimePreKeys.length,
    lastResupplyAt: bundle.lastResupplyAt,
    oneTimePreKeys,
  };
}

export interface PreKeyStoreConfig {
  storagePath: string;
}

export class PreKeyStore {
  private db: Level<string, StoredPreKeyBundleRecord>;
  private lockChains = new Map<string, Promise<void>>();

  constructor(config: PreKeyStoreConfig) {
    this.db = new Level<string, StoredPreKeyBundleRecord>(config.storagePath, {
      valueEncoding: 'json',
    });
  }

  async start(): Promise<void> {
    await this.db.open();
  }

  async stop(): Promise<void> {
    await this.db.close();
  }

  private didKey(did: string): string {
    return `did:${did}`;
  }

  private bundleKey(did: string, deviceId: string): string {
    return `bundle:${did}:${deviceId}`;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockChains.get(key) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const chain = previous.then(() => current);
    this.lockChains.set(key, chain);

    await previous;
    try {
      return await fn();
    } finally {
      resolveCurrent();
      if (this.lockChains.get(key) === chain) {
        this.lockChains.delete(key);
      }
    }
  }

  async publishBundles(did: string, realm: string, bundles: PublishedPreKeyBundle[]): Promise<void> {
    await this.withLock(this.didKey(did), async () => {
      const normalizedBundles = bundles.map(normalizeBundle);
      const nextDeviceIds = new Set(normalizedBundles.map((bundle) => bundle.deviceId));
      const prefix = this.bundleKey(did, '');

      for await (const [key] of this.db.iterator({ gte: prefix, lt: `${prefix}\xff` })) {
        const deviceId = key.slice(prefix.length);
        if (!nextDeviceIds.has(deviceId)) {
          await this.db.del(key);
        }
      }

      const updatedAt = Date.now();
      for (const bundle of normalizedBundles) {
        await this.db.put(this.bundleKey(did, bundle.deviceId), {
          did,
          realm,
          updatedAt,
          ...bundle,
          oneTimePreKeyCount: bundle.oneTimePreKeys.length,
        });
      }
    });
  }

  async claimBundle(
    did: string,
    deviceId: string,
    requesterRealm: string,
  ): Promise<ClaimedPreKeyBundle | null> {
    return this.withLock(this.didKey(did), async () => {
      let stored: StoredPreKeyBundleRecord;
      try {
        stored = await this.db.get(this.bundleKey(did, deviceId));
      } catch {
        return null;
      }

      if (stored.realm !== requesterRealm) {
        return null;
      }

      const [oneTimePreKey, ...remainingKeys] = stored.oneTimePreKeys;
      const nextRecord: StoredPreKeyBundleRecord = {
        ...stored,
        oneTimePreKeys: remainingKeys,
        oneTimePreKeyCount: remainingKeys.length,
        updatedAt: Date.now(),
      };
      await this.db.put(this.bundleKey(did, deviceId), nextRecord);

      return {
        deviceId: stored.deviceId,
        identityKeyPublic: stored.identityKeyPublic,
        signedPreKeyPublic: stored.signedPreKeyPublic,
        signedPreKeyId: stored.signedPreKeyId,
        signedPreKeySignature: stored.signedPreKeySignature,
        oneTimePreKeyCount: remainingKeys.length,
        oneTimePreKey,
        remainingOneTimePreKeyCount: remainingKeys.length,
        lastResupplyAt: stored.lastResupplyAt,
      };
    });
  }
}
