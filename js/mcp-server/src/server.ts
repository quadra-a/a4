import {
  buildMessageTrace,
  DaemonClient,
  DaemonSubscriptionClient,
  dispatchMessage,
  ensureBackgroundListener,
  getAgentCard,
  getDaemonReachabilityPolicy,
  getDaemonReachabilityStatus,
  getDaemonStatus,
  getIdentity,
  getRelayInviteToken,
  hasIdentity,
  resetDaemonReachabilityPolicy,
  resolveTargetDid,
  setDaemonReachabilityPolicy,
  waitForMessageOutcome,
} from '@quadra-a/runtime';
import type { DaemonSubscriptionEvent } from '@quadra-a/runtime';
import type { JsonRpcId, JsonRpcRequest } from './protocol.js';
import { StdioJsonRpcServer } from './protocol.js';

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SERVER_VERSION = '0.0.1';
const INBOX_RESOURCE_URI = 'quadra-a://inbox';

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
  additionalProperties: boolean = false,
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
  };
}

/**
 * MCP server surface for quadra-a local discovery, messaging, inbox, and status workflows.
 */
export class QuadraAMcpServer {
  private readonly transport: StdioJsonRpcServer;
  private readonly daemonClient = new DaemonClient();
  private readonly subscribedResources = new Set<string>();
  private readonly resources: ResourceDefinition[] = [
    {
      uri: 'quadra-a://status',
      name: 'quadra-a Status',
      description: 'Local daemon status, relays, and identity',
      mimeType: 'application/json',
    },
    {
      uri: INBOX_RESOURCE_URI,
      name: 'quadra-a Inbox',
      description: 'Latest inbox snapshot for the local agent',
      mimeType: 'application/json',
    },
    {
      uri: 'quadra-a://peers',
      name: 'quadra-a Peers',
      description: 'Current peer snapshot from discovery',
      mimeType: 'application/json',
    },
  ];

  private readonly tools = new Map<string, McpTool>();
  private initializationComplete = false;
  private protocolVersion = DEFAULT_PROTOCOL_VERSION;
  private daemonStartupPromise: Promise<void> | null = null;
  private inboxSubscriptionClient: DaemonSubscriptionClient | null = null;

  constructor() {
    this.transport = new StdioJsonRpcServer(async (message) => {
      await this.handleMessage(message);
    });

    this.registerTools();
  }

  start(): void {
    this.transport.start();

    process.stdin.on('end', () => {
      void this.dispose();
    });

    process.on('SIGINT', () => {
      void this.dispose().finally(() => process.exit(0));
    });

    process.on('SIGTERM', () => {
      void this.dispose().finally(() => process.exit(0));
    });
  }

  private registerTools(): void {
    const jsonValueSchema = { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] };

    // ─── Primary Semantic Tools (CVP-0019 Aligned) ───────────────────────────

    this.addTool('listen_agent', 'Create or update local agent identity and ensure the background listener is running', objectSchema({
      relay: { type: 'string', description: 'Relay URL to connect to' },
      token: { type: 'string', description: 'Invite token for private relays' },
      discoverable: { type: 'boolean', default: false, description: 'Make the agent discoverable on the relay' },
      name: { type: 'string', description: 'Agent name (required with discoverable=true)' },
      description: { type: 'string', description: 'Agent description (required with discoverable=true)' },
      capabilities: { type: ['array', 'string'], description: 'Capability IDs as an array or comma-separated string' },
    }), async (args) => this.handleListenAgent(args));

    this.addTool('find_agents', 'Find agents by capability or query (semantic discovery)', objectSchema({
      capability: { type: 'string', description: 'Capability filter (e.g. "translate/japanese")' },
      query: { type: 'string', description: 'Natural language query' },
      minTrust: { type: 'number', description: 'Minimum trust score filter' },
      limit: { type: 'number', default: 10, description: 'Maximum results to return' },
      relay: { type: 'string', description: 'Relay URL override for this listener session' },
      token: { type: 'string', description: 'Invite token for private relay access' },
    }), async (args) => this.handleFindAgents(args));

    this.addTool('tell_agent', 'Tell an agent something (async-first messaging)', objectSchema({
      target: { type: 'string', description: 'Agent DID, alias, or search text' },
      message: { type: 'string', description: 'Message text' },
      payload: jsonValueSchema,
      protocol: { type: 'string', default: '/agent/msg/1.0.0', description: 'Message protocol' },
      threadId: { type: 'string', description: 'Continue existing conversation thread' },
      wait: { type: 'boolean', default: false, description: 'Wait for result lifecycle settlement' },
      waitTimeout: { type: 'number', default: 30, description: 'Wait timeout in seconds' },
      relay: { type: 'string', description: 'Relay URL override for this listener session' },
      token: { type: 'string', description: 'Invite token for private relay access' },
    }, ['target']), async (args) => this.handleTellAgent(args));

    this.addTool('trace_message', 'Trace one message through local queue and reply state', objectSchema({
      messageId: { type: 'string', description: 'Full message ID or local suffix' },
    }, ['messageId']), async (args) => this.handleTraceMessage(args));

    this.addTool('score_agent', 'Get local trust score for an agent', objectSchema({
      did: { type: 'string', description: 'Agent DID to check trust score for' },
    }, ['did']), async (args) => this.callDaemonTool('trust_score', args));

    this.addTool('vouch_for_agent', 'Create endorsement for an agent', objectSchema({
      did: { type: 'string', description: 'Agent DID to endorse' },
      score: { type: 'number', minimum: 0, maximum: 1, description: 'Trust score between 0 and 1' },
      reason: { type: 'string', description: 'Reason for endorsement' },
    }, ['did', 'score']), async (args) => this.callDaemonTool('create_endorsement', args));

    this.addTool('get_endorsements', 'Query network endorsements for an agent', objectSchema({
      did: { type: 'string', description: 'Agent DID to query endorsements for' },
      domain: { type: 'string', description: 'Filter by capability domain' },
      relay: { type: 'string', description: 'Specific relay to query' },
    }, ['did']), async (args) => this.callDaemonTool('query_endorsements', {
      did: args.did,
      options: { domain: args.domain, relay: args.relay }
    }));

    // ─── Legacy Tools (Deprecated) ────────────────────────────────────────────

    this.addTool('discover_agents', 'DEPRECATED: Use find_agents instead. Discover agents on the quadra-a network', objectSchema({
      query: { type: 'string' },
      capability: { type: 'string' },
      minTrust: { type: 'number' },
      limit: { type: 'number' },
      relay: { type: 'string', description: 'Relay URL override for this listener session' },
      token: { type: 'string', description: 'Invite token for private relay access' },
    }), async (args) => this.prependDeprecationNotice(
      await this.handleFindAgents(args),
      'DEPRECATED: discover_agents is deprecated. Use find_agents for semantic discovery.',
    ));

    this.addTool('list_peers', 'DEPRECATED: Use find_agents instead. List peer agents on the quadra-a network', objectSchema({
      query: { type: 'string' },
      capability: { type: 'string' },
      minTrust: { type: 'number' },
      limit: { type: 'number' },
      relay: { type: 'string', description: 'Relay URL override for this listener session' },
      token: { type: 'string', description: 'Invite token for private relay access' },
    }), async (args) => this.prependDeprecationNotice(
      await this.handleFindAgents(args),
      'DEPRECATED: list_peers is deprecated. Use find_agents for semantic discovery.',
    ));

    this.addTool('send_message', 'DEPRECATED: Use tell_agent instead. Send a quadra-a message', objectSchema({
      to: { type: 'string', description: 'Agent DID, alias, or search text' },
      protocol: { type: 'string' },
      payload: jsonValueSchema,
      message: { type: 'string' },
      type: { type: 'string', enum: ['message', 'reply'] },
      threadId: { type: 'string' },
      relay: { type: 'string', description: 'Relay URL override for this listener session' },
      token: { type: 'string', description: 'Invite token for private relay access' },
    }, ['to']), async (args) => this.prependDeprecationNotice(
      await this.handleTellAgent({
        target: args.to,
        message: args.message,
        payload: args.payload,
        protocol: args.protocol,
        type: args.type,
        threadId: args.threadId,
        relay: args.relay,
        token: args.token,
      }),
      'DEPRECATED: send_message is deprecated. Use tell_agent for async-first messaging (add wait=true for blocking behavior).',
    ));

    // ─── Administrative Tools ─────────────────────────────────────────────────

    // ─── Administrative Tools ─────────────────────────────────────────────────

    this.addTool('get_inbox', 'Read the local inbox', objectSchema({
      filter: { type: 'object' },
      pagination: { type: 'object' },
    }, [], true), async (args) => this.callDaemonTool('inbox', args));

    this.addTool('get_message', 'Read a single inbox message', objectSchema({
      id: { type: 'string' },
    }, ['id']), async (args) => this.callDaemonTool('get_message', args));

    this.addTool('mark_message_read', 'Mark a message as read', objectSchema({
      id: { type: 'string' },
    }, ['id']), async (args) => this.callDaemonTool('mark_read', args));

    this.addTool('delete_message', 'Delete a message from the local inbox', objectSchema({
      id: { type: 'string' },
    }, ['id']), async (args) => this.callDaemonTool('delete_message', args));

    this.addTool('get_outbox', 'Read the local outbox', objectSchema({
      pagination: { type: 'object' },
    }, [], true), async (args) => this.callDaemonTool('outbox', args));

    this.addTool('retry_message', 'Retry an outbound message', objectSchema({
      id: { type: 'string' },
    }, ['id']), async (args) => this.callDaemonTool('retry_message', args));

    this.addTool('get_status', 'Read daemon status, identity, card, and queue visibility', objectSchema({}), async () => this.handleGetStatus());
    this.addTool('get_reachability_policy', 'Read local reachability policy and runtime state', objectSchema({}), async () => this.handleGetReachabilityPolicy());
    this.addTool('get_reachability_status', 'Read reachability runtime status', objectSchema({}), async () => this.handleGetReachabilityStatus());
    this.addTool('set_reachability_mode', 'Set reachability mode to adaptive or fixed', objectSchema({
      mode: { type: 'string', enum: ['adaptive', 'fixed'] },
    }, ['mode']), async (args) => this.handleSetReachabilityPolicy(args));
    this.addTool('set_bootstrap_providers', 'Set comma-separated or array bootstrap providers', objectSchema({
      providers: { type: ['array', 'string'] },
    }, ['providers']), async (args) => this.handleSetReachabilityPolicy(args));
    this.addTool('set_target_provider_count', 'Set adaptive target provider count', objectSchema({
      count: { type: 'number', minimum: 1 },
    }, ['count']), async (args) => this.handleSetReachabilityPolicy(args));
    this.addTool('set_operator_lock', 'Enable or disable operator lock for reachability policy writes', objectSchema({
      enabled: { type: 'boolean' },
    }, ['enabled']), async (args) => this.handleSetReachabilityPolicy(args));
    this.addTool('reset_default_reachability_policy', 'Reset reachability policy back to defaults', objectSchema({}), async () => this.handleResetReachabilityPolicy());
    this.addTool('get_card', 'Read the local Agent Card configuration', objectSchema({}), async () => this.callDaemonTool('get_card', {}));

    this.addTool('publish_card', 'Update and publish the local Agent Card', objectSchema({
      name: { type: 'string' },
      description: { type: 'string' },
      capabilities: {
        type: 'array',
        items: { type: 'string' },
      },
    }), async (args) => this.callDaemonTool('publish_card', args));

    this.addTool('list_sessions', 'List conversation sessions', objectSchema({
      peerDid: { type: 'string' },
      limit: { type: 'number' },
      includeArchived: { type: 'boolean' },
    }), async (args) => this.callDaemonTool('sessions', args));

    this.addTool('get_session_messages', 'Read messages for a conversation session', objectSchema({
      threadId: { type: 'string' },
      limit: { type: 'number' },
      before: { type: 'string' },
    }, ['threadId']), async (args) => this.callDaemonTool('session_messages', args));

    this.addTool('search_sessions', 'Search saved conversation sessions', objectSchema({
      query: { type: 'string' },
      limit: { type: 'number' },
    }, ['query']), async (args) => this.callDaemonTool('search_sessions', args));

    this.addTool('archive_session', 'Archive a session', objectSchema({
      threadId: { type: 'string' },
    }, ['threadId']), async (args) => this.callDaemonTool('archive_session', args));

    this.addTool('unarchive_session', 'Unarchive a session', objectSchema({
      threadId: { type: 'string' },
    }, ['threadId']), async (args) => this.callDaemonTool('unarchive_session', args));

    this.addTool('export_session', 'Export a session to text, markdown, or JSON', objectSchema({
      threadId: { type: 'string' },
      format: { type: 'string', enum: ['text', 'markdown', 'json'] },
    }, ['threadId']), async (args) => this.callDaemonTool('export_session', args));

    this.addTool('get_session_stats', 'Read conversation session statistics', objectSchema({
      threadId: { type: 'string' },
    }, ['threadId']), async (args) => this.callDaemonTool('session_stats', args));

    this.addTool('block_agent', 'Block an agent DID', objectSchema({
      did: { type: 'string' },
      reason: { type: 'string' },
    }, ['did']), async (args) => this.callDaemonTool('block', args));

    this.addTool('unblock_agent', 'Remove an agent DID from the blocklist', objectSchema({
      did: { type: 'string' },
    }, ['did']), async (args) => this.callDaemonTool('unblock', args));

    this.addTool('manage_allowlist', 'Add, remove, or list allowlist entries', objectSchema({
      action: { type: 'string', enum: ['add', 'remove', 'list'] },
      did: { type: 'string' },
      note: { type: 'string' },
    }, ['action']), async (args) => this.callDaemonTool('allowlist', args));

    this.addTool('get_queue_stats', 'Read inbox/outbox queue statistics', objectSchema({}), async () => this.callDaemonTool('queue_stats', {}));
  }

  private addTool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ): void {
    this.tools.set(name, { name, description, inputSchema, handler });
  }

  private async handleMessage(message: JsonRpcRequest): Promise<void> {
    if (message.method === 'initialize') {
      this.handleInitialize(message.id ?? null, message.params as Record<string, unknown> | undefined);
      return;
    }

    if (message.method === 'notifications/initialized') {
      this.initializationComplete = true;
      return;
    }

    if (!this.initializationComplete && message.method !== 'ping') {
      this.transport.sendError(message.id ?? null, -32002, 'Server not initialized');
      return;
    }

    switch (message.method) {
      case 'ping':
        this.reply(message.id, {});
        return;
      case 'tools/list':
        this.reply(message.id, {
          tools: Array.from(this.tools.values()).map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        return;
      case 'tools/call':
        await this.handleToolCall(message.id, message.params as Record<string, unknown> | undefined);
        return;
      case 'resources/list':
        this.reply(message.id, { resources: this.resources });
        return;
      case 'resources/read':
        await this.handleResourceRead(message.id, message.params as Record<string, unknown> | undefined);
        return;
      case 'resources/subscribe':
        await this.handleResourceSubscribe(message.id, message.params as Record<string, unknown> | undefined);
        return;
      case 'resources/unsubscribe':
        await this.handleResourceUnsubscribe(message.id, message.params as Record<string, unknown> | undefined);
        return;
      default:
        this.transport.sendError(message.id ?? null, -32601, `Unknown method: ${message.method}`);
    }
  }

  private handleInitialize(id: JsonRpcId, params?: Record<string, unknown>): void {
    const requestedVersion = typeof params?.protocolVersion === 'string'
      ? params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;

    this.protocolVersion = requestedVersion;

    this.reply(id, {
      protocolVersion: requestedVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
        resources: {
          subscribe: true,
          listChanged: false,
        },
      },
      serverInfo: {
        name: '@highway1/mcp-server',
        version: SERVER_VERSION,
      },
      instructions: 'Use listen_agent to bootstrap identity and listener state, find_agents for discovery, tell_agent for messaging, and score_agent/vouch_for_agent/get_endorsements for trust operations. Legacy tools (discover_agents, send_message) are deprecated.',
    });
  }

  private async handleToolCall(id: JsonRpcId | undefined, params?: Record<string, unknown>): Promise<void> {
    const name = typeof params?.name === 'string' ? params.name : null;
    if (!name) {
      this.transport.sendError(id ?? null, -32602, 'Missing tool name');
      return;
    }

    const tool = this.tools.get(name);
    if (!tool) {
      this.transport.sendError(id ?? null, -32601, `Unknown tool: ${name}`);
      return;
    }

    const args = this.toObject(params.arguments);

    try {
      const result = await tool.handler(args);
      this.reply(id, result);
    } catch (error) {
      this.reply(id, errorResult((error as Error).message));
    }
  }

  private async handleResourceRead(id: JsonRpcId | undefined, params?: Record<string, unknown>): Promise<void> {
    const uri = typeof params?.uri === 'string' ? params.uri : null;
    if (!uri) {
      this.transport.sendError(id ?? null, -32602, 'Missing resource uri');
      return;
    }

    try {
      const data = await this.readResource(uri);
      this.reply(id, {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      });
    } catch (error) {
      this.transport.sendError(id ?? null, -32000, (error as Error).message);
    }
  }

  private async handleResourceSubscribe(id: JsonRpcId | undefined, params?: Record<string, unknown>): Promise<void> {
    const uri = typeof params?.uri === 'string' ? params.uri : null;
    if (!uri) {
      this.transport.sendError(id ?? null, -32602, 'Missing resource uri');
      return;
    }

    if (uri !== INBOX_RESOURCE_URI) {
      this.transport.sendError(id ?? null, -32602, `Resource does not support subscriptions: ${uri}`);
      return;
    }

    await this.ensureInboxSubscription();
    this.subscribedResources.add(uri);
    this.reply(id, {});
  }

  private async handleResourceUnsubscribe(id: JsonRpcId | undefined, params?: Record<string, unknown>): Promise<void> {
    const uri = typeof params?.uri === 'string' ? params.uri : null;
    if (!uri) {
      this.transport.sendError(id ?? null, -32602, 'Missing resource uri');
      return;
    }

    this.subscribedResources.delete(uri);
    if (!this.subscribedResources.has(INBOX_RESOURCE_URI) && this.inboxSubscriptionClient) {
      await this.inboxSubscriptionClient.close();
      this.inboxSubscriptionClient = null;
    }

    this.reply(id, {});
  }

  private async ensureDaemonRunning(options: { relay?: string; token?: string } = {}): Promise<void> {
    const hasListenerOverrides = Boolean(options.relay || options.token);

    if (!hasListenerOverrides && await this.daemonClient.isDaemonRunning()) {
      return;
    }

    if (!hasIdentity()) {
      throw new Error('No identity found. Use the listen_agent tool or run "agent listen" to create one.');
    }

    if (!this.daemonStartupPromise) {
      this.daemonStartupPromise = this.startDaemonProcess(options);
    }

    try {
      await this.daemonStartupPromise;
    } finally {
      this.daemonStartupPromise = null;
    }
  }

  private async startDaemonProcess(options: { relay?: string; token?: string } = {}): Promise<void> {
    await ensureBackgroundListener(options);
  }

  private async callDaemonTool(command: Parameters<DaemonClient['send']>[0], params: Record<string, unknown>): Promise<CallToolResult> {
    try {
      await this.ensureDaemonRunning();
      const result = await this.daemonClient.send(command, params);
      return jsonResult(result);
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private async readResource(uri: string): Promise<unknown> {
    switch (uri) {
      case 'quadra-a://status':
        return this.buildStatusSnapshot();
      case INBOX_RESOURCE_URI:
        await this.ensureDaemonRunning();
        return this.daemonClient.send('inbox', { pagination: { limit: 50 } });
      case 'quadra-a://peers':
        await this.ensureDaemonRunning();
        return this.daemonClient.send('discover', { limit: 50 });
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  }

  private async ensureInboxSubscription(): Promise<void> {
    if (this.inboxSubscriptionClient) {
      return;
    }

    await this.ensureDaemonRunning();

    const subscriptionClient = new DaemonSubscriptionClient();
    await subscriptionClient.subscribeInbox({}, (event: DaemonSubscriptionEvent) => {
      if (event.event !== 'inbox') {
        return;
      }

      this.transport.sendNotification('notifications/resources/updated', {
        uri: INBOX_RESOURCE_URI,
      });
    });

    this.inboxSubscriptionClient = subscriptionClient;
  }

  private reply(id: JsonRpcId | undefined, result: unknown): void {
    if (id === undefined) {
      return;
    }
    this.transport.sendResponse(id, result);
  }

  private async buildStatusSnapshot(): Promise<Record<string, unknown>> {
    const running = await this.daemonClient.isDaemonRunning();

    return {
      identity: getIdentity() ?? null,
      card: getAgentCard() ?? null,
      hasIdentity: hasIdentity(),
      relayInviteTokenConfigured: Boolean(getRelayInviteToken()),
      daemon: running ? await getDaemonStatus() : null,
      queue: running ? await this.daemonClient.send('queue_stats', {}).catch(() => null) : null,
      surface: {
        name: '@quadra-a/mcp-server',
        version: SERVER_VERSION,
        protocolVersion: this.protocolVersion,
      },
    };
  }

  private normalizeProvidersInput(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      const providers = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);

      return providers.length > 0 ? providers : undefined;
    }

    if (typeof value === 'string') {
      const providers = value.split(',').map((entry) => entry.trim()).filter(Boolean);
      return providers.length > 0 ? providers : undefined;
    }

    return undefined;
  }

  private async ensureReachabilityWritable(): Promise<void> {
    await this.ensureDaemonRunning();
    const current = await getDaemonReachabilityPolicy();
    if (current.policy.operatorLock) {
      throw new Error('Reachability policy is operator-locked');
    }
  }

  private async handleGetReachabilityPolicy(): Promise<CallToolResult> {
    try {
      await this.ensureDaemonRunning();
      return jsonResult(await getDaemonReachabilityPolicy());
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private async handleGetReachabilityStatus(): Promise<CallToolResult> {
    try {
      await this.ensureDaemonRunning();
      return jsonResult(await getDaemonReachabilityStatus());
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private async handleSetReachabilityPolicy(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      await this.ensureReachabilityWritable();

      const policy: Record<string, unknown> = {};
      if (typeof args.mode === 'string') {
        policy.mode = args.mode;
      }
      if (typeof args.count === 'number' && Number.isFinite(args.count)) {
        policy.targetProviderCount = args.count;
      }
      if (typeof args.enabled === 'boolean') {
        policy.operatorLock = args.enabled;
      }

      const providers = this.normalizeProvidersInput(args.providers);
      if (providers) {
        policy.bootstrapProviders = providers;
      }

      return jsonResult(await setDaemonReachabilityPolicy(policy));
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private async handleResetReachabilityPolicy(): Promise<CallToolResult> {
    try {
      await this.ensureReachabilityWritable();
      return jsonResult(await resetDaemonReachabilityPolicy());
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private normalizeCapabilitiesInput(value: unknown): string[] | string | undefined {
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }

    return typeof value === 'string' ? value : undefined;
  }

  private listenerOverrides(args: Record<string, unknown>): { relay?: string; token?: string } {
    return {
      relay: typeof args.relay === 'string' && args.relay.trim() ? args.relay.trim() : undefined,
      token: typeof args.token === 'string' && args.token.trim() ? args.token.trim() : undefined,
    };
  }

  private prependDeprecationNotice(result: CallToolResult, notice: string): CallToolResult {
    if (result.content[0]) {
      result.content[0].text = `${notice}

${result.content[0].text}`;
    }

    return result;
  }

  private buildDiscoverParams(args: Record<string, unknown>): Record<string, unknown> {
    const filters = this.toObject(args.filters);

    if (typeof args.minTrust === 'number' && Number.isFinite(args.minTrust)) {
      filters.minTrustScore = args.minTrust;
    }

    return {
      capability: typeof args.capability === 'string' && args.capability.trim() ? args.capability.trim() : undefined,
      query: typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      limit: typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined,
    };
  }

  private async handleListenAgent(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const relay = typeof args.relay === 'string' && args.relay.trim() ? args.relay.trim() : undefined;
      const token = typeof args.token === 'string' && args.token.trim() ? args.token.trim() : undefined;
      const discoverable = Boolean(args.discoverable);
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
      const description = typeof args.description === 'string' && args.description.trim()
        ? args.description.trim()
        : undefined;
      const capabilities = this.normalizeCapabilitiesInput(args.capabilities);

      const result = await ensureBackgroundListener({
        relay,
        token,
        discoverable,
        name,
        description,
        capabilities,
      });

      return jsonResult({
        action: result.action,
        did: result.did,
        createdIdentity: result.createdIdentity,
        discoverable,
        relay: relay ?? result.connectedRelays[0] ?? null,
        connectedRelays: result.connectedRelays,
      });
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private async handleFindAgents(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const overrides = this.listenerOverrides(args);
      await this.ensureDaemonRunning(overrides);
      const result = await this.daemonClient.send('discover', this.buildDiscoverParams(args));
      return jsonResult(result);
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private async handleTraceMessage(args: Record<string, unknown>): Promise<CallToolResult> {
    const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
    if (!messageId) {
      return errorResult('trace_message requires messageId');
    }

    try {
      await this.ensureDaemonRunning();
      return jsonResult(await buildMessageTrace(messageId));
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private async handleTellAgent(args: Record<string, unknown>): Promise<CallToolResult> {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const protocol = typeof args.protocol === 'string' && args.protocol.trim()
      ? args.protocol.trim()
      : '/agent/msg/1.0.0';
    const threadId = typeof args.threadId === 'string' && args.threadId.trim() ? args.threadId.trim() : undefined;
    const messageType = args.type === 'reply' ? 'reply' : 'message';
    const shouldWait = Boolean(args.wait);
    const waitTimeoutSeconds = typeof args.waitTimeout === 'number' && Number.isFinite(args.waitTimeout) && args.waitTimeout > 0
      ? args.waitTimeout
      : 30;

    if (!target) {
      return errorResult('tell_agent requires target');
    }

    const payload = args.payload;
    let messagePayload: Record<string, unknown> | undefined;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      messagePayload = payload as Record<string, unknown>;
    } else if (typeof args.message === 'string') {
      messagePayload = { text: args.message };
    } else if (payload !== undefined) {
      messagePayload = { value: payload };
    }

    if (!messagePayload) {
      return errorResult('tell_agent requires either payload or message');
    }

    try {
      const overrides = this.listenerOverrides(args);
      await this.ensureDaemonRunning(overrides);
      const resolved = await resolveTargetDid(target, overrides.relay);
      const sendResult = await dispatchMessage({
        to: resolved.did,
        protocol,
        payload: messagePayload,
        type: messageType,
        threadId,
      });

      const outcome = shouldWait
        ? await waitForMessageOutcome(sendResult.id, Math.round(waitTimeoutSeconds * 1000))
        : null;
      const timedOut = shouldWait && !outcome;
      const trace = sendResult.usedDaemon ? await buildMessageTrace(sendResult.id).catch(() => null) : null;
      const message = outcome?.message;

      return jsonResult({
        messageId: sendResult.id,
        target: {
          input: target,
          resolvedDid: resolved.did,
          matchedBy: resolved.matchedBy,
        },
        sent: true,
        waiting: shouldWait,
        waitTimeoutSeconds: shouldWait ? waitTimeoutSeconds : null,
        timedOut,
        usedDaemon: sendResult.usedDaemon,
        trace,
        result: outcome ? {
          kind: outcome.kind,
          status: outcome.status,
          jobId: outcome.jobId,
          terminal: outcome.terminal,
          message: message ? {
            id: message.envelope.id,
            from: message.envelope.from,
            protocol: message.envelope.protocol,
            replyTo: message.envelope.replyTo ?? null,
            payload: message.envelope.payload,
            receivedAt: message.receivedAt ?? null,
          } : null,
        } : null,
        reply: outcome?.kind === 'reply' && message ? {
          id: message.envelope.id,
          from: message.envelope.from,
          protocol: message.envelope.protocol,
          replyTo: message.envelope.replyTo ?? null,
          payload: message.envelope.payload,
          receivedAt: message.receivedAt ?? null,
        } : null,
        notes: timedOut
          ? [
              'Result timeout does not prove remote failure.',
              `Inspect local lifecycle with trace_message {"messageId":"${sendResult.id}"}`,
            ]
          : trace?.summary.notes ?? [],
      });
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  private toObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private async dispose(): Promise<void> {
    if (this.inboxSubscriptionClient) {
      await this.inboxSubscriptionClient.close();
      this.inboxSubscriptionClient = null;
    }
  }
}
