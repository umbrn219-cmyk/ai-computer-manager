/**
 * Phase 7 - Execution Orchestration Layer.
 *
 * Bridges a validated Phase-6 `TaskPlan` to controlled execution WITHOUT
 * absorbing any responsibility that already belongs to another component:
 *
 *   AI Manager            = WHAT should be done      (planning only)
 *   Execution Orchestrator= WHEN/WHICH step proceeds (this module)
 *   Task Engine           = task lifecycle/state     (state machine owner)
 *   Perception            = current UI observation   (observation owner)
 *   Action Engine         = safe execution of one action (execution owner)
 *   Safety Kernel         = authoritative policy     (policy owner)
 *   PlatformAdapter       = platform actuation       (reached only via ActionEngine)
 *
 * What this module deliberately does NOT do:
 *   - it never calls PlatformAdapter, never drives the OS, never imports a
 *     concrete provider/SDK/network/automation library,
 *   - it never calls ModelRouter (basic orchestration is deterministic; no LLM
 *     call is made per step),
 *   - it never authorizes anything. A model cannot grant authorization and the
 *     orchestrator cannot manufacture it: financial/credential actions pause in
 *     NEEDS_USER instead,
 *   - it never duplicates TaskEngine transitions, ActionEngine validation, or
 *     ActionEngine retry logic.
 *
 * Loop shape (observe -> act -> verify), always bounded:
 *   planned step (in plan order, never reordered)
 *     -> fresh observation (Perception)
 *     -> bind the action to the observed state signature
 *     -> ActionEngine.submitAction   (grounding, policy, pre-flight, actuation,
 *                                     postcondition - all owned by Phase 4)
 *     -> fresh observation + verifier decision
 *     -> advance / bounded step recovery / NEEDS_USER / FAILED
 */

import { freeze } from '../core/index.js';
import type {
  Action,
  ActionType,
  PerceptionProvider,
  Task,
  TaskEngine,
  UIStateGraph,
} from '../core/index.js';
import type { ActionOutcome } from '../action-engine/index.js';
import type { TaskPlan } from '../ai-manager/index.js';

/**
 * Narrow structural port for the execution boundary. The Phase-4
 * `ActionEngine` satisfies it directly, and tests may supply a deterministic
 * double. The orchestrator holds only this port, so it can never reach
 * `PlatformAdapter.execute` itself.
 */
export interface ActionExecutor {
  submitAction(action: Action): Promise<ActionOutcome>;
}

// --- Verification boundary -----------------------------------------------------

export type VerificationRequest = Readonly<{
  stepId: string;
  action?: Action;
  /**
   * Present when the attempt actually reached the ActionEngine and came back
   * with a successful actuation. Absent for the side-effect reconciliation
   * probe (see `reconcile`), where the orchestrator asks the verifier whether
   * the effect is already observable before it dares to repeat anything.
   */
  actionOutcome?: ActionOutcome;
  before?: UIStateGraph;
  after: UIStateGraph;
}>;

export type VerificationDecision = Readonly<{ verified: boolean; reason: string }>;

/**
 * Perception-based verification contract. The default implementation is
 * structural and deterministic; a semantic verifier (model- or
 * provider-backed) can be injected without changing this module's behaviour.
 */
export interface StepVerifier {
  verify(request: VerificationRequest): Promise<VerificationDecision>;
}

/**
 * Deterministic structural verifier. It never claims goal achievement - it only
 * refuses to accept a step when there is no evidence at all that a live UI was
 * observed after the action. Semantic postcondition checking is a future
 * extension point behind the same contract.
 */
export class ObservationBasedStepVerifier implements StepVerifier {
  async verify(request: VerificationRequest): Promise<VerificationDecision> {
    if (request.actionOutcome === undefined) {
      return {
        verified: false,
        reason: 'No successful action outcome to verify (reconciliation probe only)',
      };
    }
    if (!request.actionOutcome.success) {
      return { verified: false, reason: 'Action outcome was not successful' };
    }
    const signature = request.after.stateSignature;
    if (typeof signature !== 'string' || signature.trim() === '') {
      return { verified: false, reason: 'Post-action observation had no state signature' };
    }
    if (request.after.elements.length === 0) {
      return { verified: false, reason: 'Post-action observation contained no UI elements' };
    }
    return {
      verified: true,
      reason: `Structural verification: action accepted and a fresh observation was obtained (${signature})`,
    };
  }
}

// --- Centralized, bounded orchestration limits ---------------------------------

export type OrchestratorLimits = Readonly<{
  /** Maximum ActionEngine submissions for a single planned step (>= 1). */
  maxStepAttempts: number;
  /** Maximum number of planned steps accepted for one run. */
  maxPlanSteps: number;
  /** Hard cap for the task-level attempt budget handed to the TaskEngine. */
  maxTotalAttempts: number;
}>;

export const DEFAULT_ORCHESTRATOR_LIMITS: OrchestratorLimits = Object.freeze({
  maxStepAttempts: 2,
  maxPlanSteps: 20,
  maxTotalAttempts: 40,
});

// --- Deterministic reason taxonomy ---------------------------------------------

export type OrchestrationReason =
  | 'plan_invalid'
  | 'resume_unavailable'
  | 'orchestration_error'
  | 'observation_failure'
  | 'missing_target'
  | 'ambiguous_target'
  | 'stale_state'
  | 'user_interference'
  | 'safety_denied'
  | 'authorization_required'
  | 'preflight_rejected'
  | 'action_failed'
  | 'verification_failed'
  | 'informational_step';

export type ActionRejectionClass = Readonly<{
  reason: OrchestrationReason;
  disposition: 'retry' | 'needs_user' | 'fail';
  retryable: boolean;
}>;

/**
 * Read-only projection of the Phase-4 `ActionOutcome` contract into
 * orchestration categories. It never upgrades an outcome: a rejection stays a
 * rejection. Only the disposition (pause / bounded retry / terminal) is added.
 * A structured `reason` field on `ActionOutcome` would remove this projection -
 * that is the recorded future improvement, not something to work around here.
 */
export const classifyActionOutcome = (
  outcome: ActionOutcome,
  action: Action,
): ActionRejectionClass => {
  const message = outcome.message;
  if (message.startsWith('Ambiguous target')) {
    // Ambiguity is not resolved by repeating: a human must disambiguate.
    return { reason: 'ambiguous_target', disposition: 'needs_user', retryable: false };
  }
  if (message.startsWith('missing target')) {
    return { reason: 'missing_target', disposition: 'needs_user', retryable: false };
  }
  if (message.startsWith('State mismatch (stale)')) {
    // No actuation happened, so a fresh observation is a safe, bounded retry.
    return { reason: 'stale_state', disposition: 'retry', retryable: true };
  }
  if (message.startsWith('User interference detected')) {
    return { reason: 'user_interference', disposition: 'retry', retryable: true };
  }
  if (message.startsWith('SafetyKernel denied')) {
    if (action.domain === 'FINANCIAL' || action.domain === 'CREDENTIAL') {
      // Authorization is a human act. The orchestrator pauses; it never grants.
      return { reason: 'authorization_required', disposition: 'needs_user', retryable: false };
    }
    return { reason: 'safety_denied', disposition: 'fail', retryable: false };
  }
  if (message.startsWith('Pre-flight failed')) {
    return { reason: 'preflight_rejected', disposition: 'fail', retryable: false };
  }
  // Remaining Phase-4 failures (platform error, postcondition failure, retry
  // exhaustion). These may have actuated, so retrying is gated by the action's
  // own idempotency classification.
  return { reason: 'action_failed', disposition: 'retry', retryable: action.retryable !== false };
};

// --- Structured results --------------------------------------------------------

export type StepOutcome = Readonly<{
  stepId: string;
  index: number;
  kind: 'action' | 'informational';
  /** Only orchestration/verification may set this - never the model. */
  verified: boolean;
  completed: boolean;
  attempts: number;
  actionType?: ActionType;
  observedSignature?: string;
  reason?: OrchestrationReason;
  message?: string;
}>;

export type OrchestrationOutcome = Readonly<{
  status: 'completed' | 'needs_user' | 'failed';
  reason: OrchestrationReason | 'completed';
  message: string;
  /** True when a per-step attempt budget was consumed by bounded retries. */
  exhausted: boolean;
  /** True only when every step carrying an action was verified. */
  allVerified: boolean;
  taskId: string | null;
  task: Task | null;
  steps: readonly StepOutcome[];
}>;

// --- Execution Orchestrator ----------------------------------------------------

export type OrchestrationRequest = Readonly<{
  goal: string;
  /** A validated Phase-6 plan. Only structurally valid plans are accepted. */
  plan: TaskPlan;
}>;

type RunCursor = {
  taskId: string;
  plan: TaskPlan;
  stepIndex: number;
  readonly stepAttempts: Map<number, number>;
  /** Steps whose actuation happened but could not yet be verified. */
  readonly needsReconcile: Set<number>;
  readonly steps: StepOutcome[];
};

export type OrchestratorDependencies = Readonly<{
  taskEngine: TaskEngine;
  perception: PerceptionProvider;
  actionExecutor: ActionExecutor;
  verifier?: StepVerifier;
  limits?: OrchestratorLimits;
}>;

/**
 * Deterministic execution orchestrator. It owns only the run cursor (which
 * planned step is active, how many attempts that step consumed) - task
 * lifecycle stays with the TaskEngine, actuation with the ActionEngine, policy
 * with the SafetyKernel and observation with the Perception provider.
 */
export class ExecutionOrchestrator {
  private readonly taskEngine: TaskEngine;
  private readonly perception: PerceptionProvider;
  private readonly actionExecutor: ActionExecutor;
  private readonly verifier: StepVerifier;
  private readonly limits: OrchestratorLimits;
  private readonly cursors = new Map<string, RunCursor>();

  constructor(dependencies: OrchestratorDependencies) {
    const limits = dependencies.limits ?? DEFAULT_ORCHESTRATOR_LIMITS;
    const positive = (value: number): boolean => Number.isInteger(value) && value >= 1;
    if (
      !positive(limits.maxStepAttempts) ||
      !positive(limits.maxPlanSteps) ||
      !positive(limits.maxTotalAttempts)
    ) {
      throw new RangeError('Orchestrator limits must be positive integers');
    }
    this.taskEngine = dependencies.taskEngine;
    this.perception = dependencies.perception;
    this.actionExecutor = dependencies.actionExecutor;
    this.verifier = dependencies.verifier ?? new ObservationBasedStepVerifier();
    this.limits = limits;
  }

  /** Run a validated plan to a terminal or paused outcome. Never unbounded. */
  async run(request: OrchestrationRequest): Promise<OrchestrationOutcome> {
    try {
      const goal = request.goal.trim();
      const planProblem = this.validatePlan(request.plan, goal);
      if (planProblem !== null) {
        return this.outcome('failed', 'plan_invalid', planProblem, false, false, null, null, []);
      }
      const actionSteps = request.plan.steps.filter((step) => step.action !== undefined).length;
      const requiredAttempts = Math.max(1, actionSteps * this.limits.maxStepAttempts);
      if (requiredAttempts > this.limits.maxTotalAttempts) {
        return this.outcome(
          'failed',
          'plan_invalid',
          `Plan needs up to ${requiredAttempts} task attempts which exceeds the configured cap of ${this.limits.maxTotalAttempts}`,
          false,
          false,
          null,
          null,
          [],
        );
      }
      const task = this.taskEngine.createTask(goal, requiredAttempts);
      const cursor: RunCursor = {
        taskId: task.id,
        plan: request.plan,
        stepIndex: 0,
        stepAttempts: new Map(),
        needsReconcile: new Set(),
        steps: [],
      };
      this.cursors.set(task.id, cursor);
      // The plan arrived already validated by the AI Manager, so the lifecycle
      // goes straight from PLANNING to READY.
      this.taskEngine.transition(task.id, 'PLANNING');
      this.taskEngine.transition(task.id, 'READY');
      return await this.advance(cursor);
    } catch (error) {
      return this.outcome(
        'failed',
        'orchestration_error',
        error instanceof Error ? error.message : String(error),
        false,
        false,
        null,
        null,
        [],
      );
    }
  }

  /**
   * Resume a paused run from its checkpoint (the stored step cursor). Nothing is
   * replayed from the start and no already-completed step is re-executed.
   */
  async resume(taskId: string): Promise<OrchestrationOutcome> {
    const cursor = this.cursors.get(taskId);
    if (cursor === undefined) {
      return this.outcome(
        'failed',
        'resume_unavailable',
        `No resumable run checkpoint for task ${taskId}`,
        false,
        false,
        taskId,
        this.taskEngine.getTask(taskId) ?? null,
        [],
      );
    }
    try {
      const task = this.taskEngine.getTask(taskId);
      if (task === undefined) {
        return this.outcome(
          'failed',
          'resume_unavailable',
          `Task not found: ${taskId}`,
          false,
          false,
          taskId,
          null,
          cursor.steps,
        );
      }
      if (task.state === 'NEEDS_USER') {
        this.taskEngine.transition(taskId, 'READY');
      }
      return await this.advance(cursor);
    } catch (error) {
      return this.outcome(
        'failed',
        'orchestration_error',
        error instanceof Error ? error.message : String(error),
        false,
        false,
        taskId,
        this.taskEngine.getTask(taskId) ?? null,
        cursor.steps,
      );
    }
  }

  private validatePlan(plan: TaskPlan, goal: string): string | null {
    if (goal === '') return 'A run requires a non-empty goal';
    if (plan.steps.length === 0) return 'A run requires a non-empty plan';
    if (plan.steps.length > this.limits.maxPlanSteps) {
      return `Plan has ${plan.steps.length} steps which exceeds the configured maximum of ${this.limits.maxPlanSteps}`;
    }
    const seen = new Set<string>();
    for (const step of plan.steps) {
      if (step.id.trim() === '') return 'Every planned step requires a non-empty id';
      if (seen.has(step.id)) return `Duplicate planned step id: ${step.id}`;
      seen.add(step.id);
    }
    return null;
  }

  private outcome(
    status: OrchestrationOutcome['status'],
    reason: OrchestrationOutcome['reason'],
    message: string,
    exhausted: boolean,
    allVerified: boolean,
    taskId: string | null,
    task: Task | null,
    steps: readonly StepOutcome[],
  ): OrchestrationOutcome {
    return freeze({
      status,
      reason,
      message,
      exhausted,
      allVerified,
      taskId,
      task,
      steps: [...steps],
    });
  }

  /** Walk the plan in order. Never reorders, never skips a step silently. */
  private async advance(cursor: RunCursor): Promise<OrchestrationOutcome> {
    while (cursor.stepIndex < cursor.plan.steps.length) {
      const index = cursor.stepIndex;
      const step = cursor.plan.steps[index];
      if (step === undefined) break;
      if (step.action === undefined) {
        // The core TaskStep contract makes `action` optional, so a step without
        // an action is informational: nothing is fabricated or invented.
        cursor.steps.push(
          freeze({
            stepId: step.id,
            index,
            kind: 'informational' as const,
            verified: false,
            completed: true,
            attempts: 0,
            reason: 'informational_step' as const,
            message: 'Step carries no action; recorded as informational (no action fabricated)',
          }),
        );
        cursor.stepIndex = index + 1;
        continue;
      }
      const halted = await this.runStep(cursor, step.action, step.id, index);
      if (halted !== null) return halted;
      cursor.stepIndex = index + 1;
    }

    // Every step is done. Completion requires verification, not model claims.
    const current = this.requireTask(cursor.taskId);
    if (current.state === 'READY') this.taskEngine.transition(cursor.taskId, 'RUNNING');
    if (this.requireTask(cursor.taskId).state === 'RUNNING') {
      this.taskEngine.transition(cursor.taskId, 'VERIFYING');
    }
    const task = this.taskEngine.transition(cursor.taskId, 'COMPLETED');
    const allVerified = cursor.steps.every((step) => step.kind === 'informational' || step.verified);
    return this.outcome(
      'completed',
      'completed',
      `Task completed: ${cursor.steps.length} step(s) processed, allVerified=${String(allVerified)}`,
      false,
      allVerified,
      task.id,
      task,
      cursor.steps,
    );
  }

  private enterRunning(taskId: string): void {
    const task = this.requireTask(taskId);
    if (task.state === 'READY' || task.state === 'VERIFYING') {
      this.taskEngine.transition(taskId, 'RUNNING');
    }
  }

  private requireTask(taskId: string): Task {
    const task = this.taskEngine.getTask(taskId);
    if (task === undefined) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  /** Terminal / paused step stop with a precise reason and step record. */
  private halt(
    cursor: RunCursor,
    index: number,
    stepId: string,
    attempts: number,
    status: 'failed' | 'needs_user',
    reason: OrchestrationReason,
    message: string,
    actionType?: ActionType,
    exhausted = false,
  ): OrchestrationOutcome {
    cursor.steps.push(
      freeze({
        stepId,
        index,
        kind: 'action' as const,
        verified: false,
        completed: false,
        attempts,
        reason,
        message,
        ...(actionType !== undefined ? { actionType } : {}),
      }),
    );
    const task = this.taskEngine.transition(cursor.taskId, status === 'needs_user' ? 'NEEDS_USER' : 'FAILED');
    return this.outcome(status, reason, message, exhausted, false, task.id, task, cursor.steps);
  }

  /**
   * One planned step: observe -> (reconcile) -> submit to the ActionEngine ->
   * verify. Bounded by `maxStepAttempts`; every exit carries a precise reason.
   */
  private async runStep(
    cursor: RunCursor,
    action: Action,
    stepId: string,
    index: number,
  ): Promise<OrchestrationOutcome | null> {
    let attempts = cursor.stepAttempts.get(index) ?? 0;
    let lastReason: OrchestrationReason = 'action_failed';
    let lastMessage = '';
    const describe = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    while (attempts < this.limits.maxStepAttempts) {
      this.enterRunning(cursor.taskId);
      attempts += 1;
      cursor.stepAttempts.set(index, attempts);

      // 1. Observation before any action is even considered.
      let before: UIStateGraph;
      try {
        before = await this.perception.observe();
      } catch (error) {
        return this.halt(
          cursor,
          index,
          stepId,
          attempts,
          'failed',
          'observation_failure',
          `Observation failed before action: ${describe(error)}`,
          action.type,
        );
      }

      // 2. If a previous attempt actuated but could not be verified, ask the
      //    verifier whether the effect is already observable BEFORE repeating.
      if (cursor.needsReconcile.has(index)) {
        const reconciliation = await this.verifier.verify({ stepId, action, before, after: before });
        if (reconciliation.verified) {
          cursor.needsReconcile.delete(index);
          this.taskEngine.transition(cursor.taskId, 'VERIFYING');
          cursor.steps.push(
            freeze({
              stepId,
              index,
              kind: 'action' as const,
              verified: true,
              completed: true,
              attempts,
              actionType: action.type,
              observedSignature: before.stateSignature,
              message: `Reconciled without repeating the action: ${reconciliation.reason}`,
            }),
          );
          return null;
        }
      }

      // 3. Bind the action to the state we just observed. The signature is
      //    observed, never fabricated, and only bound for target-sensitive
      //    actions so the ActionEngine's stale/interference checks stay live.
      const submitted: Action =
        action.target !== undefined ? { ...action, stateSignature: before.stateSignature } : action;

      // 4. Execution boundary: ActionEngine owns grounding, policy, pre-flight,
      //    actuation and postcondition checks.
      let outcome: ActionOutcome;
      try {
        outcome = await this.actionExecutor.submitAction(submitted);
      } catch (error) {
        lastReason = 'action_failed';
        lastMessage = `Action submission failed: ${describe(error)}`;
        continue;
      }

      if (outcome.success) {
        // 5. Fresh observation + verification. Platform acceptance is not proof.
        let after: UIStateGraph;
        try {
          after = await this.perception.observe();
        } catch (error) {
          return this.halt(
            cursor,
            index,
            stepId,
            attempts,
            'failed',
            'observation_failure',
            `Observation failed after action: ${describe(error)}`,
            action.type,
          );
        }
        const decision = await this.verifier.verify({
          stepId,
          action: submitted,
          actionOutcome: outcome,
          before,
          after,
        });
        if (decision.verified) {
          this.taskEngine.transition(cursor.taskId, 'VERIFYING');
          cursor.steps.push(
            freeze({
              stepId,
              index,
              kind: 'action' as const,
              verified: true,
              completed: true,
              attempts,
              actionType: action.type,
              observedSignature: after.stateSignature,
              message: decision.reason,
            }),
          );
          return null;
        }
        // Not verified: the step is NOT complete, and the actuation may already
        // have had an effect - so the next attempt reconciles first.
        cursor.needsReconcile.add(index);
        lastReason = 'verification_failed';
        lastMessage = decision.reason;
        continue;
      }

      // 6. Rejection: classify the existing ActionOutcome contract.
      const classified = classifyActionOutcome(outcome, action);
      lastReason = classified.reason;
      lastMessage = outcome.message;
      if (classified.disposition === 'needs_user') {
        return this.halt(
          cursor,
          index,
          stepId,
          attempts,
          'needs_user',
          classified.reason,
          outcome.message,
          action.type,
        );
      }
      if (classified.disposition === 'fail') {
        return this.halt(cursor, index, stepId, attempts, 'failed', classified.reason, outcome.message, action.type);
      }
      if (!classified.retryable) {
        return this.halt(
          cursor,
          index,
          stepId,
          attempts,
          'failed',
          classified.reason,
          `${outcome.message} (not retryable: the action is not repeated)`,
          action.type,
        );
      }
    }

    // Budget consumed: terminal failure, with the specific last reason kept.
    return this.halt(
      cursor,
      index,
      stepId,
      attempts,
      'failed',
      lastReason,
      `${lastMessage} (step attempt budget of ${this.limits.maxStepAttempts} exhausted)`,
      action.type,
      true,
    );
  }

}
