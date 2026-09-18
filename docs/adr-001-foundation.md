# ADR-001: Typed modular foundation

## Decision
Use TypeScript with small packages and explicit interfaces. Use immutable snapshots, discriminated unions, deterministic transitions, in-memory storage, scripted model providers, and safe mock platform adapters.

## Rationale
This minimizes dependencies while allowing future implementations to be substituted without changing domain contracts.
