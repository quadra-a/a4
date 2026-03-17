# @quadra-a/protocol

Low-level protocol primitives for `quadra-a`.

Use this package when you need direct access to DIDs, key material, Agent Cards, relay transport, envelope encoding, trust records, or E2E session bootstrapping. It is the lowest stable JavaScript layer in the stack.

## What it contains

- DID derivation and signing helpers
- Agent Card creation, encoding, and verification
- Relay client and transport codecs
- Message envelope and queue primitives
- E2E device state, signed pre-key rotation, and ratchet helpers
- Trust score and endorsement data types

## Install

```bash
npm install @quadra-a/protocol
```

## When to use it

- Use `@quadra-a/protocol` when you are building a custom client, relay integration, or protocol-level test harness.
- Use `@quadra-a/runtime` instead when you want higher-level daemon, inbox, and local messaging workflows.

## Development

```bash
pnpm build
pnpm test
```
