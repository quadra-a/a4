import { getMessageSortTimestamp, type StoredMessage } from '@quadra-a/protocol';
import { Command } from 'commander';
import {
  dispatchMessage,
  formatMessagePayload,
  redactPayloadForDisplay,
  resolveTargetDid,
  resolveThreadId,
  resolveTellBody,
  validateTellBodyInput,
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
    timestamp: getMessageSortTimestamp(message),
    from: message.envelope.from,
    protocol: message.envelope.protocol,
    type: message.envelope.type,
    replyTo: message.envelope.replyTo ?? null,
    payload: message.envelope.payload,
  };
}

export function resolveTellMessageType(replyTo?: string | null): 'message' | 'reply' {
  return replyTo ? 'reply' : 'message';
}

export function extractPrimaryProtocol(capabilities?: DiscoveryCapability[]): string | null {
  if (!capabilities) return null;

  const declaredProtocols = new Set<string>();
  for (const cap of capabilities) {
    if (typeof cap === 'string') continue;

    const metadataProtocol = cap.metadata?.protocol;
    if (typeof metadataProtocol === 'string' && metadataProtocol.trim()) {
      declaredProtocols.add(metadataProtocol.trim());
    }
  }

  return declaredProtocols.size === 1 ? [...declaredProtocols][0] : null;
}

function collectDeclaredProtocols(capabilities?: DiscoveryCapability[]): string[] {
  if (!capabilities) {
    return [];
  }

  return [...new Set(
    capabilities.flatMap((cap) => {
      if (typeof cap === 'string') {
        return [];
      }

      const metadataProtocol = cap.metadata?.protocol;
      return typeof metadataProtocol === 'string' && metadataProtocol.trim()
        ? [metadataProtocol.trim()]
        : [];
    }),
  )];
}

function describeDeclaredProtocols(protocols: string[]): string {
  return protocols.map((protocol) => `"${protocol}"`).join(', ');
}

function unwrapQueriedCapabilities(
  response: { capabilities?: DiscoveryCapability[] } | { card?: { capabilities?: DiscoveryCapability[] } } | null | undefined,
): DiscoveryCapability[] | undefined {
  if (!response) {
    return undefined;
  }

  if (Array.isArray(response.capabilities)) {
    return response.capabilities;
  }

  if ('card' in response && Array.isArray(response.card?.capabilities)) {
    return response.card.capabilities;
  }

  return undefined;
}

export function registerTellCommand(program: Command): void {
  program
    .command('tell <target> [message]')
    .description('Send a message to a specific agent')
    .option('--body <value>', 'Message body')
    .option('--body-file <path>', 'Read message body from a file')
    .option('--body-stdin', 'Read message body from stdin')
    .option('--body-format <format>', 'Body format: text|json')
    .option('--protocol <protocol>', 'Protocol to use', '/agent/msg/1.0.0')
    .option('--thread <id>', 'Continue an existing thread')
    .option('--new-thread', 'Start a new thread')
    .option('--reply-to <message-id>', 'Correlate this message to an existing message ID')
    .option('--wait [seconds]', 'Wait for a result (default: 30s)')
    .option('--relay <url>', 'Relay WebSocket URL')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .option('--human', 'Human-friendly output with colors')
    .action(async (target: string, message: string | undefined, options, command: Command) => {
      try {
        if (options.json) {
          options.format = 'json';
        }

        const isHuman = Boolean(options.human) && options.format !== 'json';
        validateTellBodyInput({
          message,
          body: options.body,
          bodyFile: options.bodyFile,
          bodyStdin: options.bodyStdin,
          bodyFormat: options.bodyFormat,
        });
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
        let protocolSelection: 'explicit' | 'default' | 'auto' = command.getOptionValueSource('protocol') === 'cli'
          ? 'explicit'
          : 'default';
        let protocolSelectionReason: string | null = null;
        if (protocolSelection !== 'explicit' && effectiveProtocol === '/agent/msg/1.0.0') {
          let declaredProtocols = resolved.agent ? collectDeclaredProtocols(resolved.agent.capabilities) : [];

          if (declaredProtocols.length === 0) {
            try {
              const client = new DaemonClient();
              if (await client.isDaemonRunning()) {
                const response = await client.send<
                  { capabilities?: DiscoveryCapability[] } | { card?: { capabilities?: DiscoveryCapability[] } } | null
                >('query_agent_card', { did: resolved.did });
                const queriedCapabilities = unwrapQueriedCapabilities(response);
                if (queriedCapabilities) {
                  declaredProtocols = collectDeclaredProtocols(queriedCapabilities);
                }
              }
            } catch {
              // Ignore daemon query errors, fall back to default protocol
            }
          }

          if (declaredProtocols.length > 1) {
            throw new Error(
              `Target advertises multiple protocols (${describeDeclaredProtocols(declaredProtocols)}). Pass --protocol explicitly.`
            );
          }

          if (declaredProtocols.length === 1) {
            effectiveProtocol = declaredProtocols[0];
            protocolSelection = 'auto';
            protocolSelectionReason = 'auto-selected from target capabilities';
          }
        }

        const { payload, format: bodyFormat } = await resolveTellBody({
          message,
          body: options.body,
          bodyFile: options.bodyFile,
          bodyStdin: options.bodyStdin,
          bodyFormat: options.bodyFormat,
        }, effectiveProtocol);
        const threadId = resolveThreadId(options);
        const result = await dispatchMessage({
          to: resolved.did,
          protocol: effectiveProtocol,
          payload,
          type: resolveTellMessageType(replyTo),
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
            bodyFormat,
            protocol: effectiveProtocol,
            protocolSelection,
            protocolSelectionReason,
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
        info(`Protocol: ${effectiveProtocol} (${protocolSelectionReason ?? protocolSelection})`);
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
