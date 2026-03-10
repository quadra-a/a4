import { Command } from 'commander';
import { resolveTargetDid } from '../services/messaging.js';
import { queryNetworkEndorsements } from '../services/trust.js';
import { error, info, printHeader } from '../ui.js';

export function registerEndorsementsCommand(program: Command): void {
  program
    .command('endorsements <target>')
    .description('Query network endorsements for an agent')
    .option('--domain <domain>', 'Filter by capability domain')
    .option('--relay <url>', 'Relay URL')
    .option('--format <fmt>', 'Output format: text|json', 'text')
    .action(async (target: string, options) => {
      try {
        const resolved = await resolveTargetDid(target, options.relay);
        const result = await queryNetworkEndorsements(resolved.did, {
          relay: options.relay,
          domain: options.domain,
        });

        if (options.format === 'json') {
          console.log(JSON.stringify({
            target,
            resolvedDid: resolved.did,
            matchedBy: resolved.matchedBy,
            result,
          }, null, 2));
          return;
        }

        printHeader('Network Endorsements');
        info(`Target: ${resolved.did}`);
        info(`Endorsement Count: ${result.endorsementCount}`);

        if (result.endorsements.length === 0) {
          console.log('No endorsements found.');
          return;
        }

        console.log();
        for (const endorsement of result.endorsements) {
          console.log(`- ${endorsement.from}`);
          console.log(`  Score: ${(endorsement.score * 100).toFixed(0)}%`);
          console.log(`  Reason: ${endorsement.reason}`);
          if (endorsement.domain) {
            console.log(`  Domain: ${endorsement.domain}`);
          }
          console.log(`  Date: ${new Date(endorsement.timestamp).toISOString()}`);
        }
      } catch (err) {
        error(`Failed to query endorsements: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
