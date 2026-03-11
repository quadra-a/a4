# Shared E2E Vector Contract

This directory is reserved for the shared fixture corpus consumed by the JS and Rust E2E protocol tests.

## Rules

- one vector format only
- JS and Rust both load the same files without translation layers
- vector files are immutable test fixtures, not generated ad hoc inside per-language tests
- every fixture file must identify its suite, version, and case IDs

## Planned fixture groups

- `x3dh/*.json` — identity keys, signed pre-keys, OTKs, shared-secret expectations
- `ratchet/*.json` — initial root keys, send/receive steps, skipped-key scenarios
- `messages/*.json` — `PREKEY_MESSAGE` and `SESSION_MESSAGE` wire encoding fixtures
- `cards/*.json` — `AgentCard.devices` positive and negative validation fixtures

## Required fields per fixture file

- `suite`
- `version`
- `encoding`
- `cases[]`

Each case must provide:

- stable `id`
- human-readable `description`
- `inputs`
- `expected`
- optional `negativeVariants[]`

## Ownership

- protocol changes that alter fixture meaning must update this directory and the schema
- JS and Rust implementations are both blocked until the same fixture file passes in both runtimes
