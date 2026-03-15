import { getMessageSortTimestamp, type StoredMessage } from '@quadra-a/protocol';
import { Command } from 'commander';
import {
  buildMessageTrace,
  parseWaitTimeoutMs,
  resolveQueuedMessageId,
  waitForMessageOutcome,
} from '../services/inbox.js';
import { formatMessagePayload } from '../services/messaging.js';
import { error, info, success, warn } from '../ui.js';

function serializeStoredMessage(message: StoredMessage | null) {
  if (!message) {
    return null;
  }

  return {
    id: message.envelope.id,
    timestamp: getMessageSortTimestamp(message),
    from: message.envelope.from,
    protocol: message.envelope.protocol,
    type: message.envelope.type,
    replyTo: message.envelope.replyTo ?? null,
    payload: message.envelope.payload,
  };
}

export function registerWaitCommand(program: Command): void {
  program
    .command('wait <messageId>')
    .description('Wait for a reply or async result for a previously sent message')
    .option('--timeout <seconds>', 'Wait timeout in seconds (default: 30)')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .option('--human', 'Human-friendly output with colors')
    .action(async (messageId: string, options) => {
      try {
        if (options.json) {
          options.format = 'json';
        }

        const timeoutMs = parseWaitTimeoutMs(options.timeout ?? true);
        const resolvedId = await resolveQueuedMessageId(messageId);
        if (!resolvedId) {
          throw new Error(
            'Only daemon-backed messages with local lifecycle history can be waited on again.',
          );
        }

        if (options.format !== 'json') {
          info(`Waiting for result (${timeoutMs! / 1000}s timeout)...`);
        }

        const outcome = await waitForMessageOutcome(resolvedId, timeoutMs);
        const trace = await buildMessageTrace(resolvedId).catch(() => null);
        const outboxMessage = trace?.outboxMessage ?? null;

        if (options.format === 'json') {
          console.log(JSON.stringify({
            requestedId: messageId,
            resolvedId,
            messageId: resolvedId,
            to: trace?.summary.targetDid ?? null,
            protocol: trace?.summary.protocol ?? null,
            protocolSelection: null,
            protocolSelectionReason: null,
            payload: outboxMessage?.envelope.payload ?? null,
            threadId: trace?.summary.threadId ?? null,
            waitSeconds: timeoutMs != null ? timeoutMs / 1000 : null,
            reply: outcome?.kind === 'reply' ? serializeStoredMessage(outcome.message) : null,
            result: outcome ? {
              kind: outcome.kind,
              status: outcome.status,
              jobId: outcome.jobId,
              terminal: outcome.terminal,
              message: serializeStoredMessage(outcome.message),
            } : null,
            timedOut: !outcome,
            trace,
          }, null, 2));

          if (!outcome) {
            process.exit(1);
          }
          return;
        }

        if (!outcome) {
          error(`No result within ${timeoutMs! / 1000}s`);
          warn('Result timeout does not prove the remote execution failed.');
          if (trace) {
            info(`Local sender state: ${trace.summary.localQueueState}`);
            info(`Trace with: agent trace ${resolvedId}`);
          }
          process.exit(1);
        }

        success(`${outcome.kind === 'reply' ? 'Reply' : 'Result'} received (${outcome.message.envelope.id.slice(-8)})`);
        console.log(formatMessagePayload(outcome.message.envelope.payload));
      } catch (err) {
        error(`Failed to wait for message: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
