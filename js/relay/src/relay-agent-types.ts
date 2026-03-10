import type { FederationExportPolicy, FederationRealmPolicyConfig } from './federation-manager.js';

export interface RelayAgentConfig {
  port?: number;
  relayId?: string;
  publicEndpoints?: string[];
  federationPeers?: string[];
  storagePath?: string;
  powDifficulty?: number;
  operatorPublicKey?: string;
  privateRelay?: boolean;
  federationEnabled?: boolean;
  federationPolicy?: FederationExportPolicy | 'auto';
  federationExportVisibility?: string;
  federationRealmPolicies?: Record<string, FederationRealmPolicyConfig>;
  genesisMode?: boolean;
  seedRelays?: string[];
  networkId?: string;
}

export interface ConnectionContext {
  remoteIp: string;
  userAgent: string;
}

export const DEFAULT_RELAY_AGENT_CONFIG: Required<RelayAgentConfig> = {
  port: 8080,
  relayId: `relay-${Math.random().toString(36).slice(2, 10)}`,
  publicEndpoints: [],
  federationPeers: [],
  storagePath: './relay-data',
  powDifficulty: 0,
  operatorPublicKey: '',
  privateRelay: false,
  federationEnabled: true,
  federationPolicy: 'auto',
  federationExportVisibility: 'public',
  federationRealmPolicies: {},
  genesisMode: false,
  seedRelays: [],
  networkId: 'highway1-mainnet',
};
