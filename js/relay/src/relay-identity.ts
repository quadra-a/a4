/**
 * Relay Identity Management
 *
 * Transforms relay from infrastructure service to proper agent with:
 * - Ed25519 keypair and did:agent DID
 * - Signed Agent Card with relay capabilities
 * - Persistent identity storage
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { AgentCard, AgentCardCapability } from './types.js';

export interface RelayKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface RelayIdentityData {
  did: string;
  publicKey: string;  // hex encoded
  privateKey: string; // hex encoded
  agentCard: AgentCard;
  createdAt: number;
}

export class RelayIdentity {
  private identityData: RelayIdentityData | null = null;
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = join(storagePath, 'relay-identity.json');
  }

  /**
   * Initialize relay identity - load existing or generate new
   */
  async initialize(relayId: string, endpoints: string[]): Promise<RelayIdentityData> {
    try {
      // Try to load existing identity
      this.identityData = await this.loadIdentity();
      const migration = await this.migrateLegacyIdentity();
      const updated = await this.refreshIdentity(relayId, endpoints);
      if (migration.migrated || updated) {
        await this.saveIdentity();
      }
      if (migration.migrated) {
        console.log(`✓ Migrated relay identity DID: ${migration.previousDid} -> ${this.identityData.did}`);
      }
      if (updated) {
        console.log('✓ Updated relay identity card metadata');
      }
      console.log(`✓ Loaded existing relay identity: ${this.identityData.did}`);
      return this.identityData;
    } catch {
      // Generate new identity
      console.log('Generating new relay identity...');
      this.identityData = await this.generateIdentity(relayId, endpoints);
      await this.saveIdentity();
      console.log(`✓ Generated new relay identity: ${this.identityData.did}`);
      return this.identityData;
    }
  }

  private normalizeEndpoints(endpoints: string[]): string[] {
    return [...new Set(endpoints.map((endpoint) => endpoint.trim()).filter(Boolean))];
  }

  private arraysEqual(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  private async migrateLegacyIdentity(): Promise<{ migrated: boolean; previousDid?: string }> {
    if (!this.identityData) {
      return { migrated: false };
    }

    const { deriveDID } = await import('@quadra-a/protocol');
    const publicKey = new Uint8Array(Buffer.from(this.identityData.publicKey, 'hex'));
    const derivedDid = deriveDID(publicKey);
    const previousDid = this.identityData.did;
    const cardDid = this.identityData.agentCard?.did;

    if (previousDid === derivedDid && cardDid === derivedDid) {
      return { migrated: false };
    }

    const { signature: _legacySignature, ...agentCardWithoutSignature } = this.identityData.agentCard;

    this.identityData.did = derivedDid;
    this.identityData.agentCard = await this.signAgentCard({
      ...agentCardWithoutSignature,
      did: derivedDid,
      timestamp: Date.now(),
    });

    return {
      migrated: true,
      previousDid,
    };
  }

  private async refreshIdentity(relayId: string, endpoints: string[]): Promise<boolean> {
    if (!this.identityData) {
      return false;
    }

    const normalizedEndpoints = this.normalizeEndpoints(endpoints);
    const currentEndpoints = this.identityData.agentCard.endpoints ?? [];
    const nextName = `quadra-a Relay (${relayId})`;
    const currentMetadata = this.identityData.agentCard.metadata ?? {};
    const nextMetadata = { ...currentMetadata, relayId };

    const shouldUpdate =
      !this.arraysEqual(currentEndpoints, normalizedEndpoints)
      || this.identityData.agentCard.name !== nextName
      || currentMetadata.relayId !== relayId;

    if (!shouldUpdate) {
      return false;
    }

    const { signature: _currentSignature, ...currentAgentCard } = this.identityData.agentCard;

    const agentCard: Omit<AgentCard, 'signature'> = {
      ...currentAgentCard,
      name: nextName,
      endpoints: normalizedEndpoints,
      metadata: nextMetadata,
      timestamp: Date.now(),
    };

    this.identityData.agentCard = await this.signAgentCard(agentCard);
    return true;
  }

  private async signAgentCard(agentCard: Omit<AgentCard, 'signature'>, privateKey?: Uint8Array): Promise<AgentCard> {
    const { signAgentCard, sign } = await import('@quadra-a/protocol');
    const signingKey = privateKey ?? this.getKeyPair().privateKey;

    return await signAgentCard(agentCard as any, async (data: Uint8Array) => {
      return await sign(data, signingKey);
    });
  }

  /**
   * Get current identity data
   */
  getIdentity(): RelayIdentityData {
    if (!this.identityData) {
      throw new Error('Relay identity not initialized');
    }
    return this.identityData;
  }

  /**
   * Get keypair as Uint8Array
   */
  getKeyPair(): RelayKeyPair {
    if (!this.identityData) {
      throw new Error('Relay identity not initialized');
    }
    return {
      publicKey: new Uint8Array(Buffer.from(this.identityData.publicKey, 'hex')),
      privateKey: new Uint8Array(Buffer.from(this.identityData.privateKey, 'hex')),
    };
  }

  /**
   * Sign data with relay's private key
   */
  async sign(data: Uint8Array): Promise<Uint8Array> {
    const { sign } = await import('@quadra-a/protocol');
    const keyPair = this.getKeyPair();
    return await sign(data, keyPair.privateKey);
  }

  /**
   * Create cryptographically signed endorsement
   */
  async createEndorsement(targetDid: string, score: number, reason: string): Promise<{ version: number; from: string; to: string; score: number; reason: string; timestamp: number; signature: string }> {
    const identity = this.getIdentity();
    const now = Date.now();

    const endorsement = {
      version: 2 as const,
      from: identity.did,
      to: targetDid,
      score,
      reason,
      timestamp: now,
      expires: now + 30 * 24 * 60 * 60 * 1000, // 30 days
    };

    // Sign the endorsement
    const endorsementData = new TextEncoder().encode(JSON.stringify(endorsement));
    const signature = await this.sign(endorsementData);

    return {
      ...endorsement,
      signature: Buffer.from(signature).toString('hex'),
    };
  }

  private async generateIdentity(relayId: string, endpoints: string[]): Promise<RelayIdentityData> {
    const { generateKeyPair, deriveDID, exportKeyPair } = await import('@quadra-a/protocol');

    // Generate Ed25519 keypair
    const keyPair = await generateKeyPair();
    const exported = exportKeyPair(keyPair);

    // Derive DID from public key
    const did = deriveDID(keyPair.publicKey);

    // Create relay capabilities
    const capabilities: AgentCardCapability[] = [
      {
        id: 'relay/message-routing',
        name: 'Message Routing',
        description: 'Route messages between agents in the network',
        metadata: { priority: 'high', latency: 'low' }
      },
      {
        id: 'relay/discovery',
        name: 'Agent Discovery',
        description: 'Index and search agent capabilities',
        metadata: { searchTypes: ['capability', 'freetext'], indexSize: 'unlimited' }
      },
      {
        id: 'relay/trust-endorsement',
        name: 'Trust Endorsement Storage',
        description: 'Store and query cryptographic trust endorsements',
        metadata: { endorsementVersion: 2, rateLimit: '20/day' }
      },
      {
        id: 'relay/message-queue',
        name: 'Message Queue',
        description: 'Queue messages for offline agents',
        metadata: { maxQueueSize: 1000, retentionDays: 7 }
      },
      {
        id: 'relay/health-check',
        name: 'Health Check',
        description: 'Provide relay status and metrics',
        metadata: { metrics: ['uptime', 'connections', 'throughput'] }
      },
      {
        id: 'relay/federation',
        name: 'Relay Federation',
        description: 'Coordinate with other relay agents',
        metadata: { protocol: 'CVP-0011', crossRelayRouting: true }
      }
    ];

    // Create Agent Card
    const agentCard: Omit<AgentCard, 'signature'> = {
      did,
      name: `quadra-a Relay (${relayId})`,
      description: 'WebSocket relay agent for quadra-a network - routes messages, indexes agents, stores endorsements',
      version: '1.0.0',
      capabilities,
      endpoints,
      metadata: {
        relayId,
        type: 'relay-agent',
        protocolVersion: 1,
        federationEnabled: true,
        operatorContact: 'relay-operator@highway1.network'
      },
      timestamp: Date.now(),
    };

    // Sign the Agent Card
    const signedCard = await this.signAgentCard(agentCard, keyPair.privateKey);

    return {
      did,
      publicKey: exported.publicKey,
      privateKey: exported.privateKey,
      agentCard: signedCard,
      createdAt: Date.now(),
    };
  }

  private async loadIdentity(): Promise<RelayIdentityData> {
    const data = await fs.readFile(this.storagePath, 'utf8');
    return JSON.parse(data);
  }

  private async saveIdentity(): Promise<void> {
    if (!this.identityData) {
      throw new Error('No identity data to save');
    }

    // Ensure directory exists
    await fs.mkdir(join(this.storagePath, '..'), { recursive: true });

    // Save identity data
    await fs.writeFile(
      this.storagePath,
      JSON.stringify(this.identityData, null, 2),
      'utf8'
    );
  }
}
