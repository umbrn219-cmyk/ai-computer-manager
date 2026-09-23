/**
 * Phase 6 - AI Manager / Planning Layer.
 *
 * Responsibility separation (unchanged from the existing architecture):
 *   user goal -> AI Manager -> validated TaskPlan
 *   The task engine owns task lifecycle, the action engine owns safe execution
 *   of a single action, the safety kernel stays the authoritative policy
 *   boundary, and the model router stays the only model/provider abstraction.
 *
 * This module:
 *   - never selects or calls a concrete model provider. It holds the core
 *     `ModelRouter` contract only and resolves roles through the provider
 *     neutral role table,
 *   - treats every model response as untrusted input and validates it before a
 *     plan is returned,
 *   - is strictly bounded (max steps, max planning attempts, centralized
 *     configuration),
 *   - plans only. It never drives the platform layer, never runs actions and
 *     never manufactures authorization. A plan is a proposal for the task
 *     engine; the safety kernel still has the final say at execution time.
 */

import type {
  Action,
  ActionType,
  ModelRouter,
  RiskDomain,
  TaskStep,
} from '../core/index.js';
import {
  MODEL_ROLE_CAPABILITY,
  ModelProviderError,
  UnsupportedCapabilityError,
} from '../models/index.js';

// --- Intent representation --------------------------------------------------

/** Structured, provider-neutral interpretation of a user goal. */
export type UserIntent = Readonly<{
  /** The (trimmed) goal the user asked for. */
  goal: string;
  /** Normalized objective produced by the intent stage. */
  objective: string;
  /** Constraints the plan must respect. */
  constraints: readonly string[];
  /** Planning context; opaque data carried through to the planner input. */
  context: Readonly<Record<string, unknown>>;
}>;

// --- Task plan representation ------------------------------------------------

/**
 * One planned step. Structurally identical to the core `TaskStep` contract so
 * a validated plan can be handed to the task engine without inventing a second
 * task model. `verified` is always false in a plan: only the execution layer
 * can verify a step, never the model that proposed it.
 */
export type PlannedStep = Readonly<{
  id: string;
  description: string;
  action?: Action;
  verified: boolean;
}>;

/** A validated, bounded, provider-neutral plan. */
export type TaskPlan = Readonly<{
  goal: string;
  steps: readonly PlannedStep[];
}>;

/**
 * Declared adapter seam into the existing task contracts: plan steps are
 * directly usable as task engine steps. This function is intentionally
 * identity-like; it keeps the compatibility promise explicit and turns any
 * future contract drift into a compile error instead of a silent one.
 */
export const planStepsToTaskSteps = (plan: TaskPlan): readonly TaskStep[] => plan.steps;

// --- Centralized, bounded planning limits ------------------------------------

export type AIManagerLimits = Readonly<{
  /** Maximum number of steps a returned plan may contain. */
  maxSteps: number;
  /** Maximum number of planner model calls for one goal. */
  maxPlanningAttempts: number;
}>;

export const DEFAULT_AI_MANAGER_LIMITS: AIManagerLimits = Object.freeze({
  maxSteps: 12,
  maxPlanningAttempts: 2,
});

// --- Deterministic failure model ---------------------------------------------

/**
 * Every planning failure is explicit. A failed result never carries a plan and
 * no failure is silently converted into a success.
 */
export type PlanningFailureReason =
  | 'empty_goal'
  | 'intent_invalid'
  | 'plan_malformed'
  | 'plan_empty'
  | 'plan_too_large'
  | 'step_invalid'
  | 'unknown_action_type'
  | 'invalid_risk_domain'
  | 'action_invalid'
  | 'attempts_exhausted'
  | 'provider_failure'
  | 'unsupported_capability';

export type PlanningFailure = Readonly<{
  ok: false;
  reason: PlanningFailureReason;
  message: string;
  attempts: number;
  detail?: string;
}>;

export type PlanningSuccess = Readonly<{
  ok: true;
  intent: UserIntent;
  plan: TaskPlan;
  attempts: number;
}>;

export type PlanningResult = PlanningSuccess | PlanningFailure;

export type ValidationFailure = Readonly<{ ok: false; reason: PlanningFailureReason; message: string }>;
export type ValidationResult<T> = Readonly<{ ok: true; value: T }> | ValidationFailure;

const fail = (reason: PlanningFailureReason, message: string): ValidationFailure => ({
  ok: false,
  reason,
  message,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Structural vocabularies for untrusted-output validation. Core does not export
// runtime value lists, so the allowed values are mirrored here for structural
// checks only. The SafetyKernel (never this module) stays the authority on what
// an action is allowed to do.
const ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  'CLICK',
  'TYPE',
  'KEY_PRESS',
  'SCROLL',
  'OPEN',
  'SELECT',
  'WAIT',
  'OBSERVE',
]);
const RISK_DOMAINS: ReadonlySet<string> = new Set<string>([
  'OBSERVATION',
  'UI',
  'FILESYSTEM',
  'NETWORK',
  'CREDENTIAL',
  'FINANCIAL',
  'SYSTEM',
]);

// --- Untrusted model output validation ---------------------------------------
//
// Model responses are data, never instructions and never authority. Every
// parser below rebuilds the domain objects field by field, so unknown fields
// (for example a model-provided "authorized": true) are dropped instead of
// trusted, and malformed input always yields a deterministic failure.

export const parseIntentResponse = (
  response: unknown,
): ValidationResult<Pick<UserIntent, 'objective' | 'constraints'>> => {
  if (!isPlainObject(response)) {
    return fail('intent_invalid', 'Intent response must be an object');
  }
  const objective = response['objective'];
  if (typeof objective !== 'string' || objective.trim() === '') {
    return fail('intent_invalid', 'Intent response requires a non-empty string "objective"');
  }
  const constraints: string[] = [];
  const rawConstraints = response['constraints'];
  if (rawConstraints !== undefined) {
    if (!Array.isArray(rawConstraints)) {
      return fail('intent_invalid', 'Intent "constraints" must be an array of strings when present');
    }
    for (const constraint of rawConstraints) {
      if (typeof constraint !== 'string') {
        return fail('intent_invalid', 'Intent "constraints" must be an array of strings when present');
      }
      constraints.push(constraint);
    }
  }
  return { ok: true, value: { objective, constraints } };
};

const parseAction = (raw: unknown, label: string): ValidationResult<Action> => {
  if (!isPlainObject(raw)) {
    return fail('action_invalid', `${label}.action must be an object`);
  }
  const type = raw['type'];
  if (typeof type !== 'string' || !ACTION_TYPES.has(type)) {
    return fail('unknown_action_type', `${label}.action has an unknown action type: ${String(type)}`);
  }
  const domain = raw['domain'];
  if (typeof domain !== 'string' || !RISK_DOMAINS.has(domain)) {
    return fail('invalid_risk_domain', `${label}.action has an invalid risk domain: ${String(domain)}`);
  }
  const target = raw['target'];
  if (target !== undefined && typeof target !== 'string') {
    return fail('action_invalid', `${label}.action "target" must be a string when present`);
  }
  const payload = raw['payload'];
  if (payload !== undefined && !isPlainObject(payload)) {
    return fail('action_invalid', `${label}.action "payload" must be an object when present`);
  }
  const action: Action = {
    type: type as ActionType,
    domain: domain as RiskDomain,
  };
  // exactOptionalPropertyTypes: attach validated optionals via conditional spread.
  const withTarget: Action = target !== undefined ? { ...action, target } : action;
  const withPayload: Action = payload !== undefined ? { ...withTarget, payload } : withTarget;
  return { ok: true, value: withPayload };
};

const parseStep = (raw: unknown, index: number): ValidationResult<PlannedStep> => {
  const label = `step[${index}]`;
  if (!isPlainObject(raw)) {
    return fail('step_invalid', `${label} must be an object`);
  }
  const id = raw['id'];
  if (typeof id !== 'string' || id.trim() === '') {
    return fail('step_invalid', `${label} requires a non-empty string "id"`);
  }
  const description = raw['description'];
  if (typeof description !== 'string' || description.trim() === '') {
    return fail('step_invalid', `${label} requires a non-empty string "description"`);
  }
  const rawAction = raw['action'];
  if (rawAction === undefined) {
    // A model-proposed step is never verified; only the execution layer can verify.
    return { ok: true, value: { id, description, verified: false } };
  }
  const parsedAction = parseAction(rawAction, label);
  if (!parsedAction.ok) {
    return parsedAction;
  }
  return { ok: true, value: { id, description, action: parsedAction.value, verified: false } };
};

export const parsePlanResponse = (
  response: unknown,
  limits: AIManagerLimits,
): ValidationResult<readonly PlannedStep[]> => {
  if (!isPlainObject(response)) {
    return fail('plan_malformed', 'Planner response must be an object');
  }
  const rawSteps = response['steps'];
  if (!Array.isArray(rawSteps)) {
    return fail('plan_malformed', 'Planner response must contain a "steps" array');
  }
  if (rawSteps.length === 0) {
    return fail('plan_empty', 'Planner returned an empty plan');
  }
  if (rawSteps.length > limits.maxSteps) {
    return fail(
      'plan_too_large',
      `Plan has ${rawSteps.length} steps which exceeds the configured maximum of ${limits.maxSteps}`,
    );
  }
  const steps: PlannedStep[] = [];
  for (let index = 0; index < rawSteps.length; index += 1) {
    const parsedStep = parseStep(rawSteps[index], index);
    if (!parsedStep.ok) {
      return parsedStep;
    }
    steps.push(parsedStep.value);
  }
  return { ok: true, value: steps };
};

// --- AI Manager ---------------------------------------------------------------

/**
 * Provider-neutral planning entry point. Holds only the core `ModelRouter`
 * contract; role resolution goes through the provider-neutral role table, so
 * this class cannot know or choose a concrete provider. It plans only: it never
 * drives the platform layer, never executes actions and never manufactures
 * authorization.
 */
export class AIManager {
  private readonly router: ModelRouter;
  private readonly limits: AIManagerLimits;

  constructor(router: ModelRouter, limits: AIManagerLimits = DEFAULT_AI_MANAGER_LIMITS) {
    if (!(limits.maxSteps >= 1) || !(limits.maxPlanningAttempts >= 1)) {
      throw new RangeError('AIManager limits must be at least 1 (maxSteps and maxPlanningAttempts)');
    }
    this.router = router;
    this.limits = limits;
  }

  /** Turn a user goal into a validated, bounded TaskPlan. */
  async plan(
    goal: string,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<PlanningResult> {
    const trimmedGoal = goal.trim();
    if (trimmedGoal === '') {
      return this.failure('empty_goal', 'A planning goal must be a non-empty string', 0);
    }

    // Stage 1 - intent understanding (single deterministic call, no retry).
    let intentResponse: unknown;
    try {
      intentResponse = await this.router.request(MODEL_ROLE_CAPABILITY.Intent, { goal: trimmedGoal });
    } catch (error) {
      const modelFailure = this.classifyModelError(error);
      return this.failure(modelFailure.reason, modelFailure.message, 0);
    }
    const parsedIntent = parseIntentResponse(intentResponse);
    if (!parsedIntent.ok) {
      return this.failure(parsedIntent.reason, parsedIntent.message, 0);
    }
    const intent: UserIntent = {
      goal: trimmedGoal,
      objective: parsedIntent.value.objective,
      constraints: parsedIntent.value.constraints,
      context,
    };

    // Stage 2 - planning. Two distinct failure classes:
    //   - deterministic validation failures (malformed / empty / oversized /
    //     invalid structure) surface their leaf reason immediately and are
    //     never retried: a structurally invalid response is not a transient
    //     condition, and the SafetyKernel - not this module - owns policy.
    //   - genuine provider failures stay retryable, bounded by
    //     maxPlanningAttempts. The attempt budget is never unbounded.
    const plannerInput = {
      goal: intent.goal,
      objective: intent.objective,
      constraints: intent.constraints,
      context: intent.context,
    };
    for (let attempt = 1; attempt <= this.limits.maxPlanningAttempts; attempt += 1) {
      let plannerResponse: unknown;
      try {
        plannerResponse = await this.router.request(MODEL_ROLE_CAPABILITY.Planner, plannerInput);
      } catch (error) {
        const modelFailure = this.classifyModelError(error);
        const attemptsLeft = attempt < this.limits.maxPlanningAttempts;
        if (!modelFailure.retryable || !attemptsLeft) {
          return this.failure(modelFailure.reason, modelFailure.message, attempt);
        }
        continue;
      }
      const parsedPlan = parsePlanResponse(plannerResponse, this.limits);
      if (parsedPlan.ok) {
        const plan: TaskPlan = { goal: intent.goal, steps: parsedPlan.value };
        return { ok: true, intent, plan, attempts: attempt };
      }
      // Deterministic validation failure - surface the leaf reason directly.
      return this.failure(parsedPlan.reason, parsedPlan.message, attempt);
    }

    return this.failure('attempts_exhausted', 'Planning attempts exhausted', this.limits.maxPlanningAttempts);
  }

  private classifyModelError(
    error: unknown,
  ): { reason: PlanningFailureReason; message: string; retryable: boolean } {
    if (error instanceof UnsupportedCapabilityError) {
      // No provider advertises the capability: retrying cannot help.
      return { reason: 'unsupported_capability', message: error.message, retryable: false };
    }
    if (error instanceof ModelProviderError) {
      return { reason: 'provider_failure', message: error.message, retryable: true };
    }
    return {
      reason: 'provider_failure',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }

  private failure(
    reason: PlanningFailureReason,
    message: string,
    attempts: number,
    detail?: string,
  ): PlanningFailure {
    return detail === undefined
      ? { ok: false, reason, message, attempts }
      : { ok: false, reason, message, attempts, detail };
  }
}
