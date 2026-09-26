/**
 * Phase 9 - pure translation from OS UI data to the project's normalized model.
 *
 * There is no Windows type, enum or identifier in this file. The output is the
 * Phase-4 `UIStateGraph` / `UIElement` contract that perception and the action
 * engine already consume, so no duplicate representation is introduced and the
 * platform-independent core stays platform-neutral.
 *
 * Every function here is pure, which is what makes normalization and signature
 * generation testable without a live desktop.
 */

import { freeze } from '../../core/index.js';
import type { InteractionState, SemanticRole, UIElement, UIStateGraph } from '../../core/index.js';
import type { RawUiElement, RawUiSnapshot } from './ui-automation.js';

/** Windows control types mapped onto the existing `SemanticRole` vocabulary. */
const CONTROL_TYPE_ROLES: Readonly<Record<string, SemanticRole>> = {
  'ControlType.Button': 'BUTTON',
  'ControlType.Edit': 'TEXT_INPUT',
  'ControlType.Document': 'unknown',
  'ControlType.Pane': 'unknown',
  'ControlType.Text': 'LABEL',
  'ControlType.CheckBox': 'CHECKBOX',
  'ControlType.RadioButton': 'RADIO',
  'ControlType.ComboBox': 'SELECT',
  'ControlType.List': 'LIST',
  'ControlType.ListItem': 'LIST_ITEM',
  'ControlType.Tree': 'LIST',
  'ControlType.TreeItem': 'LIST_ITEM',
  'ControlType.Hyperlink': 'LINK',
  'ControlType.Menu': 'MENU',
  'ControlType.MenuBar': 'MENU',
  'ControlType.MenuItem': 'MENU_ITEM',
  'ControlType.Window': 'WINDOW',
  'ControlType.Dialog': 'DIALOG',
  'ControlType.Tab': 'TAB',
  'ControlType.TabItem': 'TAB',
  'ControlType.ToolBar': 'TOOLBAR',
  'ControlType.Slider': 'SLIDER',
  'ControlType.Spinner': 'SPINNER',
  'ControlType.Header': 'HEADING',
  'ControlType.HeaderItem': 'HEADING',
  'ControlType.Table': 'TABLE',
  'ControlType.DataItem': 'CELL',
  'ControlType.ToolTip': 'TOOLTIP',
  'ControlType.Alert': 'ALERT',
  'ControlType.Group': 'unknown',
  'ControlType.Image': 'unknown',
};

/** Anything the OS reports that the project does not model is `unknown`. */
export const roleFor = (controlType: string): SemanticRole =>
  CONTROL_TYPE_ROLES[controlType] ?? 'unknown';

/**
 * Whether a control can currently be acted on.
 *
 * Interactable is derived, never invented: the control must be on screen,
 * enabled, and actually expose a usable pattern for the requested interaction.
 */
export const isInteractable = (raw: RawUiElement, wantsValue: boolean): boolean =>
  raw.enabled === true &&
  raw.offscreen === false &&
  raw.password === false &&
  (wantsValue ? raw.hasValue : raw.invokable);

/** Maps OS booleans onto the existing `InteractionState` vocabulary. */
export const statesFor = (raw: RawUiElement): readonly InteractionState[] => {
  const states: InteractionState[] = [raw.enabled ? 'enabled' : 'disabled'];
  if (raw.focused) states.push('focused');
  if (raw.password) states.push('readonly');
  return states;
};

/**
 * One raw control becomes one normalized element.
 *
 * A password field contributes its label and identity but never its value: the
 * value is dropped before it can reach any caller, let alone any checkpoint.
 */
export const normalizeElement = (raw: RawUiElement): UIElement => {
  const role = roleFor(raw.controlType);
  const wantsValue = role === 'TEXT_INPUT';
  const bounds = raw.bounds;
  return freeze<UIElement>({
    id: raw.automationId ?? raw.ref,
    role,
    label: raw.name,
    // Text is only meaningful for a text input, and never for a password field.
    ...(wantsValue && !raw.password && raw.value !== '' ? { text: raw.value } : {}),
    ...(bounds === undefined
      ? {}
      : { bounds: freeze({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }) }),
    states: statesFor(raw),
    childIds: [],
    metadata: freeze({
      visible: raw.offscreen === false,
      interactable: isInteractable(raw, wantsValue),
      isPassword: raw.password,
      invokable: raw.invokable,
      hasValue: raw.hasValue,
      ...(raw.automationId === undefined ? {} : { automationId: raw.automationId }),
    }),
  });
};


/**
 * The semantic projection a signature is computed over.
 *
 * Only identity, role, name and interaction state participate. Timestamps,
 * bounds, control text, runtime handles and traversal order are deliberately
 * excluded: none of them are semantic state, and hashing them would make every
 * signature churn and defeat stale-target detection.
 */
export type SemanticState = Readonly<{
  application: string;
  title: string;
  elements: readonly Readonly<{
    role: SemanticRole;
    label: string;
    states: readonly InteractionState[];
  }>[];
}>;

const canonicalForm = (state: SemanticState): string => {
  const rows = state.elements
    .map((element) => `${element.role}|${element.label}|${[...element.states].sort().join(',')}`)
    .sort();
  return [`app=${state.application}`, `title=${state.title}`, ...rows].join('\n');
};

/** FNV-1a in 32-bit integer arithmetic, so the result is process-independent. */
const fnv1a = (input: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/**
 * Deterministic state signature for the existing `stateSignature` contract.
 *
 * Two semantically equivalent observations produce the same string; any change
 * of window identity, control role, name or interaction state produces a
 * different one. No clock, no randomness, no memory addresses.
 */
export const computeStateSignature = (state: SemanticState): string => {
  const canonical = canonicalForm(state);
  const low = fnv1a(canonical, 0x811c9dc5);
  const high = fnv1a(canonical, 0x1000193);
  return `uia1:${low.toString(16).padStart(8, '0')}${high.toString(16).padStart(8, '0')}`;
};

/** The semantic projection of an already-normalized graph. */
export const semanticStateOf = (graph: UIStateGraph): SemanticState => ({
  application: graph.application ?? '',
  title: graph.title,
  elements: graph.elements.map((element) => ({
    role: element.role,
    label: element.label,
    states: element.states,
  })),
});

/**
 * Translates one raw OS snapshot into the project's normalized UI state.
 *
 * The result is ephemeral: it is returned to the caller and never retained by
 * the adapter, so no accessibility dump can reach durable history.
 */
export const normalizeSnapshot = (snapshot: RawUiSnapshot): UIStateGraph => {
  const elements = snapshot.elements.map(normalizeElement);
  const root = elements[0];
  const graph: UIStateGraph = {
    windowId: `uia:${snapshot.processName}:${snapshot.windowTitle}`,
    title: snapshot.windowTitle,
    application: snapshot.processName,
    elements,
    ...(root === undefined ? {} : { rootElementId: root.id }),
    // Present because the existing contract requires it; deliberately excluded
    // from the signature, which is computed from semantic state alone.
    timestamp: Date.now(),
    stateSignature: '',
  };
  return freeze<UIStateGraph>({
    ...graph,
    stateSignature: computeStateSignature(semanticStateOf(graph)),
  });
};
