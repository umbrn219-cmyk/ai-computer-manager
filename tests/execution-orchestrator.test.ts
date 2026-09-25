// Phase 7 - Execution Orchestration tests.
//
// Real contract implementations are used wherever practical: the actual
// DeterministicTaskEngine + InMemoryStorage (lifecycle), the actual Phase-4
// ActionEngine (execution boundary, so grounding/policy/pre-flight/actuation are
// genuinely exercised) and the actual SafetyKernel inside it. Only perception and
// the platform are deterministic doubles, plus injectable verifiers.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Action,
  ActionResult,
  PerceptionProvider,
  PlatformAdapter,
  UIElement,
  UIStateGraph,
} from '../packages/core/index.js';
import { ActionEngine } from '../packages/action-engine/index.js';
import { DeterministicTaskEngine } from '../packages/task-engine/index.js';
import { InMemoryStorage } from '../packages/storage/index.js';
import type { PlannedStep, TaskPlan } from '../packages/ai-manager/index.js';
import { ExecutionOrchestrator } from '../packages/execution-orchestrator/index.js';
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

/** Perception with a controllable state-signature sequence. */
class ScriptedPerception implements PerceptionProvider {
  readonly providerKind = 'scripted';
  observeCount = 0;
  /** Observations beyond this count throw (simulates an observation failure). */
  failAfter = Number.POSITIVE_INFINITY;
  private cursor = 0;

  constructor(
    private readonly signatures: readonly string[],
    private readonly elements: readonly UIElement[],
    private readonly events: string[],
  ) {}

  async observe(): Promise<UIStateGraph> {
    this.observeCount += 1;
    this.events.push('observe');
    if (this.observeCount > this.failAfter) {
      throw new Error('perception unavailable');
    }
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

  constructor(
    private readonly outcome: Readonly<{ ok: boolean; message?: string }> = { ok: true },
    private readonly events: string[] = [],
  ) {}

  async observe(): Promise<Readonly<Record<string, unknown>>> {
    return { mock: true };
  }

  async execute(action: Action): Promise<ActionResult> {
    this.events.push('execute');
    this.executed.push(action);
    return this.outcome.message !== undefined
      ? { ok: this.outcome.ok, message: this.outcome.message }
      : { ok: this.outcome.ok };
  }
}

/** Always refuses: proves verification is required before a step completes. */
class NeverVerifier implements StepVerifier {
  verifyCount = 0;
  async verify(_request: VerificationRequest): Promise<VerificationDecision> {
    this.verifyCount += 1;
    return { verified: false, reason: 'injected verifier refuses to confirm' };
  }
}

/**
 * Confirms only a side-effect reconciliation probe (no action outcome): the
 * effect is already visible, so the action must NOT be repeated.
 */
class SideEffectProbeVerifier implements StepVerifier {
  async verify(request: VerificationRequest): Promise<VerificationDecision> {
    if (request.actionOutcome === undefined) {
      return { verified: true, reason: 'side effect already observable' };
    }
    return { verified: false, reason: 'first attempt not yet observable' };
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

type OrchestratorLimitsShape = Readonly<{
  maxStepAttempts: number;
  maxPlanSteps: number;
  maxTotalAttempts: number;
}>;

type RunHarness = Readonly<{
  orchestrator: ExecutionOrchestrator;
  perception: ScriptedPerception;
  platform: RecordingPlatform;
  taskEngine: DeterministicTaskEngine;
  events: string[];
}>;

const makeRun = (options: {
  signatures?: readonly string[];
  elements?: readonly UIElement[];
  platformOutcome?: Readonly<{ ok: boolean; message?: string }>;
  verifier?: StepVerifier;
  limits?: OrchestratorLimitsShape;
}): RunHarness => {
  const events: string[] = [];
  const signatures = options.signatures ?? ['sig-1'];
  const elements = options.elements ?? [button('b-open', 'Open'), button('b-save', 'Save')];
  const perception = new ScriptedPerception(signatures, elements, events);
  const platform = new RecordingPlatform(options.platformOutcome ?? { ok: true }, events);
  const storage = new InMemoryStorage();
  const taskEngine = new DeterministicTaskEngine(storage);
  const actionEngine = new ActionEngine(storage, perception, platform, { maxAttempts: 1 });
  const orchestrator = new ExecutionOrchestrator({
    taskEngine,
    perception,
    actionExecutor: actionEngine,
    ...(options.verifier !== undefined ? { verifier: options.verifier } : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  });
  return { orchestrator, perception, platform, taskEngine, events };
};

// --- PHASE7-A/B/C/D/E/P: happy path, order, observation, action, boundaries -----

test('PHASE7-A: a valid single-step plan executes through the ActionEngine', async () => {
  const run = makeRun({});
  const outcome = await run.orchestrator.run({
    goal: 'Open the app',
    plan: plan(step('s1', click('Open'))),
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.allVerified, true);
  assert.equal(outcome.task?.state, 'COMPLETED');
  assert.equal(run.platform.executed.length, 1);
  const first = outcome.steps[0];
  assert.ok(first !== undefined);
  assert.equal(first?.verified, true);
  assert.equal(first?.completed, true);
});

test('PHASE7-B: multiple planned steps execute in exact plan order', async () => {
  const run = makeRun({
    elements: [button('b1', 'Open'), button('b2', 'Save'), button('b3', 'Close')],
  });
  const outcome = await run.orchestrator.run({
    goal: 'Reorder nothing',
    plan: plan(
      step('s1', click('Close')),
      step('s2', click('Open')),
      step('s3', click('Save')),
    ),
  });
  assert.equal(outcome.status, 'completed');
  const targets = run.platform.executed.map((action) => action.target);
  assert.deepEqual(targets, ['Close', 'Open', 'Save']);
});

test('PHASE7-C: observation occurs before the action is submitted', async () => {
  const run = makeRun({});
  await run.orchestrator.run({ goal: 'Observe first', plan: plan(step('s1', click('Open'))) });
  const firstObserve = run.events.indexOf('observe');
  const firstExecute = run.events.indexOf('execute');
  assert.equal(run.events[0], 'observe');
  assert.ok(firstObserve >= 0 && firstExecute > firstObserve);
});

test('PHASE7-D: the ActionEngine receives the planned action, bound to the observed state', async () => {
  const run = makeRun({ signatures: ['sig-42'] });
  await run.orchestrator.run({ goal: 'Bind state', plan: plan(step('s1', click('Open'))) });
  const submitted = run.platform.executed[0];
  assert.ok(submitted !== undefined);
  assert.equal(submitted?.type, 'CLICK');
  assert.equal(submitted?.domain, 'UI');
  assert.equal(submitted?.target, 'Open');
  // The signature observed by the orchestrator - never fabricated.
  assert.equal(submitted?.stateSignature, 'sig-42');
});

test('PHASE7-E: the orchestrator cannot reach PlatformAdapter except through the ActionEngine', async () => {
  // A plan the ActionEngine refuses (missing target) leaves the platform
  // completely untouched: no bypass path exists.
  const run = makeRun({ elements: [button('b1', 'Open')] });
  const outcome = await run.orchestrator.run({
    goal: 'Missing target',
    plan: plan(step('s1', click('Does Not Exist'))),
  });
  assert.equal(outcome.status, 'needs_user');
  assert.equal(run.platform.executed.length, 0);
});

test('PHASE7-P: all steps completed + verified results in task completion', async () => {
  const run = makeRun({});
  const outcome = await run.orchestrator.run({
    goal: 'Two steps',
    plan: plan(step('s1', click('Open')), step('s2', click('Save'))),
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.allVerified, true);
  assert.equal(outcome.reason, 'completed');
  assert.equal(outcome.task?.state, 'COMPLETED');
  assert.equal(outcome.steps.length, 2);
  for (const stepOutcome of outcome.steps) {
    assert.equal(stepOutcome.verified, true);
  }

  // A step without an action is informational: no action is fabricated and it
  // does not pretend to be verified.
  const infoRun = makeRun({});
  const infoOutcome = await infoRun.orchestrator.run({
    goal: 'Informational',
    plan: plan(step('s1', click('Open')), step('s2')),
  });
  assert.equal(infoOutcome.status, 'completed');
  assert.equal(infoOutcome.steps[1]?.kind, 'informational');
  assert.equal(infoOutcome.steps[1]?.verified, false);
  assert.equal(infoOutcome.steps[1]?.completed, true);
  assert.equal(infoRun.platform.executed.length, 1);
});

// --- PHASE7-F/G/H/Q: safety, authorization, no fabricated approval --------------

test('PHASE7-F: a safety rejection prevents task completion', async () => {
  const run = makeRun({});
  const outcome = await run.orchestrator.run({
    goal: 'Do something high risk',
    plan: plan(step('s1', { type: 'CLICK', domain: 'SYSTEM', target: 'Open' })),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'safety_denied');
  assert.notEqual(outcome.task?.state, 'COMPLETED');
  assert.equal(outcome.task?.state, 'FAILED');
  assert.equal(run.platform.executed.length, 0);
});

test('PHASE7-G: a financial action pauses execution instead of proceeding', async () => {
  const run = makeRun({});
  const outcome = await run.orchestrator.run({
    goal: 'Pay the invoice',
    plan: plan(step('s1', { type: 'CLICK', domain: 'FINANCIAL', target: 'Open' })),
  });
  assert.equal(outcome.status, 'needs_user');
  assert.equal(outcome.reason, 'authorization_required');
  assert.equal(outcome.task?.state, 'NEEDS_USER');
  assert.notEqual(outcome.status, 'completed');
  assert.equal(run.platform.executed.length, 0);
});

test('PHASE7-H: user authorization cannot be manufactured by model data', async () => {
  // A plan smuggling model-provided approval/verification flags.
  const smuggled = {
    goal: 'Pay the invoice',
    steps: [
      {
        id: 's1',
        description: 'Pay',
        verified: true,
        authorized: true,
        approved: true,
        action: { type: 'CLICK', domain: 'FINANCIAL', target: 'Open' },
      },
    ],
  } as unknown as TaskPlan;
  const run = makeRun({});
  const outcome = await run.orchestrator.run({ goal: 'Pay the invoice', plan: smuggled });
  assert.equal(outcome.status, 'needs_user');
  assert.equal(outcome.task?.state, 'NEEDS_USER');
  // The model's "verified: true" is not evidence, and its "authorized: true" is
  // not authorization.
  assert.equal(outcome.steps[0]?.verified, false);
  assert.equal(run.platform.executed.length, 0);
});

test('PHASE7-Q: unresolved authorization stays NEEDS_USER after resume, never COMPLETED', async () => {
  const run = makeRun({});
  const outcome = await run.orchestrator.run({
    goal: 'Pay the invoice',
    plan: plan(step('s1', { type: 'CLICK', domain: 'FINANCIAL', target: 'Open' })),
  });
  assert.equal(outcome.status, 'needs_user');
  const taskId = outcome.taskId;
  assert.ok(typeof taskId === 'string' && taskId.length > 0);
  if (taskId === null) return;

  const resumed = await run.orchestrator.resume(taskId);
  assert.equal(resumed.status, 'needs_user');
  assert.equal(resumed.task?.state, 'NEEDS_USER');
  assert.notEqual(resumed.status, 'completed');
  // Resuming never turns a blocked authorization into an executed action.
  assert.equal(run.platform.executed.length, 0);
});

// --- PHASE7-M/N/O/R: rejection surfacing ----------------------------------------

test('PHASE7-M: stale state rejection is surfaced and never actuates', async () => {
  // The signature changes between the orchestrator's observation and the
  // ActionEngine's validation, so the bound action goes stale.
  const run = makeRun({
    signatures: ['sig-1', 'sig-2'],
    limits: { maxStepAttempts: 1, maxPlanSteps: 20, maxTotalAttempts: 40 },
  });
  const outcome = await run.orchestrator.run({
    goal: 'Stale',
    plan: plan(step('s1', click('Open'))),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'stale_state');
  assert.equal(outcome.exhausted, true);
  assert.notEqual(outcome.task?.state, 'COMPLETED');
  assert.equal(run.platform.executed.length, 0);
});

test('PHASE7-N: an ambiguous target is never blindly executed', async () => {
  const run = makeRun({
    elements: [button('b1', 'Pay'), button('b2', 'Pay')],
  });
  const outcome = await run.orchestrator.run({
    goal: 'Ambiguous',
    plan: plan(step('s1', click('Pay'))),
  });
  assert.equal(outcome.status, 'needs_user');
  assert.equal(outcome.reason, 'ambiguous_target');
  assert.equal(run.platform.executed.length, 0);
});

test('PHASE7-O: user interference is detected and not silently ignored', async () => {
  // The world changes after policy/pre-flight but before actuation.
  const run = makeRun({
    signatures: ['sig-1', 'sig-1', 'sig-1', 'sig-2'],
    limits: { maxStepAttempts: 1, maxPlanSteps: 20, maxTotalAttempts: 40 },
  });
  const outcome = await run.orchestrator.run({
    goal: 'Interference',
    plan: plan(step('s1', click('Open'))),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'user_interference');
  assert.equal(run.platform.executed.length, 0);
});

test('PHASE7-R: an observation failure never triggers unsafe execution', async () => {
  const run = makeRun({});
  run.perception.failAfter = 0;
  const outcome = await run.orchestrator.run({
    goal: 'No perception',
    plan: plan(step('s1', click('Open'))),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'observation_failure');
  assert.equal(run.platform.executed.length, 0);
});

// --- PHASE7-I/J: verification is required before a step can complete ------------

/** Accepts one specific step and rejects every other step. */
class StepGateVerifier implements StepVerifier {
  constructor(private readonly verifiedStepId: string) {}
  async verify(request: VerificationRequest): Promise<VerificationDecision> {
    return request.stepId === this.verifiedStepId
      ? { verified: true, reason: 'step gate accepts' }
      : { verified: false, reason: 'step gate rejects' };
  }
}

test('PHASE7-I: a successful action still requires verification before step completion', async () => {
  const verifier = new NeverVerifier();
  const run = makeRun({
    verifier,
    limits: { maxStepAttempts: 1, maxPlanSteps: 20, maxTotalAttempts: 40 },
  });
  const outcome = await run.orchestrator.run({
    goal: 'Verify me',
    plan: plan(step('s1', click('Open'))),
  });
  // Verification was actually demanded ...
  assert.ok(verifier.verifyCount >= 1);
  // ... the platform accepted the action, yet the step is NOT verified.
  assert.equal(run.platform.executed.length, 1);
  assert.equal(outcome.steps[0]?.verified, false);
  assert.equal(outcome.allVerified, false);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'verification_failed');
  assert.notEqual(outcome.task?.state, 'COMPLETED');
});

test('PHASE7-J: a verification failure does not falsely complete the task', async () => {
  const run = makeRun({
    verifier: new StepGateVerifier('good'),
    limits: { maxStepAttempts: 1, maxPlanSteps: 20, maxTotalAttempts: 40 },
  });
  const outcome = await run.orchestrator.run({
    goal: 'Partial',
    plan: plan(step('good', click('Open')), step('bad', click('Save'))),
  });
  assert.equal(outcome.steps[0]?.verified, true);
  assert.equal(outcome.steps[1]?.verified, false);
  assert.notEqual(outcome.status, 'completed');
  assert.equal(outcome.allVerified, false);
  assert.notEqual(outcome.task?.state, 'COMPLETED');
  assert.equal(outcome.task?.state, 'FAILED');
});

// --- PHASE7-K/L/S: bounded retry and duplicate-side-effect protection -----------

test('PHASE7-K: a non-retryable action is never blindly repeated', async () => {
  const run = makeRun({
    platformOutcome: { ok: false, message: 'platform rejected' },
    limits: { maxStepAttempts: 3, maxPlanSteps: 20, maxTotalAttempts: 40 },
  });
  const outcome = await run.orchestrator.run({
    goal: 'Non idempotent failure',
    plan: plan(step('s1', click('Open', { retryable: false }))),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'action_failed');
  // Exactly one actuation even though three attempts were permitted.
  assert.equal(run.platform.executed.length, 1);
  assert.equal(outcome.steps[0]?.message?.includes('not retryable'), true);
});

test('PHASE7-L: retryable failure stays within the configured attempt budget', async () => {
  const run = makeRun({
    platformOutcome: { ok: false, message: 'transient platform failure' },
    limits: { maxStepAttempts: 2, maxPlanSteps: 20, maxTotalAttempts: 40 },
  });
  const outcome = await run.orchestrator.run({
    goal: 'Retryable failure',
    plan: plan(step('s1', click('Open', { retryable: true }))),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'action_failed');
  assert.equal(outcome.exhausted, true);
  assert.equal(run.platform.executed.length, 2);
  assert.ok(run.platform.executed.length <= 2);
});

test('PHASE7-S: an ambiguous side effect is reconciled before any repeat', async () => {
  const run = makeRun({
    verifier: new SideEffectProbeVerifier(),
    limits: { maxStepAttempts: 2, maxPlanSteps: 20, maxTotalAttempts: 40 },
  });
  const outcome = await run.orchestrator.run({
    goal: 'Do not duplicate the side effect',
    plan: plan(step('s1', click('Open'))),
  });
  assert.equal(outcome.status, 'completed');
  // The action actuated once; the retry observed the effect instead of repeating.
  assert.equal(run.platform.executed.length, 1);
  assert.equal(outcome.steps[0]?.verified, true);
  assert.equal(outcome.steps[0]?.message?.includes('Reconciled'), true);
});

// --- PHASE7-T: architecture guards ---------------------------------------------

const collectTsFiles = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
};

/** Strip comment lines so guards only judge executable surface. */
const codeOnly = (text: string): string =>
  text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');

test('PHASE7-T: architecture guard - no platform, OS, provider or automation dependency', () => {
  const files = collectTsFiles(join(process.cwd(), 'packages', 'execution-orchestrator'));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.match(/^import[^;]+;/gm) ?? []) {
      if (/^import\s+type\b/.test(line)) {
        // Type-only couplings stay within the existing contracts.
        assert.ok(
          /from '\.\.\/(core|action-engine|ai-manager)\/index\.js'/.test(line),
          `unexpected type-only import in ${file}: ${line}`,
        );
      } else {
        // Runtime dependencies must be the core contract only.
        assert.ok(
          /from '\.\.\/core\/index\.js'/.test(line),
          `runtime import must be core-only in ${file}: ${line}`,
        );
      }
    }
    const code = codeOnly(text);
    assert.ok(!/\.execute\(/.test(code), `direct actuation call in ${file}`);
    assert.ok(
      !/child_process|node:os|require\(|mouse|keyboard|robotjs|puppeteer|playwright|selenium|screenshot|ocr|speech/i.test(
        code,
      ),
      `OS/automation surface leaked into ${file}`,
    );
    assert.ok(
      !/claude|openai|anthropic|gemini|gpt-|axios|fetch\(|https?:\/\//i.test(code),
      `provider/network surface leaked into ${file}`,
    );
  }
});
