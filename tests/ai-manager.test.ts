// Phase 6 - AI Manager / Planning Layer tests.
// Deterministic doubles only: a recording ModelProvider behind the real
// SimpleModelRouter, so role routing, failure surfacing and the
// "plan only, never execute" guarantees are all proven against the actual
// production code paths.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ModelCapability, ModelRouter } from '../packages/core/index.js';
import { SimpleModelRouter, UnsupportedCapabilityError } from '../packages/models/index.js';
import { AIManager, DEFAULT_AI_MANAGER_LIMITS, parsePlanResponse } from '../packages/ai-manager/index.js';

// --- Deterministic doubles -----------------------------------------------------

type RecordedCall = { capability: ModelCapability; input: unknown };

class RecordingProvider {
  readonly calls: RecordedCall[] = [];
  readonly scripted: Readonly<Record<string, unknown>>;

  constructor(scripted: Readonly<Record<string, unknown>> = {}) {
    this.scripted = scripted;
  }

  supports(capability: ModelCapability): boolean {
    return (
      capability === 'UNDERSTAND_INTENT' ||
      capability === 'PLAN' ||
      capability === 'DESCRIBE_SCREEN' ||
      capability === 'VERIFY_OUTCOME'
    );
  }

  async request(capability: ModelCapability, input: unknown): Promise<Readonly<Record<string, unknown>>> {
    this.calls.push({ capability, input });
    const key = String(capability);
    if (!(key in this.scripted)) {
      throw new UnsupportedCapabilityError(key as never);
    }
    return this.scripted[key] as Readonly<Record<string, unknown>>;
  }
}

class FailingProvider extends RecordingProvider {
  constructor(private readonly error: Error) {
    super();
  }

  async request(): Promise<never> {
    throw this.error;
  }
}

/**
 * Succeeds at intent understanding but always throws on PLAN. Used to prove the
 * retry budget applies to genuine provider failures (a transient condition)
 * without ever becoming unbounded.
 */
class PlannerFailingProvider extends RecordingProvider {
  constructor() {
    super({ UNDERSTAND_INTENT: VALID_INTENT });
  }

  async request(capability: ModelCapability, input: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (capability === 'PLAN') {
      this.calls.push({ capability, input });
      throw new Error('planner unavailable');
    }
    return super.request(capability, input);
  }
}

const VALID_INTENT = { objective: 'Open the settings page', constraints: [] };
const VALID_PLANNER_RESPONSE = {
  steps: [
    { id: 's1', description: 'Open settings', action: { type: 'CLICK', domain: 'UI', target: 'Settings' } },
    { id: 's2', description: 'Wait for load' },
  ],
};

const makeManager = (
  plannerResponse: unknown = VALID_PLANNER_RESPONSE,
  intentResponse: unknown = VALID_INTENT,
  limits = DEFAULT_AI_MANAGER_LIMITS,
): { manager: AIManager; provider: RecordingProvider } => {
  const provider = new RecordingProvider({
    UNDERSTAND_INTENT: intentResponse,
    PLAN: plannerResponse,
  });
  const router: ModelRouter = new SimpleModelRouter([provider]);
  return { manager: new AIManager(router, limits), provider };
};

test('phase6-F: empty goal and empty plan are rejected deterministically', async () => {
  const emptyGoal = await makeManager().manager.plan('   ');
  assert.equal(emptyGoal.ok, false);
  if (emptyGoal.ok) return;
  assert.equal(emptyGoal.reason, 'empty_goal');

  const emptyPlan = parsePlanResponse({ steps: [] }, DEFAULT_AI_MANAGER_LIMITS);
  assert.equal(emptyPlan.ok, false);
  if (emptyPlan.ok) return;
  assert.equal(emptyPlan.reason, 'plan_empty');

  // End-to-end: an empty plan is a deterministic failure, not attempts_exhausted.
  const { manager, provider } = makeManager({ steps: [] });
  const planned = await manager.plan('Open the settings page');
  assert.equal(planned.ok, false);
  if (planned.ok) return;
  assert.equal(planned.reason, 'plan_empty');
  assert.equal(planned.attempts, 1);
  assert.equal(provider.calls.filter((c) => c.capability === 'PLAN').length, 1);
});

test('phase6-T: successful planning returns a validated plan only - no execution artifacts', async () => {
  const { manager, provider } = makeManager();
  const result = await manager.plan('Open the settings page');
  assert.equal(result.ok, true);
  // Exactly two model calls: intent + planner. Nothing else happened.
  assert.equal(provider.calls.length, 2);
  for (const call of provider.calls) {
    assert.ok(['UNDERSTAND_INTENT', 'PLAN'].includes(String(call.capability)));
  }
});

test('phase6-B+D: intent and planner roles are routed through ModelRouter with role capabilities', async () => {
  const { manager, provider } = makeManager();
  await manager.plan('Open the settings page');
  assert.equal(provider.calls.length, 2);
  assert.equal(String(provider.calls[0]?.capability), 'UNDERSTAND_INTENT');
  assert.equal(String(provider.calls[1]?.capability), 'PLAN');
  const plannerInput = provider.calls[1]?.input as Record<string, unknown>;
  assert.equal(plannerInput['goal'], 'Open the settings page');
});

// --- PHASE 6-E/H/I/G/J: untrusted output validation ------------------------------

test('phase6-E: malformed planner responses surface plan_malformed and are never retried', async () => {
  for (const bad of [null, 'steps', 42, {}, { steps: 'nope' }]) {
    const { manager, provider } = makeManager(bad);
    const result = await manager.plan('Open the settings page');
    assert.equal(result.ok, false);
    if (result.ok) continue;
    // The leaf reason is surfaced directly, not wrapped into attempts_exhausted.
    assert.equal(result.reason, 'plan_malformed');
    assert.equal(result.attempts, 1);
    // Deterministic validation failures must not consume retry attempts.
    assert.equal(provider.calls.filter((c) => c.capability === 'PLAN').length, 1);
  }
});

test('phase6-G: unknown action type is rejected deterministically through the AI Manager', async () => {
  const bad = {
    steps: [{ id: 's1', description: 'x', action: { type: 'DEPLOY_TO_PRODUCTION', domain: 'SYSTEM' } }],
  };
  const parsed = parsePlanResponse(bad, DEFAULT_AI_MANAGER_LIMITS);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.reason, 'unknown_action_type');

  // End-to-end: same leaf reason, single planner call, no attempts_exhausted.
  const { manager, provider } = makeManager(bad);
  const result = await manager.plan('Open the settings page');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unknown_action_type');
  assert.equal(result.attempts, 1);
  assert.equal(provider.calls.filter((c) => c.capability === 'PLAN').length, 1);
});

test('phase6-H: malformed step/action structure is rejected deterministically through the AI Manager', async () => {
  const missingId = parsePlanResponse({ steps: [{ id: '', description: 'x' }] }, DEFAULT_AI_MANAGER_LIMITS);
  assert.equal(missingId.ok, false);
  if (!missingId.ok) assert.equal(missingId.reason, 'step_invalid');

  const missingDomain = parsePlanResponse(
    { steps: [{ id: 's1', description: 'x', action: { type: 'CLICK' } }] },
    DEFAULT_AI_MANAGER_LIMITS,
  );
  assert.equal(missingDomain.ok, false);
  if (!missingDomain.ok) assert.equal(missingDomain.reason, 'invalid_risk_domain');

  // End-to-end via AIManager.plan(): same deterministic leaf reason, no retry.
  const { manager, provider } = makeManager({ steps: [{ id: '', description: 'x' }] });
  const result = await manager.plan('Open the settings page');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'step_invalid');
  assert.equal(result.attempts, 1);
  assert.equal(provider.calls.filter((c) => c.capability === 'PLAN').length, 1);
});

test('phase6-I: invalid risk domain is rejected deterministically through the AI Manager', async () => {
  const bad = { steps: [{ id: 's1', description: 'x', action: { type: 'CLICK', domain: 'NUCLEAR' } }] };
  const parsed = parsePlanResponse(bad, DEFAULT_AI_MANAGER_LIMITS);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.reason, 'invalid_risk_domain');

  const { manager, provider } = makeManager(bad);
  const result = await manager.plan('Open the settings page');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid_risk_domain');
  assert.equal(result.attempts, 1);
  assert.equal(provider.calls.filter((c) => c.capability === 'PLAN').length, 1);
});

test('phase6-J: plan exceeding maxSteps returns plan_too_large and is never truncated', async () => {
  const many = { steps: Array.from({ length: 4 }, (_, i) => ({ id: `s${String(i)}`, description: 'x' })) };
  const limits = { ...DEFAULT_AI_MANAGER_LIMITS, maxSteps: 3 };
  const { manager, provider } = makeManager(many, VALID_INTENT, limits);
  const result = await manager.plan('g');
  assert.equal(result.ok, false);
  if (result.ok) return;
  // The oversized plan keeps its own leaf reason (not attempts_exhausted) ...
  assert.equal(result.reason, 'plan_too_large');
  assert.equal(result.attempts, 1);
  // ... and is neither retried nor silently truncated.
  assert.equal(provider.calls.filter((c) => c.capability === 'PLAN').length, 1);
});

test('phase6-K: genuine provider failures stay bounded by maxPlanningAttempts', async () => {
  const limits = { ...DEFAULT_AI_MANAGER_LIMITS, maxPlanningAttempts: 3 };
  const provider = new PlannerFailingProvider();
  const manager = new AIManager(new SimpleModelRouter([provider]), limits);
  const result = await manager.plan('Open the settings page');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'provider_failure');
  // Retried, but never beyond the configured budget.
  assert.equal(provider.calls.filter((c) => c.capability === 'PLAN').length, 3);
  assert.equal(result.attempts, 3);
});

test('phase6-K2: deterministic validation failures never become attempts_exhausted', async () => {
  const oversized = { steps: Array.from({ length: 4 }, (_, i) => ({ id: `s${String(i)}`, description: 'x' })) };
  const cases: readonly { readonly label: string; readonly plan: unknown; readonly expected: string }[] = [
    { label: 'malformed', plan: null, expected: 'plan_malformed' },
    { label: 'empty', plan: { steps: [] }, expected: 'plan_empty' },
    { label: 'oversized', plan: oversized, expected: 'plan_too_large' },
    { label: 'invalid step', plan: { steps: [{ id: '', description: 'x' }] }, expected: 'step_invalid' },
    {
      label: 'unknown action',
      plan: { steps: [{ id: 's1', description: 'x', action: { type: 'NOPE', domain: 'UI' } }] },
      expected: 'unknown_action_type',
    },
    {
      label: 'invalid domain',
      plan: { steps: [{ id: 's1', description: 'x', action: { type: 'CLICK', domain: 'NUCLEAR' } }] },
      expected: 'invalid_risk_domain',
    },
  ];
  const limits = { ...DEFAULT_AI_MANAGER_LIMITS, maxSteps: 3, maxPlanningAttempts: 3 };
  for (const testCase of cases) {
    const { manager, provider } = makeManager(testCase.plan, VALID_INTENT, limits);
    const result = await manager.plan('Open the settings page');
    assert.equal(result.ok, false, `${testCase.label} must fail`);
    if (result.ok) continue;
    assert.equal(result.reason, testCase.expected, `${testCase.label} must keep its leaf reason`);
    assert.notEqual(result.reason, 'attempts_exhausted', `${testCase.label} must not be attempts_exhausted`);
    assert.equal(result.attempts, 1, `${testCase.label} must not consume retry attempts`);
    assert.equal(
      provider.calls.filter((c) => c.capability === 'PLAN').length,
      1,
      `${testCase.label} must issue a single planner call`,
    );
  }
});

// --- PHASE 6-L/M: provider failure surfaced deterministically ---------------------

test('phase6-L: provider failure is surfaced deterministically, never converted to success', async () => {
  const provider = new FailingProvider(new Error('provider exploded'));
  const manager = new AIManager(new SimpleModelRouter([provider]));
  const result = await manager.plan('Open the settings page');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'provider_failure');
});

test('phase6-M: unsupported capability is surfaced deterministically', async () => {
  class NoCapabilities {
    supports(): boolean {
      return false;
    }
    async request(): Promise<never> {
      throw new UnsupportedCapabilityError('UNDERSTAND_INTENT' as never);
    }
  }
  const manager = new AIManager(new SimpleModelRouter([new NoCapabilities()]));
  const result = await manager.plan('Open the settings page');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unsupported_capability');
});

// --- PHASE 6-P/Q: safety separation ----------------------------------------------

test('phase6-Q: financial action may be represented but never pre-authorized by the model', async () => {
  const financialPlan = {
    steps: [
      {
        id: 'pay',
        description: 'Pay invoice',
        action: { type: 'CLICK', domain: 'FINANCIAL' },
        // Model-provided authorization flags must be dropped, never trusted.
        authorized: true,
        approved: true,
      },
    ],
  };
  const result = await makeManager(financialPlan).manager.plan('Pay the invoice');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const step = result.plan.steps[0] as NonNullable<typeof result.plan.steps[0]>;
  assert.ok(step !== undefined);
  assert.equal((step.action as { domain: string }).domain, 'FINANCIAL');
  assert.equal('authorized' in step, false);
  assert.equal(step.verified, false);
});

// --- PHASE 6-R/S/N/O: architecture guards -----------------------------------------

const AI_MANAGER_DIR = join(process.cwd(), 'packages', 'ai-manager');

const collectTsFiles = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
};

test('phase6-R: the AI Manager package never imports a concrete provider, SDK or network client', () => {
  const files = collectTsFiles(AI_MANAGER_DIR);
  assert.ok(files.length >= 1);
  const forbidden = /claude|openai|anthropic|gemini|gpt|axios|node-fetch|http|https|require\(/i;
  for (const file of files) {
    const imports = readFileSync(file, 'utf8').match(/^import[^;]+;/gm) ?? [];
    for (const line of imports) {
      assert.ok(!forbidden.test(line), `forbidden import in ${file}: ${line}`);
    }
  }
});

test('phase6-N/O: the AI Manager package never imports platform, engine or kernel execution modules', () => {
  for (const file of collectTsFiles(AI_MANAGER_DIR)) {
    const imports = readFileSync(file, 'utf8').match(/^import[^;]+;/gm) ?? [];
    for (const line of imports) {
      assert.ok(
        !/platform|action-engine|policy-engine|task-engine|child_process|fs\/promises/i.test(line),
        `forbidden dependency import in ${file}: ${line}`,
      );
    }
  }
});

test('phase6-S: no vendor name appears anywhere in the AI Manager module', () => {
  const text = readFileSync(join(AI_MANAGER_DIR, 'index.ts'), 'utf8');
  assert.ok(!/claude|openai|anthropic|gemini|gpt-|azure/i.test(text));
});
