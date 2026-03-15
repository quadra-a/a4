import type { StoredMessage } from '@quadra-a/protocol';
import { Command } from 'commander';
import {
  buildMessagePayload,
  dispatchMessage,
  formatMessagePayload,
  redactPayloadForDisplay,
  resolveTargetDid,
  resolveThreadId,
  type DiscoveryCapability,
} from '../services/messaging.js';
import {
  buildMessageTrace,
  ensureDaemonInboxAvailable,
  parseWaitTimeoutMs,
  resolveQueuedMessageId,
  waitForMessageOutcome,
} from '../services/inbox.js';
import { DaemonClient } from '../services/messaging.js';
import { error, info, printHeader, success, warn } from '../ui.js';

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

function extractPrimaryProtocol(capabilities?: DiscoveryCapability[]): string | null {
  if (!capabilities) return null;

  for (const cap of capabilities) {
    const capId = typeof cap === 'string' ? cap : cap.id;
    if (capId === 'shell/exec' || capId === 'gpu/compute') {
      return '/shell/exec/1.0.0';
    }
  }

  return null;
}

export function registerTellCommand(program: Command): void {
  program
    .command('tell <target> [message]')
    .description('Send a message to a specific agent')
    .option('--file <path>', 'Attach a file to the message')
    .option('--payload <json>', 'Message payload (JSON)')
    .option('--protocol <protocol>', 'Protocol to use', '/agent/msg/1.0.0')
    .option('--thread <id>', 'Continue an existing thread')
    .option('--new-thread', 'Start a new thread')
    .option('--reply-to <message-id>', 'Correlate this message to an existing message ID')
    .option('--wait [seconds]', 'Wait for a result (default: 30s)')
    .option('--relay <url>', 'Relay WebSocket URL')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--human', 'Human-friendly output with colors')
    .action(async (target: string, message: string | undefined, options) => {
      try {
        const isHuman = Boolean(options.human) && options.format !== 'json';
        const waitTimeoutMs = parseWaitTimeoutMs(options.wait);
        const replyTo = options.replyTo
          ? ((await resolveQueuedMessageId(options.replyTo)) ?? options.replyTo)
          : undefined;

        if (waitTimeoutMs !== undefined) {
          await ensureDaemonInboxAvailable();
        }

        if (isHuman) {
          printHeader('Tell Agent');
        }

        const resolved = await resolveTargetDid(target, options.relay);

        // Auto-detect protocol from agent card if not explicitly set
        let effectiveProtocol = options.protocol;
        if (effectiveProtocol === '/agent/msg/1.0.0') {
          let detectedProtocol = resolved.agent ? extractPrimaryProtocol(resolved.agent.capabilities) : null;

          if (!detectedProtocol) {
            try {
              const client = new DaemonClient();
              if (await client.isDaemonRunning()) {
                const response = await client.send<{ card?: { capabilities?: DiscoveryCapability[] } }>('query_agent_card', { did: resolved.did });
                if (response.card?.capabilities) {
                  detectedProtocol = extractPrimaryProtocol(response.card.capabilities);
                }
              }
            } catch {
              // Ignore daemon query errors, fall back to default protocol
            }
          }

          if (detectedProtocol) {
            effectiveProtocol = detectedProtocol;
          }
        }

        let payload = await buildMessagePayload({
          message,
          payload: options.payload,
          file: options.file,
        });
        if (effectiveProtocol === '/shell/exec/1.0.0' && message && !options.payload && !options.file) {
          payload = { command: message };
        }
        const threadId = resolveThreadId(options);
        const result = await dispatchMessage({
          to: resolved.did,
          protocol: effectiveProtocol,
          payload,
          type: 'message',
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
            target,
            resolvedDid: resolved.did,
            matchedBy: resolved.matchedBy,
            threadId: threadId ?? null,
            messageId: result.id,
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
          info(`Resolved ${target} to ${resolved.did}`);
        }
        info(`Message ID: ${result.id}`);
        info(`Path: ${result.usedDaemon ? 'daemon-backed send' : 'direct relay fallback'}`);
        if (replyTo) {
          info(`Reply To: ${replyTo}`);
        }
        if (threadId) {
          info(`Thread: ${threadId}`);
        }

        if (waitTimeoutMs === undefined) {
          if (result.usedDaemon) {
            info(`Trace with: agent trace ${result.id}`);
          }
          success(`Message accepted locally (${result.id.slice(-8)})`);
          return;
        }

        if (!outcome) {
          error(`No result within ${waitTimeoutMs / 1000}s`);
          warn('Result timeout does not prove the remote execution failed.');
          if (trace) {
            info(`Local sender state: ${trace.summary.localQueueState}`);
          }
          if (result.usedDaemon) {
            info(`Trace with: agent trace ${result.id}`);
          }
          process.exit(1);
        }

        success(`${outcome.kind === 'reply' ? 'Reply' : 'Result'} received (${outcome.message.envelope.id.slice(-8)})`);
        console.log(formatMessagePayload(outcome.message.envelope.payload));
      } catch (err) {
        error(`Failed to tell agent: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
