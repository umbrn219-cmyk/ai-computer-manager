import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { InMemoryStorage } from '../packages/storage/index.js';
import { DeterministicTaskEngine } from '../packages/task-engine/index.js';
import { SafetyKernel } from '../packages/policy-engine/index.js';
import { MockPlatformAdapter } from '../packages/platform/index.js';
import {
  ScriptedModelProvider,
  SimpleModelRouter,
} from '../packages/models/index.js';
import { Authorization, Action } from '../packages/core/index.js';

const setup = () => {
  const s = new InMemoryStorage();
  const e = new DeterministicTaskEngine(s, () => 'task-1');

  return { s, e };
};

test('state transitions, verification gate, and NEEDS_USER resume', () => {
  const { e } = setup();

  let t = e.createTask('demo', 2);

  for (const state of [
    'PLANNING',
    'READY',
    'RUNNING',
    'VERIFYING',
    'COMPLETED',
  ] as const) {
    t = e.transition(t.id, state);
  }

  assert.equal(t.state, 'COMPLETED');
  assert.throws(() => e.transition(t.id, 'RUNNING'));
});

test('invalid transition and retry rejection are atomic', () => {
  const { e } = setup();

  let t = e.createTask('demo', 1);

  assert.throws(() => e.transition(t.id, 'RUNNING'));
  assert.equal(e.getTask(t.id)?.version, 0);

  t = e.transition(t.id, 'PLANNING');
  t = e.transition(t.id, 'READY');
  t = e.transition(t.id, 'RUNNING');
  t = e.transition(t.id, 'VERIFYING');

  assert.throws(() => e.transition(t.id, 'RUNNING'));
  assert.equal(e.getTask(t.id)?.attempts, 1);
});

test('task snapshots are deeply immutable', () => {
  const { e } = setup();

  const t = e.createTask('demo');

  assert.throws(() => {
    Object.defineProperty(t, 'state', {
      value: 'FAILED',
    });
  });

  assert.throws(() => {
    Object.defineProperty(t.steps, '0', {
      value: {},
    });
  });
});

test('safety boundaries ignore model advice and fail closed', () => {
  const k = new SafetyKernel();

  assert.equal(
    k.authorize(
      {
        type: 'OPEN',
        domain: 'FINANCIAL',
      },
      {
        allowed: true,
      },
    ).allowed,
    false,
  );

  assert.equal(
    k.authorize(
      {
        type: 'TYPE',
        domain: 'CREDENTIAL',
      },
      {
        allowed: true,
      },
    ).allowed,
    false,
  );

  assert.throws(() =>
    k.classify({
      type: 'OPEN',
      domain: 'UNKNOWN',
    }),
  );
});

test('mock platform and storage', async () => {
  const p = new MockPlatformAdapter();

  await p.execute({
    type: 'OBSERVE',
    domain: 'OBSERVATION',
  });

  assert.equal(p.executed.length, 1);

  const s = new InMemoryStorage();

  const task = new DeterministicTaskEngine(
    s,
    () => 'x',
  ).createTask('x');

  assert.deepEqual(s.get('x'), task);
});

test('capability model routing', async () => {
  const r = new SimpleModelRouter([
    new ScriptedModelProvider({
      PLAN: {
        answer: 42,
      },
    }),
  ]);

  assert.deepEqual(
    await r.request('PLAN', {}),
    {
      answer: 42,
    },
  );

  assert.rejects(
    r.request('VERIFY_OUTCOME', {}),
  );
});

// Regression tests for foundation corrections

test('COMPLETED can only be reached from VERIFYING', () => {
  const { e } = setup();

  let t = e.createTask('demo');

  assert.throws(() =>
    e.transition(t.id, 'COMPLETED'),
  );

  t = e.transition(t.id, 'PLANNING');

  assert.throws(() =>
    e.transition(t.id, 'COMPLETED'),
  );

  t = e.transition(t.id, 'READY');

  assert.throws(() =>
    e.transition(t.id, 'COMPLETED'),
  );

  t = e.transition(t.id, 'RUNNING');

  assert.throws(() =>
    e.transition(t.id, 'COMPLETED'),
  );

  t = e.transition(t.id, 'VERIFYING');
  t = e.transition(t.id, 'COMPLETED');

  assert.equal(t.state, 'COMPLETED');
});

test('attempts increment when entering RUNNING', () => {
  const { e } = setup();

  let t = e.createTask('demo', 3);

  assert.equal(t.attempts, 0);

  t = e.transition(t.id, 'PLANNING');
  assert.equal(t.attempts, 0);

  t = e.transition(t.id, 'READY');
  assert.equal(t.attempts, 0);

  t = e.transition(t.id, 'RUNNING');
  assert.equal(t.attempts, 1);

  t = e.transition(t.id, 'VERIFYING');
  assert.equal(t.attempts, 1);

  t = e.transition(t.id, 'RUNNING');
  assert.equal(t.attempts, 2);

  t = e.transition(t.id, 'VERIFYING');
  assert.equal(t.attempts, 2);

  t = e.transition(t.id, 'RUNNING');
  assert.equal(t.attempts, 3);
});

test('exceeding maxAttempts does not mutate task', () => {
  const { e } = setup();

  let t = e.createTask('demo', 1);

  assert.equal(t.attempts, 0);
  assert.equal(t.version, 0);

  t = e.transition(t.id, 'PLANNING');
  t = e.transition(t.id, 'READY');
  t = e.transition(t.id, 'RUNNING');

  assert.equal(t.attempts, 1);
  assert.equal(t.version, 3);

  const snapshotBefore = e.getTask(t.id);

  assert.deepEqual(snapshotBefore, t);

  assert.throws(() =>
    e.transition(t.id, 'RUNNING'),
  );

  const snapshotAfter = e.getTask(t.id);

  assert.deepEqual(snapshotAfter, snapshotBefore);
  assert.equal(e.getTask(t.id)?.attempts, 1);
  assert.equal(e.getTask(t.id)?.version, 3);
});

test('unknown risk domain fails closed', () => {
  const k = new SafetyKernel();

  assert.throws(() =>
    k.classify({
      type: 'CLICK',
      domain: 'UNKNOWN',
    }),
  );
});

test('model advice cannot lower safety decisions', () => {
  const k = new SafetyKernel();

  const financialAction: Action = {
    type: 'CLICK',
    domain: 'FINANCIAL',
    target: 'account',
    payload: {
      amount: 1000,
    },
  };

  assert.equal(
    k.authorize(
      financialAction,
      {
        allowed: true,
        confidence: 0.9,
      },
    ).allowed,
    false,
  );

  assert.equal(
    k.authorize(
      financialAction,
      {
        risk: 'LOW',
      },
    ).allowed,
    false,
  );

  assert.equal(
    k.authorize(
      financialAction,
      {},
    ).allowed,
    false,
  );

  const credentialAction: Action = {
    type: 'TYPE',
    domain: 'CREDENTIAL',
    target: 'password',
    payload: {},
  };

  assert.equal(
    k.authorize(
      credentialAction,
      {
        allowed: true,
      },
    ).allowed,
    false,
  );

  assert.equal(
    k.authorize(
      credentialAction,
      {
        risk: 'LOW',
      },
    ).allowed,
    false,
  );
});

test('financial boundary cannot be bypassed', () => {
  const k = new SafetyKernel();

  const financialActions: Action[] = [
    {
      type: 'CLICK',
      domain: 'FINANCIAL',
    },
    {
      type: 'TYPE',
      domain: 'FINANCIAL',
    },
  ];

  for (const action of financialActions) {
    assert.equal(
      k.authorize(
        action,
        {
          allowed: true,
        },
      ).allowed,
      false,
    );
  }
});

test('credential boundary cannot be bypassed', () => {
  const k = new SafetyKernel();

  const credentialActions: Action[] = [
    {
      type: 'CLICK',
      domain: 'CREDENTIAL',
    },
    {
      type: 'TYPE',
      domain: 'CREDENTIAL',
    },
  ];

  for (const action of credentialActions) {
    assert.equal(
      k.authorize(
        action,
        {
          allowed: true,
        },
      ).allowed,
      false,
    );
  }
});

test('caller cannot manufacture a valid authorization object', () => {
  const forgedAuth = {
    domain: 'FINANCIAL',
    risk: 'HIGH',
    token: Symbol('forged-token'),
  };

  assert.ok(
    !(forgedAuth instanceof Authorization),
  );

  const k = new SafetyKernel();

  const decision = k.authorize(
    {
      type: 'CLICK',
      domain: 'OBSERVATION',
    },
    {
      allowed: true,
    },
  );

  const authorization = decision.authorization;

  if (authorization === undefined) throw new Error('authorization must be defined');
  assert.ok(authorization);
  assert.ok(authorization instanceof Authorization);
  assert.equal(authorization.risk, 'HIGH');
});

test('network requires the correct authorization boundary', () => {
  const k = new SafetyKernel();

  const networkAction: Action = {
    type: 'CLICK',
    domain: 'NETWORK',
  };

  assert.equal(
    k.authorize(networkAction, {}).allowed,
    false,
  );
});

test('system requires the correct authorization boundary', () => {
  const k = new SafetyKernel();

  const systemAction: Action = {
    type: 'CLICK',
    domain: 'SYSTEM',
  };

  assert.equal(
    k.authorize(systemAction, {}).allowed,
    false,
  );
});

test('authorization is correctly scoped', () => {
  const k = new SafetyKernel();

  const action: Action = {
    type: 'CLICK',
    domain: 'OBSERVATION',
  };

  const decision = k.authorize(action, {});

  const authorization = decision.authorization;
  if (authorization === undefined) throw new Error('authorization must be defined');
  assert.ok(authorization instanceof Authorization);
  assert.equal(authorization.domain, 'OBSERVATION');
  assert.equal(authorization.risk, 'HIGH');
});

test('financial final authorization cannot be autonomously completed', () => {
  const k = new SafetyKernel();

  const financialAction: Action = {
    type: 'CLICK',
    domain: 'FINANCIAL',
    target: 'account',
    payload: {
      amount: 1000,
    },
  };

  // Even with model advice claiming financial actions are safe and allowed,
  // the Safety Kernel deterministically blocks them.
  assert.equal(
    k.authorize(financialAction, {
      allowed: true,
      confidence: 1.0,
    }).allowed,
    false,
  );

  assert.equal(
    k.authorize(financialAction, {}).allowed,
    false,
  );
});

test('platform implementation remains mock-only', () => {
  const p = new MockPlatformAdapter();

  assert.equal(p.executed.length, 0);

  const action: Action = {
    type: 'CLICK',
    domain: 'UI',
    target: 'button',
  };

  return p.execute(action).then((result) => {
    assert.equal(p.executed.length, 1);
    assert.deepEqual(p.executed[0], action);
    assert.ok(result.ok);
    assert.equal(result.message, 'Mock execution only');
  });
});