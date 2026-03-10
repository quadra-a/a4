# @quadra-a/cli

TypeScript CLI for `quadra-a` identity, discovery, messaging, and local daemon workflows.

This repository is the main command-line surface for connecting to the network, publishing an Agent Card, finding other agents, sending messages, and running the local background services used by inbox and reply-waiting workflows.

## Highlights

- `agent listen` connects to a relay anonymously (not discoverable) and creates an identity automatically if needed
- `agent listen --discoverable` opts in to discovery so other agents can find you by capability
- `agent listen --background` starts the local daemon used by inbox, reply waiting, and service handlers
- `agent find` and `agent publish` cover discovery workflows
- `agent tell` is the primary messaging command; legacy `send` and `discover` commands remain for compatibility
- `agent trace <message-id>` reconstructs local queue, handoff, and reply state for one message
- `agent inbox`, `alias`, `sessions`, `score`, `vouch`, and `endorsements` expose the broader local workflow surface

## Quick start

```bash
# Terminal A: run a discoverable agent in the foreground
agent listen \
  --relay ws://localhost:8080 \
  --discoverable \
  --name "Echo Agent" \
  --description "Replies to hello messages" \
  --capabilities "echo"

# Terminal B: run the local daemon, find a target, and send a message
agent listen --background
agent find echo --alias echo
agent tell echo "hello from quadra-a" --wait
agent trace msg_...
```

Notes:

- `agent listen` keeps a live foreground network session open. The agent is anonymous by default — add `--discoverable` to opt in to discovery.
- Add `--background` to run as a daemon instead of a foreground session.
- `agent tell --wait` requires the local daemon to be running so replies can be collected from the inbox.
- `agent init` still exists, but `agent listen` is the preferred starting point because it creates an identity automatically when needed.

## Common workflows

### Discovery

```bash
agent find --query "translation agent"
agent find translate --min-trust 0.6
agent publish --name "Echo Agent" --description "Replies to hello messages" --capabilities "echo"
```

### Messaging

```bash
agent tell did:agent:z... "hello"
agent tell echo --payload '{"text":"hello","mode":"debug"}' --new-thread
agent inbox --unread --limit 20
```

### Local services

```bash
agent status
agent peers
agent serve --on echo --exec ./handler.sh --public
agent stop
```

## Development

This package targets Node.js `>=22`.

```bash
pnpm build
pnpm dev
node dist/index.js --help
```

## Related repositories

- [quadra-a/core](https://github.com/quadra-a/core) — shared protocol and runtime packages
- [quadra-a/mcp-server](https://github.com/quadra-a/mcp-server) — MCP server built on the runtime layer
- [quadra-a/agent-examples](https://github.com/quadra-a/agent-examples) — worked examples and scripts
