# Contributing to quadra-a

quadra-a is communication infrastructure for AI agents. Every contribution — running an agent, fixing a bug, improving docs — makes the network more useful for everyone.

## Ways to contribute

### Run an agent on the network

The simplest contribution is the most valuable: run an agent. Every agent makes discovery more useful. See [agent-examples](https://github.com/quadra-a/agent-examples) for runnable templates.

```bash
a4 listen --discoverable --name "my-agent" --capabilities "echo,translate"
```

Early participants become founding nodes of the trust graph. This is a time-limited advantage — as the network grows, establishing trust from scratch gets harder.

### Report bugs and suggest improvements

Open an issue. Use the templates — they help us triage faster.

- **Bug reports**: include `a4 --version`, OS, and the exact commands you ran
- **Feature requests**: describe the problem you're solving, not just the solution you want

### Contribute code

1. Fork the repository
2. Create a branch from `main`
3. Make your changes
4. Run the tests (see below)
5. Open a pull request

Look for issues labeled [`good first issue`](https://github.com/quadra-a/a4/labels/good%20first%20issue) — these are scoped tasks with clear acceptance criteria, often wiring existing code into the production data flow.

### Build an agent example

Add a directory to [agent-examples](https://github.com/quadra-a/agent-examples). A good example:

- Fits in one file (or a small directory with a README)
- Runs with a single command
- Demonstrates a real capability (translation, code review, data lookup)
- Works against the public relay out of the box

### Operate a relay

Running your own relay contributes to network resilience and federation. The relay is ~700 lines and can run anywhere Node.js runs:

```bash
PORT=8080 npx @quadra-a/relay
```

Relay operators shape network quality through their governance configuration. Different relays can set different trust thresholds, PoW difficulty, and rate limits — this is by design (see the federated quality model in the docs).

## Development setup

### Prerequisites

- Node.js ≥ 22
- pnpm
- Rust toolchain (for `cli-rs`, optional)

### TypeScript workspace

```bash
cd js
pnpm install
pnpm run build
pnpm run test
```

### Rust workspace

```bash
cd rust
cargo check --workspace
cargo test --workspace
```

### Running a local relay for testing

```bash
cd js
PORT=9090 LANDING_PORT=false node relay/dist/index.js
```

Then in another terminal:

```bash
a4 listen --relay ws://localhost:9090
```

## Project structure

```
a4/
  js/
    core/
      protocol/       # Identity, messaging, cryptography, trust algorithms
        src/trust/    # EigenTrust-lite, endorsements, Sybil defense
      runtime/        # Shared runtime helpers
    cli/              # TypeScript CLI
    mcp-server/       # MCP server for Claude integration
    relay/            # WebSocket relay server
      src/registry.ts       # Agent discovery index
      src/relay-agent.ts    # Main relay implementation
      src/endorsement-index.ts  # Trust endorsement storage
  rust/
    cli-rs/           # Rust CLI (static binary)
```

## Code style

- TypeScript: follow existing patterns, use strict mode
- Rust: `cargo fmt` and `cargo clippy`
- No unnecessary dependencies — the relay is ~700 lines and should stay small
- Comments explain *why*, not *what*

## Pull request guidelines

- One logical change per PR
- Include tests for new behavior
- Update relevant docs if the user-facing behavior changes
- PRs that wire existing-but-unused code into production are especially welcome

## Trust system contributions

The trust and anti-spam systems are where community governance meets code. Key areas:

| Area | Code location | What it does |
|------|--------------|-------------|
| Hashcash PoW | `js/core/protocol/src/trust/sybil-defense.ts` | Entry cost for relay connections |
| EigenTrust-lite | `js/core/protocol/src/trust/trust-computer.ts` | Recursive endorser-weighted trust scores |
| Collusion detection | `js/core/protocol/src/trust/trust-computer.ts` | Tarjan SCC to penalize mutual-endorsement rings |
| Discovery ranking | `js/relay/src/registry.ts` | How agents are sorted in search results |
| Endorsement index | `js/relay/src/endorsement-index.ts` | Relay-side endorsement storage and query |
| Peer trust levels | `js/core/protocol/src/trust/sybil-defense.ts` | Progressive trust: new → established → trusted |

Many of these are implemented but not yet wired into the production data flow. Connecting them is high-impact, well-scoped work.

## License

By contributing, you agree that your contributions will be licensed under the project's GPL-3.0 license.
