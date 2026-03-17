import {
  generateThreadId,
  resolveDid,
  type MessageEnvelopeType,
} from '@quadra-a/protocol';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getAliases } from './config.js';
import { DaemonClient } from './daemon-client.js';
import {
  searchAgents,
  type DiscoveryAgent,
} from './agent-runtime.js';

export interface MessagePayloadInput {
  message?: string;
  payload?: string;
  file?: string;
}

export type TellBodyFormat = 'text' | 'json';
export type TellBodySource = 'positional' | 'inline' | 'file' | 'stdin';

export interface TellBodyInput {
  message?: string;
  body?: string;
  bodyFile?: string;
  bodyStdin?: boolean;
  bodyFormat?: string;
}

export interface ResolvedTellBody {
  source: TellBodySource;
  format: TellBodyFormat;
  payload: Record<string, unknown>;
  rawText: string | null;
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
  deliveryMode?: DeliveryMode;
  relay?: string;
}

export type DeliveryMode = 'required' | 'preferred' | 'disabled';

export interface DispatchMessageResult {
  id: string;
  usedDaemon: boolean;
  deliveryMode: DeliveryMode;
  deliveryPath: 'e2e' | 'plaintext';
  transportStatus: string;
}

function normalizeBodyFormat(bodyFormat?: string): TellBodyFormat {
  if (bodyFormat === 'text' || bodyFormat === 'json') {
    return bodyFormat;
  }

  throw new Error('Body format must be either "text" or "json".');
}

export function normalizeDeliveryMode(deliveryMode?: string): DeliveryMode {
  switch (deliveryMode?.trim()) {
    case undefined:
    case '':
    case 'required':
      return 'required';
    case 'preferred':
      return 'preferred';
    case 'disabled':
      return 'disabled';
    default:
      throw new Error('Delivery mode must be one of: required, preferred, disabled.');
  }
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function wrapTextBody(protocol: string, body: string): Record<string, unknown> {
  if (protocol === '/shell/exec/1.0.0') {
    return { command: body };
  }

  return { text: body };
}

function parseJsonBody(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JSON body must be valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JSON body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

export function validateTellBodyInput(input: TellBodyInput): TellBodySource {
  const sources = [
    input.message !== undefined ? 'positional' : null,
    input.body !== undefined ? 'inline' : null,
    input.bodyFile ? 'file' : null,
    input.bodyStdin ? 'stdin' : null,
  ].filter((value): value is TellBodySource => value !== null);

  if (sources.length !== 1) {
    throw new Error('Provide exactly one body source: positional message, --body, --body-file, or --body-stdin.');
  }

  const source = sources[0];
  if (source === 'positional') {
    if (input.bodyFormat && input.bodyFormat !== 'text') {
      throw new Error('Positional message always uses --body-format text.');
    }
    return source;
  }

  if (!input.bodyFormat) {
    throw new Error('Body format is required with --body, --body-file, and --body-stdin.');
  }

  return source;
}

export async function resolveTellBody(
  input: TellBodyInput,
  protocol: string,
): Promise<ResolvedTellBody> {
  const source = validateTellBodyInput(input);

  if (source === 'positional') {
    return {
      source,
      format: 'text',
      payload: wrapTextBody(protocol, input.message ?? ''),
      rawText: input.message ?? '',
    };
  }

  const format = normalizeBodyFormat(input.bodyFormat);
  const rawBody = source === 'inline'
    ? input.body ?? ''
    : source === 'file'
      ? await readFile(input.bodyFile!, 'utf8')
      : await readStdinText();

  if (format === 'json') {
    return {
      source,
      format,
      payload: parseJsonBody(rawBody),
      rawText: null,
    };
  }

  return {
    source,
    format,
    payload: wrapTextBody(protocol, rawBody),
    rawText: rawBody,
  };
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
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
  const client = new DaemonClient();

  if (!(await client.isDaemonRunning())) {
    throw new Error('Daemon not running. Start with: agent listen --background');
  }

  const result = await client.send<{
    id: string;
    messageId?: string;
    deliveryMode?: DeliveryMode;
    deliveryPath?: 'e2e' | 'plaintext';
    transportStatus?: string;
  }>('send', {
    to: input.to,
    protocol,
    payload: input.payload,
    type,
    replyTo: input.replyTo,
    threadId: input.threadId,
    deliveryMode,
  });

  return {
    id: result.id,
    usedDaemon: true,
    deliveryMode: result.deliveryMode ?? deliveryMode,
    deliveryPath: result.deliveryPath ?? 'e2e',
    transportStatus: result.transportStatus ?? 'accepted',
  };
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
