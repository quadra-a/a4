/**
 * CVP-0015: Token store - persists token metadata for management
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export interface TokenMetadata {
  jti: string;
  realm: string;
  sub: string;       // Agent DID or "*"
  exp: number;       // Unix timestamp
  iat: number;       // Unix timestamp
  permissions?: string[];
  maxAgents?: number;
  note?: string;
  createdBy: string; // Operator DID
  token: string;     // The actual token string
}

export class TokenStore {
  private tokens = new Map<string, TokenMetadata>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const list: TokenMetadata[] = JSON.parse(data);
      this.tokens = new Map(list.map((t) => [t.jti, t]));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        this.tokens = new Map();
      } else {
        throw err;
      }
    }
  }

  async save(metadata: TokenMetadata): Promise<void> {
    this.tokens.set(metadata.jti, metadata);
    await this.persist();
  }

  async list(realm?: string): Promise<TokenMetadata[]> {
    const all = Array.from(this.tokens.values());
    return realm ? all.filter((t) => t.realm === realm) : all;
  }

  async get(jti: string): Promise<TokenMetadata | null> {
    return this.tokens.get(jti) ?? null;
  }

  async delete(jti: string): Promise<void> {
    this.tokens.delete(jti);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const list = Array.from(this.tokens.values());
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(list, null, 2), 'utf-8');
  }
}
