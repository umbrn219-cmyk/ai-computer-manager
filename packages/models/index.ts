import type { ModelCapability, ModelProvider, ModelRouter } from '../core/index.js';

/**
 * Phase 5 - Model Router / Model Provider foundation.
 *
 * Dependency direction (enforced by the Phase 5 guardrail tests):
 *   AI Manager / future planner  ->  ModelRouter  ->  ModelProvider
 *
 * This module is provider-neutral: it contains no vendor names, no vendor SDKs,
 * no API keys, no authentication and no network client. Concrete providers are
 * injected by the caller, and every model call is selected by the router.
 */

// --- Capability roles ---------------------------------------------------
//
// Roles are the vocabulary used by the manager/planner layer. Each role
// resolves to a capability declared in core, so a routing decision never
// mentions a vendor. This table is the single seam between the role vocabulary
// and the capability set: if core renames or splits a capability, only this
// table changes.

export type ModelRole = 'Intent' | 'Planner' | 'Grounder' | 'Verifier';

export const MODEL_ROLE_CAPABILITY: Readonly<Record<ModelRole, ModelCapability>> = Object.freeze({
  Intent: 'UNDERSTAND_INTENT',
  Planner: 'PLAN',
  Grounder: 'DESCRIBE_SCREEN',
  Verifier: 'VERIFY_OUTCOME',
});

// --- Explicit failure representation ------------------------------------
//
// The router never reports success when provider execution failed. An
// unroutable capability and a failing provider both surface as typed
// rejections, and neither is silently converted into a successful response.

export class UnsupportedCapabilityError extends Error {
  readonly capability: ModelCapability;

  constructor(capability: ModelCapability) {
    super(`No registered provider supports capability: ${capability}`);
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
  }
}

export class ModelProviderError extends Error {
  readonly capability: ModelCapability;
  readonly providerKind: string;

  constructor(capability: ModelCapability, providerKind: string, cause: unknown) {
    super(
      `Provider "${providerKind}" failed for capability ${capability}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = 'ModelProviderError';
    this.capability = capability;
    this.providerKind = providerKind;
  }
}

// --- Provider identity --------------------------------------------------
//
// `providerKind` is optional so that every ModelProvider implementation
// satisfies the core contract without modification; the router only uses it to
// make failures self-describing.

export type IdentifiedModelProvider = ModelProvider & { readonly providerKind?: string };

// --- Deterministic scripted provider (tests and local development) ------

export class ScriptedModelProvider implements ModelProvider {
  readonly providerKind: string;
  private readonly responses: Readonly<
    Partial<Record<ModelCapability, Readonly<Record<string, unknown>>>>
  >;

  constructor(
    responses: Readonly<Partial<Record<ModelCapability, Readonly<Record<string, unknown>>>>> = {},
    providerKind = 'scripted',
  ) {
    this.responses = responses;
    this.providerKind = providerKind;
  }

  supports(capability: ModelCapability): boolean {
    return capability in this.responses;
  }

  async request(
    capability: ModelCapability,
    _input: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!this.supports(capability)) {
      throw new Error(`Unsupported capability: ${capability}`);
    }
    return this.responses[capability]!;
  }
}

// --- Router -------------------------------------------------------------
//
// Selection is deterministic: the first registered provider that advertises the
// requested capability wins. The router never falls back to a provider that
// does not advertise the capability, never retries on its own, and never
// swallows a provider failure.

export class SimpleModelRouter implements ModelRouter {
  private readonly providers: readonly IdentifiedModelProvider[];

  constructor(providers: readonly IdentifiedModelProvider[]) {
    this.providers = providers;
  }

  /** True when at least one registered provider advertises the capability. */
  supports(capability: ModelCapability): boolean {
    return this.resolveProvider(capability) !== undefined;
  }

  /** Deterministic eligible-provider lookup, exposed for inspection and tests. */
  resolveProvider(capability: ModelCapability): IdentifiedModelProvider | undefined {
    return this.providers.find((provider) => provider.supports(capability));
  }

  async request(
    capability: ModelCapability,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const provider = this.resolveProvider(capability);
    if (provider === undefined) {
      throw new UnsupportedCapabilityError(capability);
    }

    try {
      return await provider.request(capability, input);
    } catch (cause) {
      throw new ModelProviderError(
        capability,
        provider.providerKind ?? 'anonymous-provider',
        cause,
      );
    }
  }

  /** Role-based entry point for the manager/planner layer. */
  async requestRole(
    role: ModelRole,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.request(MODEL_ROLE_CAPABILITY[role], input);
  }
}
