import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MODEL_ROLE_CAPABILITY,
  ModelProviderError,
  ScriptedModelProvider,
  SimpleModelRouter,
  UnsupportedCapabilityError,
} from '../packages/models/index.js';
import type { ModelCapability, ModelProvider, ModelRouter } from '../packages/core/index.js';

// --- Deterministic test doubles -----------------------------------------

/** Records every capability it is asked for and answers with a marker object. */
class RecordingModelProvider implements ModelProvider {
  readonly providerKind: string;
  readonly calls: ModelCapability[] = [];
  private readonly advertised: readonly ModelCapability[];
  private readonly responses: Partial<Record<ModelCapability, Readonly<Record<string, unknown>>>>;

  constructor(
    providerKind: string,
    advertised: readonly ModelCapability[],
    responses: Partial<Record<ModelCapability, Readonly<Record<string, unknown>>>> = {},
  ) {
    this.providerKind = providerKind;
    this.advertised = advertised;
    this.responses = responses;
  }

  supports(capability: ModelCapability): boolean {
    return this.advertised.includes(capability);
  }

  async request(capability: ModelCapability): Promise<Readonly<Record<string, unknown>>> {
    this.calls.push(capability);
    return this.responses[capability] ?? { handledBy: this.providerKind, capability };
  }
}

/** Advertises capabilities but always fails, recording each invocation. */
class FailingModelProvider implements ModelProvider {
  readonly providerKind = 'failing';
  readonly calls: ModelCapability[] = [];
  private readonly advertised: readonly ModelCapability[];

  constructor(advertised: readonly ModelCapability[]) {
    this.advertised = advertised;
  }

  supports(capability: ModelCapability): boolean {
    return this.advertised.includes(capability);
  }

  async request(capability: ModelCapability): Promise<Readonly<Record<string, unknown>>> {
    this.calls.push(capability);
    throw new Error('provider exploded');
  }
}

/** Resolves with the rejection reason so assertions stay precise. */
const capture = async (work: () => Promise<unknown>): Promise<Error | undefined> => {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

/**
 * Narrows a captured rejection to a concrete error type. `assert.ok` cannot
 * narrow here because the repository's `node:assert` shim is untyped, so this
 * throws on a mismatch instead of relying on assertion-based narrowing.
 */
const expectInstance = <T>(value: unknown, ctor: new (...args: any[]) => T, label: string): T => {
  if (!(value instanceof ctor)) {
    const received = value === undefined ? 'a resolved promise' : 'an unexpected error';
    throw new Error(`expected ${label} but received ${received}`);
  }
  return value;
};

// --- Routing ------------------------------------------------------------

test('phase5: router routes an advertised capability to a provider', async () => {
  const router = new SimpleModelRouter([new ScriptedModelProvider({ PLAN: { answer: 42 } })]);

  assert.deepEqual(await router.request('PLAN', {}), { answer: 42 });
});

test('phase5: architecture roles resolve to provider-neutral capabilities', () => {
  assert.deepEqual(Object.keys(MODEL_ROLE_CAPABILITY).sort(), [
    'Grounder',
    'Intent',
    'Planner',
    'Verifier',
  ]);
  assert.equal(MODEL_ROLE_CAPABILITY.Intent, 'UNDERSTAND_INTENT');
  assert.equal(MODEL_ROLE_CAPABILITY.Planner, 'PLAN');
  assert.equal(MODEL_ROLE_CAPABILITY.Grounder, 'DESCRIBE_SCREEN');
  assert.equal(MODEL_ROLE_CAPABILITY.Verifier, 'VERIFY_OUTCOME');
});

test('phase5: role requests route through the role table', async () => {
  const planner = new RecordingModelProvider('planner', ['PLAN']);
  const router = new SimpleModelRouter([planner]);

  const response = await router.requestRole('Planner', {});

  assert.equal(response.handledBy, 'planner');
  assert.deepEqual(planner.calls, ['PLAN']);
});

test('phase5: unsupported capability is rejected explicitly and no provider is called', async () => {
  const provider = new RecordingModelProvider('planner-only', ['PLAN']);
  const router = new SimpleModelRouter([provider]);

  const error = expectInstance(
    await capture(() => router.request('VERIFY_OUTCOME', {})),
    UnsupportedCapabilityError,
    'UnsupportedCapabilityError',
  );

  assert.equal(error.capability, 'VERIFY_OUTCOME');
  assert.match(error.message, /No registered provider supports capability: VERIFY_OUTCOME/);
  assert.deepEqual(provider.calls, []);
});

test('phase5: provider failure is explicit, never a success, and never retried', async () => {
  const provider = new FailingModelProvider(['PLAN']);
  const router = new SimpleModelRouter([provider]);

  const error = expectInstance(
    await capture(() => router.request('PLAN', {})),
    ModelProviderError,
    'ModelProviderError',
  );

  assert.equal(error.capability, 'PLAN');
  assert.equal(error.providerKind, 'failing');
  assert.match(error.message, /provider exploded/);
  // Exactly one invocation: the router must not hide a retry loop.
  assert.deepEqual(provider.calls, ['PLAN']);
});

test('phase5: provider selection is deterministic', async () => {
  const first = new RecordingModelProvider('first', ['PLAN']);
  const second = new RecordingModelProvider('second', ['PLAN']);
  const router = new SimpleModelRouter([first, second]);

  assert.equal(router.resolveProvider('PLAN'), first);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await router.request('PLAN', {})).handledBy, 'first');
  }

  assert.deepEqual(first.calls, ['PLAN', 'PLAN', 'PLAN']);
  assert.deepEqual(second.calls, []);
});

test('phase5: multiple providers with different capabilities route independently', async () => {
  const planner = new RecordingModelProvider('planner', ['PLAN']);
  const verifier = new RecordingModelProvider('verifier', ['VERIFY_OUTCOME']);
  const router = new SimpleModelRouter([planner, verifier]);

  assert.equal((await router.request('PLAN', {})).handledBy, 'planner');
  assert.equal((await router.request('VERIFY_OUTCOME', {})).handledBy, 'verifier');

  assert.deepEqual(planner.calls, ['PLAN']);
  assert.deepEqual(verifier.calls, ['VERIFY_OUTCOME']);
});

test('phase5: router never selects a provider that does not advertise the capability', async () => {
  // The first provider would answer if asked, but advertises nothing: it must
  // never be selected and must never be invoked.
  const notAdvertised = new RecordingModelProvider('not-advertised', []);
  const advertised = new RecordingModelProvider('advertised', ['PLAN']);
  const router = new SimpleModelRouter([notAdvertised, advertised]);

  assert.equal(router.resolveProvider('PLAN'), advertised);
  assert.equal((await router.request('PLAN', {})).handledBy, 'advertised');
  assert.deepEqual(notAdvertised.calls, []);
});

test('phase5: router exposes only capabilities it can actually serve', () => {
  const router = new SimpleModelRouter([new ScriptedModelProvider({ PLAN: { answer: 1 } })]);

  assert.equal(router.supports('PLAN'), true);
  assert.equal(router.supports('VERIFY_OUTCOME'), false);
  assert.equal(router.resolveProvider('VERIFY_OUTCOME'), undefined);
});

test('phase5: a consumer holding only the ModelRouter contract completes a request', async () => {
  const provider = new RecordingModelProvider('recorder', ['PLAN']);
  // Typed as the core contract: no consumer needs to know which provider exists.
  const router: ModelRouter = new SimpleModelRouter([provider]);

  const response = await router.request('PLAN', { goal: 'anything' });

  assert.deepEqual(response, { handledBy: 'recorder', capability: 'PLAN' });
  assert.deepEqual(provider.calls, ['PLAN']);
});

test('phase5: ScriptedModelProvider keeps its deterministic contract', async () => {
  const provider = new ScriptedModelProvider({ PLAN: { answer: 42 } });

  assert.equal(provider.providerKind, 'scripted');
  assert.equal(provider.supports('PLAN'), true);
  assert.equal(provider.supports('VERIFY_OUTCOME'), false);
  assert.deepEqual(await provider.request('PLAN', {}), { answer: 42 });

  const error = expectInstance(
    await capture(() => provider.request('VERIFY_OUTCOME', {})),
    Error,
    'Error',
  );
  assert.match(error.message, /Unsupported capability: VERIFY_OUTCOME/);
});

// --- Architecture guardrails --------------------------------------------

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readSource = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

/** Vendor names that must never appear in contracts or routing logic. */
const VENDOR_TOKENS = [
  'claude',
  'gemini',
  'openai',
  'anthropic',
  'mistral',
  'llama',
  'copilot',
  'bedrock',
  'vertex',
];

test('phase5: contracts and routing stay provider-neutral', () => {
  for (const path of ['packages/core/index.ts', 'packages/models/index.ts']) {
    const source = readSource(path).toLowerCase();
    for (const vendor of VENDOR_TOKENS) {
      assert.equal(
        source.includes(vendor),
        false,
        `${path} must not mention the vendor name "${vendor}"`,
      );
    }
  }
});

test('phase5: core does not depend on the models package or any provider', () => {
  const core = readSource('packages/core/index.ts');

  assert.doesNotMatch(core, /from\s+['"][^'"]*models[^'"]*['"]/);
  assert.equal(core.includes('ScriptedModelProvider'), false);
  assert.equal(core.includes('SimpleModelRouter'), false);
});

test('phase5: no core/task/action/perception module imports a concrete provider', () => {
  const packagesDir = join(repoRoot, 'packages');
  const available = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Core, task, action and perception must reach models only through the
  // ModelRouter contract, never through a concrete provider implementation.
  const consumers = ['core', 'task-engine', 'action-engine', 'perception'];

  for (const name of consumers) {
    assert.ok(available.includes(name), `expected package "${name}" to exist`);

    const source = readSource(join('packages', name, 'index.ts'));

    assert.equal(
      source.includes('ScriptedModelProvider'),
      false,
      `${name} must not reference a concrete provider implementation`,
    );
    assert.doesNotMatch(
      source,
      /from\s+['"][^'"]*\/models\/[^'"]*['"]/,
      `${name} must not import the concrete provider package`,
    );
  }
});

