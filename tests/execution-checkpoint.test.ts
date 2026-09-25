// Phase 8 - durable execution checkpoint & recovery tests.
//
// Real contract implementations throughout: the actual InMemoryStorage (now the
// checkpoint store), the actual DeterministicTaskEngine, the actual Phase-4
// ActionEngine and the actual ExecutionOrchestrator. Only perception, the
// platform and the verifier are deterministic doubles.
//
// "Process restart" is simulated honestly: a SECOND orchestrator instance is
// constructed over the SAME storage, with no in-memory cursor and no plan
// registry, exactly as a fresh process would have. The test runner is never
// killed.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Action,
  ActionResult,
  ExecutionCheckpoint,
  PerceptionProvider,
  PlatformAdapter,
  Task,
  UIElement,
  UIStateGraph,
} from '../packages/core/index.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  CheckpointRejectedError,
  materializeCheckpoint,
  validateCheckpoint,
} from '../packages/core/index.js';
import { ActionEngine } from '../packages/action-engine/index.js';
import { DeterministicTaskEngine } from '../packages/task-engine/index.js';
import { InMemoryStorage } from '../packages/storage/index.js';
import type { PlannedStep, TaskPlan } from '../packages/ai-manager/index.js';
import {
  ExecutionOrchestrator,
  planFingerprint,
} from '../packages/execution-orchestrator/index.js';
import type {
  StepVerifier,
  VerificationDecision,
  VerificationRequest,
} from '../packages/execution-orchestrator/index.js';

// --- Deterministic doubles -----------------------------------------------------

const button = (id: string, label: string): UIElement => ({
  id,
  role: 'BUTTON',
  label,
  states: ['enabled'],
  childIds: [],
  metadata: {},
});

/** Perception with a controllable signature and a replaceable element set. */
class ScriptedPerception implements PerceptionProvider {
  readonly providerKind = 'scripted';
  observeCount = 0;
  failAfter = Number.POSITIVE_INFINITY;
  elements: readonly UIElement[];
  private cursor = 0;

  constructor(
    private readonly signatures: readonly string[],
    elements: readonly UIElement[],
  ) {
    this.elements = elements;
  }

  async observe(): Promise<UIStateGraph> {
    this.observeCount += 1;
    if (this.observeCount > this.failAfter) throw new Error('perception unavailable');
    const last = this.signatures[this.signatures.length - 1] ?? 'sig-0';
    const signature = this.signatures[Math.min(this.cursor, this.signatures.length - 1)] ?? last;
    this.cursor += 1;
    return {
      windowId: 'w1',
      title: 'Scripted UI',
      elements: this.elements,
      timestamp: 1,
      stateSignature: signature,
    };
  }
}

/** Platform double: records actuations and returns a scriptable outcome. */
class RecordingPlatform implements PlatformAdapter {
  readonly executed: Action[] = [];

  constructor(private readonly outcome: Readonly<{ ok: boolean; message?: string }> = { ok: true }) {}

  async observe(): Promise<Readonly<Record<string, unknown>>> {
    return { mock: true };
  }

  async execute(action: Action): Promise<ActionResult> {
    this.executed.push(action);
    return this.outcome.message !== undefined
      ? { ok: this.outcome.ok, message: this.outcome.message }
      : { ok: this.outcome.ok };
  }
}

/** Never confirms anything: models a verifier that cannot settle ambiguity. */
class NeverVerifier implements StepVerifier {
  async verify(_request: VerificationRequest): Promise<VerificationDecision> {
    return { verified: false, reason: 'cannot confirm' };
  }
}

/** Confirms an already-observable side effect (no action outcome needed). */
class SideEffectProbeVerifier implements StepVerifier {
  async verify(request: VerificationRequest): Promise<VerificationDecision> {
    return request.actionOutcome === undefined
      ? { verified: true, reason: 'side effect already observable' }
      : { verified: true, reason: 'action accepted' };
  }
}

// --- Plan / action helpers -----------------------------------------------------

const plan = (...steps: readonly PlannedStep[]): TaskPlan => ({ goal: 'test goal', steps });

const step = (id: string, action?: Action): PlannedStep =>
  action === undefined
    ? { id, description: id, verified: false }
    : { id, description: id, action, verified: false };

const click = (target: string, extra?: Readonly<Record<string, unknown>>): Action => ({
  type: 'CLICK',
  domain: 'UI',
  target,
  ...(extra ?? {}),
});

const TWO_STEP_PLAN = (): TaskPlan =>
  plan(step('s1', click('Open')), step('s2', click('Save')));

/** A checkpoint written straight to the store, as a crashed process would leave. */
const checkpointFor = (
  task: Task,
  plan: TaskPlan,
  overrides?: Partial<ExecutionCheckpoint>,
): ExecutionCheckpoint => ({
  taskId: task.id,
  taskVersion: task.version,
  planVersion: planFingerprint(plan),
  activeStepIndex: 0,
  stepAttempts: [],
  verifiedStepIds: [],
  status: 'RUNNING',
  reconcilePending: false,
  checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
  ...(overrides ?? {}),
});

type Harness = Readonly<{
  storage: InMemoryStorage;
  taskEngine: DeterministicTaskEngine;
  perception: ScriptedPerception;
  platform: RecordingPlatform;
  /** The orchestrator "process" currently running. */
  orchestrator: ExecutionOrchestrator;
  /** A brand-new orchestrator over the same storage: a simulated restart. */
  restart: (options?: Readonly<{ verifier?: StepVerifier }>) => ExecutionOrchestrator;
  /** Replace the plan the caller would resolve for this task. */
  setPlan: (next: TaskPlan) => void;
}>;

const makeHarness = (options?: {
  elements?: readonly UIElement[];
  signatures?: readonly string[];
  platformOutcome?: Readonly<{ ok: boolean; message?: string }>;
  plan?: TaskPlan;
}): Harness => {
  const storage = new InMemoryStorage();
  const taskEngine = new DeterministicTaskEngine(storage);
  const perception = new ScriptedPerception(
    options?.signatures ?? ['sig-1'],
    options?.elements ?? [button('b-open', 'Open'), button('b-save', 'Save')],
  );
  const platform = new RecordingPlatform(options?.platformOutcome ?? { ok: true });
  const planRef = { current: options?.plan ?? TWO_STEP_PLAN() };

  const build = (verifier?: StepVerifier): ExecutionOrchestrator =>
    new ExecutionOrchestrator({
      taskEngine,
      perception,
      actionExecutor: new ActionEngine(storage, perception, platform, { maxAttempts: 1 }),
      checkpoints: storage,
      resolvePlan: () => planRef.current,
      ...(verifier !== undefined ? { verifier } : {}),
    });

  return {
    storage,
    taskEngine,
    perception,
    platform,
    orchestrator: build(),
    restart: (restartOptions) => build(restartOptions?.verifier),
    setPlan: (next: TaskPlan) => {
      planRef.current = next;
    },
  };
};

/** Drive a task to RUNNING without any orchestration (a crashed-process setup). */
const readyTask = (taskEngine: DeterministicTaskEngine, goal: string): Task => {
  const created = taskEngine.createTask(goal, 10);
  taskEngine.transition(created.id, 'PLANNING');
  taskEngine.transition(created.id, 'READY');
  return taskEngine.transition(created.id, 'RUNNING');
};

// --- PHASE8-D/E/F/G: checkpoint validation -------------------------------------

test('PHASE8-D: malformed checkpoints are rejected, never repaired', () => {
  const harness = makeHarness();
  const task = readyTask(harness.taskEngine, 'malformed');
  const base = checkpointFor(task, TWO_STEP_PLAN());
  const withOverrides = (overrides: Record<string, unknown>): unknown => ({ ...base, ...overrides });

  const cases: readonly unknown[] = [
    null,
    undefined,
    'checkpoint',
    42,
    [],
    withOverrides({ taskId: '' }),
    withOverrides({ taskId: 7 }),
    withOverrides({ taskVersion: -1 }),
    withOverrides({ planVersion: '' }),
    withOverrides({ status: 'UNKNOWN' }),
    withOverrides({ reconcilePending: 'yes' }),
    withOverrides({ verifiedStepIds: ['s1', 's1'] }),
    withOverrides({ verifiedStepIds: [7] }),
    withOverrides({ stepAttempts: 'nope' }),
    withOverrides({ stepAttempts: [{ index: 1, attempts: 1 }] }),
    withOverrides({ stepAttempts: [{ index: 0, attempts: 1 }, { index: 0, attempts: 2 }] }),
    withOverrides({ reason: '' }),
  ];
  for (const value of cases) {
    const result = validateCheckpoint(value);
    assert.equal(result.valid, false, `expected rejection for ${JSON.stringify(value) ?? 'undefined'}`);
  }

  // A valid checkpoint passes ...
  assert.equal(validateCheckpoint(base).valid, true);
  // ... a mismatched expected task id does not.
  assert.equal(validateCheckpoint(base, 'other-task').valid, false);

  // The store refuses malformed input instead of writing it.
  assert.throws(() => {
    harness.storage.saveCheckpoint(withOverrides({ status: 'UNKNOWN' }) as ExecutionCheckpoint);
  }, CheckpointRejectedError);
  assert.equal(harness.storage.loadCheckpoint(task.id), undefined);
});

test('PHASE8-E: a negative activeStepIndex is rejected', () => {
  const harness = makeHarness();
  const task = readyTask(harness.taskEngine, 'negative index');
  const result = validateCheckpoint(checkpointFor(task, TWO_STEP_PLAN(), { activeStepIndex: -1 }));
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /activeStepIndex/);
  assert.throws(() => {
    harness.storage.saveCheckpoint(checkpointFor(task, TWO_STEP_PLAN(), { activeStepIndex: -1 }));
  }, CheckpointRejectedError);
});

test('PHASE8-F: negative or zero attempt counts are rejected', () => {
  const harness = makeHarness();
  const task = readyTask(harness.taskEngine, 'negative attempts');
  for (const attempts of [-3, 0]) {
    const result = validateCheckpoint(
      checkpointFor(task, TWO_STEP_PLAN(), { stepAttempts: [{ index: 0, attempts }] }),
    );
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /attempts/);
    assert.throws(() => {
      harness.storage.saveCheckpoint(
        checkpointFor(task, TWO_STEP_PLAN(), { stepAttempts: [{ index: 0, attempts }] }),
      );
    }, CheckpointRejectedError);
  }
});

test('PHASE8-G: an unknown checkpoint schema version is rejected', () => {
  const harness = makeHarness();
  const task = readyTask(harness.taskEngine, 'schema version');
  // The schema version is not the task version: bumping only taskVersion is fine,
  // but an unknown schema version is refused.
  const wrongSchema = checkpointFor(task, TWO_STEP_PLAN(), { checkpointVersion: 99 });
  const result = validateCheckpoint(wrongSchema);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /schema version/);
  assert.throws(() => {
    harness.storage.saveCheckpoint(wrongSchema);
  }, CheckpointRejectedError);
  assert.throws(() => {
    harness.storage.saveCheckpoint(
      checkpointFor(task, TWO_STEP_PLAN(), { checkpointVersion: 0 }),
    );
  }, CheckpointRejectedError);
});

test('PHASE8-H: a stale checkpoint cannot overwrite newer state', () => {
  const harness = makeHarness();
  const taskPlan = TWO_STEP_PLAN();
  const task = readyTask(harness.taskEngine, 'stale write');
  harness.storage.saveCheckpoint(
    checkpointFor(task, taskPlan, { activeStepIndex: 1, verifiedStepIds: ['s1'] }),
  );
  const newer = harness.taskEngine.transition(task.id, 'VERIFYING');
  harness.storage.saveCheckpoint(
    checkpointFor(newer, taskPlan, { activeStepIndex: 1, verifiedStepIds: ['s1'] }),
  );
  const before = harness.storage.loadCheckpoint(task.id);

  // Older taskVersion: refused, stored state untouched.
  assert.throws(() => {
    harness.storage.saveCheckpoint(checkpointFor(task, taskPlan, { activeStepIndex: 1 }));
  }, CheckpointRejectedError);
  // Index regression at the same version: refused as well.
  assert.throws(() => {
    harness.storage.saveCheckpoint(checkpointFor(newer, taskPlan, { activeStepIndex: 0 }));
  }, CheckpointRejectedError);

  const after = harness.storage.loadCheckpoint(task.id);
  assert.deepEqual(after, before);
  assert.equal(after?.taskVersion, newer.version);
});

// --- PHASE8-I/P: orchestration writes and cleans up checkpoints -----------------

test('PHASE8-I: the orchestrator checkpoints safe cursor advancement', async () => {
  // Step 1 verifies, step 2 pauses on an ambiguous target: the checkpoint must
  // reflect the advanced cursor and the verified step.
  const ambiguous = plan(step('s1', click('Open')), step('s2', click('Pay')));
  const harness = makeHarness({
    elements: [button('b1', 'Open'), button('b2', 'Pay'), button('b3', 'Pay')],
    plan: ambiguous,
  });
  const outcome = await harness.orchestrator.run({ goal: 'advance', plan: ambiguous });
  assert.equal(outcome.status, 'needs_user');
  assert.equal(outcome.reason, 'ambiguous_target');

  const checkpoint = harness.storage.loadCheckpoint(outcome.taskId ?? '');
  assert.ok(checkpoint !== undefined);
  assert.equal(checkpoint?.activeStepIndex, 1, 'cursor advanced past the verified step');
  assert.deepEqual(checkpoint?.verifiedStepIds, ['s1']);
  assert.equal(checkpoint?.status, 'NEEDS_USER');
  assert.equal(checkpoint?.reconcilePending, false);
  assert.equal(checkpoint?.stepAttempts.length, 2);
});

test('PHASE8-P: a completed task leaves no checkpoint behind', async () => {
  const harness = makeHarness();
  const completed = plan(step('s1', click('Open')), step('s2', click('Save')));
  const outcome = await harness.orchestrator.run({ goal: 'clean up', plan: completed });
  assert.equal(outcome.status, 'completed');
  const taskId = outcome.taskId ?? '';
  assert.ok(taskId.length > 0);
  assert.equal(harness.storage.loadCheckpoint(taskId), undefined);
  assert.equal(harness.platform.executed.length, 2);
});

// --- PHASE8-J/K/L: restart, resume, no replay, restored counters ---------------

/**
 * Drive a two-step run until step 2 pauses on an ambiguous target, then simulate
 * the user resolving the ambiguity and clearing the pause. Step 1 is verified and
 * checkpointed before the pause.
 */
const pauseThenResolve = async (): Promise<
  Readonly<{ harness: Harness; taskId: string; taskPlan: TaskPlan }>
> => {
  const taskPlan = plan(step('s1', click('Open')), step('s2', click('Pay')));
  const harness = makeHarness({
    elements: [button('b1', 'Open'), button('b2', 'Pay'), button('b3', 'Pay')],
    plan: taskPlan,
  });
  const first = await harness.orchestrator.run({ goal: 'pause then resolve', plan: taskPlan });
  assert.equal(first.status, 'needs_user');
  const taskId = first.taskId ?? '';
  assert.ok(taskId.length > 0);
  // The user disambiguates the screen, then clears the pause explicitly.
  harness.perception.elements = [button('b1', 'Open'), button('b2', 'Pay')];
  harness.taskEngine.transition(taskId, 'READY');
  return { harness, taskId, taskPlan };
};

test('PHASE8-J: a verified step is not executed again after a restart', async () => {
  const { harness, taskId } = await pauseThenResolve();
  assert.equal(harness.platform.executed.length, 1);

  // The restarted process has no cursor and no plan registry: the checkpoint and
  // the caller's plan are the only inputs.
  const resumed = await harness.restart().resume(taskId);
  assert.equal(resumed.status, 'completed');

  const targets = harness.platform.executed.map((action) => action.target);
  assert.deepEqual(targets, ['Open', 'Pay']);
  assert.equal(targets.filter((target) => target === 'Open').length, 1, 'step 1 replayed');
});

test('PHASE8-K: resume restores the active step from the checkpoint', async () => {
  const { harness, taskId, taskPlan } = await pauseThenResolve();
  const resumed = await harness.restart().resume(taskId);

  const step1 = resumed.steps.find((entry) => entry.stepId === 's1');
  const step2 = resumed.steps.find((entry) => entry.stepId === 's2');
  assert.equal(step1?.verified, true, 'verified step restored from the checkpoint');
  assert.equal(step1?.index, 0);
  assert.equal(step2?.verified, true);
  assert.equal(step2?.index, 1);
  assert.equal(resumed.steps.length, taskPlan.steps.length);
  // Only step 2 was actuated by the resumed run.
  assert.equal(harness.platform.executed[1]?.target, 'Pay');
  assert.equal(harness.platform.executed.length, 2);
});

test('PHASE8-L: resume restores the bounded attempt counters', async () => {
  const { harness, taskId } = await pauseThenResolve();
  const checkpoint = harness.storage.loadCheckpoint(taskId);
  const restored = checkpoint?.stepAttempts.find((entry) => entry.index === 1)?.attempts ?? 0;
  assert.ok(restored >= 1, 'the pre-pause attempt was checkpointed');

  const resumed = await harness.restart().resume(taskId);
  const step2 = resumed.steps.find((entry) => entry.stepId === 's2');
  // The counter continued from the restored value rather than resetting to zero,
  // which is what keeps the retry budget bounded across a restart.
  assert.equal(step2?.attempts, restored + 1);
});

// --- PHASE8-A/B/C: store round-trip, newest-wins, immutability ------------------

test('PHASE8-A: a checkpoint can be saved and loaded', () => {
  const harness = makeHarness();
  const task = readyTask(harness.taskEngine, 'checkpoint round trip');
  const checkpoint = checkpointFor(task, TWO_STEP_PLAN(), {
    stepAttempts: [{ index: 0, attempts: 1 }],
  });
  harness.storage.saveCheckpoint(checkpoint);
  const loaded = harness.storage.loadCheckpoint(task.id);
  assert.ok(loaded !== undefined);
  assert.equal(loaded?.taskId, task.id);
  assert.equal(loaded?.activeStepIndex, 0);
  assert.equal(loaded?.checkpointVersion, CHECKPOINT_SCHEMA_VERSION);
  assert.equal(loaded?.status, 'RUNNING');
  assert.deepEqual(loaded?.stepAttempts, [{ index: 0, attempts: 1 }]);
});

test('PHASE8-B: replacement returns the newest valid checkpoint', () => {
  const harness = makeHarness();
  const taskPlan = TWO_STEP_PLAN();
  const task = readyTask(harness.taskEngine, 'newest wins');
  harness.storage.saveCheckpoint(checkpointFor(task, taskPlan, { activeStepIndex: 0 }));
  const bumped = harness.taskEngine.transition(task.id, 'VERIFYING');
  harness.storage.saveCheckpoint(
    checkpointFor(bumped, taskPlan, { activeStepIndex: 1, verifiedStepIds: ['s1'] }),
  );
  const loaded = harness.storage.loadCheckpoint(task.id);
  assert.equal(loaded?.activeStepIndex, 1);
  assert.equal(loaded?.taskVersion, bumped.version);
  assert.deepEqual(loaded?.verifiedStepIds, ['s1']);
});

test('PHASE8-C: stored checkpoints are immutable snapshots', () => {
  const harness = makeHarness();
  const task = readyTask(harness.taskEngine, 'immutability');
  const ids: string[] = ['s1'];
  harness.storage.saveCheckpoint(checkpointFor(task, TWO_STEP_PLAN(), { verifiedStepIds: ids }));

  // Mutating the caller's own array afterwards cannot affect stored state.
  ids.push('s2');
  const loaded = harness.storage.loadCheckpoint(task.id);
  assert.deepEqual(loaded?.verifiedStepIds, ['s1']);

  // Snapshots are deeply frozen ...
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded?.verifiedStepIds), true);
  assert.throws(() => {
    (loaded as { activeStepIndex: number }).activeStepIndex = 5;
  });

  // ... and every load yields an independent snapshot, never internal state.
  const other = harness.storage.loadCheckpoint(task.id);
  assert.notEqual(other, loaded);
  assert.deepEqual(other?.verifiedStepIds, ['s1']);
});


// --- PHASE8-M/N/O: privacy boundaries and user control surviving resume ---------

test('PHASE8-M: a NEEDS_USER pause survives a restart and is never auto-crossed', async () => {
  const financial = plan(step('s1', { type: 'CLICK', domain: 'FINANCIAL', target: 'Open' }));
  const harness = makeHarness({ plan: financial });
  const first = await harness.orchestrator.run({ goal: 'pay', plan: financial });
  assert.equal(first.status, 'needs_user');
  const taskId = first.taskId ?? '';
  assert.ok(taskId.length > 0);

  // Restart: no in-memory cursor, no registry - the checkpoint is the only memory.
  const resumed = await harness.restart().resume(taskId);
  assert.equal(resumed.status, 'needs_user');
  assert.equal(resumed.reason, 'authorization_required');
  assert.equal(resumed.task?.state, 'NEEDS_USER');
  assert.notEqual(resumed.status, 'completed');
  assert.equal(harness.platform.executed.length, 0);
});

test('PHASE8-N: financial authorization stays user-controlled after a restart', async () => {
  const financial = plan(step('s1', { type: 'CLICK', domain: 'FINANCIAL', target: 'Open' }));
  const harness = makeHarness({ plan: financial });
  const first = await harness.orchestrator.run({ goal: 'pay', plan: financial });
  const taskId = first.taskId ?? '';
  const checkpoint = harness.storage.loadCheckpoint(taskId);
  assert.equal(checkpoint?.status, 'NEEDS_USER');
  assert.equal(checkpoint?.reason, 'authorization_required');

  // No authorization material is stored anywhere in the checkpoint.
  assert.equal(validateCheckpoint(checkpoint).valid, true);
  assert.equal('authorized' in (checkpoint ?? {}), false);
  assert.equal('token' in (checkpoint ?? {}), false);

  // Even after the user resolves the pause, the kernel still decides: nothing
  // executes autonomously and no approval is manufactured.
  harness.taskEngine.transition(taskId, 'READY');
  const resumed = await harness.restart().resume(taskId);
  assert.equal(resumed.status, 'needs_user');
  assert.equal(resumed.task?.state, 'NEEDS_USER');
  assert.equal(harness.platform.executed.length, 0);
});

test('PHASE8-O: checkpoints cannot carry credentials or raw model/UI data', () => {
  const harness = makeHarness();
  const task = readyTask(harness.taskEngine, 'secrets');
  const smuggled = {
    ...checkpointFor(task, TWO_STEP_PLAN()),
    otp: '123456',
    pin: '4321',
    cardNumber: '4111111111111111',
    authorizationToken: 'secret-token',
    screenshot: 'base64-image',
    modelResponse: 'raw model text',
    prompt: 'raw prompt',
    clickTrace: ['x=1,y=2'],
  };
  harness.storage.saveCheckpoint(smuggled as unknown as ExecutionCheckpoint);
  const loaded = harness.storage.loadCheckpoint(task.id);
  const serialized = JSON.stringify(loaded);
  const expectedKeys = [
    'activeStepIndex',
    'checkpointVersion',
    'planVersion',
    'reconcilePending',
    'status',
    'stepAttempts',
    'taskId',
    'taskVersion',
    'verifiedStepIds',
  ];
  assert.deepEqual(Object.keys(loaded ?? {}).sort(), expectedKeys);
  for (const secret of [
    '123456',
    '4321',
    '4111111111111111',
    'secret-token',
    'base64-image',
    'raw model text',
    'raw prompt',
    'x=1,y=2',
  ]) {
    assert.equal(serialized.includes(secret), false, `checkpoint leaked ${secret}`);
  }
});


// --- PHASE8-Q/R/R2/R3/S: recovery semantics, crash ambiguity, plan fidelity ----

test('PHASE8-Q: a task that terminates outside the orchestrator is cleaned up', async () => {
  const harness = makeHarness();
  const taskPlan = TWO_STEP_PLAN();
  const task = readyTask(harness.taskEngine, 'externally cancelled');
  harness.storage.saveCheckpoint(
    checkpointFor(task, taskPlan, { stepAttempts: [{ index: 0, attempts: 1 }] }),
  );
  // The architecture has no CANCELLED state and no cancel API: a caller-driven
  // stop is an explicit FAILED transition. The checkpoint must not survive it.
  const stopped = harness.taskEngine.transition(task.id, 'FAILED');
  const resumed = await harness.restart().resume(stopped.id);
  assert.equal(resumed.status, 'failed');
  assert.equal(harness.storage.loadCheckpoint(stopped.id), undefined);
  assert.equal(harness.platform.executed.length, 0);
});

test('PHASE8-R: an unconfirmable crash window never blindly replays an action', async () => {
  const taskPlan = plan(step('s1', click('Open', { retryable: false })));
  const harness = makeHarness({ plan: taskPlan });
  const task = readyTask(harness.taskEngine, 'ambiguous crash');
  // The process died after submitting the action but before verifying/checkpointing it.
  harness.storage.saveCheckpoint(
    checkpointFor(task, taskPlan, {
      reconcilePending: true,
      stepAttempts: [{ index: 0, attempts: 1 }],
    }),
  );
  const resumed = await harness.restart({ verifier: new NeverVerifier() }).resume(task.id);
  assert.equal(resumed.status, 'recovery_required');
  assert.equal(resumed.reason, 'recovery_required');
  assert.equal(harness.platform.executed.length, 0, 'the action was NOT blindly replayed');
  assert.equal(resumed.task?.state, 'NEEDS_USER');
  assert.match(resumed.message, /not replayed/);
});

test('PHASE8-R2: a crash that proves the action had not started continues safely', async () => {
  const taskPlan = plan(step('s1', click('Open')));
  const harness = makeHarness({ plan: taskPlan });
  const task = readyTask(harness.taskEngine, 'clean crash');
  harness.storage.saveCheckpoint(
    checkpointFor(task, taskPlan, { reconcilePending: false }),
  );
  const resumed = await harness.restart().resume(task.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(harness.platform.executed.length, 1);
  assert.equal(harness.platform.executed[0]?.target, 'Open');
});

test('PHASE8-R3: a confirmed side effect is reconciled without repeating the action', async () => {
  const taskPlan = plan(step('s1', click('Open')));
  const harness = makeHarness({ plan: taskPlan });
  const task = readyTask(harness.taskEngine, 'ambiguous but observable');
  harness.storage.saveCheckpoint(
    checkpointFor(task, taskPlan, {
      reconcilePending: true,
      stepAttempts: [{ index: 0, attempts: 1 }],
    }),
  );
  const resumed = await harness.restart({ verifier: new SideEffectProbeVerifier() }).resume(task.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(harness.platform.executed.length, 0, 'the effect was observed, not repeated');
  const record = resumed.steps.find((entry) => entry.stepId === 's1');
  assert.equal(record?.verified, true);
});

test('PHASE8-S: a changed plan cannot consume an old checkpoint', async () => {
  const { harness, taskId } = await pauseThenResolve();
  // The caller presents a modified plan for the same task.
  harness.setPlan(plan(step('s1', click('Open')), step('s2', click('Other'))));
  const resumed = await harness.restart().resume(taskId);
  assert.equal(resumed.status, 'recovery_required');
  assert.equal(resumed.reason, 'recovery_required');
  assert.match(resumed.message, /plan identity/);
  // Nothing beyond the pre-pause step was ever actuated.
  assert.equal(harness.platform.executed.length, 1);
});

// --- PHASE8-T: architecture boundaries ----------------------------------------

const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');

test('PHASE8-T: checkpoint and recovery code has no provider, OS or network dependencies', () => {
  const files = [
    join(process.cwd(), 'packages', 'core', 'index.ts'),
    join(process.cwd(), 'packages', 'storage', 'index.ts'),
    join(process.cwd(), 'packages', 'execution-orchestrator', 'index.ts'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.match(/^import[^;]+;/gm) ?? []) {
      assert.ok(
        !/platform|policy-engine|task-engine|models\/index|child_process|node:os|node:net|node:http|node:https|axios|node-fetch|puppeteer|playwright|selenium|robotjs/i.test(
          line,
        ),
        `forbidden dependency in ${file}: ${line}`,
      );
    }
    const code = codeOnly(text);
    assert.ok(!/\.execute\(/.test(code), `direct actuation call in ${file}`);
    assert.ok(
      !/child_process|node:os|node:net|node:http|node:https|require\(|mouse|keyboard|screenshot|ocr|speech/i.test(
        code,
      ),
      `OS/network surface in ${file}`,
    );
    assert.ok(
      !/claude|openai|anthropic|gemini|gpt-|axios|fetch\(|https?:\/\//i.test(code),
      `provider/network surface in ${file}`,
    );
  }
});

