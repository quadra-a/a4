import { compareMessagesBySortTimestamp } from '@quadra-a/protocol';
import type { MessageFilter, MessagePage, StoredMessage } from '@quadra-a/protocol';
import { DaemonClient, DaemonSubscriptionClient } from './daemon-client.js';

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_LOOKUP_LIMIT = 200;
const DAEMON_HINT = 'Daemon not running. Start with: agent listen --background';
const TERMINAL_OUTCOME_STATUSES = new Set(['success', 'error', 'rejected', 'cancelled', 'timeout']);

interface PaginationInput {
  limit?: number;
  offset?: number;
}

export interface MessageOutcome {
  requestId: string;
  kind: 'reply' | 'result';
  message: StoredMessage;
  status: string | null;
  jobId: string | null;
  terminal: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortMessagesByTimestamp(messages: StoredMessage[]): StoredMessage[] {
  return [...messages].sort(compareMessagesBySortTimestamp);
}

function getPayloadRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return payload as Record<string, unknown>;
}

export function getMessageOutcomeStatus(message: StoredMessage): string | null {
  const payload = getPayloadRecord(message.envelope.payload);
  return typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : null;
}

export function getMessageOutcomeJobId(message: StoredMessage): string | null {
  const payload = getPayloadRecord(message.envelope.payload);
  return typeof payload?.jobId === 'string' ? payload.jobId : null;
}

export function isTerminalOutcomeStatus(status: string | null): boolean {
  return status !== null && TERMINAL_OUTCOME_STATUSES.has(status);
}

function buildMessageOutcome(requestId: string, message: StoredMessage): MessageOutcome {
  const status = getMessageOutcomeStatus(message);
  return {
    requestId,
    kind: message.envelope.type === 'reply' ? 'reply' : 'result',
    message,
    status,
    jobId: getMessageOutcomeJobId(message),
    terminal: message.envelope.type === 'reply' || isTerminalOutcomeStatus(status),
  };
}

class MessageOutcomeTracker {
  private correlatedJobId: string | null = null;
  private correlatedFromDid: string | null = null;
  private correlatedProtocol: string | null = null;

  constructor(private readonly requestId: string) {}

  observe(message: StoredMessage): MessageOutcome | null {
    if (message.direction !== 'inbound') {
      return null;
    }

    const directMatch = message.envelope.replyTo === this.requestId;
    const jobId = getMessageOutcomeJobId(message);
    const sameJob = this.correlatedJobId !== null && jobId === this.correlatedJobId;
    const sameSender = this.correlatedFromDid === null || message.envelope.from === this.correlatedFromDid;
    const sameProtocol = this.correlatedProtocol === null || message.envelope.protocol === this.correlatedProtocol;

    if (!directMatch && !(sameJob && sameSender && sameProtocol)) {
      return null;
    }

    if (directMatch) {
      this.correlatedFromDid = message.envelope.from;
      this.correlatedProtocol = message.envelope.protocol;
      if (jobId) {
        this.correlatedJobId = jobId;
      }
    }

    return buildMessageOutcome(this.requestId, message);
  }
}

export function findMessageOutcome(messages: StoredMessage[], requestId: string): MessageOutcome | null {
  const tracker = new MessageOutcomeTracker(requestId);
  let latestOutcome: MessageOutcome | null = null;

  for (const message of sortMessagesByTimestamp(messages)) {
    const outcome = tracker.observe(message);
    if (!outcome) {
      continue;
    }

    latestOutcome = outcome;
    if (outcome.terminal) {
      return outcome;
    }
  }

  return latestOutcome;
}

export function parseWaitTimeoutMs(
  value: boolean | string | undefined,
  defaultSeconds = 30,
): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }

  if (value === true) {
    return defaultSeconds * 1000;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Wait timeout must be a positive number of seconds.');
  }

  return Math.round(seconds * 1000);
}

export async function ensureDaemonInboxAvailable(): Promise<DaemonClient> {
  const client = new DaemonClient();
  if (!(await client.isDaemonRunning())) {
    throw new Error(DAEMON_HINT);
  }

  return client;
}

export async function listInboxMessages(
  filter: MessageFilter = {},
  pagination: PaginationInput = {},
): Promise<MessagePage> {
  const client = await ensureDaemonInboxAvailable();
  return client.send<MessagePage>('inbox', { filter, pagination });
}

export async function markInboxMessageRead(id: string): Promise<void> {
  const client = await ensureDaemonInboxAvailable();
  await client.send('mark_read', { id });
}

export async function deleteInboxMessage(id: string): Promise<void> {
  const client = await ensureDaemonInboxAvailable();
  await client.send('delete_message', { id });
}

export async function resolveQueuedMessageId(id: string, limit = DEFAULT_LOOKUP_LIMIT): Promise<string | null> {
  const client = await ensureDaemonInboxAvailable();
  const exact = await client.send<StoredMessage>('get_message', { id }).catch(() => null);
  if (exact) {
    return exact.envelope.id;
  }

  const [inboxPage, outboxPage] = await Promise.all([
    client.send<MessagePage>('inbox', { filter: {}, pagination: { limit } }),
    client.send<MessagePage>('outbox', { pagination: { limit } }),
  ]);

  const matches = [...inboxPage.messages, ...outboxPage.messages]
    .map((message) => message.envelope.id)
    .filter((messageId) => messageId.endsWith(id));

  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length > 1) {
    throw new Error(`Multiple messages match ID suffix: ${id}`);
  }

  return uniqueMatches[0] ?? null;
}

export async function resolveInboxMessage(id: string, limit = DEFAULT_LOOKUP_LIMIT): Promise<StoredMessage | null> {
  const client = await ensureDaemonInboxAvailable();
  const exact = await client.send<StoredMessage>('get_message', { id }).catch(() => null);
  if (exact?.direction === 'inbound') {
    return exact;
  }

  const page = await client.send<MessagePage>('inbox', {
    filter: {},
    pagination: { limit },
  });

  const matches = page.messages.filter((message) => message.envelope.id.endsWith(id));
  if (matches.length > 1) {
    throw new Error(`Multiple inbox messages match ID suffix: ${id}`);
  }

  return matches[0] ?? null;
}

export async function waitForMessageOutcome(
  messageId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<MessageOutcome | null> {
  const client = await ensureDaemonInboxAvailable();

  try {
    return await waitForMessageOutcomeViaSubscription(client, messageId, timeoutMs);
  } catch {
    return waitForMessageOutcomeViaPolling(client, messageId, timeoutMs);
  }
}

export async function waitForReply(messageId: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<StoredMessage | null> {
  const outcome = await waitForMessageOutcome(messageId, timeoutMs);
  return outcome?.message ?? null;
}

export async function waitForInboxMessage(
  filter: MessageFilter = {},
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<StoredMessage | null> {
  const client = await ensureDaemonInboxAvailable();

  try {
    return await waitForInboxMessageViaSubscription(client, filter, timeoutMs);
  } catch {
    return waitForInboxMessageViaPolling(client, filter, timeoutMs);
  }
}

async function waitForMessageOutcomeViaSubscription(
  client: DaemonClient,
  messageId: string,
  timeoutMs: number,
): Promise<MessageOutcome | null> {
  const tracker = new MessageOutcomeTracker(messageId);
  const subscriptionClient = new DaemonSubscriptionClient<StoredMessage>();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveEvent: ((value: MessageOutcome) => void) | undefined;

  const eventPromise = new Promise<MessageOutcome>((resolve) => {
    resolveEvent = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  try {
    await subscriptionClient.subscribeInbox({}, (event) => {
      const outcome = tracker.observe(event.data);
      if (outcome?.terminal) {
        resolveEvent?.(outcome);
      }
    });

    const existing = await client.send<MessagePage>('inbox', {
      filter: {},
      pagination: { limit: DEFAULT_LOOKUP_LIMIT },
    });

    for (const message of sortMessagesByTimestamp(existing.messages)) {
      const outcome = tracker.observe(message);
      if (outcome?.terminal) {
        settled = true;
        return outcome;
      }
    }

    const pollingPromise = waitForMessageOutcomeViaPolling(client, messageId, timeoutMs)
      .then((outcome) => {
        if (!outcome || settled) {
          return null;
        }
        settled = true;
        return outcome;
      });

    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);
    });

    return await Promise.race([eventPromise, pollingPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    await subscriptionClient.close().catch(() => undefined);
  }
}

async function waitForMessageOutcomeViaPolling(
  client: DaemonClient,
  messageId: string,
  timeoutMs: number,
): Promise<MessageOutcome | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const page = await client.send<MessagePage>('inbox', {
      filter: {},
      pagination: { limit: DEFAULT_LOOKUP_LIMIT },
    });

    const outcome = findMessageOutcome(page.messages, messageId);
    if (outcome?.terminal) {
      return outcome;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, remainingMs));
  }

  return null;
}

async function waitForInboxMessageViaSubscription(
  client: DaemonClient,
  filter: MessageFilter,
  timeoutMs: number,
): Promise<StoredMessage | null> {
  const subscriptionClient = new DaemonSubscriptionClient<StoredMessage>();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveEvent: ((value: StoredMessage) => void) | undefined;

  const eventPromise = new Promise<StoredMessage>((resolve) => {
    resolveEvent = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  try {
    await subscriptionClient.subscribeInbox({ filter }, (event) => {
      resolveEvent?.(event.data);
    });

    const existing = await client.send<MessagePage>('inbox', {
      filter,
      pagination: { limit: 1 },
    });

    if (existing.messages.length > 0) {
      settled = true;
      return existing.messages[0];
    }

    const pollingPromise = waitForInboxMessageViaPolling(client, filter, timeoutMs)
      .then((message) => {
        if (!message || settled) {
          return null;
        }
        settled = true;
        return message;
      });

    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);
    });

    return await Promise.race([eventPromise, pollingPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    await subscriptionClient.close().catch(() => undefined);
  }
}

async function waitForInboxMessageViaPolling(
  client: DaemonClient,
  filter: MessageFilter,
  timeoutMs: number,
): Promise<StoredMessage | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const page = await client.send<MessagePage>('inbox', {
      filter,
      pagination: { limit: 1 },
    });

    if (page.messages.length > 0) {
      return page.messages[0];
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, remainingMs));
  }

  return null;
}
