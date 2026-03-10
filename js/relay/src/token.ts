/**
 * CVP-0015: Invite token creation and verification
 *
 * Uses Ed25519 signatures over a JSON payload (PASETO-style, no external dep).
 * Format: base64url(header).base64url(payload).base64url(signature)
 */

import { sign as cryptoSign, verify as cryptoVerify, createPublicKey, createPrivateKey } from 'crypto';

export interface TokenPayload {
  iss: string;       // Issuer DID
  sub: string;       // Subject DID or "*"
  realm: string;     // Realm identifier
  exp: number;       // Expiry (Unix seconds)
  iat: number;       // Issued at (Unix seconds)
  jti: string;       // JWT ID (UUID)
  note?: string;
  maxAgents?: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'HW1-TOKEN' })).toString('base64url');

/**
 * Create a signed invite token.
 * privateKey: 64-byte Ed25519 private key (seed + public key, as returned by @noble/ed25519)
 */
export async function createInviteToken(payload: TokenPayload, privateKey: Uint8Array): Promise<string> {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${HEADER}.${payloadB64}`;

  // Build DER-encoded Ed25519 private key from raw 64-byte key
  // The first 32 bytes are the seed; Node's createPrivateKey expects PKCS#8 DER
  const seed = privateKey.slice(0, 32);
  const pkcs8Der = buildEd25519Pkcs8(seed);
  const privKey = createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

  const sig = cryptoSign(null, Buffer.from(signingInput), privKey);

  return `${signingInput}.${sig.toString('base64url')}`;
}

/**
 * Verify and decode an invite token.
 * publicKey: 32-byte Ed25519 public key
 * Returns decoded payload or throws on invalid/expired token.
 */
export async function verifyInviteToken(token: string, publicKey: Uint8Array): Promise<TokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TokenError('INVALID_FORMAT', 'Token must have 3 parts');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify header
  let header: { alg: string; typ: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('INVALID_FORMAT', 'Invalid header');
  }
  if (header.alg !== 'EdDSA' || header.typ !== 'HW1-TOKEN') {
    throw new TokenError('INVALID_FORMAT', 'Unsupported token type');
  }

  // Verify signature
  const spkiDer = buildEd25519Spki(publicKey);
  const pubKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const sig = Buffer.from(sigB64, 'base64url');
  const valid = cryptoVerify(null, Buffer.from(signingInput), pubKey, sig);
  if (!valid) {
    throw new TokenError('INVALID_SIGNATURE', 'Token signature is invalid');
  }

  // Decode payload
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('INVALID_FORMAT', 'Invalid payload');
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new TokenError('EXPIRED', `Token expired at ${new Date(payload.exp * 1000).toISOString()}`);
  }

  return payload;
}

export class TokenError extends Error {
  constructor(
    public readonly code: 'INVALID_FORMAT' | 'INVALID_SIGNATURE' | 'EXPIRED' | 'REVOKED' | 'DID_MISMATCH',
    message: string
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

// ---- DER helpers (no external deps) ----

/**
 * Build PKCS#8 DER for Ed25519 from 32-byte seed.
 * Structure: SEQUENCE { version INTEGER 0, AlgorithmIdentifier { OID 1.3.101.112 }, OCTET STRING { OCTET STRING seed } }
 */
function buildEd25519Pkcs8(seed: Uint8Array): Buffer {
  // OID for Ed25519: 1.3.101.112 → 06 03 2b 65 70
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
  const algoId = derSequence(oid);
  const innerOctet = derOctetString(seed);
  const outerOctet = derOctetString(innerOctet);
  const version = Buffer.from([0x02, 0x01, 0x00]); // INTEGER 0
  return derSequence(Buffer.concat([version, algoId, outerOctet]));
}

/**
 * Build SPKI DER for Ed25519 from 32-byte public key.
 * Structure: SEQUENCE { AlgorithmIdentifier { OID 1.3.101.112 }, BIT STRING { 0x00 pubkey } }
 */
function buildEd25519Spki(pubKey: Uint8Array): Buffer {
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
  const algoId = derSequence(oid);
  const bitString = derBitString(pubKey);
  return derSequence(Buffer.concat([algoId, bitString]));
}

function derSequence(content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLength(content.length), content]);
}

function derOctetString(content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0x04]), derLength(content.length), content]);
}

function derBitString(content: Uint8Array): Buffer {
  // prepend 0x00 (no unused bits)
  const payload = Buffer.concat([Buffer.from([0x00]), content]);
  return Buffer.concat([Buffer.from([0x03]), derLength(payload.length), payload]);
}

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}
