import type { StoredMessage } from '@quadra-a/protocol';
import { Command } from 'commander';
import {
  buildMessagePayload,
  dispatchMessage,
  formatMessagePayload,
  redactPayloadForDisplay,
  resolveTargetDid,
  resolveThreadId,
} from '../services/messaging.js';
import {
  buildMessageTrace,
  ensureDaemonInboxAvailable,
  parseWaitTimeoutMs,
  resolveQueuedMessageId,
  waitForMessageOutcome,
} from '../services/inbox.js';
import { error, info, printHeader, success, warn } from '../ui.js';

type SendMessageType = 'message' | 'reply';

function normalizeSendType(type: string): { type: SendMessageType; waitByDefault: boolean } {
  switch (type.toLowerCase()) {
    case 'request':
      return { type: 'message', waitByDefault: true };
    case 'notification':
    case 'message':
      return { type: 'message', waitByDefault: false };
    case 'response':
    case 'reply':
      return { type: 'reply', waitByDefault: false };
    default:
      throw new Error(`Unsupported message type: ${type}`);
  }
}

function serializeStoredMessage(message: StoredMessage | null) {
  if (!message) {
    return null;
  }

  return {
    id: message.envelope.id,
    from: message.envelope.from,
    protocol: message.envelope.protocol,
    type: message.envelope.type,
    replyTo: message.envelope.replyTo ?? null,
    payload: message.envelope.payload,
  };
}

export function registerSendCommand(program: Command): void {
  program
    .command('send')
    .description('Legacy compatibility command for sending a message')
    .configureHelp({ visibleCommands: () => [] })
    .requiredOption('--to <did-or-name>', 'Recipient DID, alias, or agent name')
    .option('--protocol <protocol>', 'Protocol identifier', '/agent/msg/1.0.0')
    .option('--message <text>', 'Message text')
    .option('--payload <json>', 'Message payload (JSON)')
    .option('--file <path>', 'Attach a file as payload attachment')
    .option('--type <type>', 'Message type (request|notification|message|reply|response)', 'request')
    .option('--reply-to <message-id>', 'Reply to an existing message ID')
    .option('--wait [seconds]', 'Wait for a result (default: 30s)')
    .option('--relay <url>', 'Relay WebSocket URL')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .option('--human', 'Human-friendly output with colors')
    .option('--thread <id>', 'Continue conversation in existing thread')
    .option('--new-thread', 'Start a new conversation thread')
    .action(async (options) => {
      try {
        if (options.json) options.format = 'json';
        const isHuman = Boolean(options.human) && options.format !== 'json';
        const normalized = normalizeSendType(options.type);
        const explicitWaitMs = parseWaitTimeoutMs(options.wait);
        const waitTimeoutMs = explicitWaitMs ?? (normalized.waitByDefault ? 30_000 : undefined);
        const replyTo = options.replyTo
          ? ((await resolveQueuedMessageId(options.replyTo)) ?? options.replyTo)
          : undefined;

        if (normalized.type === 'reply' && !replyTo) {
          throw new Error('Reply messages require --reply-to <message-id>.');
        }
        if (normalized.type === 'reply' && waitTimeoutMs !== undefined) {
          throw new Error('Reply messages cannot be combined with --wait.');
        }
        if (waitTimeoutMs !== undefined) {
          await ensureDaemonInboxAvailable();
        }

        if (isHuman) {
          printHeader('Send Message');
        }

        const resolved = await resolveTargetDid(options.to, options.relay);
        const payload = await buildMessagePayload({
          message: options.message,
          payload: options.payload,
          file: options.file,
        });
        const threadId = resolveThreadId(options);
        const result = await dispatchMessage({
          to: resolved.did,
          protocol: options.protocol,
          payload,
          type: normalized.type,
          replyTo,
          threadId,
          relay: options.relay,
        });

        let outcome = null;
        let trace = null;
        if (waitTimeoutMs !== undefined) {
          if (options.format !== 'json') {
            info(`Waiting for result (${waitTimeoutMs / 1000}s timeout)...`);
          }
          outcome = await waitForMessageOutcome(result.id, waitTimeoutMs);
          if (!outcome && result.usedDaemon) {
            trace = await buildMessageTrace(result.id).catch(() => null);
          }
        } else if (result.usedDaemon && options.format === 'json') {
          trace = await buildMessageTrace(result.id).catch(() => null);
        }

        if (options.format === 'json') {
          console.log(JSON.stringify({
            to: options.to,
            resolvedDid: resolved.did,
            matchedBy: resolved.matchedBy,
            threadId: threadId ?? null,
            messageId: result.id,
            type: normalized.type,
            replyTo: replyTo ?? null,
            payload: redactPayloadForDisplay(payload),
            waitSeconds: waitTimeoutMs != null ? waitTimeoutMs / 1000 : null,
            reply: outcome?.kind === 'reply' ? serializeStoredMessage(outcome.message) : null,
            result: outcome ? {
              kind: outcome.kind,
              status: outcome.status,
              jobId: outcome.jobId,
              terminal: outcome.terminal,
              message: serializeStoredMessage(outcome.message),
            } : null,
            timedOut: waitTimeoutMs !== undefined && !outcome,
            usedDaemon: result.usedDaemon,
            trace,
            notes: waitTimeoutMs !== undefined && !outcome
              ? [
                  'Result timeout does not prove remote failure.',
                  result.usedDaemon
                    ? `Inspect local lifecycle with: agent trace ${result.id}`
                    : 'This send used direct relay mode, so daemon-backed trace data is unavailable.',
                ]
              : [],
          }, null, 2));

          if (waitTimeoutMs !== undefined && !outcome) {
            process.exit(1);
          }
          return;
        }

        if (resolved.matchedBy === 'search') {
          info(`Resolved ${options.to} to ${resolved.did}`);
        }
        info(`Message ID: ${result.id}`);
        info(`To: ${resolved.did}`);
        info(`Type: ${normalized.type}`);
        if (replyTo) {
          info(`Reply To: ${replyTo}`);
        }
        if (threadId) {
          info(`Thread: ${threadId}`);
        }
        info(`Payload: ${JSON.stringify(redactPayloadForDisplay(payload))}`);
        info(`Path: ${result.usedDaemon ? 'daemon-backed send' : 'direct relay fallback'}`);
        if (result.usedDaemon) {
          info(`Trace with: agent trace ${result.id}`);
        }

        if (waitTimeoutMs !== undefined) {
          if (!outcome) {
            error(`No result within ${waitTimeoutMs / 1000}s`);
            warn('Result timeout does not prove the remote execution failed.');
            if (trace) {
              info(`Local sender state: ${trace.summary.localQueueState}`);
            }
            process.exit(1);
          }

          console.log();
          success(`>>> ${outcome.kind === 'reply' ? 'Reply' : 'Result'} received`);
          console.log(formatMessagePayload(outcome.message.envelope.payload));
          return;
        }

        success('Done');
      } catch (err) {
        error(`Failed to send message: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
