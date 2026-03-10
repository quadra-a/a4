import type { MessagePage, QueueStats, StoredMessage } from '@quadra-a/protocol';
import { DaemonClient } from './daemon-client.js';
import {
  ensureDaemonInboxAvailable,
  findMessageOutcome,
  getMessageOutcomeJobId,
  resolveQueuedMessageId,
} from './inbox.js';

export type MessageTraceStageState = 'done' | 'active' | 'warning' | 'unknown';

export interface MessageTraceStage {
  key: string;
  label: string;
  state: MessageTraceStageState;
  detail: string;
  at: string | null;
}

export interface MessageTrace {
  requestedId: string;
  resolvedId: string | null;
  messageId: string | null;
  available: boolean;
  summary: {
    state:
      | 'replied'
      | 'result_received'
      | 'result_in_progress'
      | 'sender_failed'
      | 'queued'
      | 'waiting_for_result'
      | 'untracked';
    dispatchPath: 'daemon';
    localQueueState: string;
    replyState: 'reply_observed' | 'no_reply_yet';
    resultState: 'terminal_result_observed' | 'progress_result_observed' | 'no_result_yet';
    resultStatus: string | null;
    jobId: string | null;
    threadId: string | null;
    protocol: string | null;
    targetDid: string | null;
    notes: string[];
  };
  stages: MessageTraceStage[];
  outboxMessage: StoredMessage | null;
  replyMessage: StoredMessage | null;
  resultMessage: StoredMessage | null;
  lifecycleMessages: StoredMessage[];
  queue: QueueStats | null;
}

function timestampOf(message: StoredMessage | null): number | null {
  if (!message) {
    return null;
  }

  return message.receivedAt ?? message.sentAt ?? message.envelope.timestamp ?? null;
}

function isoTimestamp(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value).toISOString();
}

function sortMessagesByTimestamp(messages: StoredMessage[]): StoredMessage[] {
  return [...messages].sort((left, right) => (timestampOf(left) ?? 0) - (timestampOf(right) ?? 0));
}

function uniqueMessages(messages: StoredMessage[]): StoredMessage[] {
  const seen = new Set<string>();
  const result: StoredMessage[] = [];

  for (const message of messages) {
    if (seen.has(message.envelope.id)) {
      continue;
    }
    seen.add(message.envelope.id);
    result.push(message);
  }

  return result;
}

function resolveRequestIdFromMessage(message: StoredMessage | null, inboxMessages: StoredMessage[]): string | null {
  if (!message) {
    return null;
  }

  if (message.direction === 'outbound') {
    return message.envelope.id;
  }

  if (message.envelope.replyTo) {
    return message.envelope.replyTo;
  }

  const jobId = getMessageOutcomeJobId(message);
  if (!jobId) {
    return null;
  }

  const correlated = sortMessagesByTimestamp(inboxMessages).find((candidate) => {
    if (candidate.direction !== 'inbound') {
      return false;
    }

    return candidate.envelope.from === message.envelope.from
      && candidate.envelope.protocol === message.envelope.protocol
      && candidate.envelope.replyTo !== undefined
      && getMessageOutcomeJobId(candidate) === jobId;
  });

  return correlated?.envelope.replyTo ?? null;
}

function collectCorrelatedLifecycleMessages(messages: StoredMessage[], requestId: string): StoredMessage[] {
  let correlatedJobId: string | null = null;
  let correlatedFromDid: string | null = null;
  let correlatedProtocol: string | null = null;
  const collected: StoredMessage[] = [];

  for (const message of sortMessagesByTimestamp(messages)) {
    if (message.direction !== 'inbound') {
      continue;
    }

    const directMatch = message.envelope.replyTo === requestId;
    const jobId = getMessageOutcomeJobId(message);
    const sameJob = correlatedJobId !== null && jobId === correlatedJobId;
    const sameSender = correlatedFromDid === null || message.envelope.from === correlatedFromDid;
    const sameProtocol = correlatedProtocol === null || message.envelope.protocol === correlatedProtocol;

    if (!directMatch && !(sameJob && sameSender && sameProtocol)) {
      continue;
    }

    if (directMatch) {
      correlatedFromDid = message.envelope.from;
      correlatedProtocol = message.envelope.protocol;
      if (jobId) {
        correlatedJobId = jobId;
      }
    }

    if (message.envelope.type === 'message') {
      collected.push(message);
    }
  }

  return collected;
}

function buildTraceStages(
  outboxMessage: StoredMessage | null,
  resultMessage: StoredMessage | null,
  replyMessage: StoredMessage | null,
  resultState: MessageTrace['summary']['resultState'],
  resultStatus: string | null,
): MessageTraceStage[] {
  const outboxTime = isoTimestamp(timestampOf(outboxMessage));
  const resultTime = isoTimestamp(timestampOf(resultMessage ?? replyMessage));
  const queueState = outboxMessage?.status;

  return [
    {
      key: 'accepted',
      label: 'Accepted locally',
      state: outboxMessage ? 'done' : 'unknown',
      detail: outboxMessage
        ? 'The local sender created an outbound envelope and recorded it in the outbox.'
        : 'No local outbound record was found for this message ID.',
      at: outboxTime,
    },
    {
      key: 'queue',
      label: 'Queued locally',
      state: outboxMessage ? 'done' : 'unknown',
      detail: outboxMessage
        ? 'This local outbox record is the source of truth for browser and CLI lifecycle views.'
        : 'The daemon queue does not currently contain a matching outbound message.',
      at: outboxTime,
    },
    {
      key: 'transport',
      label: 'Sender handoff',
      state: !outboxMessage
        ? 'unknown'
        : queueState === 'failed'
          ? 'warning'
          : queueState === 'pending'
            ? 'active'
            : 'done',
      detail: !outboxMessage
        ? 'There is not enough local state to tell whether transport handoff finished.'
        : queueState === 'failed'
          ? `The local sender recorded a transport failure: ${outboxMessage.error ?? 'unknown error'}`
          : queueState === 'pending'
            ? 'The local outbox is still pending. Handoff has not been confirmed yet.'
            : 'The sender marked handoff as delivered to its current transport. This is not remote execution confirmation.',
      at: outboxTime,
    },
    {
      key: 'execution',
      label: 'Remote execution',
      state: resultMessage || replyMessage
        ? 'done'
        : queueState === 'failed'
          ? 'warning'
          : outboxMessage
            ? 'active'
            : 'unknown',
      detail: replyMessage
        ? 'A formal reply arrived, so remote processing clearly happened.'
        : resultMessage
          ? `An async result update${resultStatus ? ` (${resultStatus})` : ''} arrived from the remote agent.`
          : queueState === 'failed'
            ? 'No execution evidence is visible because transport itself failed.'
            : 'No remote execution evidence is visible yet.',
      at: resultMessage || replyMessage ? resultTime : null,
    },
    {
      key: 'result',
      label: 'Result observed',
      state: replyMessage || resultState === 'terminal_result_observed'
        ? 'done'
        : resultState === 'progress_result_observed'
          ? 'active'
          : queueState === 'failed'
            ? 'warning'
            : outboxMessage
              ? 'active'
              : 'unknown',
      detail: replyMessage
        ? 'A formal reply with matching correlation is present in the local inbox.'
        : resultState === 'terminal_result_observed'
          ? `A terminal async result${resultStatus ? ` (${resultStatus})` : ''} is present in the local inbox.`
          : resultState === 'progress_result_observed'
            ? `A non-terminal async result${resultStatus ? ` (${resultStatus})` : ''} indicates remote work is in progress.`
            : queueState === 'failed'
              ? 'No result was observed because transport itself failed.'
              : 'No correlated reply or async result is present in the local inbox yet.',
      at: resultMessage || replyMessage ? resultTime : null,
    },
  ];
}

export async function buildMessageTrace(requestedId: string): Promise<MessageTrace> {
  const normalized = requestedId.trim();
  if (!normalized) {
    throw new Error('Message ID is required.');
  }

  const client = await ensureDaemonInboxAvailable();
  const [queue, exactMatch, inboxPage] = await Promise.all([
    client.send<QueueStats>('queue_stats', {}),
    client.send<StoredMessage>('get_message', { id: normalized }).catch(() => null),
    client.send<MessagePage>('inbox', { filter: {}, pagination: { limit: 200 } }),
  ]);

  const allInboxMessages = uniqueMessages([
    ...(exactMatch?.direction === 'inbound' ? [exactMatch] : []),
    ...inboxPage.messages,
  ]);

  let resolvedId = resolveRequestIdFromMessage(exactMatch, allInboxMessages);
  if (!resolvedId) {
    resolvedId = (await resolveQueuedMessageId(normalized, 200).catch(() => null)) ?? normalized;
  }

  let outboxMessage = exactMatch?.direction === 'outbound' ? exactMatch : null;
  if (!outboxMessage) {
    const outboxPage = await client.send<MessagePage>('outbox', { pagination: { limit: 200 } });
    outboxMessage = outboxPage.messages.find((message) => message.envelope.id === resolvedId) ?? null;
  }

  const correlatedLifecycleMessages = collectCorrelatedLifecycleMessages(allInboxMessages, resolvedId);
  const outcome = findMessageOutcome(allInboxMessages, resolvedId);
  const replyMessage = sortMessagesByTimestamp(allInboxMessages)
    .filter((message) => message.direction === 'inbound' && message.envelope.type === 'reply' && message.envelope.replyTo === resolvedId)
    .at(-1) ?? null;
  const resultMessage = outcome?.message ?? null;
  const resultStatus = outcome?.status ?? null;
  const resultJobId = outcome?.jobId ?? (exactMatch ? getMessageOutcomeJobId(exactMatch) : null);

  const notes: string[] = [];
  if (outboxMessage?.status === 'delivered') {
    notes.push('“Delivered” means local handoff to the current transport, not proof that remote execution started.');
  }
  if (replyMessage) {
    notes.push('A formal reply is present in the local inbox.');
  } else if (outcome?.terminal) {
    notes.push(`A terminal async result${resultStatus ? ` (${resultStatus})` : ''} is present in the local inbox.`);
  } else if (outcome) {
    notes.push(`A non-terminal async result${resultStatus ? ` (${resultStatus})` : ''} indicates remote work is in progress.`);
  } else {
    notes.push('No correlated reply or async result is visible in the local inbox yet.');
  }
  if (!outboxMessage) {
    notes.push('No matching outbound queue entry was found locally, so part of the lifecycle remains unobserved.');
  }

  const summaryState: MessageTrace['summary']['state'] = replyMessage
    ? 'replied'
    : outcome?.terminal
      ? 'result_received'
      : outcome
        ? 'result_in_progress'
        : outboxMessage?.status === 'failed'
          ? 'sender_failed'
          : outboxMessage?.status === 'pending'
            ? 'queued'
            : outboxMessage?.status === 'delivered'
              ? 'waiting_for_result'
              : 'untracked';

  const resultState: MessageTrace['summary']['resultState'] = replyMessage || outcome?.terminal
    ? 'terminal_result_observed'
    : outcome
      ? 'progress_result_observed'
      : 'no_result_yet';

  return {
    requestedId: normalized,
    resolvedId,
    messageId: outboxMessage?.envelope.id ?? resolvedId,
    available: Boolean(outboxMessage || resultMessage || replyMessage),
    summary: {
      state: summaryState,
      dispatchPath: 'daemon',
      localQueueState: outboxMessage?.status ?? 'unknown',
      replyState: replyMessage ? 'reply_observed' : 'no_reply_yet',
      resultState,
      resultStatus,
      jobId: resultJobId,
      threadId: outboxMessage?.envelope.threadId ?? resultMessage?.envelope.threadId ?? replyMessage?.envelope.threadId ?? null,
      protocol: outboxMessage?.envelope.protocol ?? resultMessage?.envelope.protocol ?? replyMessage?.envelope.protocol ?? null,
      targetDid: outboxMessage?.envelope.to ?? resultMessage?.envelope.from ?? replyMessage?.envelope.from ?? null,
      notes,
    },
    stages: buildTraceStages(outboxMessage, resultMessage, replyMessage, resultState, resultStatus),
    outboxMessage,
    replyMessage,
    resultMessage,
    lifecycleMessages: correlatedLifecycleMessages,
    queue,
  };
}

export async function isDaemonTraceAvailable(client: DaemonClient = new DaemonClient()): Promise<boolean> {
  return client.isDaemonRunning();
}
