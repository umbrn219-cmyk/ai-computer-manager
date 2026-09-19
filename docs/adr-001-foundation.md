# ADR-001: Typed modular foundation

## Decision
Use TypeScript with small packages and explicit interfaces. Use immutable snapshots, discriminated unions, deterministic transitions, in-memory storage, scripted model providers, and safe mock platform adapters.

## Rationale
This minimizes dependencies while allowing future implementations to be substituted without changing domain contracts.

## Safety policy
The Safety Kernel classifies actions across the `OBSERVATION`, `UI`, `FILESYSTEM`, `NETWORK`, `CREDENTIAL`, `FINANCIAL`, and `SYSTEM` domains, and fails closed for unknown domains. `CREDENTIAL` and `FINANCIAL` actions are deterministically blocked. `NETWORK` and `SYSTEM` actions require explicit authorization before they can proceed. Model advice cannot lower a deterministic safety decision, and financial final authorization remains a manual user action. Authorization objects are created by the kernel and cannot be forged by callers.
