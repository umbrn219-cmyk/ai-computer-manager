/**
 * Action Engine – minimal contracts and orchestrator for the Phase‑4 pipeline.
 *
 * Pipeline (exact order):
 *   semantic action
 *   → target grounding (exact / missing / ambiguous)
 *   → current UI/state signature check (stale / interference detection)
 *   → SafetyKernel policy check (immediately before actuation)
 *   → pre‑flight validation
 *   → PlatformAdapter.execute  (only with a validated action)
 *   → fresh observation
 *   → postcondition verification
 *   → structured result (success / retry / recovery / user intervention)
 *
 * No real OS automation, browser automation, OCR, VLM, third‑party APIs,
 * CAPTCHA bypass, or security‑control bypass is implemented here.
 */

import type {
  Action,
  ActionResult,
  PlatformAdapter,
  UIStateGraph,
  PerceptionProvider,
  UIElement,
  PolicyDecision,
  Authorization,
} from '../core/index.js';

import { SafetyKernel } from '../policy-engine/index.js';
import { MockPlatformAdapter } from '../platform/index.js';

// Re‑export for test ergonomics and downstream consumers.
export type {
  Action,
  ActionResult,
  PlatformAdapter,
  UIStateGraph,
  PerceptionProvider,
  UIElement,
  PolicyDecision,
} from '../core/index.js';

export { SafetyKernel, MockPlatformAdapter };

/**
 * Outcome of a single `submitAction` call.
 */
export type ActionOutcome = {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  attempts: number;
  decision: 'success' | 'retry' | 'recovery' | 'user_intervention';
};

export type GroundingResult =
  | { kind: 'exact'; element: UIElement }
  | { kind: 'ambiguous'; matches: readonly UIElement[] }
  | { kind: 'missing' };

export type StateValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'stale' | 'interference';
      expectedSignature: string;
      currentSignature: string;
    };

export class ActionEngine {
  private readonly safetyKernel: SafetyKernel;
  private readonly maxAttempts: number;
  private readonly retryable: Set<string>;

  constructor(
    private readonly storage: unknown,
    private readonly perception: PerceptionProvider,
    private readonly platform: PlatformAdapter,
    options?: Partial<{ maxAttempts: number; retryableActions: readonly string[] }>,
  ) {
    this.safetyKernel = new SafetyKernel();
    this.maxAttempts = options?.maxAttempts ?? 1;
    this.retryable = new Set(options?.retryableActions ?? []);
  }

  async submitAction(
    action: Action,
    opts?: Partial<{ maxAttempts: number; retryableActions: readonly string[] }>,
  ): Promise<ActionOutcome> {
    const maxAttempts = opts?.maxAttempts ?? this.maxAttempts;
    let attempts = 0;

    const grounding = await this._groundTarget(action);
    if (grounding.kind === 'missing') {
      return this._outcome(false, 'missing target', 'user_intervention', attempts);
    }
    if (grounding.kind === 'ambiguous') {
      return this._outcome(
        false,
        `Ambiguous target: ${grounding.matches.length} elements match "${action.target}"`,
        'user_intervention',
        attempts,
      );
    }

    const targetElement = grounding.element;

    const current = await this.perception.observe();
    const validation = this._validateState(action, current.stateSignature, targetElement);
    if (!validation.valid) {
      return this._outcome(
        false,
        `State mismatch (${validation.reason}): expected ${validation.expectedSignature}, got ${validation.currentSignature}`,
        'user_intervention',
        attempts,
      );
    }

    const decision = this.safetyKernel.authorize(action);
    if (!decision.allowed) {
      return this._outcome(false, `SafetyKernel denied: ${decision.reason}`, 'user_intervention', attempts);
    }

    const preflight = this._preflight(action, targetElement);
    if (!preflight.ok) {
      return this._outcome(false, `Pre-flight failed: ${preflight.reason}`, 'user_intervention', attempts);
    }

    const retryable = this._isRetryable(action);
    while (attempts < maxAttempts) {
      attempts += 1;

      const stateBefore = await this.perception.observe();
      const freshValidation = this._validateState(
        action,
        stateBefore.stateSignature,
        targetElement,
      );
      if (!freshValidation.valid) {
        return this._outcome(
          false,
          `User interference detected: state changed during execution (expected ${freshValidation.expectedSignature}, got ${freshValidation.currentSignature})`,
          'user_intervention',
          attempts,
        );
      }

      // Re-authorize every iteration so policy stays authoritative
      const retryDecision = this.safetyKernel.authorize(action);
      if (!retryDecision.allowed) {
        return this._outcome(
          false,
          `SafetyKernel denied on attempt ${attempts}`,
          'user_intervention',
          attempts,
        );
      }

      let result: ActionResult;
      try {
        result = await this.platform.execute(action);
      } catch (err) {
        if (this._isRetryableError(err) && retryable) {
          if (attempts >= maxAttempts) {
            return this._outcome(
              false,
              `Retry exhausted after ${attempts} attempts`,
              'recovery',
              attempts,
            );
          }
          continue;
        }
        return this._outcome(
          false,
          `Execution error: ${err instanceof Error ? err.message : String(err)}`,
          'recovery',
          attempts,
        );
      }

      if (!result.ok) {
        if (retryable && attempts < maxAttempts) {
          continue;
        }
        return this._outcome(
          false,
          `Platform execution failed: ${result.message ?? 'unknown'}`,
          'recovery',
          attempts,
        );
      }

      // Stage 5 – fresh observation
      const freshState = await this.perception.observe();

      // Stage 6 – postcondition verification
      const postOk = this._verifyPostcondition(action, targetElement, freshState, result);
      if (!postOk.ok) {
        if (retryable && attempts < maxAttempts) {
          continue;
        }
        return this._outcome(
          false,
          `Postcondition failed: ${postOk.reason}`,
          'recovery',
          attempts,
        );
      }

      // Stage 7 – success
      return this._outcome(true, `Action ${action.type} succeeded`, 'success', attempts, result.data);
    }

    // Exhausted the loop without returning (non-retryable action)
    return this._outcome(
      false,
      `Action exhausted after ${attempts} attempt(s)`,
      attempts > 0 && !retryable ? 'recovery' : 'user_intervention',
      attempts,
    );
  }

  // ── Stage 1: target grounding ──────────────────────────────────────────
  private async _groundTarget(action: Action): Promise<GroundingResult> {
    const state = await this.perception.observe();
    const targetLabel = action.target ?? '';
    if (!targetLabel) {
      return { kind: 'missing' };
    }
    const matches = state.elements.filter(
      (e) =>
        e.label === targetLabel &&
        (e.role === 'BUTTON' || e.role === 'TEXT_INPUT' || e.role === 'LINK'),
    );
    if (matches.length === 0) return { kind: 'missing' };
    if (matches.length === 1) return { kind: 'exact', element: matches[0]! };
    return { kind: 'ambiguous', matches };
  }

  // ── Stage 2: state signature validation ──────────────────────────────
  private _validateState(
    action: Action,
    currentSignature: string,
    target: UIElement,
  ): StateValidationResult {
    if (!action.stateSignature) {
      return { valid: true };
    }
    if (action.stateSignature !== currentSignature) {
      return {
        valid: false,
        reason: 'stale',
        expectedSignature: action.stateSignature,
        currentSignature,
      };
    }
    return { valid: true };
  }

  // ── Stage 3: pre-flight validation ─────────────────────────────────────
  private _preflight(action: Action, target: UIElement):
  | { ok: true }
  | { ok: false; reason: string } {
    if (!action.type) return { ok: false, reason: 'Missing action type' };
    if (!action.domain) return { ok: false, reason: 'Missing domain' };
    if (!target.id) return { ok: false, reason: 'Invalid target' };
    return { ok: true };
  }

  // ── Idempotency / retry classification ────────────────────────────────
  private _isRetryable(action: Action): boolean {
    if (action.retryable === false) return false;
    if (this.retryable.has(action.type)) return true;
    // OBSERVE and WAIT are inherently idempotent/safe-to-repeat.
    if (action.type === 'OBSERVE' || action.type === 'WAIT') return true;
    return false;
  }

  private _isRetryableError(_err: unknown): boolean {
    // In the foundation layer every error is treated as potentially transient
    // but retrying is still gated by _isRetryable(action).
    return true;
  }

  // ── Stage 5/6: postcondition verification ─────────────────────────────
  private _verifyPostcondition(
    _action: Action,
    _target: UIElement,
    _freshState: UIStateGraph,
    result: ActionResult,
  ): { ok: boolean; reason: string } {
    if (!result.ok) {
      return { ok: false, reason: 'Result was not ok' };
    }
    // Foundation layer performs a structural check only – domain-specific
    // effects would be injected here by future implementations.
    return { ok: true, reason: '' };
  }

  // ── Outcome helper ───────────────────────────────────────────────────
  private _outcome(
    success: boolean,
    message: string,
    decision: ActionOutcome['decision'],
    attempts: number,
    data?: Record<string, unknown>,
  ): ActionOutcome {
    const out: ActionOutcome = {
      success,
      message,
      attempts,
      decision,
    };
    if (data !== undefined) {
      out.data = data as Record<string, unknown>;
    }
    return out;
  }
}