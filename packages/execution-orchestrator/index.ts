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

import { CHECKPOINT_SCHEMA_VERSION, CheckpointRejectedError, freeze } from '../core/index.js';
import type {
  Action,
  ActionType,
  CheckpointStatus,
  CheckpointStore,
  ExecutionCheckpoint,
  PerceptionProvider,
  Task,
  TaskEngine,
  TaskState,
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
  | 'recovery_required'
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

/** Runtime vocabulary of the reason union, used to validate recovered reasons. */
const ORCHESTRATION_REASONS: readonly OrchestrationReason[] = [
  'plan_invalid',
  'resume_unavailable',
  'recovery_required',
  'orchestration_error',
  'observation_failure',
  'missing_target',
  'ambiguous_target',
  'stale_state',
  'user_interference',
  'safety_denied',
  'authorization_required',
  'preflight_rejected',
  'action_failed',
  'verification_failed',
  'informational_step',
];

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
  status: 'completed' | 'needs_user' | 'failed' | 'recovery_required';
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
  /** Deterministic plan fingerprint - the checkpoint `planVersion`. */
  planVersion: string;
  stepIndex: number;
  readonly stepAttempts: Map<number, number>;
  /** Steps whose actuation happened but could not yet be verified. */
  readonly needsReconcile: Set<number>;
  /**
   * Steps recovered from a durable checkpoint where an actuation may have
   * happened without a confirmable result. These must never be blindly
   * replayed: if reconciliation cannot confirm the effect, the run stops.
   */
  readonly ambiguityPending: Set<number>;
  readonly verifiedStepIds: string[];
  readonly steps: StepOutcome[];
  /** Reason recorded when the run paused for user interaction. */
  pauseReason?: OrchestrationReason;
  /** Reason recorded when the run stopped terminally. */
  terminalReason?: OrchestrationReason;
};

export type OrchestratorDependencies = Readonly<{
  taskEngine: TaskEngine;
  perception: PerceptionProvider;
  actionExecutor: ActionExecutor;
  verifier?: StepVerifier;
  limits?: OrchestratorLimits;
  /**
   * Optional durable checkpoint store (behind StorageEngine). When absent, the
   * cursor stays in memory exactly as in Phase 7.
   */
  checkpoints?: CheckpointStore;
  /**
   * How the caller supplies the plan when a durable resume happens in a NEW
   * process. Checkpoints deliberately store plan identity (`planVersion`
   * fingerprint) only, never plan contents, so the plan must come from the
   * caller's own store. Same-process resumes use the in-memory plan registry.
   */
  resolvePlan?: (taskId: string) => TaskPlan | undefined;
}>;

/**
 * Deterministic content fingerprint of a plan, used as the checkpoint
 * `planVersion`. A checkpoint can therefore never be resumed against a
 * different plan, and it contains no model prose or secrets.
 */
export const planFingerprint = (plan: TaskPlan): string => {
  const steps = plan.steps.map((step) => {
    const action = step.action;
    const actionPart =
      action === undefined
        ? 'none'
        : [action.type, action.domain, action.target ?? '', String(action.retryable ?? '')].join('~');
    return [step.id, step.description, actionPart].join('|');
  });
  return `p1:${steps.length}:${steps.join('||')}`;
};

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
  private readonly checkpoints: CheckpointStore | undefined;
  private readonly resolvePlan: ((taskId: string) => TaskPlan | undefined) | undefined;
  private readonly cursors = new Map<string, RunCursor>();
  /** Plans seen in this process, so an in-process durable resume needs no lookup. */
  private readonly plans = new Map<string, TaskPlan>();

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
    this.checkpoints = dependencies.checkpoints;
    this.resolvePlan = dependencies.resolvePlan;
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
        planVersion: planFingerprint(request.plan),
        stepIndex: 0,
        stepAttempts: new Map(),
        needsReconcile: new Set(),
        ambiguityPending: new Set(),
        verifiedStepIds: [],
        steps: [],
      };
      this.cursors.set(task.id, cursor);
      this.plans.set(task.id, request.plan);
      // The plan arrived already validated by the AI Manager, so the lifecycle
      // goes straight from PLANNING to READY.
      this.taskEngine.transition(task.id, 'PLANNING');
      this.taskEngine.transition(task.id, 'READY');
      // Durable boundary 1: the task has entered an executable state.
      this.writeCheckpoint(cursor, { status: 'RUNNING', reconcilePending: false });
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
   * Resume a run from its durable checkpoint. The signature is unchanged from
   * Phase 7: the plan is recovered from this process's registry, or from the
   * caller's own store through the optional `resolvePlan` dependency.
   *
   * A run paused in NEEDS_USER is NOT resumed by this call - the user boundary
   * is reported back instead, so a restart can never cross it automatically.
   */
  async resume(taskId: string): Promise<OrchestrationOutcome> {
    const inMemory = this.cursors.get(taskId);
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
          inMemory?.steps ?? [],
        );
      }

      // Terminal tasks: nothing to resume. A leftover checkpoint is cleaned up.
      if (task.state === 'COMPLETED' || task.state === 'FAILED') {
        return this.terminalOutcome(taskId, task, inMemory);
      }

      const plan = this.plans.get(taskId) ?? this.resolvePlan?.(taskId);
      if (inMemory !== undefined) {
        return await this.continueTask(inMemory, plan);
      }
      return await this.durableResume(task, plan);
    } catch (error) {
      return this.outcome(
        'failed',
        'orchestration_error',
        error instanceof Error ? error.message : String(error),
        false,
        false,
        taskId,
        this.taskEngine.getTask(taskId) ?? null,
        inMemory?.steps ?? [],
      );
    }
  }

  /** In-process continuation of a run that already has a cursor. */
  private async continueTask(
    cursor: RunCursor,
    plan: TaskPlan | undefined,
  ): Promise<OrchestrationOutcome> {
    if (plan !== undefined && planFingerprint(plan) !== cursor.planVersion) {
      return this.recovery(
        cursor,
        'Resume refused: the supplied plan does not match the active run (plan identity mismatch)',
      );
    }
    const task = this.taskEngine.getTask(cursor.taskId);
    if (task === undefined) {
      return this.outcome(
        'failed',
        'resume_unavailable',
        `Task not found: ${cursor.taskId}`,
        false,
        false,
        cursor.taskId,
        null,
        cursor.steps,
      );
    }
    if (task.state === 'NEEDS_USER') {
      // The user boundary survives the resume call: it must be crossed by an
      // explicit user action outside this API, never automatically.
      return this.outcome(
        'needs_user',
        cursor.pauseReason ?? 'authorization_required',
        'Run is paused for user interaction; resume reports the pause and never crosses it automatically',
        false,
        false,
        task.id,
        task,
        cursor.steps,
      );
    }
    this.writeCheckpoint(cursor, {
      status: 'RUNNING',
      reconcilePending: cursor.needsReconcile.size > 0,
    });
    return await this.advance(cursor);
  }

  /** Rebuild the cursor from a durable checkpoint (fresh process). */
  private async durableResume(
    task: Task,
    plan: TaskPlan | undefined,
  ): Promise<OrchestrationOutcome> {
    if (this.checkpoints === undefined) {
      return this.outcome(
        'failed',
        'resume_unavailable',
        'No in-memory cursor and no checkpoint store configured',
        false,
        false,
        task.id,
        task,
        [],
      );
    }
    let checkpoint: ExecutionCheckpoint | undefined;
    try {
      checkpoint = this.checkpoints.loadCheckpoint(task.id);
    } catch (error) {
      return this.outcome(
        'recovery_required',
        'recovery_required',
        `Checkpoint rejected: ${error instanceof Error ? error.message : String(error)}`,
        false,
        false,
        task.id,
        task,
        [],
      );
    }
    if (checkpoint === undefined) {
      return this.outcome(
        'failed',
        'resume_unavailable',
        `No durable checkpoint for task ${task.id}`,
        false,
        false,
        task.id,
        task,
        [],
      );
    }
    if (checkpoint.taskVersion > task.version) {
      // A checkpoint from the future can only be corrupt or foreign.
      return this.outcome(
        'recovery_required',
        'recovery_required',
        `Checkpoint taskVersion ${checkpoint.taskVersion} is ahead of task version ${task.version}: refusing a foreign checkpoint`,
        false,
        false,
        task.id,
        task,
        [],
      );
    }
    if (task.state === 'NEEDS_USER') {
      return this.outcome(
        'needs_user',
        this.reasonFrom(checkpoint.reason) ?? 'authorization_required',
        'Restored pause: this task still requires an explicit user action after restart',
        false,
        false,
        task.id,
        task,
        [],
      );
    }
    if (plan === undefined) {
      return this.outcome(
        'failed',
        'resume_unavailable',
        'A durable resume needs the plan, and none is available for this task',
        false,
        false,
        task.id,
        task,
        [],
      );
    }
    if (planFingerprint(plan) !== checkpoint.planVersion) {
      return this.outcome(
        'recovery_required',
        'recovery_required',
        'Checkpoint plan identity does not match the supplied plan: the old checkpoint cannot be consumed',
        false,
        false,
        task.id,
        task,
        [],
      );
    }
    const cursor: RunCursor = {
      taskId: task.id,
      plan,
      planVersion: checkpoint.planVersion,
      stepIndex: checkpoint.activeStepIndex,
      stepAttempts: new Map(checkpoint.stepAttempts.map((entry) => [entry.index, entry.attempts])),
      needsReconcile: new Set(checkpoint.reconcilePending ? [checkpoint.activeStepIndex] : []),
      ambiguityPending: new Set(checkpoint.reconcilePending ? [checkpoint.activeStepIndex] : []),
      verifiedStepIds: [...checkpoint.verifiedStepIds],
      steps: this.rebuildStepRecords(checkpoint, plan),
    };
    this.cursors.set(task.id, cursor);
    this.plans.set(task.id, plan);
    this.writeCheckpoint(cursor, {
      status: 'RUNNING',
      reconcilePending: checkpoint.reconcilePending,
    });
    return await this.advance(cursor);
  }

  /**
   * Minimal reporting records for steps a checkpoint says are already verified.
   * Only verification recorded in the checkpoint produces these; a model can
   * never establish them.
   */
  private rebuildStepRecords(checkpoint: ExecutionCheckpoint, plan: TaskPlan): StepOutcome[] {
    const records: StepOutcome[] = [];
    for (const id of checkpoint.verifiedStepIds) {
      const index = plan.steps.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        records.push({
          stepId: id,
          index,
          kind: 'action',
          verified: true,
          completed: true,
          attempts: 0,
        });
      }
    }
    return records;
  }

  /** Terminal task: nothing to resume; remove any leftover checkpoint. */
  private terminalOutcome(
    taskId: string,
    task: Task,
    cursor: RunCursor | undefined,
  ): OrchestrationOutcome {
    this.deleteCheckpoint(taskId);
    const completed = task.state === 'COMPLETED';
    const reason: OrchestrationOutcome['reason'] = completed
      ? 'completed'
      : this.reasonFrom(cursor?.terminalReason) ?? 'orchestration_error';
    return this.outcome(
      completed ? 'completed' : 'failed',
      reason,
      completed
        ? 'Task is already complete; checkpoint removed'
        : `Task is already terminal (${task.state}); checkpoint removed`,
      false,
      completed,
      task.id,
      task,
      cursor?.steps ?? [],
    );
  }

  private recovery(cursor: RunCursor, message: string): OrchestrationOutcome {
    return this.outcome(
      'recovery_required',
      'recovery_required',
      message,
      false,
      false,
      cursor.taskId,
      this.taskEngine.getTask(cursor.taskId) ?? null,
      cursor.steps,
    );
  }

  private reasonFrom(value: string | undefined): OrchestrationReason | undefined {
    if (value === undefined) return undefined;
    return ORCHESTRATION_REASONS.includes(value as OrchestrationReason)
      ? (value as OrchestrationReason)
      : undefined;
  }

  private deleteCheckpoint(taskId: string): void {
    if (this.checkpoints === undefined) return;
    this.checkpoints.deleteCheckpoint(taskId);
  }

  /**
   * Persist the complete immutable checkpoint as one logical operation. The
   * snapshot is always built in full, so a partial write is impossible. A write
   * the store rejects as stale is not an error for the run: the newer stored
   * state wins, exactly as required.
   */
  private writeCheckpoint(
    cursor: RunCursor,
    state: Readonly<{
      status: CheckpointStatus;
      reconcilePending: boolean;
      reason?: string;
      activeStepIndex?: number;
      verifiedStepIds?: readonly string[];
    }>,
  ): void {
    if (this.checkpoints === undefined) return;
    const task = this.taskEngine.getTask(cursor.taskId);
    if (task === undefined) return;
    const activeStepIndex = state.activeStepIndex ?? cursor.stepIndex;
    const checkpoint: ExecutionCheckpoint = {
      taskId: task.id,
      taskVersion: task.version,
      planVersion: cursor.planVersion,
      activeStepIndex,
      stepAttempts: [...cursor.stepAttempts.entries()]
        .filter(([index]) => index <= activeStepIndex)
        .map(([index, attempts]) => ({ index, attempts })),
      verifiedStepIds: [...(state.verifiedStepIds ?? cursor.verifiedStepIds)],
      status: state.status,
      reconcilePending: state.reconcilePending,
      checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
      ...(state.reason !== undefined ? { reason: state.reason } : {}),
    };
    try {
      this.checkpoints.saveCheckpoint(checkpoint);
    } catch (error) {
      if (error instanceof CheckpointRejectedError) return;
      throw error;
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
    // Durable boundary: completion is recorded atomically, then the checkpoint is
    // removed - completed runs never retain one.
    this.writeCheckpoint(cursor, {
      status: 'COMPLETED',
      reconcilePending: false,
      activeStepIndex: cursor.steps.length,
    });
    this.deleteCheckpoint(cursor.taskId);
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
    status: 'failed' | 'needs_user' | 'recovery_required',
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
    if (status === 'failed') {
      cursor.terminalReason = reason;
    } else {
      cursor.pauseReason = reason;
    }
    const target: TaskState = status === 'failed' ? 'FAILED' : 'NEEDS_USER';
    const current = this.taskEngine.getTask(cursor.taskId);
    const task =
      current !== undefined && current.state === target
        ? current
        : this.taskEngine.transition(cursor.taskId, target);
    if (status === 'failed') {
      // Terminal: the checkpoint has no further purpose (data lifecycle - no
      // retention for terminal tasks).
      this.deleteCheckpoint(cursor.taskId);
    } else {
      // Durable boundary: a pause the user must resolve. Written against the new
      // task version so a restart can restore the boundary exactly.
      this.writeCheckpoint(cursor, {
        status: 'NEEDS_USER',
        reconcilePending: cursor.needsReconcile.has(index),
        reason,
        activeStepIndex: index,
      });
    }
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
      // Durable boundary: the attempt has begun. `reconcilePending` carries the
      // "an actuation may already have happened for this step" marker forward, so
      // a crash here can never masquerade as a clean pre-action state.
      this.writeCheckpoint(cursor, {
        status: 'RUNNING',
        reconcilePending: cursor.needsReconcile.has(index),
        activeStepIndex: index,
      });

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
          if (!cursor.verifiedStepIds.includes(stepId)) cursor.verifiedStepIds.push(stepId);
          // Durable boundary: the step is verified and the cursor advances.
          this.writeCheckpoint(cursor, {
            status: 'RUNNING',
            reconcilePending: false,
            activeStepIndex: index + 1,
          });
          return null;
        }
        if (cursor.ambiguityPending.has(index)) {
          // Recovered from a restart: an actuation may or may not have happened
          // and the verifier cannot confirm it. Replaying is not safe, so the run
          // stops for a human decision instead of guessing.
          cursor.ambiguityPending.delete(index);
          return this.halt(
            cursor,
            index,
            stepId,
            attempts,
            'recovery_required',
            'recovery_required',
            'Unconfirmed actuation after restart: the previous attempt may have taken effect and cannot be verified, so the action is not replayed',
            action.type,
            true,
          );
        }
      }

      // 3. Bind the action to the state we just observed. The signature is
      //    observed, never fabricated, and only bound for target-sensitive
      //    actions so the ActionEngine's stale/interference checks stay live.
      const submitted: Action =
        action.target !== undefined ? { ...action, stateSignature: before.stateSignature } : action;

      // Durable boundary: about to hand the action to the execution boundary, so
      // the checkpoint now records that an actuation may occur. This is exactly
      // what lets a crash between action and checkpoint be recovered without a
      // blind replay.
      this.writeCheckpoint(cursor, {
        status: 'RUNNING',
        reconcilePending: true,
        activeStepIndex: index,
      });

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
          if (!cursor.verifiedStepIds.includes(stepId)) cursor.verifiedStepIds.push(stepId);
          // Durable boundary: the step is verified and the cursor advances. The
          // pending-actuation marker is cleared because this step is settled.
          this.writeCheckpoint(cursor, {
            status: 'RUNNING',
            reconcilePending: false,
            activeStepIndex: index + 1,
          });
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
