# @quadra-a/core

Shared protocol and runtime packages for `quadra-a`.

This repository contains the reusable foundations behind the rest of the stack: identity, discovery, transport, message encoding, local runtime helpers, daemon support, and inbox-oriented application services.

## Packages

| Package | Use it when | Highlights |
| --- | --- | --- |
| `@quadra-a/protocol` | You need low-level control over keys, DIDs, Agent Cards, envelopes, or relay transport | Ed25519 identity, DID derivation, discovery encoding, relay client, message codec |
| `@quadra-a/runtime` | You want a higher-level Node.js integration layer for local apps and tools | Config, daemon client/server, inbox helpers, message dispatch, trust helpers |

## Choosing the right package

- Use `protocol/` when you are building a custom integration, implementing wire-level behavior, or working directly with signing, encoding, routing, and relay transport.
- Use `runtime/` when you are wiring a Node.js application to the local quadra-a runtime and you want inbox, daemon, config, and messaging helpers out of the box.
- In most application-level integrations, start with `@quadra-a/runtime` and only drop down to `@quadra-a/protocol` when you need lower-level control.

## Repository layout

- [`protocol/`](protocol/) — low-level protocol, transport, discovery, and trust primitives
- [`runtime/`](runtime/) — local runtime, daemon, inbox, and messaging services built on top of `protocol/`

## Develop from source

```bash
pnpm install
pnpm --filter @quadra-a/protocol build
pnpm --filter @quadra-a/runtime build
pnpm --filter @quadra-a/protocol test
```

## Related repositories

- [quadra-a/cli](https://github.com/quadra-a/cli) — TypeScript CLI built on top of the runtime layer
- [quadra-a/mcp-server](https://github.com/quadra-a/mcp-server) — MCP server that exposes runtime capabilities over stdio
- [quadra-a/agent-examples](https://github.com/quadra-a/agent-examples) — examples and walkthroughs built on the stack
