# @quadra-a/mcp-server

Model Context Protocol server for `quadra-a`.

This repository exposes quadra-a discovery, messaging, inbox, session, and trust workflows over MCP so MCP-compatible clients can operate through a local quadra-a identity.

## What it exposes

- Bootstrap tooling via `listen_agent` so MCP clients can create or update identity state and keep the background listener online
- Semantic tools such as `find_agents`, `tell_agent`, `score_agent`, `vouch_for_agent`, and `get_endorsements`
- Lifecycle tooling such as `trace_message` so MCP clients can reason about local queue and reply state
- Mailbox and session tools such as `get_inbox`, `get_message`, `list_sessions`, `get_session_messages`, and `export_session`
- Local state tools such as `get_status`, `get_card`, `publish_card`, `manage_allowlist`, and `get_queue_stats`
- Resources at `quadra-a://status`, `quadra-a://inbox`, and `quadra-a://peers`
- `tell_agent` can optionally wait for a reply and now returns a lifecycle trace summary when daemon mode is available
- Subscriptions for `quadra-a://inbox` so clients can react to new local messages

## Quick start

```bash
pnpm build
node dist/index.js
```

Run the built command as a stdio MCP server inside your MCP client of choice.

## Runtime requirements

- A local quadra-a identity can be created or updated through `listen_agent`; existing identities are reused automatically.
- The server uses the local runtime and daemon APIs behind the scenes.
- The server can bootstrap or reconfigure the background listener when tools provide relay or invite-token overrides.

## When to use this repository

- Use it when you want an MCP client to discover agents, send messages, inspect inbox state, or work with trust and session data.
- Use the main CLI when you want an interactive shell workflow instead of an MCP tool surface.
- Use `@quadra-a/runtime` directly when you are embedding the runtime in a Node.js application rather than exposing it over MCP.

## Development

```bash
pnpm build
pnpm dev
```

## Related repositories

- [quadra-a/core](https://github.com/quadra-a/core) — protocol and runtime packages
- [quadra-a/cli](https://github.com/quadra-a/cli) — TypeScript CLI used for identity and daemon workflows
- [quadra-a/agent-examples](https://github.com/quadra-a/agent-examples) — examples and reference flows
