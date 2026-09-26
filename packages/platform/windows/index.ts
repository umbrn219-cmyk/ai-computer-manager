/**
 * Phase 9 - Windows platform adapter barrel.
 *
 * This sub-package is the only place in the repository that knows a concrete
 * desktop operating system exists. It is deliberately NOT re-exported from
 * `packages/platform/index.ts`, so the modules that import the platform-neutral
 * mock (the action engine, deterministic tests) never pull OS code into their
 * import graph. Composition code opts in explicitly.
 */

export {
  WindowsPlatformAdapter,
  WindowsPerceptionProvider,
  SUPPORTED_ACTION_TYPES,
  SUPPORTED_ACTION_DOMAINS,
} from './windows-platform-adapter.js';
export type { PlatformFailureCode, WindowsPlatformAdapterOptions } from './windows-platform-adapter.js';

export {
  PowerShellUiAutomation,
  UiAutomationError,
  parseSnapshot,
} from './ui-automation.js';
export type {
  RawUiElement,
  RawUiSnapshot,
  UiAutomationPort,
  UiAutomationOperation,
  UiLocator,
  PowerShellUiAutomationOptions,
} from './ui-automation.js';

export {
  computeStateSignature,
  isInteractable,
  normalizeElement,
  normalizeSnapshot,
  roleFor,
  semanticStateOf,
  statesFor,
} from './normalize.js';
export type { SemanticState } from './normalize.js';

export { invokeScript, observeScript } from './powershell-scripts.js';
