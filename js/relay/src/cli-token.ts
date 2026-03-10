/**
 * CVP-0015: Token management CLI for quadra-a-relay
 * Commands: token create | list | revoke | rotate
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createInviteToken } from './token.js';
import { TokenStore } from './token-store.js';
import { RevocationList } from './revocation.js';
import { randomUUID } from 'crypto';

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${s} (use e.g. 24h, 7d, 30m)`);
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const secs = { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
  return n * secs;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[++i];
      } else {
        result[key] = true;
      }
    } else {
      result['_arg'] = argv[i];
    }
  }
  return result;
}

async function loadOperatorKey(keyFile?: string): Promise<Uint8Array> {
  const path = keyFile || process.env.QUADRA_A_OPERATOR_KEY || join(process.env.QUADRA_A_HOME || join(homedir(), '.quadra-a'), 'operator.key');
  try {
    const data = await readFile(path, 'utf-8');
    const json = JSON.parse(data.trim());
    const keyHex = json.privateKey || json.secretKey;
    if (!keyHex) throw new Error('No privateKey field in key file');
    return Buffer.from(keyHex, 'hex');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Operator key not found at ${path}. Set QUADRA_A_OPERATOR_KEY or use --key-file`, { cause: err });
    }
    throw err;
  }
}

function getStorePaths(dataDir?: string): { tokenStore: string; revocationList: string } {
  const dir = dataDir || process.env.DATA_DIR || './relay-data';
  return {
    tokenStore: `${dir}/tokens.json`,
    revocationList: `${dir}/revoked.json`,
  };
}

async function cmdCreate(args: Record<string, string | boolean>): Promise<void> {
  const realm = args['realm'] as string;
  const did = (args['did'] as string) || '*';
  const expires = (args['expires'] as string) || '24h';
  const note = args['note'] as string | undefined;
  const maxAgents = args['max-agents'] ? parseInt(args['max-agents'] as string, 10) : undefined;
  const keyFile = args['key-file'] as string | undefined;
  const dataDir = args['data-dir'] as string | undefined;

  if (!realm) {
    console.error('Error: --realm is required');
    process.exit(1);
  }

  const privateKey = await loadOperatorKey(keyFile);
  const now = Math.floor(Date.now() / 1000);
  const expSecs = parseDuration(expires);
  const jti = randomUUID();

  const payload = {
    iss: 'did:agent:operator',
    sub: did,
    realm,
    exp: now + expSecs,
    iat: now,
    jti,
    ...(note && { note }),
    ...(maxAgents !== undefined && { maxAgents }),
  };

  const token = await createInviteToken(payload, privateKey);

  const paths = getStorePaths(dataDir);
  const store = new TokenStore(paths.tokenStore);
  await store.load();
  await store.save({
    jti,
    realm,
    sub: did,
    exp: payload.exp,
    iat: now,
    note,
    maxAgents,
    createdBy: payload.iss,
    token,
  });

  console.log(`TOKEN_JTI=${jti}`);
  console.log(`TOKEN_REALM=${realm}`);
  console.log(`TOKEN_SUB=${did}`);
  console.log(`TOKEN_EXPIRES=${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`TOKEN=${token}`);
}

async function cmdList(args: Record<string, string | boolean>): Promise<void> {
  const realm = args['realm'] as string | undefined;
  const dataDir = args['data-dir'] as string | undefined;
  const paths = getStorePaths(dataDir);

  const store = new TokenStore(paths.tokenStore);
  await store.load();
  const tokens = await store.list(realm);

  if (tokens.length === 0) {
    console.log('NO_TOKENS');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  console.log(`TOKENS count=${tokens.length}`);
  console.log('');
  for (const t of tokens) {
    const expired = t.exp < now;
    const status = expired ? 'EXPIRED' : 'ACTIVE';
    console.log(`JTI=${t.jti}`);
    console.log(`  REALM=${t.realm}`);
    console.log(`  SUB=${t.sub}`);
    console.log(`  STATUS=${status}`);
    console.log(`  EXPIRES=${new Date(t.exp * 1000).toISOString()}`);
    if (t.note) console.log(`  NOTE=${t.note}`);
    if (t.maxAgents !== undefined) console.log(`  MAX_AGENTS=${t.maxAgents}`);
    console.log('');
  }
}

async function cmdRevoke(args: Record<string, string | boolean>): Promise<void> {
  const jti = args['_arg'] as string;
  const reason = args['reason'] as string | undefined;
  const dataDir = args['data-dir'] as string | undefined;

  if (!jti) {
    console.error('Error: JTI is required (quadra-a-relay token revoke <jti>)');
    process.exit(1);
  }

  const paths = getStorePaths(dataDir);

  const store = new TokenStore(paths.tokenStore);
  await store.load();
  const meta = await store.get(jti);

  if (!meta) {
    console.error(`Error: Token ${jti} not found`);
    process.exit(1);
  }

  const revList = new RevocationList(paths.revocationList);
  await revList.load();
  await revList.revoke(jti, reason, meta.exp);
  await revList.save();

  await store.delete(jti);

  console.log(`REVOKED jti=${jti}`);
  if (reason) console.log(`REASON=${reason}`);
}

async function cmdRotate(args: Record<string, string | boolean>): Promise<void> {
  const realm = args['realm'] as string;
  const expires = (args['expires'] as string) || '24h';
  const keyFile = args['key-file'] as string | undefined;
  const dataDir = args['data-dir'] as string | undefined;

  if (!realm) {
    console.error('Error: --realm is required');
    process.exit(1);
  }

  const paths = getStorePaths(dataDir);
  const store = new TokenStore(paths.tokenStore);
  await store.load();
  const existing = await store.list(realm);

  const revList = new RevocationList(paths.revocationList);
  await revList.load();

  // Revoke all existing tokens for this realm
  for (const t of existing) {
    await revList.revoke(t.jti, 'rotated', t.exp);
    await store.delete(t.jti);
  }
  await revList.save();

  // Create new wildcard token for the realm
  const privateKey = await loadOperatorKey(keyFile);
  const now = Math.floor(Date.now() / 1000);
  const expSecs = parseDuration(expires);
  const jti = randomUUID();

  const payload = {
    iss: 'did:agent:operator',
    sub: '*',
    realm,
    exp: now + expSecs,
    iat: now,
    jti,
    note: 'rotated',
  };

  const token = await createInviteToken(payload, privateKey);
  await store.save({
    jti,
    realm,
    sub: '*',
    exp: payload.exp,
    iat: now,
    note: 'rotated',
    createdBy: payload.iss,
    token,
  });

  console.log(`ROTATED realm=${realm} revoked=${existing.length}`);
  console.log(`NEW_TOKEN_JTI=${jti}`);
  console.log(`NEW_TOKEN_EXPIRES=${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`NEW_TOKEN=${token}`);
}

function printHelp(): void {
  console.log(`quadra-a-relay token <command> [options]

COMMANDS
  create   Create a new invitation token
  list     List tokens (optionally filter by realm)
  revoke   Revoke a token by JTI
  rotate   Revoke all realm tokens and issue a new one

CREATE OPTIONS
  --realm <realm>       Realm identifier (required)
  --did <did>           Agent DID to bind token to (default: * for any)
  --expires <duration>  Token lifetime: 30m, 24h, 7d (default: 24h)
  --note <text>         Human-readable note
  --max-agents <n>      Max agents that can use this token
  --key-file <path>     Operator key file (default: ~/.quadra-a/operator.key)
  --data-dir <path>     Data directory (default: ./relay-data)

LIST OPTIONS
  --realm <realm>       Filter by realm
  --data-dir <path>     Data directory

REVOKE OPTIONS
  <jti>                 Token JTI to revoke (required)
  --reason <text>       Revocation reason
  --data-dir <path>     Data directory

ROTATE OPTIONS
  --realm <realm>       Realm to rotate (required)
  --expires <duration>  New token lifetime (default: 24h)
  --key-file <path>     Operator key file
  --data-dir <path>     Data directory

ENVIRONMENT
  QUADRA_A_OPERATOR_KEY Path to operator key file
  DATA_DIR              Data directory path
`);
}

export async function runTokenCLI(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (subcommand) {
    case 'create':
      await cmdCreate(args);
      break;
    case 'list':
      await cmdList(args);
      break;
    case 'revoke':
      await cmdRevoke(args);
      break;
    case 'rotate':
      await cmdRotate(args);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown token subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}
