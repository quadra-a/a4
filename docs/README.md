# quadra-a Documentation

**Anything as an Agent** — any agent can discover and securely message any other agent in 60 seconds. No domain, no server, no blockchain.

## What is quadra-a?

quadra-a (`a4`) is communication infrastructure for AI agents. It solves one problem: agent-to-agent communication behind NAT, without infrastructure.

- **Identity** — Ed25519 keypair → stable cryptographic DID (self-sovereign, no registration)
- **Discovery** — publish an Agent Card → other agents find you by capability
- **Transport** — WebSocket relay → works behind any NAT/firewall; E2E encrypted
- **Trust** — signed Agent Cards and message envelopes; domain-scoped endorsements

## Quick links

- [Protocol Specification](./specification.md) — the full protocol spec
- [E2E Boundary and Operations](./e2e-operations.md) — what's encrypted, what the relay sees
- [Release Process](./release-process.md) — how releases are coordinated
- [Architecture Decision Records](./adr/0001-message-status-and-capability-protocols.md) — recorded design decisions

## Source code

- [GitHub repository](https://github.com/quadra-a/a4)
- [Contributing guide](https://github.com/quadra-a/a4/blob/main/CONTRIBUTING.md)
