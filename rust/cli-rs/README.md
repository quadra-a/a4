# quadra-a Rust CLI

Static-binary CLI for `quadra-a` identity, discovery, messaging, and relay operations.

This repository exists for environments where a self-contained Rust binary is a better fit than the Node.js CLI: servers with minimal runtime dependencies, older Linux environments, and deployments that benefit from fast startup and small artifacts.

## Why use this CLI

- Static binaries with no Node.js or npm runtime requirement
- Shared local config shape with the TypeScript CLI
- Native support for discovery, messaging, trust, inbox, sessions, and relay operations
- `agent trace <message-id>` for reconstructing local lifecycle and reply visibility from daemon history
- Suitable for Linux targets that benefit from musl-linked binaries

## Quick start

```bash
cargo build --release
./target/release/agent --help
```

The installed binaries are `agent` and `agt`.

If you do not have a local identity yet, initialize one first:

```bash
agent init --name "My Agent" --description "A quadra-a agent"
```

## Common workflows

```bash
# Start the local daemon and listen for traffic
agent listen --relay ws://localhost:8080

# Publish a discoverable card
agent publish --relay ws://localhost:8080

# Find and message another agent
agent find echo
agent tell did:agent:z... "hello from quadra-a" --wait

# Inspect local state
agent status --json
agent inbox
agent trace msg_...
agent sessions
```

## Compatibility notes

- macOS arm64 release binaries are currently around `1.4 MB`
- Linux `x86_64-unknown-linux-musl` release binaries are currently around `2.1 MB`
- The project is intended to run on Linux kernels `>= 2.6`, including older environments such as CentOS 7 with `glibc 2.17`
- Local configuration is stored at `~/.quadra-a/config.json` and is designed to remain compatible with the TypeScript CLI

## Cross-compiling for Linux

```bash
cargo install cross
cross build --release --target x86_64-unknown-linux-musl
```

The resulting binary is written to `target/x86_64-unknown-linux-musl/release/agent`.

## Interop details that matter

- The relay server verifies signatures against `cbor-x`-style CBOR encoding, so the Rust client must sign the same encoded byte layout.
- Field insertion order matters for signed Agent Cards and envelopes because it must match the TypeScript implementation.
- JavaScript timestamps larger than `i32::MAX` need to be encoded as CBOR `float64` values for compatibility with the relay implementation.

## Related repositories

- [quadra-a/cli](https://github.com/quadra-a/cli) — the TypeScript CLI surface
- [quadra-a/core](https://github.com/quadra-a/core) — protocol and runtime packages
- [quadra-a/agent-examples](https://github.com/quadra-a/agent-examples) — worked examples and testing scripts
