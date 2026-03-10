/**
 * Sessions Command - CVP-0014 Part 2
 *
 * quadra-a sessions list              - List all conversation threads
 * quadra-a sessions show <threadId>   - Show messages in a thread
 */

import { Command } from 'commander';
import { DaemonClient } from '../daemon/client.js';
import { createLogger } from '@quadra-a/protocol';
import { llmSection, llmKeyValue, llmTable } from '../ui.js';
import { getAliases } from '../config.js';
import { reverseAlias } from '@quadra-a/protocol';

const logger = createLogger('cli:sessions');

function formatAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function shortThreadId(threadId: string): string {
  // thread_1709424000000_k8f3m2p9x -> thread_...k8f3m2p9x
  const parts = threadId.split('_');
  if (parts.length === 3) return `thread_...${parts[2]}`;
  return threadId.slice(0, 20) + '...';
}

export function createSessionsCommand(): Command {
  const sessions = new Command('sessions')
    .description('Manage conversation threads (CVP-0014)');

  // quadra-a sessions list
  sessions
    .command('list')
    .description('List all conversation threads')
    .option('--with <did-or-alias>', 'Filter by peer DID or alias')
    .option('--limit <n>', 'Max sessions to show', '50')
    .option('--archived', 'Show only archived sessions')
    .option('--include-archived', 'Include archived sessions in results')
    .option('--search <query>', 'Search sessions by title or content')
    .option('--human', 'Human-friendly output with colors')
    .action(async (options) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      try {
        const aliases = getAliases();
        let peerDid: string | undefined;

        // Resolve alias if provided
        if (options.with) {
          if (options.with.startsWith('did:')) {
            peerDid = options.with;
          } else {
            peerDid = aliases[options.with];
            if (!peerDid) {
              console.error(`Unknown alias: ${options.with}`);
              process.exit(1);
            }
          }
        }

        let result;
        if (options.search) {
          // Search sessions
          result = await client.send('search_sessions', {
            query: options.search,
            limit: parseInt(options.limit, 10),
          });
        } else {
          // List sessions
          result = await client.send('sessions', {
            peerDid,
            limit: parseInt(options.limit, 10),
            archived: options.archived,
            includeArchived: options.includeArchived,
          });
        }

        const isHuman = options.human;

        if (isHuman) {
          console.log(`\nSessions (${result.total} total)\n`);

          if (result.sessions.length === 0) {
            console.log('  No sessions.');
            return;
          }

          for (const session of result.sessions) {
            const threadId = shortThreadId(session.threadId);
            const peer = reverseAlias(session.peerDid, aliases) || session.peerDid.slice(10, 24) + '…';
            const age = formatAge(session.lastMessageAt);
            const title = session.title || '(no title)';

            console.log(`  ${threadId}  ${peer}  ${session.messageCount} msgs  ${age}`);
            console.log(`    ${title}`);
          }
          console.log();
        } else {
          // LLM-friendly format
          llmSection('SESSIONS');
          llmKeyValue('Total', result.total.toString());
          console.log();

          if (result.sessions.length === 0) {
            console.log('No sessions.');
            return;
          }

          const rows = result.sessions.map((session: { peerDid: string; lastMessageAt: number; messageCount: number; threadId?: string }) => {
            const peer = reverseAlias(session.peerDid, aliases) || session.peerDid;
            const age = formatAge(session.lastMessageAt);
            const title = session.title || '(no title)';

            return [
              session.threadId,
              peer,
              session.messageCount.toString(),
              age,
              title,
            ];
          });

          llmTable(['Thread ID', 'Peer', 'Messages', 'Last Activity', 'Title'], rows);
          console.log();
        }
      } catch (error) {
        logger.error('Sessions list failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  // quadra-a sessions show <threadId>
  sessions
    .command('show <threadId>')
    .description('Show messages in a conversation thread')
    .option('--limit <n>', 'Max messages to show', '50')
    .option('--human', 'Human-friendly output with colors')
    .action(async (threadId: string, options) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      try {
        const result = await client.send('session_messages', {
          threadId,
          limit: parseInt(options.limit, 10),
        });

        if (result.messages.length === 0) {
          console.log('No messages in this thread.');
          return;
        }

        const isHuman = options.human;
        const aliases = getAliases();

        // Get session metadata
        const sessionResult = await client.send('sessions', { limit: 1000 });
        const session = sessionResult.sessions.find((s: { threadId?: string }) => s.threadId === threadId);

        if (isHuman) {
          console.log('\n' + '─'.repeat(60));
          console.log(`Thread: ${threadId}`);
          if (session) {
            const peer = reverseAlias(session.peerDid, aliases) || session.peerDid;
            console.log(`Peer: ${peer}`);
            console.log(`Started: ${new Date(session.startedAt).toLocaleString()}`);
            console.log(`Messages: ${session.messageCount}`);
          }
          console.log('─'.repeat(60));
          console.log();

          for (const msg of result.messages) {
            const timestamp = new Date(msg.receivedAt ?? msg.sentAt ?? msg.envelope.timestamp).toLocaleString();
            const from = msg.direction === 'outbound' ? 'you' : reverseAlias(msg.envelope.from, aliases) || msg.envelope.from.slice(10, 24) + '…';
            const text = typeof msg.envelope.payload === 'object' && msg.envelope.payload !== null
              ? (msg.envelope.payload as Record<string, unknown>).text ?? (msg.envelope.payload as Record<string, unknown>).message ?? JSON.stringify(msg.envelope.payload)
              : String(msg.envelope.payload ?? '');

            console.log(`[${timestamp}] ${from}`);
            console.log(text);
            console.log();
          }
        } else {
          // LLM-friendly format
          llmSection('SESSION DETAILS');
          llmKeyValue('Thread ID', threadId);
          if (session) {
            const peer = reverseAlias(session.peerDid, aliases) || session.peerDid;
            llmKeyValue('Peer', peer);
            llmKeyValue('Peer DID', session.peerDid);
            llmKeyValue('Started', new Date(session.startedAt).toISOString());
            llmKeyValue('Last Activity', new Date(session.lastMessageAt).toISOString());
            llmKeyValue('Messages', session.messageCount.toString());
          }
          console.log();

          llmSection('MESSAGES');
          for (const msg of result.messages) {
            const timestamp = new Date(msg.receivedAt ?? msg.sentAt ?? msg.envelope.timestamp).toISOString();
            const from = msg.direction === 'outbound' ? 'you' : reverseAlias(msg.envelope.from, aliases) || msg.envelope.from;
            const text = typeof msg.envelope.payload === 'object' && msg.envelope.payload !== null
              ? (msg.envelope.payload as Record<string, unknown>).text ?? (msg.envelope.payload as Record<string, unknown>).message ?? JSON.stringify(msg.envelope.payload)
              : String(msg.envelope.payload ?? '');

            console.log(`[${timestamp}] ${from}`);
            console.log(text);
            console.log();
          }
        }
      } catch (error) {
        logger.error('Session show failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  // quadra-a sessions archive <threadId>
  sessions
    .command('archive <threadId>')
    .description('Archive a conversation thread')
    .action(async (threadId: string) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      try {
        await client.send('archive_session', { threadId });
        console.log('SESSION ARCHIVED\n');
        console.log(`Thread ID: ${threadId}`);
        console.log();
      } catch (error) {
        logger.error('Archive session failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  // quadra-a sessions unarchive <threadId>
  sessions
    .command('unarchive <threadId>')
    .description('Unarchive a conversation thread')
    .action(async (threadId: string) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      try {
        await client.send('unarchive_session', { threadId });
        console.log('SESSION UNARCHIVED\n');
        console.log(`Thread ID: ${threadId}`);
        console.log();
      } catch (error) {
        logger.error('Unarchive session failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  // quadra-a sessions export <threadId>
  sessions
    .command('export <threadId>')
    .description('Export a conversation thread')
    .option('--format <fmt>', 'Export format: text|markdown|json', 'text')
    .option('--output <file>', 'Output file path (default: stdout)')
    .action(async (threadId: string, options) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      try {
        const result = await client.send('export_session', {
          threadId,
          format: options.format,
        });

        const content = result.data.content;

        if (options.output) {
          // Write to file
          const fs = await import('fs/promises');
          await fs.writeFile(options.output, content, 'utf-8');
          console.log(`SESSION EXPORTED\n`);
          console.log(`Thread ID: ${threadId}`);
          console.log(`Format: ${options.format}`);
          console.log(`Output: ${options.output}`);
          console.log();
        } else {
          // Write to stdout
          console.log(content);
        }
      } catch (error) {
        logger.error('Export session failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  // quadra-a sessions stats <threadId>
  sessions
    .command('stats <threadId>')
    .description('Show statistics for a conversation thread')
    .option('--human', 'Human-friendly output with colors')
    .action(async (threadId: string, options) => {
      const client = new DaemonClient();
      if (!(await client.isDaemonRunning())) {
        console.error('Daemon not running. Start with: agent listen --background');
        process.exit(1);
      }

      try {
        const result = await client.send('session_stats', { threadId });
        const stats = result.data;

        const isHuman = options.human;

        if (isHuman) {
          console.log('\n' + '─'.repeat(60));
          console.log(`Thread Statistics: ${threadId}`);
          console.log('─'.repeat(60));
          console.log();
          console.log(`Peer: ${stats.peerDid}`);
          console.log(`Total Messages: ${stats.messageCount}`);
          console.log(`  Inbound: ${stats.inboundCount}`);
          console.log(`  Outbound: ${stats.outboundCount}`);
          console.log();
          console.log(`Duration: ${formatDuration(stats.duration)}`);
          console.log(`Average Response Time: ${formatDuration(stats.avgResponseTime)}`);
          console.log();
          console.log(`Started: ${new Date(stats.startedAt).toLocaleString()}`);
          console.log(`Last Activity: ${new Date(stats.lastMessageAt).toLocaleString()}`);
          console.log();
        } else {
          console.log('THREAD STATISTICS\n');
          console.log(`Thread ID: ${threadId}`);
          console.log(`Peer: ${stats.peerDid}`);
          console.log(`Total Messages: ${stats.messageCount}`);
          console.log(`Inbound Messages: ${stats.inboundCount}`);
          console.log(`Outbound Messages: ${stats.outboundCount}`);
          console.log(`Duration: ${stats.duration}ms`);
          console.log(`Average Response Time: ${stats.avgResponseTime}ms`);
          console.log(`Started: ${new Date(stats.startedAt).toISOString()}`);
          console.log(`Last Activity: ${new Date(stats.lastMessageAt).toISOString()}`);
          console.log();
        }
      } catch (error) {
        logger.error('Session stats failed', error);
        console.error('Error:', (error as Error).message);
        process.exit(1);
      }
    });

  return sessions;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`;
  return `${(ms / 86400000).toFixed(1)}d`;
}
