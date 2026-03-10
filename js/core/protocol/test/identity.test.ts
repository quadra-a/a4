import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  sign,
  verify,
  exportKeyPair,
  importKeyPair,
} from '../src/identity/keys.js';
import { deriveDID, extractPublicKey, validateDID } from '../src/identity/did.js';
import { createDIDDocument, validateDIDDocument } from '../src/identity/document.js';
import { signMessage, verifyMessage } from '../src/identity/signer.js';

describe('Identity Layer', () => {
  describe('Key Generation', () => {
    it('should generate a valid Ed25519 key pair', async () => {
      const keyPair = await generateKeyPair();

      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.privateKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey.length).toBe(32);
      expect(keyPair.privateKey.length).toBe(32);
    });

    it('should generate different key pairs each time', async () => {
      const keyPair1 = await generateKeyPair();
      const keyPair2 = await generateKeyPair();

      expect(keyPair1.publicKey).not.toEqual(keyPair2.publicKey);
      expect(keyPair1.privateKey).not.toEqual(keyPair2.privateKey);
    });

    it('should export and import key pairs', async () => {
      const original = await generateKeyPair();
      const exported = exportKeyPair(original);
      const imported = importKeyPair(exported);

      expect(imported.publicKey).toEqual(original.publicKey);
      expect(imported.privateKey).toEqual(original.privateKey);
    });
  });

  describe('Signing and Verification', () => {
    it('should sign and verify a message', async () => {
      const keyPair = await generateKeyPair();
      const message = new TextEncoder().encode('Hello, quadra-a!');

      const signature = await sign(message, keyPair.privateKey);
      const isValid = await verify(signature, message, keyPair.publicKey);

      expect(isValid).toBe(true);
    });

    it('should reject invalid signatures', async () => {
      const keyPair = await generateKeyPair();
      const message = new TextEncoder().encode('Hello, quadra-a!');
      const signature = await sign(message, keyPair.privateKey);

      const tamperedMessage = new TextEncoder().encode('Hello, World!');
      const isValid = await verify(signature, tamperedMessage, keyPair.publicKey);

      expect(isValid).toBe(false);
    });

    it('should reject signatures from wrong key', async () => {
      const keyPair1 = await generateKeyPair();
      const keyPair2 = await generateKeyPair();
      const message = new TextEncoder().encode('Hello, quadra-a!');

      const signature = await sign(message, keyPair1.privateKey);
      const isValid = await verify(signature, message, keyPair2.publicKey);

      expect(isValid).toBe(false);
    });
  });

  describe('DID Operations', () => {
    it('should derive a valid did:clawiverse DID', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      expect(did).toMatch(/^did:agent:[1-9A-HJ-NP-Za-km-z]+$/);
    });

    it('should extract public key from DID', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);
      const extracted = extractPublicKey(did);

      expect(extracted).toEqual(keyPair.publicKey);
    });

    it('should validate correct DID format', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      expect(validateDID(did)).toBe(true);
    });

    it('should reject invalid DID formats', () => {
      expect(validateDID('did:web:example.com')).toBe(false);
      expect(validateDID('not-a-did')).toBe(false);
      expect(validateDID('did:agent:invalid!!!')).toBe(false);
    });
  });

  describe('DID Documents', () => {
    it('should create a valid DID Document', async () => {
      const keyPair = await generateKeyPair();
      const doc = createDIDDocument(keyPair.publicKey);

      expect(doc.id).toMatch(/^did:agent:/);
      expect(doc.verificationMethod).toHaveLength(1);
      expect(doc.authentication).toHaveLength(1);
      expect(doc.assertionMethod).toHaveLength(1);
    });

    it('should include service endpoints if provided', async () => {
      const keyPair = await generateKeyPair();
      const services = [
        {
          id: '#relay',
          type: 'QuadraARelay',
          serviceEndpoint: 'https://relay.example.com',
        },
      ];

      const doc = createDIDDocument(keyPair.publicKey, services);

      expect(doc.service).toEqual(services);
    });

    it('should validate correct DID Documents', async () => {
      const keyPair = await generateKeyPair();
      const doc = createDIDDocument(keyPair.publicKey);

      expect(validateDIDDocument(doc)).toBe(true);
    });

    it('should reject invalid DID Documents', () => {
      expect(validateDIDDocument({})).toBe(false);
      expect(validateDIDDocument(null)).toBe(false);
      expect(validateDIDDocument({ id: 'not-a-did' })).toBe(false);
    });
  });

  describe('Message Signing', () => {
    it('should sign and verify a message with DID', async () => {
      const keyPair = await generateKeyPair();
      const payload = new TextEncoder().encode('Test message');

      const signed = await signMessage(payload, keyPair.privateKey, keyPair.publicKey);
      const isValid = await verifyMessage(signed, keyPair.publicKey);

      expect(signed.signer).toMatch(/^did:agent:/);
      expect(isValid).toBe(true);
    });

    it('should reject messages with wrong public key', async () => {
      const keyPair1 = await generateKeyPair();
      const keyPair2 = await generateKeyPair();
      const payload = new TextEncoder().encode('Test message');

      const signed = await signMessage(payload, keyPair1.privateKey, keyPair1.publicKey);
      const isValid = await verifyMessage(signed, keyPair2.publicKey);

      expect(isValid).toBe(false);
    });
  });
});
