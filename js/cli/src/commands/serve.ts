/**
 * Serve Command - CVP-0010 §2.2
 *
 * Registers custom handlers that execute when matching requests arrive.
 *
 * quadra-a serve --on "translate" --exec "./translate.sh"
 * quadra-a serve --on "code_review" --exec "python review.py"
 * quadra-a serve --handlers ./my-handlers/
 */

import { Command } from 'commander';
import { DaemonClient } from '../daemon/client.js';
import { createLogger } from '@quadra-a/protocol';
import { spawn } from 'child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';

const logger = createLogger('cli:serve');

const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KiB

interface HandlerEntry {
  capability: string;
  exec: string;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Register handlers for incoming requests (CVP-0010 §2.2)')
    .option('--on <capability>', 'Capability name to handle')
    .option('--exec <script>', 'Script to execute for matching requests')
    .option('--handlers <dir>', 'Directory of handler scripts (filename = capability name)')
    .option('--allow-from <dids...>', 'Only accept requests from these DIDs (default: deny-all except allowlist)')
    .option('--public', 'Accept requests from any agent (overrides --allow-from)')
    .option('--max-concurrency <n>', 'Max concurrent handler executions', '4')
    .option('--timeout <seconds>', 'Handler execution timeout in seconds', '60')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .action(async (options) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      // Build handler list
      const handlers: HandlerEntry[] = [];

      if (options.on && options.exec) {
        handlers.push({ capability: options.on, exec: resolve(options.exec) });
      }

      if (options.handlers) {
        const dir = resolve(options.handlers);
        const entries = await readdir(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const s = await stat(fullPath);
          if (!s.isFile()) continue;
          // Strip extension to get capability name; skip _default for now
          const cap = basename(entry).replace(/\.[^.]+$/, '');
          handlers.push({ capability: cap, exec: fullPath });
        }
      }

      if (handlers.length === 0) {
        console.error('No handlers specified. Use --on/--exec or --handlers <dir>');
        process.exit(1);
      }

      const maxConcurrency = parseInt(options.maxConcurrency, 10);
      const timeoutMs = parseInt(options.timeout, 10) * 1000;
      let activeCount = 0;

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
          console.log(`  ${h.capability} → ${h.exec}`);
        }
        console.log(`\nMax concurrency: ${maxConcurrency}, timeout: ${options.timeout}s`);
        console.log('Waiting for requests... (Ctrl+C to stop)\n');
      }

      // Subscribe to incoming messages via queue
      // Poll inbox for new messages matching our capabilities
      const poll = async () => {
        try {
          const page = await client.send('inbox', {
            filter: { unreadOnly: true, status: 'pending', type: 'message' },
            pagination: { limit: 10 },
          });

          for (const msg of page.messages ?? []) {
            const envelope = msg.envelope;
            const protocol: string = envelope.protocol ?? '';

            // Find matching handler
            const handler = handlers.find((h) =>
              protocol.includes(h.capability) ||
              (envelope.payload as Record<string, unknown>)?.capability === h.capability
            );

            if (!handler) continue;

            // Mark as read immediately to avoid double-processing
            await client.send('mark_read', { id: envelope.id });

            // Concurrency control
            if (activeCount >= maxConcurrency) {
              if (options.format !== 'json') {
                console.log(`[BUSY] Rejected ${envelope.id.slice(-8)} from ${envelope.from.slice(0, 20)}…`);
              }
              // Send BUSY reply
              await client.send('send', {
                to: envelope.from,
                protocol: envelope.protocol,
                payload: { error: 'BUSY', message: 'Server at capacity, try again later' },
                type: 'reply',
                replyTo: envelope.id,
                threadId: envelope.threadId,
              });
              continue;
            }

            // Payload size check
            const payloadStr = JSON.stringify(envelope.payload ?? '');
            if (payloadStr.length > MAX_PAYLOAD_BYTES) {
              await client.send('send', {
                to: envelope.from,
                protocol: envelope.protocol,
                payload: { error: 'PAYLOAD_TOO_LARGE', message: `Max payload is ${MAX_PAYLOAD_BYTES} bytes` },
                type: 'reply',
                replyTo: envelope.id,
                threadId: envelope.threadId,
              });
              continue;
            }

            // Execute handler
            activeCount++;
            const startTime = Date.now();

            if (options.format !== 'json') {
              console.log(`[${new Date().toLocaleTimeString()}] ${handler.capability} ← ${envelope.from.slice(0, 30)}…`);
            }

            executeHandler(handler.exec, envelope.payload, timeoutMs)
              .then(async (result) => {
                const latencyMs = Date.now() - startTime;
                await client.send('send', {
                  to: envelope.from,
                  protocol: envelope.protocol,
                  payload: result,
                  type: 'reply',
                  replyTo: envelope.id,
                threadId: envelope.threadId,
                });

                if (options.format === 'json') {
                  console.log(JSON.stringify({
                    event: 'handled',
                    capability: handler.capability,
                    from: envelope.from,
                    latencyMs,
                    success: true,
                  }));
                } else {
                  console.log(`  → responded in ${latencyMs}ms`);
                }
              })
              .catch(async (err) => {
                const latencyMs = Date.now() - startTime;
                const isTimeout = err.message?.includes('timeout');
                await client.send('send', {
                  to: envelope.from,
                  protocol: envelope.protocol,
                  payload: {
                    error: isTimeout ? 'TIMEOUT' : 'HANDLER_ERROR',
                    message: err.message,
                  },
                  type: 'reply',
                  replyTo: envelope.id,
                threadId: envelope.threadId,
                });

                if (options.format === 'json') {
                  console.log(JSON.stringify({
                    event: 'error',
                    capability: handler.capability,
                    from: envelope.from,
                    latencyMs,
                    error: err.message,
                  }));
                } else {
                  console.error(`  → error after ${latencyMs}ms: ${err.message}`);
                }
              })
              .finally(() => {
                activeCount--;
              });
          }
        } catch (err) {
          logger.warn('Poll error', err);
        }
      };

      // Poll every 500ms
      const interval = setInterval(poll, 500);

      // Graceful shutdown
      const shutdown = () => {
        clearInterval(interval);
        if (options.format !== 'json') console.log('\nStopped serving.');
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}

async function executeHandler(
  scriptPath: string,
  payload: unknown,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, [], {
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
