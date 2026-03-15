import { getMessageSortTimestamp } from '@quadra-a/protocol';
import type { MessageFilter, MessagePage, StoredMessage } from '@quadra-a/protocol';
import { Command } from 'commander';
import { createLogger } from '@quadra-a/protocol';
import {
  deleteInboxMessage,
  listInboxMessages,
  markInboxMessageRead,
  parseWaitTimeoutMs,
  resolveInboxMessage,
  resolveQueuedMessageId,
  waitForInboxMessage,
} from '../services/inbox.js';
import {
  buildMessagePayload,
  dispatchMessage,
  redactPayloadForDisplay,
} from '../services/messaging.js';
import { llmKeyValue, llmSection, llmTable } from '../ui.js';

const logger = createLogger('cli:inbox');

function shortDid(did: string): string {
  if (did.startsWith('did:agent:')) return did.slice(10, 24) + '…';
  if (did.length > 30) return did.slice(0, 14) + '…' + did.slice(-8);
  return did;
}

function formatAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function payloadPreview(payload: unknown, limit = 72): string {
  let text = '';

  if (typeof payload === 'string') {
    text = payload;
  } else if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    const candidate = record.text ?? record.message;
    if (typeof candidate === 'string') {
      text = candidate;
    }
  }

  if (!text) {
    return '';
  }

  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function isSystemDiagnosticMessage(message: StoredMessage): boolean {
  return message.envelope.protocol === 'e2e/decrypt-failed';
}

function filterSystemMessages(messages: StoredMessage[], includeSystem: boolean): StoredMessage[] {
  return includeSystem ? messages : messages.filter((message) => !isSystemDiagnosticMessage(message));
}

function serializeMessage(message: StoredMessage) {
  return {
    ...message,
    timestamp: getMessageSortTimestamp(message),
    category: isSystemDiagnosticMessage(message) ? 'system' : 'message',
    userVisible: !isSystemDiagnosticMessage(message),
  };
}

function serializeMessagePage(page: MessagePage, includeSystem: boolean) {
  const messages = filterSystemMessages(page.messages, includeSystem);
  return {
    ...page,
    total: messages.length,
    messages: messages.map((message) => serializeMessage(message)),
  };
}

function renderMessageList(page: MessagePage, options: {
  human?: boolean;
  unread?: boolean;
  from?: string;
  protocol?: string;
  thread?: string;
  replyTo?: string;
  includeSystem?: boolean;
}): void {
  const visibleMessages = filterSystemMessages(page.messages, Boolean(options.includeSystem));
  const unreadCount = visibleMessages.filter((message) => !message.readAt).length;

  if (options.human) {
    console.log(`\nInbox (${visibleMessages.length} total, ${unreadCount} unread)\n`);

    if (visibleMessages.length === 0) {
      console.log('  No messages.');
      return;
    }

    // Group messages by jobId for aggregated display
    const jobGroups = new Map<string, StoredMessage[]>();
    const ungrouped: StoredMessage[] = [];

    for (const message of visibleMessages) {
      const payload = message.envelope.payload as Record<string, unknown> | undefined;
      const jobId = payload?.jobId as string | undefined;
      if (jobId) {
        const group = jobGroups.get(jobId) ?? [];
        group.push(message);
        jobGroups.set(jobId, group);
      } else {
        ungrouped.push(message);
      }
    }

    // Render job groups (collapsed when >1 message)
    for (const [jobId, jobMsgs] of jobGroups) {
      if (jobMsgs.length > 1) {
        console.log(`  ▸ Job ${jobId} (${jobMsgs.length} messages)`);
        const latest = jobMsgs[jobMsgs.length - 1];
        const p = latest.envelope.payload as Record<string, unknown> | undefined;
        if (p) {
          const status = p.status as string | undefined;
          const exitCode = p.exitCode as number | undefined;
          if (status) {
            console.log(`    Status: ${status}${exitCode != null ? `  Exit: ${exitCode}` : ''}`);
          }
          const stdout = p.stdout as string | undefined;
          if (stdout) {
            for (const line of stdout.split('\n').slice(0, 5)) {
              console.log(`    ${line}`);
            }
          }
          const stderr = p.stderr as string | undefined;
          if (stderr) {
            console.log(`    stderr: ${stderr.split('\n')[0] ?? ''}`);
          }
        }
        console.log();
        continue;
      }
      // Single-message job: render normally
      ungrouped.push(...jobMsgs);
    }

    // Render ungrouped messages normally
    for (const message of ungrouped) {
      const unread = !message.readAt ? '●' : ' ';
      const from = shortDid(message.envelope.from);
      const age = formatAge(getMessageSortTimestamp(message));
      const id = message.envelope.id.slice(-8);
      const protocol = message.envelope.protocol ?? '';
      const replyTag = message.envelope.replyTo ? `  ↩ ${message.envelope.replyTo.slice(-8)}` : '';
      const statusTag = message.trustStatus === 'unknown' ? ' [?未知来源]' :
        message.trustStatus === 'suspicious' ? ' [!可疑]' : '';

      // Special rendering for E2E decrypt failures
      if (protocol === 'e2e/decrypt-failed') {
        console.log(`${unread} [${id}] ⚠ E2E decrypt failed (session cleared, will auto-recover)`);
        console.log(`    From: ${message.envelope.from}`);
        const payload = message.envelope.payload as Record<string, unknown> | undefined;
        if (payload?.error) {
          console.log(`    Error: ${payload.error}`);
        }
        continue;
      }

      console.log(`${unread} [${id}] ${from}${statusTag}  ${age}  ${protocol}${replyTag}`);
      const preview = payloadPreview(message.envelope.payload);
      if (preview) {
        console.log(`    ${preview}`);
      }
    }
    console.log();
    return;
  }

  llmSection('Inbox');
  llmKeyValue('Total', visibleMessages.length.toString());
  llmKeyValue('Unread', unreadCount.toString());
  llmKeyValue('Showing', visibleMessages.length.toString());
  console.log();

  if (visibleMessages.length === 0) {
    console.log('No messages.');
    return;
  }

  const rows = visibleMessages.map((message) => [
    message.envelope.id.slice(-8),
    message.envelope.type,
    message.envelope.from,
    message.envelope.protocol ?? '',
    message.envelope.replyTo ?? '',
    formatAge(getMessageSortTimestamp(message)),
    payloadPreview(message.envelope.payload, 50),
  ]);

  llmTable(['ID', 'Type', 'From', 'Protocol', 'ReplyTo', 'Age', 'Preview'], rows);

  console.log();
  llmSection('Filters');
  llmKeyValue('Unread', options.unread ? 'true' : 'false');
  llmKeyValue('From', options.from || '(none)');
  llmKeyValue('Protocol', options.protocol || '(none)');
  llmKeyValue('Thread', options.thread || '(none)');
  llmKeyValue('ReplyTo', options.replyTo || '(none)');
  console.log();
}

function renderMessageDetail(message: StoredMessage): void {
  console.log('\n' + '─'.repeat(60));
  console.log(`ID:        ${message.envelope.id}`);
  console.log(`From:      ${message.envelope.from}`);
  console.log(`To:        ${message.envelope.to}`);
  console.log(`Protocol:  ${message.envelope.protocol}`);
  console.log(`Type:      ${message.envelope.type}`);
  if (message.envelope.replyTo) {
    console.log(`Reply To:  ${message.envelope.replyTo}`);
  }
  if (message.envelope.threadId) {
    console.log(`Thread:    ${message.envelope.threadId}`);
  }
  console.log(`Message Time: ${new Date(message.envelope.timestamp).toLocaleString()}`);
  if (message.receivedAt != null) {
    console.log(`Received:  ${new Date(message.receivedAt).toLocaleString()}`);
  }
  if (message.sentAt != null) {
    console.log(`Sent:      ${new Date(message.sentAt).toLocaleString()}`);
  }
  if (message.trustScore != null) {
    console.log(`Trust:     ${(message.trustScore * 100).toFixed(0)}%`);
  }
  console.log('─'.repeat(60));
  console.log(JSON.stringify(message.envelope.payload, null, 2));
  console.log();
}

export function createInboxCommand(): Command {
  const inbox = new Command('inbox')
    .description('Manage your message inbox')
    .option('--unread', 'Show only unread messages')
    .option('--from <did>', 'Filter by sender DID')
    .option('--protocol <protocol>', 'Filter by protocol')
    .option('--thread <id>', 'Filter by conversation thread')
    .option('--reply-to <id>', 'Filter by reply target message ID')
    .option('--include-system', 'Include internal system/diagnostic messages')
    .option('--wait [seconds]', 'Wait for the first matching message (default: 30s)')
    .option('--limit <n>', 'Max messages to show', '50')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .option('--human', 'Human-friendly output with colors')
    .action(async (options) => {
      try {
        if (options.json) options.format = 'json';
        const filter: MessageFilter = {};
        if (options.unread) filter.unreadOnly = true;
        if (options.from) filter.fromDid = options.from;
        if (options.protocol) filter.protocol = options.protocol;
        if (options.thread) filter.threadId = options.thread;
        if (options.replyTo) {
          const replyTo = await resolveQueuedMessageId(options.replyTo);
          if (!replyTo) {
            throw new Error(`Message not found: ${options.replyTo}`);
          }
          filter.replyTo = replyTo;
        }

        const waitTimeoutMs = parseWaitTimeoutMs(options.wait);
        if (waitTimeoutMs !== undefined) {
          const message = await waitForInboxMessage(filter, waitTimeoutMs);
          if (!message) {
            console.error(`Error: no matching message within ${waitTimeoutMs / 1000}s`);
            process.exit(1);
          }

          if (options.format === 'json') {
            console.log(JSON.stringify(serializeMessage(message), null, 2));
          } else {
            renderMessageDetail(message);
          }
          return;
        }

        const page = await listInboxMessages(filter, {
          limit: parseInt(options.limit, 10),
        });

        if (options.format === 'json') {
          console.log(JSON.stringify(serializeMessagePage(page, Boolean(options.includeSystem)), null, 2));
          return;
        }

        renderMessageList(page, {
          human: Boolean(options.human),
          unread: Boolean(options.unread),
          from: options.from,
          protocol: options.protocol,
          thread: options.thread,
          replyTo: filter.replyTo as string | undefined,
          includeSystem: Boolean(options.includeSystem),
        });
      } catch (error) {
        logger.error('Inbox list failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  inbox
    .command('read <id>')
    .description('Show full message')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .action(async (id: string, options) => {
      try {
        if (options.json) options.format = 'json';
        const message = await resolveInboxMessage(id);
        if (!message) {
          console.error(`Message not found: ${id}`);
          process.exit(1);
        }

        if (options.format === 'json') {
          console.log(JSON.stringify(serializeMessage(message), null, 2));
        } else {
          renderMessageDetail(message);
        }

        await markInboxMessageRead(message.envelope.id);
      } catch (error) {
        logger.error('Read message failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  inbox
    .command('reply <id> [message]')
    .description('Reply to a message')
    .option('-m, --message <text>', 'Reply text')
    .option('--payload <json>', 'Reply payload (JSON)')
    .option('--file <path>', 'Attach a file to the reply')
    .option('--protocol <protocol>', 'Protocol to use (defaults to original message protocol)')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--json', 'Output as JSON (alias for --format json)')
    .action(async (id: string, message: string | undefined, options) => {
      try {
        if (options.json) options.format = 'json';
        const original = await resolveInboxMessage(id);
        if (!original) {
          console.error(`Message not found: ${id}`);
          process.exit(1);
        }

        const payload = await buildMessagePayload({
          message: message ?? options.message,
          payload: options.payload,
          file: options.file,
        });
        const result = await dispatchMessage({
          to: original.envelope.from,
          protocol: options.protocol ?? original.envelope.protocol,
          payload,
          type: 'reply',
          replyTo: original.envelope.id,
          threadId: original.envelope.threadId,
        });

        if (options.format === 'json') {
          console.log(JSON.stringify({
            id: result.id,
            to: original.envelope.from,
            protocol: options.protocol ?? original.envelope.protocol,
            replyTo: original.envelope.id,
            threadId: original.envelope.threadId ?? null,
            payload: redactPayloadForDisplay(payload),
            usedDaemon: result.usedDaemon,
          }, null, 2));
          return;
        }

        console.log(`Reply sent (${result.id.slice(-8)})`);
        if (original.envelope.threadId) {
          console.log(`Thread: ${original.envelope.threadId}`);
        }
      } catch (error) {
        logger.error('Reply failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  inbox
    .command('delete <id>')
    .description('Delete a message')
    .action(async (id: string) => {
      try {
        const message = await resolveInboxMessage(id);
        if (!message) {
          console.error(`Message not found: ${id}`);
          process.exit(1);
        }

        await deleteInboxMessage(message.envelope.id);
        console.log(`Deleted message ${id}`);
      } catch (error) {
        logger.error('Delete failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  return inbox;
}
