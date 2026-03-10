import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCKER_DATA_DIR, LEGACY_DOCKER_DATA_DIR, resolveStoragePath } from '../storage-path.js';

describe('resolveStoragePath', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the CLI data dir when provided', () => {
    const cliDataDir = makeTempDir('relay-storage-cli-');

    const resolved = resolveStoragePath({
      cliDataDir,
      envDataDir: DEFAULT_DOCKER_DATA_DIR,
    });

    expect(resolved.storagePath).toBe(cliDataDir);
    expect(resolved.usedLegacyDockerPath).toBe(false);
  });

  it('uses configured non-docker env data dir as-is', () => {
    const envDataDir = makeTempDir('relay-storage-env-');

    const resolved = resolveStoragePath({
      envDataDir,
    });

    expect(resolved.storagePath).toBe(envDataDir);
    expect(resolved.usedLegacyDockerPath).toBe(false);
  });

  it('falls back to the legacy docker mount when /data has no state yet', () => {
    const dockerDataDir = makeTempDir('relay-storage-data-');
    const legacyDockerDataDir = makeTempDir('relay-storage-legacy-');

    const resolved = resolveStoragePath({
      envDataDir: dockerDataDir,
      dockerDataDir,
      legacyDockerDataDir,
    });

    expect(resolved.storagePath).toBe(legacyDockerDataDir);
    expect(resolved.usedLegacyDockerPath).toBe(true);
  });

  it('keeps the docker data dir when relay state already exists there', () => {
    const dockerDataDir = makeTempDir('relay-storage-data-');
    const legacyDockerDataDir = makeTempDir('relay-storage-legacy-');
    writeFileSync(join(dockerDataDir, 'relay-identity.json'), '{"did":"did:agent:test"}', 'utf8');

    const resolved = resolveStoragePath({
      envDataDir: dockerDataDir,
      dockerDataDir,
      legacyDockerDataDir,
    });

    expect(resolved.storagePath).toBe(dockerDataDir);
    expect(resolved.usedLegacyDockerPath).toBe(false);
  });

  it('keeps the default docker dir when no legacy dir exists', () => {
    const dockerDataDir = makeTempDir('relay-storage-data-');
    const missingLegacyDir = join(makeTempDir('relay-storage-root-'), 'missing');

    const resolved = resolveStoragePath({
      envDataDir: dockerDataDir,
      dockerDataDir,
      legacyDockerDataDir: missingLegacyDir,
    });

    expect(resolved.storagePath).toBe(dockerDataDir);
    expect(resolved.usedLegacyDockerPath).toBe(false);
  });

  it('exports the legacy docker directory constant for compatibility handling', () => {
    expect(LEGACY_DOCKER_DATA_DIR).toBe('/app/relay-data');
  });
});
