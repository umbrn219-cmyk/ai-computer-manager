/**
 * Phase 9 - WindowsPlatformAdapter.
 *
 * The first real desktop backend. It satisfies the existing, unchanged
 * `PlatformAdapter` contract from `packages/core`, so it is reached through
 * `ActionEngine` exactly like the mock, and it is never reached from the
 * orchestrator, the AI manager, the model router or the safety kernel.
 *
 * What it is allowed to do is deliberately small:
 *   observe  - read the focused window through Windows UI Automation
 *   CLICK    - invoke a grounded control
 *   TYPE     - set the value of a grounded text input
 *   SELECT   - move focus to a grounded control
 *   OBSERVE  - read state only
 *   WAIT     - read state only
 *
 * Everything else is refused explicitly. Financial, credential, network and
 * system domains are refused here as a second, independent gate behind the
 * SafetyKernel: the adapter is not an authorization layer and never becomes one.
 *
 * Nothing observed here is retained. Snapshots are returned to the caller and
 * discarded, so no accessibility dump, control text or typed value can reach a
 * checkpoint or any other durable history.
 */

import type {
  Action,
  ActionResult,
  PlatformAdapter,
  PerceptionProvider,
  UIElement,
  UIStateGraph,
} from '../../core/index.js';

import { normalizeSnapshot } from './normalize.js';
import { PowerShellUiAutomation, UiAutomationError } from './ui-automation.js';
import type { UiAutomationPort, UiLocator } from './ui-automation.js';

/**
 * Structured platform failure vocabulary. This is the Phase-9 answer to "do not
 * convert every failure into a generic unknown error": callers can branch on the
 * reason without ever seeing a host exception.
 */
export type PlatformFailureCode =
  | 'unsupported'
  | 'permission_denied'
  | 'target_not_found'
  | 'stale_target'
  | 'ambiguous_target'
  | 'actuation_failed'
  | 'observation_failed'
  | 'malformed_action';

/** Action types the real adapter actuates. Anything else is refused. */
export const SUPPORTED_ACTION_TYPES = ['CLICK', 'TYPE', 'SELECT', 'OBSERVE', 'WAIT'] as const;

/**
 * Domains the real adapter will act on at all. It is a UI interaction backend,
 * so only UI work and observation qualify. FINANCIAL, CREDENTIAL, NETWORK and
 * SYSTEM are refused by name, and an unrecognised domain fails closed.
 */
export const SUPPORTED_ACTION_DOMAINS = ['UI', 'OBSERVATION'] as const;

const BLOCKED_DOMAINS: readonly string[] = ['FINANCIAL', 'CREDENTIAL', 'NETWORK', 'SYSTEM'];

/** Interactable controls only, so a disabled or off-screen node is never a target. */
const isGrounded = (element: UIElement): boolean =>
  element.metadata['interactable'] === true && element.metadata['visible'] === true;

/** The single shape every failure is reported in. */
const failure = (code: PlatformFailureCode, message: string): ActionResult =>
  Object.freeze({
    ok: false,
    message,
    data: Object.freeze({ failure: code, reason: message }),
  });

export type WindowsPlatformAdapterOptions = Readonly<{
  /**
   * The OS backend. Defaults to real Windows UI Automation. Tests inject a
   * deterministic double so the whole pipeline can be exercised offline.
   */
  port?: UiAutomationPort;
}>;

export class WindowsPlatformAdapter implements PlatformAdapter {
  private readonly port: UiAutomationPort;

  constructor(options: WindowsPlatformAdapterOptions = {}) {
    this.port = options.port ?? new PowerShellUiAutomation();
  }

  /**
   * Reads the focused window and returns the normalized UI state.
   *
   * Satisfies the existing `PlatformAdapter.observe` shape: a record carrying the
   * project-standard `UIStateGraph` under `uiState`, plus the signature that the
   * action engine binds actions to.
   */
  async observe(): Promise<Readonly<Record<string, unknown>>> {
    const graph = await this.observeGraph();
    return { platform: 'windows', uiState: graph, stateSignature: graph.stateSignature };
  }

  /** The normalized observation, for a `PerceptionProvider` to publish. */
  async observeGraph(): Promise<UIStateGraph> {
    const snapshot = await this.port.observe();
    return normalizeSnapshot(snapshot);
  }

  /**
   * Performs at most one low-risk UI interaction.
   *
   * Order matters and is the Phase-7 interference invariant, not a second
   * mechanism: refuse by policy, re-observe, re-check the state signature, ground
   * the target, and only then actuate.
   */
  async execute(action: Action): Promise<ActionResult> {
    const gate = this.gate(action);
    if (gate !== undefined) {
      // Rejected before the desktop is contacted at all.
      return gate;
    }

    const text = this.textPayload(action);
    if (text === undefined) {
      return failure('malformed_action', 'TYPE action requires a string "text" payload');
    }

    let graph: UIStateGraph;
    try {
      graph = await this.observeGraph();
    } catch (error) {
      return this.toFailure(error, 'observation_failed');
    }

    // The action was bound to a state that no longer exists: the user changed
    // the screen. Refuse rather than actuate a stale target.
    if (action.stateSignature !== undefined && action.stateSignature !== graph.stateSignature) {
      return failure(
        'stale_target',
        `Screen changed since the action was prepared (expected ${action.stateSignature}, found ${graph.stateSignature})`,
      );
    }

    const target = action.target ?? '';
    if (target.trim() === '') {
      return failure('malformed_action', 'Action has no target to ground');
    }

    const candidates = graph.elements.filter(
      (element) => isGrounded(element) && (element.id === target || element.label === target),
    );
    if (candidates.length === 0) {
      return failure('target_not_found', `No interactable element matches "${target}"`);
    }
    if (candidates.length > 1) {
      return failure('ambiguous_target', `${candidates.length} interactable elements match "${target}"`);
    }

    const element = candidates[0]!;

    // Optional stronger guard: the caller may pin the exact control it grounded.
    const expectedId = action.payload?.['expectedElementId'];
    if (typeof expectedId === 'string' && expectedId !== '' && expectedId !== element.id) {
      return failure(
        'stale_target',
        `Grounded control changed (expected ${expectedId}, found ${element.id})`,
      );
    }

    const locator: UiLocator = {
      name: element.label,
      ...(element.metadata['automationId'] === undefined
        ? {}
        : { automationId: String(element.metadata['automationId']) }),
    };

    try {
      if (action.type === 'CLICK') {
        await this.port.invoke({ operation: 'click', locator });
      } else if (action.type === 'TYPE') {
        await this.port.invoke({ operation: 'type', locator, text });
      } else if (action.type === 'SELECT') {
        await this.port.invoke({ operation: 'focus', locator });
      }
      // OBSERVE and WAIT are read-only and are complete once observed above.
    } catch (error) {
      return this.toFailure(error, 'actuation_failed');
    }

    // The typed text is never echoed back, here or anywhere else.
    return Object.freeze({
      ok: true,
      message: `Performed ${action.type} on "${element.label}"`,
      data: Object.freeze({ elementId: element.id, role: element.role }),
    });
  }

  /**
   * Policy and shape gate. Returns a rejection, or `undefined` when the action
   * may proceed to the desktop.
   *
   * This runs before any OS call, so an unsupported or forbidden action can
   * never reach the machine.
   */
  private gate(action: Action): ActionResult | undefined {
    // Read as unknown: the adapter is the last line of defence, so it must be
    // able to reject a structurally invalid action, not only a valid one.
    const rawType: unknown = (action as { type?: unknown }).type;
    const rawDomain: unknown = (action as { domain?: unknown }).domain;

    if (typeof rawType !== 'string' || rawType === '') {
      return failure('malformed_action', 'Action has no type');
    }
    if (typeof rawDomain !== 'string' || rawDomain === '') {
      return failure('malformed_action', 'Action has no risk domain');
    }
    if (BLOCKED_DOMAINS.includes(rawDomain)) {
      return failure(
        'permission_denied',
        `The real platform refuses to actuate ${rawDomain} actions`,
      );
    }
    if (!(SUPPORTED_ACTION_DOMAINS as readonly string[]).includes(rawDomain)) {
      // Unknown domains fail closed rather than being reinterpreted.
      return failure('unsupported', `Unsupported risk domain for real actuation: ${rawDomain}`);
    }
    if (!(SUPPORTED_ACTION_TYPES as readonly string[]).includes(rawType)) {
      // Explicit refusal: never silently reinterpret one action as another.
      return failure('unsupported', `Unsupported action type for real actuation: ${rawType}`);
    }
    return undefined;
  }

  /** Extracts the text to enter, or `undefined` when the payload is unusable. */
  private textPayload(action: Action): string | undefined {
    if (action.type !== 'TYPE') return '';
    const payload = action.payload;
    if (payload === undefined) return undefined;
    const text = payload['text'];
    return typeof text === 'string' ? text : undefined;
  }

  /** Maps any host error onto the structured Phase-9 vocabulary. */
  private toFailure(error: unknown, fallback: PlatformFailureCode): ActionResult {
    if (error instanceof UiAutomationError) {
      return failure(error.code, error.message);
    }
    // A host exception never escapes to the core and never becomes "unknown".
    const message = error instanceof Error ? error.message : String(error);
    return failure(fallback, message);
  }
}

/**
 * Publishes the real desktop as a `PerceptionProvider`, so the existing
 * orchestrator and action engine observe the live machine through exactly the
 * contract they already use for the mock.
 */
export class WindowsPerceptionProvider implements PerceptionProvider {
  readonly providerKind = 'windows-uia';

  constructor(private readonly adapter: WindowsPlatformAdapter) {}

  async observe(): Promise<UIStateGraph> {
    return this.adapter.observeGraph();
  }
}
