import { Command } from 'commander';
import Table from 'cli-table3';
import { validateAliasName } from '@quadra-a/protocol';
import { setAlias } from '../config.js';
import {
  queryAgentCard,
  searchAgents,
  type DiscoveryAgent,
  type DiscoveryCapability,
} from '../services/agent-runtime.js';
import { error, info, llmKeyValue, llmSection, llmTable, printHeader, success } from '../ui.js';

interface FindCommandOptions {
  name?: string;
  hidden?: boolean;
  description?: string;
}

function capabilityNames(agent: DiscoveryAgent): string {
  return Array.isArray(agent.capabilities)
    ? agent.capabilities.map((capability: DiscoveryCapability) => (
      typeof capability === 'string'
        ? capability
        : capability.name ?? capability.id ?? ''
    )).filter(Boolean).join(', ')
    : '';
}

function renderAgentCard(agent: DiscoveryAgent, isHuman: boolean): void {
  if (isHuman) {
    console.log();
    info(`DID:          ${agent.did}`);
    info(`Name:         ${agent.name ?? '(unnamed)'}`);
    info(`Description:  ${agent.description ?? ''}`);
    info(`Capabilities: ${capabilityNames(agent) || '(none)'}`);
    info(`Timestamp:    ${new Date(agent.timestamp).toISOString()}`);
    return;
  }

  llmSection('Agent Details');
  llmKeyValue('DID', agent.did);
  llmKeyValue('Name', agent.name ?? '(unnamed)');
  llmKeyValue('Description', agent.description ?? '');
  llmKeyValue('Capabilities', capabilityNames(agent) || '(none)');
  llmKeyValue('Timestamp', new Date(agent.timestamp).toISOString());
  console.log();
}

function renderAgentResults(cards: DiscoveryAgent[], isHuman: boolean): void {
  if (cards.length === 0) {
    console.log(isHuman ? 'No agents found.' : 'NO_RESULTS');
    return;
  }

  if (isHuman) {
    const table = new Table({
      head: ['DID', 'Name', 'Capabilities', 'Trust'],
      colWidths: [40, 20, 36, 10],
    });

    for (const card of cards) {
      const trust = card.trust ? `${(card.trust.interactionScore * 100).toFixed(0)}%` : 'N/A';
      table.push([
        card.did.length > 38 ? `${card.did.slice(0, 35)}...` : card.did,
        card.name ?? '(unnamed)',
        capabilityNames(card),
        trust,
      ]);
    }

    console.log();
    console.log(table.toString());
    return;
  }

  const rows = cards.map((card) => [
    card.did,
    card.name ?? '(unnamed)',
    capabilityNames(card),
    card.trust ? `${(card.trust.interactionScore * 100).toFixed(0)}%` : 'N/A',
  ]);

  llmSection('Discovery Results');
  llmTable(['DID', 'Name', 'Capabilities', 'Trust'], rows);
  console.log();
}

export function createFindCommand(config: FindCommandOptions = {}): Command {
  const command = new Command(config.name ?? 'find')
    .description(config.description ?? 'Find published agents by capability or query')
    .argument('[capability]', 'Capability prefix to search for')
    .option('--capability <capability>', 'Compatibility alias for the capability positional argument')
    .option('--did <did>', 'Query a specific DID')
    .option('--query <text>', 'Natural language query')
    .option('--min-trust <score>', 'Minimum trust score (0-1)')
    .option('--language <lang>', 'Language filter')
    .option('--limit <number>', 'Maximum number of results', '10')
    .option('--all', 'List published agents without additional filtering')
    .option('--online', 'Only show currently online agents when the field is available')
    .option('--relay <url>', 'Relay WebSocket URL')
    .option('--human', 'Human-friendly output with colors')
    .option('--alias <name>', 'Auto-alias the top result with this name')
    .action(async (capabilityArg: string | undefined, options) => {
      try {
        const isHuman = Boolean(options.human);
        const capability = capabilityArg ?? options.capability;
        const limit = parseInt(options.limit, 10);

        if (isHuman) {
          printHeader(config.name === 'discover' ? 'Discover Agents' : 'Find Agents');
        }

        if (options.did) {
          const agent = await queryAgentCard(options.did, options.relay);
          if (!agent) {
            console.log('Agent not found.');
            return;
          }

          renderAgentCard(agent, isHuman);
          return;
        }

        const filters: Record<string, unknown> = {};
        if (options.minTrust) {
          filters.minTrustScore = parseFloat(options.minTrust);
        }
        if (options.language) {
          filters.language = options.language;
        }

        const cards = await searchAgents(
          options.all
            ? { limit }
            : {
                text: options.query,
                capability,
                filters: Object.keys(filters).length > 0 ? filters : undefined,
                limit,
              },
          options.relay,
        );

        const filteredCards = options.online
          ? cards.filter((card) => card.online !== false)
          : cards;

        renderAgentResults(filteredCards, isHuman);

        if (options.alias && filteredCards.length > 0) {
          const validation = validateAliasName(options.alias);
          if (!validation.valid) {
            error(`Invalid alias name: ${validation.error}`);
            process.exit(1);
          }

          setAlias(options.alias, filteredCards[0].did);
          success(`Aliased top result as "${options.alias}"`);
        }
      } catch (err) {
        error(`Failed to ${config.name === 'discover' ? 'discover' : 'find'} agents: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  if (config.hidden) {
    command.configureHelp({ visibleCommands: () => [] });
  }

  return command;
}

export function registerFindCommand(program: Command): void {
  program.addCommand(createFindCommand());
}
