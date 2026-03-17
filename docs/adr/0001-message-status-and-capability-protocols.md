# ADR 0001: Message Status And Capability Protocol Normalization

## Status
Accepted

## Context
Recent cross-runtime regressions came from two places:

1. Message status mixed transport delivery state with local inbox consumption state.
2. Capability protocols were represented in two valid forms, but matchers only accepted one.

These bugs were hard to catch because JS and Rust each passed their own local tests while still disagreeing on the shared semantics.

## Decision
We standardize the shared semantics as follows:

- Inbound message status is driven by local read state.
- Outbound message status is driven by delivery success or failure.
- A failed delivery always wins over any non-terminal status.
- Capability matchers must accept both bare capability IDs like `gpu/compute` and prefixed protocols like `/capability/gpu/compute`.
- Extra protocol segments and token changes still do not match.

## Consequences
This decision requires:

- Shared conformance vectors under `spec/conformance/`.
- JS and Rust runners that execute the same vectors against production code paths.
- Any future change to message lifecycle, reply correlation, or capability normalization to update both the ADR and the conformance vectors in the same change.
