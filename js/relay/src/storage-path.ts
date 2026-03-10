import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_STORAGE_PATH = './relay-data';
export const DEFAULT_DOCKER_DATA_DIR = '/data';
export const LEGACY_DOCKER_DATA_DIR = '/app/relay-data';

const RELAY_STATE_FILES = [
  'relay-identity.json',
  'endorsements.json',
  'tokens.json',
  'revoked.json',
];

export interface StoragePathResolution {
  storagePath: string;
  usedLegacyDockerPath: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasRelayState(path: string): boolean {
  return RELAY_STATE_FILES.some((file) => existsSync(join(path, file)));
}

export function resolveStoragePath(options: {
  cliDataDir?: string;
  envDataDir?: string;
  defaultStoragePath?: string;
  dockerDataDir?: string;
  legacyDockerDataDir?: string;
} = {}): StoragePathResolution {
  const defaultStoragePath = options.defaultStoragePath ?? DEFAULT_STORAGE_PATH;
  const dockerDataDir = options.dockerDataDir ?? DEFAULT_DOCKER_DATA_DIR;
  const legacyDockerDataDir = options.legacyDockerDataDir ?? LEGACY_DOCKER_DATA_DIR;

  if (options.cliDataDir) {
    return {
      storagePath: options.cliDataDir,
      usedLegacyDockerPath: false,
    };
  }

  const configuredPath = options.envDataDir || defaultStoragePath;
  if (configuredPath !== dockerDataDir) {
    return {
      storagePath: configuredPath,
      usedLegacyDockerPath: false,
    };
  }

  if (!isDirectory(legacyDockerDataDir) || hasRelayState(dockerDataDir)) {
    return {
      storagePath: configuredPath,
      usedLegacyDockerPath: false,
    };
  }

  return {
    storagePath: legacyDockerDataDir,
    usedLegacyDockerPath: true,
  };
}
