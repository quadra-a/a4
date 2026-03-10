import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryLevel } from 'memory-level';
import { EndorsementManager } from '../src/trust/endorsement.js';
import type { Endorsement, SignFunction, VerifyFunction } from '../src/trust/endorsement.js';
import { generateKeyPair, sign, verify } from '../src/identity/keys.js';

describe('Endorsement System', () => {
  let db: MemoryLevel<string, Endorsement>;
  let manager: EndorsementManager;
  let keyPair1: { publicKey: Uint8Array; privateKey: Uint8Array };
  let keyPair2: { publicKey: Uint8Array; privateKey: Uint8Array };

  beforeEach(async () => {
    // Create unique in-memory database for each test
    db = new MemoryLevel<string, Endorsement>({ valueEncoding: 'json' });
    await db.open();

    // Generate test key pairs
    keyPair1 = await generateKeyPair();
    keyPair2 = await generateKeyPair();

    // Create manager with mock getPublicKey function
    const getPublicKey = async (did: string): Promise<Uint8Array> => {
      if (did === 'did:agent:agent1') return keyPair1.publicKey;
      if (did === 'did:agent:agent2') return keyPair2.publicKey;
      if (did === 'did:agent:agent3') return keyPair2.publicKey; // Use keyPair2 for agent3
      throw new Error(`Unknown DID: ${did}`);
    };

    manager = new EndorsementManager(db as Level<string, unknown>, getPublicKey);
  });

  describe('Creating Endorsements', () => {
    it('should create a valid endorsement', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        'Excellent collaboration',
        signFn
      );

      expect(endorsement.from).toBe('did:agent:agent1');
      expect(endorsement.to).toBe('did:agent:agent2');
      expect(endorsement.score).toBe(0.9);
      expect(endorsement.reason).toBe('Excellent collaboration');
      expect(endorsement.signature).toBeDefined();
      expect(endorsement.timestamp).toBeGreaterThan(0);
    });

    it('should reject invalid scores', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      await expect(
        manager.endorse(
          'did:agent:agent1',
          'did:agent:agent2',
          1.5, // Invalid: > 1
          'Test',
          signFn
        )
      ).rejects.toThrow('Score must be between 0 and 1');

      await expect(
        manager.endorse(
          'did:agent:agent1',
          'did:agent:agent2',
          -0.5, // Invalid: < 0
          'Test',
          signFn
        )
      ).rejects.toThrow('Score must be between 0 and 1');
    });

    it('should sign endorsements correctly', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.8,
        'Good work',
        signFn
      );

      expect(endorsement.signature).toMatch(/^[0-9a-f]+$/);
      expect(endorsement.signature.length).toBeGreaterThan(0);
    });
  });

  describe('Verifying Endorsements', () => {
    it('should verify valid endorsements', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const verifyFn: VerifyFunction = async (sig: Uint8Array, data: Uint8Array, pubKey: Uint8Array) => {
        return verify(sig, data, pubKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        'Test',
        signFn
      );

      const isValid = await manager.verify(endorsement, verifyFn);

      expect(isValid).toBe(true);
    });

    it('should reject endorsements with invalid signatures', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const verifyFn: VerifyFunction = async (sig: Uint8Array, data: Uint8Array, pubKey: Uint8Array) => {
        return verify(sig, data, pubKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        'Test',
        signFn
      );

      // Tamper with the endorsement
      endorsement.score = 0.5;

      const isValid = await manager.verify(endorsement, verifyFn);

      expect(isValid).toBe(false);
    });

    it('should reject endorsements with wrong public key', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const verifyFn: VerifyFunction = async (sig: Uint8Array, data: Uint8Array, _pubKey: Uint8Array) => {
        // Use wrong public key
        return verify(sig, data, keyPair2.publicKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        'Test',
        signFn
      );

      const isValid = await manager.verify(endorsement, verifyFn);

      expect(isValid).toBe(false);
    });
  });

  describe('Publishing and Querying Endorsements', () => {
    it('should publish endorsements to database', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        'Test',
        signFn
      );

      await manager.publish(endorsement);

      const endorsements = await manager.getEndorsements('did:agent:agent2');

      expect(endorsements).toHaveLength(1);
      expect(endorsements[0].from).toBe('did:agent:agent1');
      expect(endorsements[0].to).toBe('did:agent:agent2');
    });

    it('should retrieve all endorsements for an agent', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      // Create multiple endorsements from different agents
      const e1 = await manager.endorse('did:agent:agent1', 'did:agent:agent2', 0.9, 'Test 1', signFn);

      // Use different "from" agent for second endorsement
      const signFn2: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair2.privateKey);
      };
      const e2 = await manager.endorse('did:agent:agent3', 'did:agent:agent2', 0.8, 'Test 2', signFn2);

      await manager.publish(e1);
      await manager.publish(e2);

      const endorsements = await manager.getEndorsements('did:agent:agent2');

      expect(endorsements).toHaveLength(2);
    });

    it('should retrieve endorsements given by an agent', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const e1 = await manager.endorse('did:agent:agent1', 'did:agent:agent2', 0.9, 'Test', signFn);
      await manager.publish(e1);

      const endorsements = await manager.getEndorsementsBy('did:agent:agent1');

      expect(endorsements).toHaveLength(1);
      expect(endorsements[0].from).toBe('did:agent:agent1');
    });

    it('should return empty array for agents with no endorsements', async () => {
      const endorsements = await manager.getEndorsements('did:agent:unknown');

      expect(endorsements).toEqual([]);
    });
  });

  describe('Average Score Calculation', () => {
    it('should calculate average endorsement score', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const signFn2: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair2.privateKey);
      };

      // Create endorsements from different agents
      const e1 = await manager.endorse('did:agent:agent1', 'did:agent:agent2', 0.8, 'Test 1', signFn);
      const e2 = await manager.endorse('did:agent:agent3', 'did:agent:agent2', 0.6, 'Test 2', signFn2);

      await manager.publish(e1);
      await manager.publish(e2);

      const avgScore = await manager.getAverageScore('did:agent:agent2');

      expect(avgScore).toBe(0.7);
    });

    it('should return 0 for agents with no endorsements', async () => {
      const avgScore = await manager.getAverageScore('did:agent:unknown');

      expect(avgScore).toBe(0);
    });
  });

  describe('Deleting Endorsements', () => {
    it('should delete endorsements', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        'Test',
        signFn
      );

      await manager.publish(endorsement);

      let endorsements = await manager.getEndorsements('did:agent:agent2');
      expect(endorsements).toHaveLength(1);

      await manager.deleteEndorsement('did:agent:agent1', 'did:agent:agent2');

      endorsements = await manager.getEndorsements('did:agent:agent2');
      expect(endorsements).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple endorsements from same agent', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const e1 = await manager.endorse('did:agent:agent1', 'did:agent:agent2', 0.9, 'First', signFn);
      const e2 = await manager.endorse('did:agent:agent1', 'did:agent:agent2', 0.5, 'Second', signFn);

      await manager.publish(e1);
      await manager.publish(e2);

      // Second endorsement should overwrite first (same key)
      const endorsements = await manager.getEndorsements('did:agent:agent2');

      expect(endorsements).toHaveLength(1);
      expect(endorsements[0].score).toBe(0.5);
      expect(endorsements[0].reason).toBe('Second');
    });

    it('should handle empty reason strings', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        '',
        signFn
      );

      expect(endorsement.reason).toBe('');
    });

    it('should handle very long reason strings', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const longReason = 'A'.repeat(1000);

      const endorsement = await manager.endorse(
        'did:agent:agent1',
        'did:agent:agent2',
        0.9,
        longReason,
        signFn
      );

      expect(endorsement.reason).toBe(longReason);
    });

    it('should handle score boundaries', async () => {
      const signFn: SignFunction = async (data: Uint8Array) => {
        return sign(data, keyPair1.privateKey);
      };

      const e1 = await manager.endorse('did:agent:agent1', 'did:agent:agent2', 0, 'Min', signFn);
      const e2 = await manager.endorse('did:agent:agent1', 'did:agent:agent2', 1, 'Max', signFn);

      expect(e1.score).toBe(0);
      expect(e2.score).toBe(1);
    });
  });
});
