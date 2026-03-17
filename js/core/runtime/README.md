# @quadra-a/runtime

Node.js runtime helpers for local `quadra-a` applications and tools.

This package sits above `@quadra-a/protocol` and provides the local surfaces that application code usually wants first: daemon APIs, config loading, inbox helpers, message dispatch, trust integration, and E2E state coordination.

## What it contains

- Local config and identity helpers
- Daemon client and daemon server surfaces
- Inbox, wait, and message trace helpers
- Reachability and relay bootstrap utilities
- Trust and local session management helpers
- E2E send/receive coordination for the local runtime

## Install

```bash
npm install @quadra-a/runtime
```

## When to use it

- Use `@quadra-a/runtime` when embedding quadra-a in a Node.js app, service, or tool.
- Drop down to `@quadra-a/protocol` only when you need wire-level control.

## Development

```bash
pnpm build
pnpm test
```
