/**
 * Serve Command - CVP-0010 §2.2
 *
 * Registers custom handlers that execute when matching requests arrive.
 *
 * quadra-a serve --on "translate" --exec "./translate.sh"
 * quadra-a serve --on "code_review" --exec python -- review.py
 * quadra-a serve --handlers ./my-handlers/
 */

import { Command } from 'commander';
import { DaemonClient, DaemonSubscriptionClient } from '../daemon/client.js';
import { getAgentCard } from '../config.js';
import { createLogger } from '@quadra-a/protocol';
import { spawn } from 'child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';

const logger = createLogger('cli:serve');

const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KiB
const SERVE_INBOX_FILTER = {
  direction: 'inbound',
  unreadOnly: true,
  status: 'pending',
  type: 'message',
};

interface HandlerEntry {
  capability: string;
  exec: string;
  args: string[];
}

interface ServeMessagePage {
  messages?: Array<{
    direction?: string;
    envelope?: {
      id?: string;
      from?: string;
      protocol?: string;
      payload?: unknown;
      type?: string;
      threadId?: string;
    };
  }>;
}

interface ServeClient {
  send(command: string, params: Record<string, unknown>): Promise<unknown>;
}

interface ServeProcessingOptions {
  client: ServeClient;
  handlers: HandlerEntry[];
  claimedMessageIds: Set<string>;
  activeCountRef: { value: number };
  maxConcurrency: number;
  timeoutMs: number;
  format: string;
  execute?: typeof executeHandler;
  now?: () => number;
  log?: Pick<typeof console, 'log' | 'error'>;
}

function normalizeCapabilityId(capability: string): string {
  return capability.trim().replace(/^\/+|\/+$/g, '');
}

export function capabilityProtocol(capability: string): string {
  return `/capability/${normalizeCapabilityId(capability)}`;
}

export function protocolMatchesCapability(protocol: string, capability: string): boolean {
  const normalizedProtocol = protocol.trim();
  const bareCapability = normalizeCapabilityId(capability);
  return normalizedProtocol === capabilityProtocol(capability) || normalizedProtocol === bareCapability;
}

export function extractExecArgsFromArgv(argv: string[]): string[] {
  const separatorIndex = argv.indexOf('--');
  return separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];
}

export function handlerFilenameToCapability(entry: string): string {
  return normalizeCapabilityId(basename(entry).replace(/\.[^.]+$/, '').replace(/__/g, '/'));
}

export function claimServeMessage(claimedMessageIds: Set<string>, envelopeId: string): boolean {
  const normalizedId = envelopeId.trim();
  if (!normalizedId || claimedMessageIds.has(normalizedId)) {
    return false;
  }
  claimedMessageIds.add(normalizedId);
  return true;
}

export function releaseServeMessage(claimedMessageIds: Set<string>, envelopeId: string): void {
  claimedMessageIds.delete(envelopeId);
}

function assertHandlersMatchLocalCard(handlers: HandlerEntry[]): void {
  const localCard = getAgentCard();
  const declaredCapabilities = new Set((localCard?.capabilities ?? []).map(normalizeCapabilityId));
  const missing = handlers
    .map((handler) => handler.capability)
    .filter((capability) => !declaredCapabilities.has(normalizeCapabilityId(capability)));

  if (!localCard || declaredCapabilities.size === 0) {
    throw new Error('Local Agent Card has no declared capabilities. Update it before running serve.');
  }

  if (missing.length > 0) {
    throw new Error(
      `Serve handlers must match local Agent Card capabilities. Missing: ${missing.join(', ')}`
    );
  }
}

function formatHandlerCommand(handler: HandlerEntry): string {
  return handler.args.length > 0 ? `${handler.exec} ${handler.args.join(' ')}` : handler.exec;
}

export async function buildServeHandlers(
  options: Record<string, unknown>,
  argv: string[] = process.argv
): Promise<HandlerEntry[]> {
  const handlers: HandlerEntry[] = [];
  const execArgs = extractExecArgsFromArgv(argv);

  if (options.on && options.exec && typeof options.on === 'string' && typeof options.exec === 'string') {
    let execPathExists = false;
    try {
      execPathExists = (await stat(resolve(options.exec))).isFile();
    } catch {
      execPathExists = false;
    }

    if (execArgs.length === 0 && /\s/.test(options.exec.trim()) && !execPathExists) {
      throw new Error(
        `--exec expects a single program path or name. Pass handler arguments after --, for example: a4 serve --on ${options.on} --exec python -- gpu_handler.py`
      );
    }

    handlers.push({ capability: normalizeCapabilityId(options.on), exec: options.exec, args: execArgs });
  }

  if (typeof options.handlers === 'string') {
    const dir = resolve(options.handlers);
    const entries = await readdir(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
      const cap = handlerFilenameToCapability(entry);
      handlers.push({ capability: cap, exec: fullPath, args: [] });
    }
  }

  return handlers;
}

async function markServeMessageRead(client: ServeClient, envelopeId: string): Promise<void> {
  await client.send('mark_read', { id: envelopeId });
}

async function sendServeReply(
  client: ServeClient,
  envelope: NonNullable<ServeMessagePage['messages']>[number]['envelope'],
  payload: unknown
): Promise<void> {
  if (!envelope?.from || !envelope.id) {
    return;
  }

  await client.send('send', {
    to: envelope.from,
    protocol: envelope.protocol ?? '/agent/msg/1.0.0',
    payload,
    type: 'reply',
    replyTo: envelope.id,
    ...(envelope.threadId ? { threadId: envelope.threadId } : {}),
  });
}

export async function processServeInboxPage(
  page: ServeMessagePage,
  options: ServeProcessingOptions
): Promise<void> {
  const execute = options.execute ?? executeHandler;
  const now = options.now ?? Date.now;
  const log = options.log ?? console;

  for (const message of page.messages ?? []) {
    if (message.direction && message.direction !== 'inbound') {
      continue;
    }

    const envelope = message.envelope;
    if (!envelope || (envelope.type && envelope.type !== 'message')) {
      continue;
    }

    const protocol = envelope.protocol ?? '';
    const handler = options.handlers.find((entry) =>
      protocolMatchesCapability(protocol, entry.capability) ||
      (envelope.payload as Record<string, unknown> | undefined)?.capability === entry.capability
    );

    if (!handler || !envelope.id) {
      continue;
    }

    if (!claimServeMessage(options.claimedMessageIds, envelope.id)) {
      continue;
    }

    if (options.activeCountRef.value >= options.maxConcurrency) {
      if (options.format !== 'json') {
        log.log(`[BUSY] Rejected ${envelope.id.slice(-8)} from ${(envelope.from ?? 'unknown').slice(0, 20)}…`);
      }

      try {
        await sendServeReply(options.client, envelope, {
          error: 'BUSY',
          message: 'Server at capacity, try again later',
        });
        await markServeMessageRead(options.client, envelope.id);
      } finally {
        releaseServeMessage(options.claimedMessageIds, envelope.id);
      }
      continue;
    }

    const payloadStr = JSON.stringify(envelope.payload ?? '');
    if (payloadStr.length > MAX_PAYLOAD_BYTES) {
      try {
        await sendServeReply(options.client, envelope, {
          error: 'PAYLOAD_TOO_LARGE',
          message: `Max payload is ${MAX_PAYLOAD_BYTES} bytes`,
        });
        await markServeMessageRead(options.client, envelope.id);
      } finally {
        releaseServeMessage(options.claimedMessageIds, envelope.id);
      }
      continue;
    }

    options.activeCountRef.value += 1;
    const startedAt = now();

    if (options.format !== 'json') {
      log.log(`[${new Date(startedAt).toLocaleTimeString()}] ${handler.capability} ← ${(envelope.from ?? 'unknown').slice(0, 30)}…`);
    }

    void (async () => {
      try {
        const result = await execute(handler.exec, handler.args, envelope.payload, options.timeoutMs);
        const latencyMs = now() - startedAt;

        await sendServeReply(options.client, envelope, result);
        await markServeMessageRead(options.client, envelope.id!);

        if (options.format === 'json') {
          log.log(JSON.stringify({
            event: 'handled',
            capability: handler.capability,
            from: envelope.from,
            latencyMs,
            success: true,
          }));
        } else {
          log.log(`  → responded in ${latencyMs}ms`);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const latencyMs = now() - startedAt;
        const isTimeout = err.message.includes('timeout');

        try {
          await sendServeReply(options.client, envelope, {
            error: isTimeout ? 'TIMEOUT' : 'HANDLER_ERROR',
            message: err.message,
          });
          await markServeMessageRead(options.client, envelope.id!);
        } catch (replyError) {
          logger.warn('Failed to send serve reply', replyError);
        }

        if (options.format === 'json') {
          log.log(JSON.stringify({
            event: 'error',
            capability: handler.capability,
            from: envelope.from,
            latencyMs,
            error: err.message,
          }));
        } else {
          log.error(`  → error after ${latencyMs}ms: ${err.message}`);
        }
      } finally {
        options.activeCountRef.value -= 1;
        releaseServeMessage(options.claimedMessageIds, envelope.id!);
      }
    })();
  }
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Register handlers for incoming requests (CVP-0010 §2.2)')
    .addHelpText('after', `
Handler contract:
  stdin  receives the incoming message payload JSON (not the full envelope)
  stdout JSON object becomes the reply payload as-is
  stdout non-JSON is wrapped as {"result":"<stdout>"}
  exit!=0 sends a HANDLER_ERROR reply
  timeout sends a TIMEOUT reply
`)
    .option('--on <capability>', 'Capability name to handle')
    .option('--exec <script>', 'Script to execute for matching requests')
    .option('--handlers <dir>', 'Directory of handler scripts (filename = capability name)')
    .option('--allow-from <dids...>', 'Only accept requests from these DIDs (default: deny-all except allowlist)')
    .option('--public', 'Accept requests from any agent (overrides --allow-from)')
    .option('--max-concurrency <n>', 'Max concurrent handler executions', '4')
    .option('--timeout <seconds>', 'Handler execution timeout in seconds', '60')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .action(async (options) => {
      if (options.json) options.format = 'json';
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: a4 listen --background');
        process.exit(1);
      }

      const handlers = await buildServeHandlers(options, process.argv);

      if (handlers.length === 0) {
        console.error('No handlers specified. Use --on/--exec or --handlers <dir>');
        process.exit(1);
      }

      assertHandlersMatchLocalCard(handlers);

      const maxConcurrency = parseInt(options.maxConcurrency, 10);
      const timeoutMs = parseInt(options.timeout, 10) * 1000;
      const activeCountRef = { value: 0 };
      const claimedMessageIds = new Set<string>();
      const subscriptionClient = new DaemonSubscriptionClient();
      let pollInFlight = false;
      let pollInterval: NodeJS.Timeout | null = null;
      let shuttingDown = false;

      // Apply allowlist if --allow-from specified
      if (options.allowFrom && !options.public) {
        for (const did of options.allowFrom) {
          await client.send('allowlist', { action: 'add', did, note: 'quadra-a serve --allow-from' });
        }
        if (options.format !== 'json') {
          console.log(`Allowlisted ${options.allowFrom.length} DID(s)`);
        }
      }

      if (options.format !== 'json') {
        console.log(`\nServing ${handlers.length} handler(s):`);
        for (const h of handlers) {
          console.log(`  ${h.capability} → ${formatHandlerCommand(h)}`);
        }
        console.log(`\nMax concurrency: ${maxConcurrency}, timeout: ${options.timeout}s`);
        console.log('Waiting for requests... (Ctrl+C to stop)\n');
      }

      // Subscribe to incoming messages via queue
      // Poll inbox for new messages matching our capabilities
      const poll = async () => {
        if (pollInFlight) {
          return;
        }

        pollInFlight = true;
        try {
          const page = await client.send('inbox', {
            filter: SERVE_INBOX_FILTER,
            pagination: { limit: 10 },
          });
          await processServeInboxPage(page as ServeMessagePage, {
            client,
            handlers,
            claimedMessageIds,
            activeCountRef,
            maxConcurrency,
            timeoutMs,
            format: options.format,
          });
        } catch (err) {
          logger.warn('Poll error', err);
        } finally {
          pollInFlight = false;
        }
      };

      const startPollingFallback = () => {
        if (pollInterval) {
          return;
        }

        pollInterval = setInterval(() => {
          void poll();
        }, 500);
      };

      try {
        await subscriptionClient.subscribeInbox(
          { filter: SERVE_INBOX_FILTER },
          (event) => {
            void processServeInboxPage(
              { messages: [event.data as ServeMessagePage['messages'][number]] },
              {
                client,
                handlers,
                claimedMessageIds,
                activeCountRef,
                maxConcurrency,
                timeoutMs,
                format: options.format,
              },
            ).catch((err) => {
              logger.warn('Serve subscription event processing error', err);
            });
          },
        );
      } catch (error) {
        logger.warn('Inbox subscription unavailable, falling back to polling', error);
        startPollingFallback();
      }

      await poll();

      // Graceful shutdown
      const shutdown = async () => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;

        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }

        await subscriptionClient.close().catch(() => undefined);
        if (options.format !== 'json') console.log('\nStopped serving.');
        process.exit(0);
      };
      process.on('SIGINT', () => {
        void shutdown();
      });
      process.on('SIGTERM', () => {
        void shutdown();
      });
    });
}

async function executeHandler(
  scriptPath: string,
  execArgs: string[],
  payload: unknown,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, execArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Handler timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Handler exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ result: stdout.trim() });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write payload to stdin
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
