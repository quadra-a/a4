import { Command } from 'commander';
import { buildMessageTrace } from '@quadra-a/runtime';
import { error, info, llmKeyValue, llmSection, printHeader, printKeyValue, printSection, warn } from '../ui.js';

export function registerTraceCommand(program: Command): void {
  program
    .command('trace <messageId>')
    .description('Trace one message through local queue and result lifecycle')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .option('--human', 'Human-friendly output with colors')
    .action(async (messageId: string, options) => {
      try {
        const trace = await buildMessageTrace(messageId);

        if (options.format === 'json') {
          console.log(JSON.stringify(trace, null, 2));
          return;
        }

        const isHuman = Boolean(options.human);

        if (isHuman) {
          printHeader('Message Trace');
          printKeyValue('Requested ID', trace.requestedId);
          printKeyValue('Message ID', trace.messageId ?? '(unresolved)');
          printKeyValue('State', trace.summary.state);
          printKeyValue('Dispatch Path', trace.summary.dispatchPath);
          printKeyValue('Local Queue', trace.summary.localQueueState);
          printKeyValue('Reply State', trace.summary.replyState);
          printKeyValue('Result State', trace.summary.resultState);
          if (trace.summary.resultStatus) {
            printKeyValue('Result Status', trace.summary.resultStatus);
          }
          if (trace.summary.jobId) {
            printKeyValue('Job ID', trace.summary.jobId);
          }
          if (trace.summary.targetDid) {
            printKeyValue('Target', trace.summary.targetDid);
          }
          if (trace.summary.threadId) {
            printKeyValue('Thread', trace.summary.threadId);
          }
          if (trace.summary.protocol) {
            printKeyValue('Protocol', trace.summary.protocol);
          }

          printSection('Lifecycle');
          for (const stage of trace.stages) {
            const prefix = stage.state === 'done'
              ? '✓'
              : stage.state === 'warning'
                ? '⚠'
                : stage.state === 'active'
                  ? '…'
                  : '·';
            console.log(`${prefix} ${stage.label}: ${stage.detail}`);
            if (stage.at) {
              console.log(`  at: ${stage.at}`);
            }
          }

          if (trace.summary.notes.length > 0) {
            printSection('Notes');
            for (const note of trace.summary.notes) {
              warn(note);
            }
          }

          return;
        }

        llmSection('Message Trace');
        llmKeyValue('Requested ID', trace.requestedId);
        llmKeyValue('Message ID', trace.messageId ?? '(unresolved)');
        llmKeyValue('State', trace.summary.state);
        llmKeyValue('Dispatch Path', trace.summary.dispatchPath);
        llmKeyValue('Local Queue', trace.summary.localQueueState);
        llmKeyValue('Reply State', trace.summary.replyState);
        llmKeyValue('Result State', trace.summary.resultState);
        if (trace.summary.resultStatus) {
          llmKeyValue('Result Status', trace.summary.resultStatus);
        }
        if (trace.summary.jobId) {
          llmKeyValue('Job ID', trace.summary.jobId);
        }
        if (trace.summary.targetDid) {
          llmKeyValue('Target', trace.summary.targetDid);
        }
        if (trace.summary.threadId) {
          llmKeyValue('Thread', trace.summary.threadId);
        }
        if (trace.summary.protocol) {
          llmKeyValue('Protocol', trace.summary.protocol);
        }
        console.log();
        for (const stage of trace.stages) {
          llmKeyValue(`Stage ${stage.label}`, `${stage.state} — ${stage.detail}${stage.at ? ` @ ${stage.at}` : ''}`);
        }
        for (const note of trace.summary.notes) {
          info(note);
        }
      } catch (err) {
        error(`Failed to trace message: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
