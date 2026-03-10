import type { IncomingMessage } from 'http';
import { encode as encodeCBOR } from 'cbor-x';
import { deserializeQueuedEnvelope } from './queue.js';
import type { ConnectionContext } from './relay-agent-types.js';
import type { DeliverMessage } from './types.js';

export function normalizeEnvelopeBytes(envelope: Uint8Array | number[] | Record<string, unknown>): Uint8Array {
  if (envelope instanceof Uint8Array) {
    return envelope;
  }

  return new Uint8Array(deserializeQueuedEnvelope(envelope as number[] | Record<string, unknown>));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0.0.0.0';
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return isLoopbackHostname(new URL(endpoint).hostname);
  } catch {
    return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:|\/|$)/i.test(endpoint);
  }
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function getConnectionContext(req?: IncomingMessage): ConnectionContext {
  const forwardedFor = getHeaderValue(req?.headers['x-forwarded-for'])?.split(',')[0]?.trim();
  const remoteIp = forwardedFor || req?.socket?.remoteAddress || 'unknown';
  const userAgent = getHeaderValue(req?.headers['user-agent'])?.trim() || 'unknown';
  return { remoteIp, userAgent };
}

export function formatConnectionContext(context: ConnectionContext): string {
  return `ip=${context.remoteIp} ua=${JSON.stringify(context.userAgent)}`;
}

export function getRelayStartupWarnings(config: {
  port: number;
  configuredPublicEndpoints: string[];
  publishedEndpoints: string[];
}): string[] {
  const warnings: string[] = [];

  if (config.configuredPublicEndpoints.length === 0) {
    const fallbackEndpoint = config.publishedEndpoints[0] ?? `ws://localhost:${config.port}`;
    warnings.push(
      `No PUBLIC_ENDPOINT configured; this relay is advertising ${fallbackEndpoint}. `
      + 'That only works for local development. For external clients or federation, '
      + 'set PUBLIC_ENDPOINT or --public-endpoint to a reachable ws:// or wss:// URL.'
    );
  }

  const loopbackEndpoints = [...new Set(config.publishedEndpoints.filter(isLoopbackEndpoint))];
  for (const endpoint of loopbackEndpoints) {
    warnings.push(
      `Published endpoint ${endpoint} is loopback-only. External peers cannot reach localhost, `
      + '127.0.0.1, ::1, or 0.0.0.0 from another machine.'
    );
  }

  return warnings;
}

export function randomMessageId(): string {
  return Math.random().toString(36).slice(2);
}

export function createRelayDeliverMessage(from: string, payload: unknown): DeliverMessage {
  return {
    type: 'DELIVER',
    messageId: randomMessageId(),
    from,
    envelope: encodeCBOR(payload),
  };
}
