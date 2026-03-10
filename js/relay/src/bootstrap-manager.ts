/**
 * Bootstrap Manager - Handles network bootstrapping and genesis relay mode
 *
 * Implements:
 * - Genesis relay mode for network initialization
 * - Seed relay fallback for faster network formation
 * - Automatic detection of existing networks
 * - Federation join protocol for subsequent relays
 */

import type { RelayIdentity } from './relay-identity.js';
import type { AgentRegistry } from './registry.js';
import type { FederationManager } from './federation-manager.js';

export interface BootstrapConfig {
  /** Seed relays to connect to for network discovery */
  seedRelays: string[];
  /** Whether this relay should start in genesis mode */
  genesisMode: boolean;
  /** Timeout for seed relay connections */
  seedTimeout: number;
  /** Network ID to prevent accidental cross-network connections */
  networkId: string;
}

const DEFAULT_BOOTSTRAP_CONFIG: BootstrapConfig = {
  seedRelays: [],
  genesisMode: false,
  seedTimeout: 10000, // 10 seconds
  networkId: 'highway1-mainnet',
};

export class BootstrapManager {
  private relayIdentity: RelayIdentity;
  private registry: AgentRegistry;
  private federationManager: FederationManager | null;
  private config: BootstrapConfig;
  private isGenesis = false;

  constructor(
    relayIdentity: RelayIdentity,
    registry: AgentRegistry,
    federationManager: FederationManager | null,
    config: Partial<BootstrapConfig> = {}
  ) {
    this.relayIdentity = relayIdentity;
    this.registry = registry;
    this.federationManager = federationManager;
    this.config = { ...DEFAULT_BOOTSTRAP_CONFIG, ...config };
  }

  /**
   * Initialize network bootstrap process
   */
  async initialize(): Promise<{ mode: 'genesis' | 'join'; networkFound: boolean }> {
    console.log('Initializing network bootstrap...');

    // Check if we should start in genesis mode
    if (this.config.genesisMode) {
      return await this.startGenesisMode();
    }

    // Try to discover existing network
    const networkFound = await this.discoverExistingNetwork();

    if (networkFound) {
      console.log('✓ Existing network discovered, joining federation');
      return { mode: 'join', networkFound: true };
    } else {
      console.log('No existing network found, starting in genesis mode');
      return await this.startGenesisMode();
    }
  }

  /**
   * Start in genesis mode - first relay in the network
   */
  private async startGenesisMode(): Promise<{ mode: 'genesis'; networkFound: boolean }> {
    console.log('🌱 Starting in genesis mode - bootstrapping new network');
    this.isGenesis = true;

    const identity = this.relayIdentity.getIdentity();

    // Create genesis bootstrap endorsement for ourselves
    try {
      await this.relayIdentity.createEndorsement(
        identity.did,
        1.0, // Full trust for genesis relay
        `Genesis relay bootstrap - network founder (${this.config.networkId})`
      );

      // Store the genesis endorsement
      // Note: We need to import the endorsement index to store this
      console.log('✓ Created genesis bootstrap endorsement');
    } catch (err) {
      console.error('Failed to create genesis endorsement:', err);
    }

    // Publish network announcement
    await this.publishNetworkAnnouncement();

    return { mode: 'genesis', networkFound: false };
  }

  /**
   * Discover existing network through seed relays or local discovery
   */
  private async discoverExistingNetwork(): Promise<boolean> {
    // First, try seed relays if configured
    if (this.federationManager && this.config.seedRelays.length > 0) {
      console.log(`Trying ${this.config.seedRelays.length} seed relays...`);

      for (const seedRelay of this.config.seedRelays) {
        try {
          const connected = await this.federationManager.connectToSeedRelay(seedRelay);
          if (connected) {
            console.log(`✓ Connected to seed relay: ${seedRelay}`);
            return true;
          }
        } catch (err) {
          console.warn(`Failed to connect to seed relay ${seedRelay}:`, err);
        }
      }
    }

    // Try local discovery through registry
    const existingRelays = await this.discoverLocalRelays();
    if (existingRelays.length > 0) {
      console.log(`✓ Found ${existingRelays.length} existing relays locally`);
      return true;
    }

    return false;
  }
  /**
   * Discover existing relays through local registry
   */
  private async discoverLocalRelays(): Promise<string[]> {
    try {
      // Search for other relay agents
      const { agents } = this.registry.searchByCapability('relay/message-routing', undefined, 100);
      const myDid = this.relayIdentity.getIdentity().did;

      return agents
        .filter(agent => agent.did !== myDid)
        .map(agent => agent.did);
    } catch (err) {
      console.error('Error discovering local relays:', err);
      return [];
    }
  }

  /**
   * Publish network announcement for genesis relay
   */
  private async publishNetworkAnnouncement(): Promise<void> {
    const identity = this.relayIdentity.getIdentity();

    console.log(`📡 Publishing network announcement for ${this.config.networkId}`);
    console.log(`   Genesis Relay: ${identity.did}`);
    console.log(`   Network ID: ${this.config.networkId}`);
    console.log(`   Endpoints: ${identity.agentCard.endpoints.join(', ')}`);

    // The announcement is implicit through the relay being discoverable
    // Other relays will find this one through normal discovery mechanisms
  }

  /**
   * Handle federation join protocol for new relays
   */
  async handleFederationJoin(newRelayDid: string): Promise<void> {
    if (!this.isGenesis) return;

    console.log(`🤝 New relay joining federation: ${newRelayDid}`);

    // Create welcome endorsement for new relay
    try {
      await this.relayIdentity.createEndorsement(
        newRelayDid,
        0.5, // Medium trust for federated relays
        `Federation welcome endorsement from genesis relay`
      );

      console.log(`✓ Created welcome endorsement for ${newRelayDid}`);
    } catch (err) {
      console.error('Failed to create welcome endorsement:', err);
    }
  }

  /**
   * Validate network compatibility
   */
  validateNetworkCompatibility(remoteNetworkId: string): boolean {
    if (remoteNetworkId !== this.config.networkId) {
      console.warn(`Network ID mismatch: local=${this.config.networkId}, remote=${remoteNetworkId}`);
      return false;
    }
    return true;
  }

  /**
   * Get bootstrap status
   */
  getBootstrapStatus(): {
    mode: 'genesis' | 'federated';
    networkId: string;
    isGenesis: boolean;
    seedRelays: string[];
  } {
    return {
      mode: this.isGenesis ? 'genesis' : 'federated',
      networkId: this.config.networkId,
      isGenesis: this.isGenesis,
      seedRelays: this.config.seedRelays,
    };
  }

  /**
   * Create network-specific bootstrap endorsement
   */
  async createNetworkBootstrapEndorsement(targetDid: string, reason: string): Promise<{ version: number; from: string; to: string; score: number; reason: string; timestamp: number; signature: string }> {
    const networkReason = `${reason} (network: ${this.config.networkId})`;
    return await this.relayIdentity.createEndorsement(targetDid, 0.3, networkReason);
  }
}
