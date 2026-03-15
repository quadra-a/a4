import {
  generateThreadId,
  resolveDid,
  type MessageEnvelopeType,
} from '@quadra-a/protocol';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getAliases, setE2EConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { resolveE2EConfig } from './e2e-config.js';
import { prepareEncryptedSends } from './e2e-send.js';
import {
  requireIdentity,
  searchAgents,
  withRelaySession,
  type DiscoveryAgent,
} from './agent-runtime.js';

export interface MessagePayloadInput {
  message?: string;
  payload?: string;
  file?: string;
}

export interface MessageThreadInput {
  thread?: string;
  newThread?: boolean;
}

export interface ResolvedTarget {
  did: string;
  matchedBy: 'did' | 'alias' | 'search';
  label: string;
  agent?: DiscoveryAgent;
}

export interface DispatchMessageInput {
  to: string;
  protocol?: string;
  payload: Record<string, unknown>;
  type?: MessageEnvelopeType;
  replyTo?: string;
  threadId?: string;
  relay?: string;
}

export interface DispatchMessageResult {
  id: string;
  usedDaemon: boolean;
}

export async function buildMessagePayload(input: MessagePayloadInput): Promise<Record<string, unknown>> {
  if (!input.message && !input.payload && !input.file) {
    throw new Error('A message, payload, or file attachment is required.');
  }

  let payload: Record<string, unknown> = {};

  if (input.payload) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.payload);
    } catch {
      throw new Error('Invalid JSON payload');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Payload JSON must be an object');
    }

    payload = parsed as Record<string, unknown>;
  }

  if (input.message && payload.text === undefined) {
    payload.text = input.message;
  }

  if (input.file) {
    const fileBytes = await readFile(input.file);
    const filename = basename(input.file);
    payload.attachment = {
      filename,
      mimeType: guessMimeType(filename),
      size: fileBytes.length,
      data: fileBytes.toString('base64'),
    };
  }

  return payload;
}

export function resolveThreadId(input: MessageThreadInput): string | undefined {
  if (input.newThread) {
    return generateThreadId();
  }

  return input.thread;
}

export async function resolveTargetDid(target: string, relay?: string): Promise<ResolvedTarget> {
  const aliases = getAliases();
  const resolvedDid = resolveDid(target, aliases);

  if (resolvedDid) {
    return {
      did: resolvedDid,
      matchedBy: target.startsWith('did:') ? 'did' : 'alias',
      label: target,
    };
  }

  const results = await searchAgents({ text: target, limit: 1 }, relay);
  if (results.length === 0) {
    throw new Error(`Could not resolve "${target}" to a DID.`);
  }

  return {
    did: results[0].did,
    matchedBy: 'search',
    label: results[0].name ?? target,
    agent: results[0],
  };
}

export async function routeCapability(
  capability: string,
  options: { relay?: string; minTrust?: number; limit?: number } = {},
): Promise<ResolvedTarget> {
  const results = await searchAgents(
    {
      capability,
      filters: options.minTrust != null ? { minTrustScore: options.minTrust } : undefined,
      limit: options.limit ?? 10,
    },
    options.relay,
  );

  if (results.length === 0) {
    throw new Error(`No agents found for capability: ${capability}`);
  }

  const sorted = [...results].sort((left, right) => {
    const leftTrust = left.trust?.interactionScore ?? 0;
    const rightTrust = right.trust?.interactionScore ?? 0;
    return rightTrust - leftTrust;
  });

  const best = sorted[0];

  return {
    did: best.did,
    matchedBy: 'search',
    label: best.name ?? capability,
    agent: best,
  };
}

export async function dispatchMessage(input: DispatchMessageInput): Promise<DispatchMessageResult> {
  const protocol = input.protocol ?? '/agent/msg/1.0.0';
  const type = input.type ?? 'message';
  const client = new DaemonClient();

  if (await client.isDaemonRunning()) {
    const result = await client.send<{ id: string }>('send', {
      to: input.to,
      protocol,
      payload: input.payload,
      type,
      replyTo: input.replyTo,
      threadId: input.threadId,
    });

    return {
      id: result.id,
      usedDaemon: true,
    };
  }

  const identity = requireIdentity();

  return withRelaySession(
    {
      relay: input.relay,
      identity,
    },
    async ({ keyPair, relayClient }) => {
      const encrypted = await prepareEncryptedSends({
        identity,
        keyPair,
        relayClient,
        e2eConfig: await resolveE2EConfig(identity),
        to: input.to,
        protocol,
        payload: input.payload,
        type,
        replyTo: input.replyTo,
        threadId: input.threadId,
      });

      setE2EConfig(encrypted.e2eConfig);
      for (const target of encrypted.targets) {
        await relayClient.sendEnvelope(input.to, target.outerEnvelopeBytes);
      }

      return {
        id: encrypted.applicationEnvelope.id,
        usedDaemon: false,
      };
    },
  );
}

export function formatMessagePayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }

  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }

    if (record.result !== undefined) {
      return typeof record.result === 'string'
        ? record.result
        : JSON.stringify(record.result, null, 2);
    }
  }

  return JSON.stringify(payload ?? null, null, 2);
}

export function redactPayloadForDisplay(payload: Record<string, unknown>) {
  if (!payload.attachment) {
    return payload;
  }

  return {
    ...payload,
    attachment: '[binary data omitted]',
  };
}

export function describeMatch(agent?: DiscoveryAgent): string {
  const trust = agent?.trust?.interactionScore;
  const trustText = typeof trust === 'number' ? ` (trust ${(trust * 100).toFixed(0)}%)` : '';
  return `${agent?.name ?? agent?.did ?? 'unknown'}${trustText}`;
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    wav: 'audio/wav',
    zip: 'application/zip',
    gz: 'application/gzip',
  };

  return map[ext] ?? 'application/octet-stream';
}
