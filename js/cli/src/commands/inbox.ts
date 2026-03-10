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

function renderMessageList(page: MessagePage, options: {
  human?: boolean;
  unread?: boolean;
  from?: string;
  protocol?: string;
  thread?: string;
  replyTo?: string;
}): void {
  const unreadCount = page.messages.filter((message) => !message.readAt).length;

  if (options.human) {
    console.log(`\nInbox (${page.total} total, ${unreadCount} unread)\n`);

    if (page.messages.length === 0) {
      console.log('  No messages.');
      return;
    }

    for (const message of page.messages) {
      const unread = !message.readAt ? '●' : ' ';
      const from = shortDid(message.envelope.from);
      const age = formatAge(message.receivedAt ?? message.envelope.timestamp);
      const id = message.envelope.id.slice(-8);
      const protocol = message.envelope.protocol ?? '';
      const replyTag = message.envelope.replyTo ? `  ↩ ${message.envelope.replyTo.slice(-8)}` : '';
      const statusTag = message.trustStatus === 'unknown' ? ' [?未知来源]' :
        message.trustStatus === 'suspicious' ? ' [!可疑]' : '';

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
  llmKeyValue('Total', page.total.toString());
  llmKeyValue('Unread', unreadCount.toString());
  llmKeyValue('Showing', page.messages.length.toString());
  console.log();

  if (page.messages.length === 0) {
    console.log('No messages.');
    return;
  }

  const rows = page.messages.map((message) => [
    message.envelope.id.slice(-8),
    message.envelope.type,
    message.envelope.from,
    message.envelope.protocol ?? '',
    message.envelope.replyTo ?? '',
    formatAge(message.receivedAt ?? message.envelope.timestamp),
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
  console.log(`Received:  ${new Date(message.receivedAt ?? message.envelope.timestamp).toLocaleString()}`);
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
    .option('--wait [seconds]', 'Wait for the first matching message (default: 30s)')
    .option('--limit <n>', 'Max messages to show', '50')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--human', 'Human-friendly output with colors')
    .action(async (options) => {
      try {
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
            console.log(JSON.stringify(message, null, 2));
          } else {
            renderMessageDetail(message);
          }
          return;
        }

        const page = await listInboxMessages(filter, {
          limit: parseInt(options.limit, 10),
        });

        if (options.format === 'json') {
          console.log(JSON.stringify(page, null, 2));
          return;
        }

        renderMessageList(page, {
          human: Boolean(options.human),
          unread: Boolean(options.unread),
          from: options.from,
          protocol: options.protocol,
          thread: options.thread,
          replyTo: filter.replyTo as string | undefined,
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
    .action(async (id: string, options) => {
      try {
        const message = await resolveInboxMessage(id);
        if (!message) {
          console.error(`Message not found: ${id}`);
          process.exit(1);
        }

        if (options.format === 'json') {
          console.log(JSON.stringify(message, null, 2));
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
    .action(async (id: string, message: string | undefined, options) => {
      try {
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
