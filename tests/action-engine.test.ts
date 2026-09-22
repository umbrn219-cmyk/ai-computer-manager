import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ActionEngine } from '../packages/action-engine/index.js';
import { SafetyKernel } from '../packages/policy-engine/index.js';
import type {
  Action,
  ActionResult,
  PlatformAdapter,
  UIStateGraph,
  PerceptionProvider,
  UIElement,
} from '../packages/core/index.js';

// ── Deterministic mock infrastructure ──────────────────────────────────────────

type ScriptedObservation = {
  readonly elements: readonly UIElement[];
  readonly stateSignature: string;
};

/**
 * Returns a scripted sequence of UI states. The final entry repeats forever, so
 * a stable-state scenario only needs a single entry.
 */
class ScriptedPerceptionProvider implements PerceptionProvider {
  readonly providerKind = 'scripted-mock';
  private readonly states: readonly ScriptedObservation[];
  private index = 0;

  constructor(states: readonly ScriptedObservation[]) {
    assert.ok(states.length > 0, 'ScriptedPerceptionProvider requires at least one observation');
    this.states = states;
  }

  get observationCount(): number {
    return this.index;
  }

  async observe(): Promise<UIStateGraph> {
    const position = Math.min(this.index, this.states.length - 1);
    this.index += 1;
    const state = this.states[position];
    if (state === undefined) {
      throw new Error('scripted observation unavailable');
    }
    return {
      windowId: 'scripted-window',
      title: 'Scripted Test UI',
      elements: state.elements,
      timestamp: 1_700_000_000_000 + this.index,
      stateSignature: state.stateSignature,
    };
  }
}

/**
 * Records every actuation attempt and replays scripted results. The final
 * scripted result repeats forever, so retry scenarios need only one entry.
 */
class RecordingPlatformAdapter implements PlatformAdapter {
  readonly executed: Action[] = [];
  private readonly results: readonly ActionResult[];
  private index = 0;

  constructor(results: readonly ActionResult[] = [{ ok: true, message: 'recorded-ok' }]) {
    this.results = results;
  }

  get executionCount(): number {
    return this.executed.length;
  }

  async observe(): Promise<Readonly<Record<string, unknown>>> {
    return { mock: true };
  }

  async execute(action: Action): Promise<ActionResult> {
    this.executed.push(action);
    const position = Math.min(this.index, this.results.length - 1);
    this.index += 1;
    return this.results[position] ?? { ok: true, message: 'recorded-ok' };
  }
}

const button = (label: string, id?: string): UIElement => ({
  id: id ?? `btn-${label}`,
  role: 'BUTTON',
  label,
  states: ['enabled'],
  childIds: [],
  metadata: {},
});

const link = (label: string, id?: string): UIElement => ({
  id: id ?? `lnk-${label}`,
  role: 'LINK',
  label,
  states: ['enabled'],
  childIds: [],
  metadata: {},
});

const SIGNATURE = 'sig-1';
const OTHER_SIGNATURE = 'sig-2';

// NOTE: domain choice matters for these tests. The existing SafetyKernel allows
// OBSERVATION / UI / FILESYSTEM and fails closed for NETWORK / CREDENTIAL /
// FINANCIAL / SYSTEM. The engine itself must not add domain policy.
const ALLOWED_DOMAIN = 'OBSERVATION';

type EngineOptions = Partial<{ maxAttempts: number; retryableActions: readonly string[] }>;

function makeEngine(
  perception: ScriptedPerceptionProvider,
  platform: RecordingPlatformAdapter,
  options?: EngineOptions,
): ActionEngine {
  return options === undefined
    ? new ActionEngine(null, perception, platform)
    : new ActionEngine(null, perception, platform, options);
}

/** A single-element UI whose signature repeats for every observation. */
const stableUi = (stateSignature: string = SIGNATURE): ScriptedObservation[] => [
  { elements: [button('Submit')], stateSignature },
];

test('phase4-A: missing target is rejected and PlatformAdapter.execute is never called', async () => {
  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter();
  const engine = makeEngine(perception, platform);

  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Not Present',
    stateSignature: SIGNATURE,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.decision, 'user_intervention');
  assert.equal(outcome.attempts, 0);
  assert.match(outcome.message, /missing target/i);
  assert.equal(platform.executionCount, 0);
  assert.deepEqual(platform.executed, []);
});

test('phase4-B: ambiguous target is rejected and PlatformAdapter.execute is never called', async () => {
  const perception = new ScriptedPerceptionProvider([
    {
      elements: [button('Pay', 'btn-pay-1'), button('Pay', 'btn-pay-2'), link('Pay', 'lnk-pay')],
      stateSignature: SIGNATURE,
    },
  ]);
  const platform = new RecordingPlatformAdapter();
  const engine = makeEngine(perception, platform);

  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Pay',
    stateSignature: SIGNATURE,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.decision, 'user_intervention');
  assert.match(outcome.message, /^Ambiguous target: 3 elements match "Pay"$/);
  assert.equal(platform.executionCount, 0);
  assert.deepEqual(platform.executed, []);
});

test('phase4-C: stale stateSignature is rejected and PlatformAdapter.execute is never called', async () => {
  // The UI reports OTHER_SIGNATURE but the action was grounded against SIGNATURE.
  const perception = new ScriptedPerceptionProvider(stableUi(OTHER_SIGNATURE));
  const platform = new RecordingPlatformAdapter();
  const engine = makeEngine(perception, platform);

  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Submit',
    stateSignature: SIGNATURE,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.decision, 'user_intervention');
  assert.match(outcome.message, /State mismatch \(stale\)/);
  assert.equal(platform.executionCount, 0);
  assert.deepEqual(platform.executed, []);
});

test('phase4-D: existing SafetyKernel denial blocks actuation', async () => {
  const action: Action = {
    type: 'CLICK',
    domain: 'SYSTEM',
    target: 'Submit',
    stateSignature: SIGNATURE,
  };

  // The rejection must come from the existing policy boundary, not the engine.
  assert.equal(new SafetyKernel().authorize(action).allowed, false);

  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter();
  const engine = makeEngine(perception, platform);

  const outcome = await engine.submitAction(action);

  assert.equal(outcome.success, false);
  assert.equal(outcome.decision, 'user_intervention');
  // Grounding and state validation both passed, so the SafetyKernel is the gate.
  assert.match(outcome.message, /SafetyKernel denied: High-risk actions/);
  assert.equal(platform.executionCount, 0);
  assert.deepEqual(platform.executed, []);
});

test('phase4-E: user interference before actuation is detected and execute is never called', async () => {
  const elements = [button('Submit')];
  const perception = new ScriptedPerceptionProvider([
    { elements, stateSignature: SIGNATURE }, // observation 1: target grounding
    { elements, stateSignature: SIGNATURE }, // observation 2: initial state validation
    { elements, stateSignature: OTHER_SIGNATURE }, // observation 3: user changed the UI
  ]);
  const platform = new RecordingPlatformAdapter();
  const engine = makeEngine(perception, platform);

  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Submit',
    stateSignature: SIGNATURE,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.decision, 'user_intervention');
  assert.match(outcome.message, /User interference detected/);
  assert.equal(perception.observationCount, 3);
  assert.equal(platform.executionCount, 0);
  assert.deepEqual(platform.executed, []);
});

test('phase4-F: valid action executes exactly once and reports success', async () => {
  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter([{ ok: true, message: 'recorded-ok' }]);
  const engine = makeEngine(perception, platform);

  const action: Action = {
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Submit',
    stateSignature: SIGNATURE,
  };

  const outcome = await engine.submitAction(action);

  assert.equal(outcome.success, true);
  assert.equal(outcome.decision, 'success');
  assert.equal(outcome.attempts, 1);
  assert.equal(platform.executionCount, 1);
  assert.deepEqual(platform.executed, [action]);
  // grounding + initial validation + pre-actuation re-check + fresh observation
  assert.equal(perception.observationCount, 4);
});

test('phase4-G: financial action is blocked by the existing SafetyKernel and never executed', async () => {
  const action: Action = {
    type: 'CLICK',
    domain: 'FINANCIAL',
    target: 'Submit',
    payload: { amount: 100 },
    stateSignature: SIGNATURE,
  };

  // The existing policy boundary classifies and blocks this action.
  const kernel = new SafetyKernel();
  assert.equal(kernel.classify(action), 'FINANCIAL');
  assert.equal(kernel.authorize(action).allowed, false);

  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter();
  const engine = makeEngine(perception, platform);

  const outcome = await engine.submitAction(action);

  assert.equal(outcome.success, false);
  assert.match(outcome.message, /SafetyKernel denied: Financial actions are blocked/);
  assert.equal(platform.executionCount, 0);
  assert.deepEqual(platform.executed, []);
});

test('phase4-H: retryable action retries and execution count never exceeds maxAttempts', async () => {
  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter([{ ok: false, message: 'transient failure' }]);
  const engine = makeEngine(perception, platform, {
    maxAttempts: 3,
    retryableActions: ['CLICK'],
  });

  // No stateSignature on purpose: this isolates retry behaviour from staleness.
  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Submit',
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.decision, 'recovery');
  assert.equal(outcome.attempts, 3);
  assert.equal(platform.executionCount, 3);
  assert.ok(platform.executionCount <= 3, 'must never exceed the configured maxAttempts');
});

test('phase4-H: bounded retry respects a smaller configured maxAttempts', async () => {
  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter([{ ok: false, message: 'transient failure' }]);
  const engine = makeEngine(perception, platform, {
    maxAttempts: 2,
    retryableActions: ['CLICK'],
  });

  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Submit',
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.attempts, 2);
  assert.equal(platform.executionCount, 2);
  assert.ok(platform.executionCount <= 2, 'must never exceed the configured maxAttempts');
});


test('phase4-I: non-retryable failed action is not automatically re-executed', async () => {
  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter([{ ok: false, message: 'permanent failure' }]);
  // 'CLICK' is deliberately absent from retryableActions, so the action is
  // non-retryable even though maxAttempts would allow more iterations.
  const engine = makeEngine(perception, platform, { maxAttempts: 5 });

  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Submit',
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.decision, 'recovery');
  assert.equal(outcome.attempts, 1);
  assert.equal(platform.executionCount, 1);
  assert.equal(platform.executed.length, 1);
});

test('phase4-I: explicit retryable=false is actuated at most once regardless of retry config', async () => {
  const perception = new ScriptedPerceptionProvider(stableUi());
  const platform = new RecordingPlatformAdapter([{ ok: false, message: 'permanent failure' }]);
  const engine = makeEngine(perception, platform, {
    maxAttempts: 4,
    retryableActions: ['CLICK'],
  });

  const outcome = await engine.submitAction({
    type: 'CLICK',
    domain: ALLOWED_DOMAIN,
    target: 'Submit',
    retryable: false,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.attempts, 1);
  assert.equal(platform.executionCount, 1);
  assert.equal(platform.executed.length, 1);
});

