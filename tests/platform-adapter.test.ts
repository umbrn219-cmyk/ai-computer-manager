// Phase 9 - real platform adapter tests.
//
// Layering, as required by the phase brief:
//
//   A. Pure/unit    - normalization, signatures, refusal, error mapping and
//                    action translation. These run against a deterministic
//                    `UiAutomationPort` double and never need a desktop.
//   B. Contract     - the real vertical slice through the REAL
//                    ExecutionOrchestrator -> ActionEngine -> SafetyKernel ->
//                    WindowsPlatformAdapter chain, still with a stubbed port.
//   C. Live smoke   - one read-only observation of the real desktop, which
//                    skips explicitly when the environment cannot provide it.
//
// No test here actuates the real desktop. The live test is read-only, and the
// write path is covered deterministically, so the suite never depends on
// whichever window happens to be focused when it runs.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Action, PlatformAdapter } from '../packages/core/index.js';
import { validateCheckpoint } from '../packages/core/index.js';
import { ActionEngine } from '../packages/action-engine/index.js';
import { DeterministicTaskEngine } from '../packages/task-engine/index.js';
import { InMemoryStorage } from '../packages/storage/index.js';
import { MockPlatformAdapter } from '../packages/platform/index.js';
import type { PlannedStep, TaskPlan } from '../packages/ai-manager/index.js';
import { ExecutionOrchestrator } from '../packages/execution-orchestrator/index.js';
import {
  SUPPORTED_ACTION_DOMAINS,
  SUPPORTED_ACTION_TYPES,
  UiAutomationError,
  WindowsPerceptionProvider,
  WindowsPlatformAdapter,
  computeStateSignature,
  normalizeSnapshot,
  parseSnapshot,
  roleFor,
  semanticStateOf,
} from '../packages/platform/windows/index.js';
import type {
  RawUiElement,
  RawUiSnapshot,
  UiAutomationOperation,
  UiAutomationPort,
} from '../packages/platform/windows/index.js';

// --- Deterministic doubles -----------------------------------------------------

/**
 * Stands in for the operating system. This is the only seam the tests control:
 * everything above it - adapter policy, grounding, the action engine, the safety
 * kernel, the orchestrator, the checkpoint store - is the real implementation.
 */
class StubUiPort implements UiAutomationPort {
  readonly invocations: UiAutomationOperation[] = [];
  observeCount = 0;
  snapshot: RawUiSnapshot;
  observeError: Error | undefined;
  invokeError: Error | undefined;

  constructor(snapshot: RawUiSnapshot) {
    this.snapshot = snapshot;
  }

  async observe(): Promise<RawUiSnapshot> {
    this.observeCount += 1;
    if (this.observeError !== undefined) throw this.observeError;
    return this.snapshot;
  }

  async invoke(request: UiAutomationOperation): Promise<void> {
    this.invocations.push(request);
    if (this.invokeError !== undefined) throw this.invokeError;
  }
}

const rawElement = (overrides: Partial<RawUiElement> = {}): RawUiElement => ({
  ref: 'ok_button',
  name: 'ZqxWidgetButton',
  controlType: 'ControlType.Button',
  enabled: true,
  offscreen: false,
  focused: false,
  password: false,
  invokable: true,
  hasValue: false,
  value: '',
  automationId: 'ok_button',
  ...overrides,
});

const snapshotOf = (elements: readonly RawUiElement[]): RawUiSnapshot => ({
  processName: 'notepad',
  windowTitle: 'ZqxTestWindow',
  elements,
});

const click = (target: string, extra?: Readonly<Record<string, unknown>>): Action => ({
  type: 'CLICK',
  domain: 'UI',
  target,
  ...(extra ?? {}),
});

/** The structured failure code the adapter reported, if any. */
const failureOf = (result: {
  ok: boolean;
  data?: Readonly<Record<string, unknown>>;
}): unknown => result.data?.['failure'];

const plan = (...steps: readonly PlannedStep[]): TaskPlan => ({ goal: 'phase9 goal', steps });

const step = (id: string, action?: Action): PlannedStep =>
  action === undefined
    ? { id, description: id, verified: false }
    : { id, description: id, action, verified: false };


// --- PHASE9-A/B: contract and normalization ------------------------------------

test('PHASE9-A: the real adapter satisfies the unchanged PlatformAdapter contract', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  // Compile-time proof that the core contract is untouched, plus a runtime one.
  const adapter: PlatformAdapter = new WindowsPlatformAdapter({ port });
  const record = await adapter.observe();
  assert.equal(record['platform'], 'windows');
  assert.equal(typeof record['stateSignature'], 'string');
  assert.equal(typeof adapter.execute, 'function');
});

test('PHASE9-B: a valid platform observation normalizes into the existing UI model', () => {
  const graph = normalizeSnapshot(
    snapshotOf([
      rawElement({ automationId: 'ok_button', name: 'ZqxWidgetButton' }),
      rawElement({
        ref: 'name_field',
        automationId: 'name_field',
        name: 'Full name',
        controlType: 'ControlType.Edit',
        invokable: false,
        hasValue: true,
        value: 'Ada',
      }),
      rawElement({ ref: 'gone', automationId: 'gone', name: 'OffscreenThing', offscreen: true }),
    ]),
  );

  assert.equal(graph.application, 'notepad');
  assert.equal(graph.title, 'ZqxTestWindow');
  assert.equal(graph.elements.length, 3);

  // Role mapping reuses the project's own SemanticRole vocabulary.
  const button = graph.elements[0]!;
  const field = graph.elements[1]!;
  const offscreen = graph.elements[2]!;
  assert.equal(button.role, 'BUTTON');
  assert.equal(field.role, 'TEXT_INPUT');
  assert.equal(field.text, 'Ada');
  assert.deepEqual([...button.states], ['enabled']);
  assert.equal(button.metadata['interactable'], true);
  assert.equal(button.metadata['visible'], true);
  // An off-screen control is visible=false and therefore never a target.
  assert.equal(offscreen.metadata['visible'], false);
  assert.equal(offscreen.metadata['interactable'], false);
  assert.equal(typeof graph.stateSignature, 'string');
  assert.ok(graph.stateSignature.length > 0);
});

test('PHASE9-B2: OS control types map onto existing project roles, unknown stays unknown', () => {
  assert.equal(roleFor('ControlType.Button'), 'BUTTON');
  assert.equal(roleFor('ControlType.Edit'), 'TEXT_INPUT');
  assert.equal(roleFor('ControlType.Hyperlink'), 'LINK');
  assert.equal(roleFor('ControlType.SomethingNovel'), 'unknown');
});

test('PHASE9-B3: a disabled or password control is never interactable', () => {
  const graph = normalizeSnapshot(
    snapshotOf([
      rawElement({ enabled: false }),
      rawElement({
        ref: 'pw',
        automationId: 'pw',
        name: 'Password',
        controlType: 'ControlType.Edit',
        invokable: false,
        hasValue: true,
        password: true,
        value: 'hunter2',
      }),
    ]),
  );
  assert.equal(graph.elements[0]!.metadata['interactable'], false);
  const password = graph.elements[1]!;
  assert.equal(password.metadata['interactable'], false);
  assert.equal(password.metadata['isPassword'], true);
  // The secret itself never reaches the normalized model.
  assert.equal(password.text, undefined);
  assert.equal(JSON.stringify(graph).includes('hunter2'), false);
});

test('PHASE9-B4: a malformed host payload is rejected, never half-parsed', () => {
  assert.throws(() => parseSnapshot(null), UiAutomationError);
  assert.throws(() => parseSnapshot({ processName: 'x' }), UiAutomationError);
  assert.throws(() => parseSnapshot({ elements: 'nope' }), UiAutomationError);
  // A node with no control type cannot be grounded later, so it is dropped.
  const parsed = parseSnapshot({ processName: 'p', windowTitle: 't', elements: [{ name: 'x' }] });
  assert.equal(parsed.elements.length, 0);

// --- PHASE9-C/J: failures are structured, never host exceptions -----------------

test('PHASE9-C: an observation failure becomes a structured failure', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  port.observeError = new UiAutomationError('permission_denied', 'UIAccess denied by the host');
  const adapter = new WindowsPlatformAdapter({ port });

  // observe() surfaces a normalized adapter error, not a host exception type.
  await assert.rejects(
    () => adapter.observe(),
    (error: unknown) => {
      assert.ok(error instanceof UiAutomationError);
      assert.equal(error.code, 'permission_denied');
      return true;
    },
  );

  // execute() reports the same condition as data, and never actuates.
  const result = await adapter.execute(click('ZqxWidgetButton'));
  assert.equal(result.ok, false);
  assert.equal(failureOf(result), 'permission_denied');
  assert.equal(port.invocations.length, 0);
});

test('PHASE9-J: an arbitrary platform exception is normalized, not leaked', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  port.invokeError = new Error('COMException 0x8001010A RPC_E_SERVERFAULT');
  const adapter = new WindowsPlatformAdapter({ port });

  const result = await adapter.execute(click('ZqxWidgetButton'));
  assert.equal(result.ok, false);
  // Mapped into the Phase-9 vocabulary rather than surfacing as "unknown".
  assert.equal(failureOf(result), 'actuation_failed');
  assert.match(String(result.message), /RPC_E_SERVERFAULT/);
});

// --- PHASE9-D/E: refusal happens before the OS is contacted --------------------

test('PHASE9-D: an unsupported action is rejected before OS actuation', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });

  for (const type of ['KEY_PRESS', 'SCROLL', 'OPEN'] as const) {
    const result = await adapter.execute({ type, domain: 'UI', target: 'ZqxWidgetButton' });
    assert.equal(result.ok, false, `${type} must be refused`);
    assert.equal(failureOf(result), 'unsupported');
    assert.match(String(result.message), new RegExp(type));
  }

  // Refused outright: the desktop was neither observed nor actuated.
  assert.equal(port.invocations.length, 0);
  assert.equal(port.observeCount, 0);
});

test('PHASE9-D2: forbidden risk domains are refused even with a supported type', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });
  for (const domain of ['FINANCIAL', 'CREDENTIAL', 'NETWORK', 'SYSTEM']) {
    const result = await adapter.execute(click('ZqxWidgetButton', { domain }));
    assert.equal(result.ok, false, `${domain} must be refused`);
    assert.equal(failureOf(result), 'permission_denied');
  }
  // An unrecognised domain fails closed rather than being reinterpreted.
  const unknown = await adapter.execute(click('ZqxWidgetButton', { domain: 'WHATEVER' }));
  assert.equal(failureOf(unknown), 'unsupported');
  assert.equal(port.invocations.length, 0);
});

test('PHASE9-E: a malformed action is rejected safely', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });

  const noType = await adapter.execute({ domain: 'UI', target: 'ZqxWidgetButton' } as Action);
  assert.equal(failureOf(noType), 'malformed_action');

  const noDomain = await adapter.execute({ type: 'CLICK', target: 'ZqxWidgetButton' } as Action);
  assert.equal(failureOf(noDomain), 'malformed_action');

  const noTarget = await adapter.execute({ type: 'CLICK', domain: 'UI' });
  assert.equal(failureOf(noTarget), 'malformed_action');

  // TYPE without usable text is malformed, and must not be coerced to ''.
  const badText = await adapter.execute({
    type: 'TYPE',
    domain: 'UI',
    target: 'Full name',
    payload: { text: { nested: true } },
  });
  assert.equal(failureOf(badText), 'malformed_action');

  assert.equal(port.invocations.length, 0);
});


// --- PHASE9-F/G/H: low-risk actuation ------------------------------------------

test('PHASE9-F: a low-risk click maps to the right platform operation', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });

  const result = await adapter.execute(click('ZqxWidgetButton'));
  assert.equal(result.ok, true);
  assert.equal(port.invocations.length, 1);
  const operation = port.invocations[0]!;
  assert.equal(operation.operation, 'click');
  assert.deepEqual(operation.locator, { name: 'ZqxWidgetButton', automationId: 'ok_button' });
});

test('PHASE9-F2: focus maps to the focus operation, observe actuates nothing', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });

  const focus = await adapter.execute({ type: 'SELECT', domain: 'UI', target: 'ZqxWidgetButton' });
  assert.equal(focus.ok, true);
  assert.equal(port.invocations[0]!.operation, 'focus');

  const observe = await adapter.execute({
    type: 'OBSERVE',
    domain: 'OBSERVATION',
    target: 'ZqxWidgetButton',
  });
  assert.equal(observe.ok, true);
  // Observation reads; it never writes to the desktop.
  assert.equal(port.invocations.length, 1);
});

test('PHASE9-G: text input maps correctly without exposing the typed value', async () => {
  const typed = 'Ada Lovelace';
  const port = new StubUiPort(
    snapshotOf([
      rawElement({
        ref: 'name_field',
        automationId: 'name_field',
        name: 'Full name',
        controlType: 'ControlType.Edit',
        invokable: false,
        hasValue: true,
        value: '',
      }),
    ]),
  );
  const adapter = new WindowsPlatformAdapter({ port });

  const result = await adapter.execute({
    type: 'TYPE',
    domain: 'UI',
    target: 'Full name',
    payload: { text: typed },
  });

  assert.equal(result.ok, true);
  // The value reaches the platform call...
  const operation = port.invocations[0]!;
  assert.equal(operation.operation, 'type');
  assert.equal(operation.operation === 'type' ? operation.text : undefined, typed);
  // ...but is never echoed into the result the pipeline may log or persist.
  assert.equal(JSON.stringify(result).includes(typed), false);
});

test('PHASE9-H: a missing target is reported without blind actuation', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });

  const result = await adapter.execute(click('NoSuchControl'));
  assert.equal(result.ok, false);
  assert.equal(failureOf(result), 'target_not_found');
  assert.equal(port.invocations.length, 0, 'must not actuate a target it never grounded');
});

test('PHASE9-H2: a disabled control is not a valid target', async () => {
  const port = new StubUiPort(snapshotOf([rawElement({ enabled: false })]));
  const adapter = new WindowsPlatformAdapter({ port });
  const result = await adapter.execute(click('ZqxWidgetButton'));
  assert.equal(failureOf(result), 'target_not_found');
  assert.equal(port.invocations.length, 0);
});

// --- PHASE9-I: interference / stale target ------------------------------------

test('PHASE9-I: a changed screen prevents actuation of the stale target', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });
  const before = await adapter.observeGraph();

  // The user changes the window: the semantic state signature moves.
  port.snapshot = snapshotOf([
    rawElement(),
    rawElement({ ref: 'cancel', automationId: 'cancel', name: 'ZqxCancelButton' }),
  ]);
  const after = await adapter.observeGraph();
  assert.notEqual(after.stateSignature, before.stateSignature);

  // The action was bound to the earlier signature, so it must not be executed.
  const result = await adapter.execute(
    click('ZqxWidgetButton', { stateSignature: before.stateSignature }),
  );
  assert.equal(result.ok, false);
  assert.equal(failureOf(result), 'stale_target');
  assert.equal(port.invocations.length, 0, 'a stale target must never be actuated');
});

test('PHASE9-I2: a pinned control identity is honoured as an extra guard', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const adapter = new WindowsPlatformAdapter({ port });
  const result = await adapter.execute(
    click('ZqxWidgetButton', { payload: { expectedElementId: 'some_other_control' } }),
  );
  assert.equal(failureOf(result), 'stale_target');
  assert.equal(port.invocations.length, 0);
});

test('PHASE9-I3: an ambiguous control is refused rather than guessed', async () => {
  const port = new StubUiPort(
    snapshotOf([
      rawElement({ ref: 'a', automationId: 'a', name: 'ZqxWidgetButton' }),
      rawElement({ ref: 'b', automationId: 'b', name: 'ZqxWidgetButton' }),
    ]),
  );
  const adapter = new WindowsPlatformAdapter({ port });
  const result = await adapter.execute(click('ZqxWidgetButton'));
  assert.equal(failureOf(result), 'ambiguous_target');
  assert.equal(port.invocations.length, 0);
});


// --- PHASE9-K/L/M: the SafetyKernel stays authoritative ------------------------

/** The real ActionEngine wired to the real Windows adapter over a stubbed OS. */
const makeEngine = (port: StubUiPort): ActionEngine => {
  const adapter = new WindowsPlatformAdapter({ port });
  return new ActionEngine(
    new InMemoryStorage(),
    new WindowsPerceptionProvider(adapter),
    adapter,
  );
};

test('PHASE9-K: a SafetyKernel denial prevents PlatformAdapter.execute entirely', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const engine = makeEngine(port);

  // SYSTEM is denied by the deterministic policy boundary.
  const outcome = await engine.submitAction(click('ZqxWidgetButton', { domain: 'SYSTEM' }));

  assert.equal(outcome.success, false);
  assert.match(outcome.message, /^SafetyKernel denied/);
  // The proof: the adapter was never asked to actuate.
  assert.equal(port.invocations.length, 0);
});

test('PHASE9-L: a financial action never reaches real platform actuation', async () => {
  const port = new StubUiPort(snapshotOf([rawElement()]));
  const engine = makeEngine(port);

  const outcome = await engine.submitAction(
    click('ZqxWidgetButton', { domain: 'FINANCIAL', payload: { amount: 100 } }),
  );

  assert.equal(outcome.success, false);
  assert.match(outcome.message, /SafetyKernel denied: Financial actions are blocked/);
  assert.equal(port.invocations.length, 0, 'a financial click must never reach the desktop');
});

test('PHASE9-M: a credential action never reaches real platform actuation', async () => {
  const port = new StubUiPort(
    snapshotOf([
      rawElement({
        ref: 'pw',
        automationId: 'pw',
        name: 'Password',
        controlType: 'ControlType.Edit',
        invokable: false,
        hasValue: true,
        password: true,
      }),
    ]),
  );
  const engine = makeEngine(port);

  const outcome = await engine.submitAction({
    type: 'TYPE',
    domain: 'CREDENTIAL',
    target: 'Password',
    payload: { text: 'hunter2' },
  });

  assert.equal(outcome.success, false);
  assert.match(outcome.message, /SafetyKernel denied/);
  assert.equal(port.invocations.length, 0, 'credentials must never reach the desktop');
});

// --- PHASE9-N: the deterministic mock is untouched -----------------------------

test('PHASE9-N: MockPlatformAdapter remains available to deterministic tests', async () => {
  const mock = new MockPlatformAdapter();
  const action = click('Anything');

  const result = await mock.execute(action);

  // Phase-4 behaviour is unchanged by the arrival of the real adapter.
  assert.equal(result.ok, true);
  assert.equal(result.message, 'Mock execution only');
  assert.deepEqual([...mock.executed], [action]);
  assert.deepEqual(await mock.observe(), { mock: true });
  assert.deepEqual([...SUPPORTED_ACTION_DOMAINS], ['UI', 'OBSERVATION']);
  assert.ok(SUPPORTED_ACTION_TYPES.includes('CLICK'));
});

// --- PHASE9-O/P: architecture boundaries ---------------------------------------

const platformDir = join(process.cwd(), 'packages', 'platform', 'windows');

test('PHASE9-O: the core package has no platform-specific imports', () => {
  const core = readFileSync(join(process.cwd(), 'packages', 'core', 'index.ts'), 'utf8');
  for (const line of core.match(/^import[^;]+;/gm) ?? []) {
    assert.ok(!/platform|windows|child_process|node:os/i.test(line), `core must stay neutral: ${line}`);
  }
  // No OS vocabulary at all in the platform-independent contracts.
  assert.ok(!/UiAutomation|ControlType|InvokePattern|ValuePattern|PowerShell/i.test(core));
  // The neutral contract itself is unchanged by Phase 9.
  assert.match(core, /export interface PlatformAdapter/);
  assert.ok(!/windows/i.test(core));
});

test('PHASE9-P: the orchestrator has no direct platform-specific dependency', () => {
  const text = readFileSync(
    join(process.cwd(), 'packages', 'execution-orchestrator', 'index.ts'),
    'utf8',
  );
  for (const line of text.match(/^import[^;]+;/gm) ?? []) {
    assert.ok(!/platform|windows/i.test(line), `orchestrator must not import a platform: ${line}`);
  }
  assert.ok(!/WindowsPlatformAdapter|UiAutomation/i.test(text));
});

test('PHASE9-P2: all OS-specific code is confined to packages/platform', () => {
  // Walk every package except the platform one and prove none of them know the OS.
  const packagesDir = join(process.cwd(), 'packages');
  for (const entry of ['core', 'task-engine', 'action-engine', 'ai-manager', 'execution-orchestrator', 'perception', 'storage', 'policy-engine', 'models']) {
    const text = readFileSync(join(packagesDir, entry, 'index.ts'), 'utf8');
    assert.ok(
      !/child_process|node:os|UiAutomation|InvokePattern|PowerShell|platform\/windows/i.test(text),
      `${entry} must not contain OS-specific code`,
    );
  }

  // The real backend lives where it is allowed to, and nowhere else.
  assert.ok(readFileSync(join(platformDir, 'ui-automation.ts'), 'utf8').includes('node:child_process'));
  // And the neutral platform barrel still publishes only the mock.
  const barrel = readFileSync(join(process.cwd(), 'packages', 'platform', 'index.ts'), 'utf8');
  assert.ok(!/windows/i.test(barrel.replace(/^\s*\*.*$/gm, '')));
});


// --- PHASE9-Q/R: checkpoints are untouched by platform observation -------------

/** The full real pipeline over a stubbed OS: nothing here is a mock except the OS. */
const makeVertical = (snapshot: RawUiSnapshot) => {
  const storage = new InMemoryStorage();
  let counter = 0;
  const taskEngine = new DeterministicTaskEngine(storage, () => `phase9-task-${(counter += 1)}`);
  const port = new StubUiPort(snapshot);
  const adapter = new WindowsPlatformAdapter({ port });
  const perception = new WindowsPerceptionProvider(adapter);
  const orchestrator = new ExecutionOrchestrator({
    taskEngine,
    perception,
    actionExecutor: new ActionEngine(storage, perception, adapter),
    checkpoints: storage,
  });
  return { storage, port, orchestrator };
};

test('PHASE9-Q: the checkpoint schema is unchanged by platform observation', async () => {
  const { storage, orchestrator } = makeVertical(
    snapshotOf([
      rawElement({ ref: 'a', automationId: 'a', name: 'ZqxWidgetButton' }),
      rawElement({ ref: 'b', automationId: 'b', name: 'ZqxWidgetButton' }),
    ]),
  );

  // Two controls share a label, so the run pauses and a checkpoint is written.
  const outcome = await orchestrator.run({
    goal: 'phase9 checkpoint shape',
    plan: plan(step('s1', click('ZqxWidgetButton'))),
  });
  assert.equal(outcome.status, 'needs_user');

  const checkpoint = storage.loadCheckpoint(outcome.taskId ?? '');
  assert.ok(checkpoint !== undefined, 'a paused run must leave a checkpoint');
  assert.equal(validateCheckpoint(checkpoint, outcome.taskId ?? '').valid, true);
  // Exactly the Phase-8 schema - platform observation added no field to it.
  assert.deepEqual(Object.keys(checkpoint ?? {}).sort(), [
    'activeStepIndex',
    'checkpointVersion',
    'planVersion',
    'reason',
    'reconcilePending',
    'status',
    'stepAttempts',
    'taskId',
    'taskVersion',
    'verifiedStepIds',
  ]);
  // The stored reason is a stable taxonomy code, never a UI message.
  assert.equal(checkpoint?.reason, 'ambiguous_target');
});

test('PHASE9-R: raw observation data is never inserted into a checkpoint', async () => {
  const { storage, orchestrator } = makeVertical(
    snapshotOf([
      rawElement({ ref: 'a', automationId: 'a', name: 'ZqxWidgetButton' }),
      rawElement({ ref: 'b', automationId: 'b', name: 'ZqxWidgetButton' }),
    ]),
  );
  const outcome = await orchestrator.run({
    goal: 'phase9 privacy',
    plan: plan(step('s1', click('ZqxWidgetButton'))),
  });

  const serialized = JSON.stringify(storage.loadCheckpoint(outcome.taskId ?? ''));
  // Nothing that can only have come from observing the desktop is persisted:
  // no window title, no process name, no control type, no element ids, no
  // bounds, no element list and no state signature.
  for (const leak of [
    'ZqxTestWindow',
    'notepad',
    'ControlType',
    'ok_button',
    '"a"',
    'elements',
    'stateSignature',
    'bounds',
    'interactable',
  ]) {
    assert.equal(serialized.includes(leak), false, `checkpoint leaked "${leak}"`);
  }
  // The plan's own target appears only inside the Phase-8 plan fingerprint,
  // which is derived from the caller's plan rather than from the observation.
  const checkpoint = storage.loadCheckpoint(outcome.taskId ?? '');
  assert.equal(checkpoint?.planVersion.startsWith('p1:'), true);
});


// --- PHASE9-S: deterministic state signature -----------------------------------

test('PHASE9-S: the state signature is deterministic for equivalent observations', () => {
  const first = normalizeSnapshot(
    snapshotOf([
      rawElement({ automationId: 'a', name: 'ZqxWidgetButton' }),
      rawElement({
        ref: 'f',
        automationId: 'f',
        name: 'Full name',
        controlType: 'ControlType.Edit',
        invokable: false,
        hasValue: true,
        value: 'Ada',
      }),
    ]),
  );
  // Same semantic state, different incidental detail: different order, moved
  // window, different text value, different bounds.
  const second = normalizeSnapshot({
    processName: 'notepad',
    windowTitle: 'ZqxTestWindow',
    elements: [
      rawElement({
        ref: 'f',
        automationId: 'f',
        name: 'Full name',
        controlType: 'ControlType.Edit',
        invokable: false,
        hasValue: true,
        value: 'Grace',
        bounds: { x: 900, y: 800, width: 10, height: 10 },
      }),
      rawElement({
        ref: 'a',
        automationId: 'a',
        name: 'ZqxWidgetButton',
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ],
  });

  assert.equal(second.stateSignature, first.stateSignature);
  assert.equal(
    computeStateSignature(semanticStateOf(first)),
    computeStateSignature(semanticStateOf(second)),
  );

  // A genuine semantic change does move the signature.
  const changed = normalizeSnapshot(
    snapshotOf([rawElement({ automationId: 'a', name: 'ZqxWidgetButton', enabled: false })]),
  );
  assert.notEqual(changed.stateSignature, first.stateSignature);

  // The signature is a pure function of state: no clock, no randomness.
  assert.equal(computeStateSignature(semanticStateOf(first)), first.stateSignature);
  assert.match(first.stateSignature, /^uia1:[0-9a-f]{16}$/);
});

// --- PHASE9-T: the real vertical slice -----------------------------------------

test('PHASE9-T: the full pipeline drives a grounded real action through the adapter', async () => {
  const { storage, port, orchestrator } = makeVertical(
    snapshotOf([rawElement({ automationId: 'ok_button', name: 'ZqxWidgetButton' })]),
  );

  const outcome = await orchestrator.run({
    goal: 'phase9 vertical slice',
    plan: plan(step('s1', click('ZqxWidgetButton'))),
  });

  // Plan -> orchestrator -> action engine -> grounding -> safety kernel ->
  // pre-flight -> WindowsPlatformAdapter -> one grounded UI operation.
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.allVerified, true);
  assert.equal(port.invocations.length, 1);
  const operation = port.invocations[0]!;
  assert.equal(operation.operation, 'click');
  assert.deepEqual(operation.locator, { name: 'ZqxWidgetButton', automationId: 'ok_button' });
  // A completed run leaves no checkpoint behind.
  assert.equal(storage.loadCheckpoint(outcome.taskId ?? ''), undefined);
});

test('PHASE9-T2: live read-only observation of the real desktop', async (t) => {
  // Read-only by construction: this only calls observe(), never execute().
  const adapter = new WindowsPlatformAdapter();
  let record: Readonly<Record<string, unknown>>;
  try {
    record = await adapter.observe();
  } catch (error) {
    // Never fake success: if the environment cannot provide UI Automation, the
    // limitation is reported explicitly and the test is skipped, not passed.
    const code = error instanceof UiAutomationError ? error.code : 'unknown';
    t.skip(`live UI Automation unavailable in this environment (${code})`);
    return;
  }

  const graph = record['uiState'] as { elements: readonly unknown[]; stateSignature: string };
  assert.equal(record['platform'], 'windows');
  assert.ok(Array.isArray(graph.elements), 'live observation must yield a normalized element list');
  assert.equal(typeof graph.stateSignature, 'string');
  assert.ok(graph.stateSignature.length > 0);
  console.log(
    `PHASE9-T2 live observation succeeded: ${graph.elements.length} controls, signature ${graph.stateSignature}`,
  );
});

});
