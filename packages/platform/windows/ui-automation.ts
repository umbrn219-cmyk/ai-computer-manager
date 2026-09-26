/**
 * Phase 9 - the Windows UI Automation port.
 *
 * This module and its siblings are the ONLY code in the repository that talks to
 * a concrete desktop operating system. Everything above them works against the
 * platform-neutral contracts declared in `packages/core`.
 *
 * The port is deliberately an interface so the adapter can be exercised against a
 * deterministic double in tests, while production uses the real PowerShell +
 * UI Automation implementation below.
 */

import { spawn } from 'node:child_process';

import { invokeScript, observeScript } from './powershell-scripts.js';
import type { UiAutomationFailureCode } from './powershell-scripts.js';

export type { UiAutomationFailureCode };

export type RawUiBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

/** One control exactly as the OS reported it, before any project semantics. */
export type RawUiElement = Readonly<{
  ref: string;
  name: string;
  controlType: string;
  enabled: boolean;
  offscreen: boolean;
  focused: boolean;
  password: boolean;
  invokable: boolean;
  hasValue: boolean;
  value: string;
  automationId?: string;
  bounds?: RawUiBounds;
}>;

/** One observation of the focused window, still in OS terms. */
export type RawUiSnapshot = Readonly<{
  processName: string;
  windowTitle: string;
  elements: readonly RawUiElement[];
}>;

/** Identifies one control inside the focused window. */
export type UiLocator = Readonly<{
  automationId?: string;
  name?: string;
  controlType?: string;
}>;

export type UiAutomationOperation =
  | Readonly<{ operation: 'click'; locator: UiLocator }>
  | Readonly<{ operation: 'type'; locator: UiLocator; text: string }>
  | Readonly<{ operation: 'focus'; locator: UiLocator }>;

/** A platform failure that never leaks a host-specific exception to the core. */
export class UiAutomationError extends Error {
  readonly code: UiAutomationFailureCode;

  constructor(code: UiAutomationFailureCode, message: string) {
    super(message);
    this.name = 'UiAutomationError';
    this.code = code;
  }
}

/** The whole OS surface the adapter is allowed to touch. */
export interface UiAutomationPort {
  observe(): Promise<RawUiSnapshot>;
  invoke(request: UiAutomationOperation): Promise<void>;
}


export type PowerShellUiAutomationOptions = Readonly<{
  /** Upper bound on controls read from one window. */
  maxElements?: number;
  /** Milliseconds before a UI Automation call is abandoned. */
  timeoutMs?: number;
  /** Host used to reach the accessibility API. */
  shell?: string;
}>;

const DEFAULT_MAX_ELEMENTS = 200;
const DEFAULT_TIMEOUT_MS = 15_000;

type HostResult = Readonly<{ stdout: string; stderr: string; timedOut: boolean }>;

/**
 * Runs one script through the host shell and returns its raw output.
 *
 * The script is written to the child's stdin rather than to a temporary file, so
 * nothing is persisted. No execution-policy or privilege flag is passed.
 */
const runScript = (
  script: string,
  shell: string,
  timeoutMs: number,
): Promise<HostResult> =>
  new Promise<HostResult>((resolve) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      stderr += error.message;
      finish();
    });
    child.on('close', () => {
      finish();
    });

    child.stdin.on('error', () => {
      /* the child may exit before consuming stdin; the close handler settles */
    });
    child.stdin.end(script, 'utf8');
  });

type Envelope =
  | Readonly<{ ok: true; data: unknown }>
  | Readonly<{ ok: false; code: UiAutomationFailureCode; message: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SCRIPT_CODES: readonly UiAutomationFailureCode[] = [
  'unsupported',
  'permission_denied',
  'target_not_found',
  'actuation_failed',
  'observation_failed',
];

/**
 * Reads the JSON answer from the host output.
 *
 * The host may prepend a byte-order mark and may interleave non-JSON noise, so
 * every line is stripped and the scan runs from the end: the answer is always
 * the last JSON document the script printed.
 */
const readEnvelope = (stdout: string): Envelope | undefined => {
  const lines = stdout
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.replace(/^\uFEFF/, '').trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      if (parsed['ok'] === true) {
        return { ok: true, data: parsed['data'] };
      }
      if (parsed['ok'] === false) {
        const code = parsed['code'];
        const message = parsed['message'];
        return {
          ok: false,
          code:
            typeof code === 'string' && SCRIPT_CODES.includes(code as UiAutomationFailureCode)
              ? (code as UiAutomationFailureCode)
              : 'actuation_failed',
          message: typeof message === 'string' ? message : 'Unspecified platform failure',
        };
      }
    } catch {
      continue;
    }
  }
  return undefined;
};


const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asBoolean = (value: unknown): boolean => value === true;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Coerces a script payload into a `RawUiSnapshot`.
 *
 * Anything structurally unusable is rejected rather than half-parsed, so a
 * malformed host answer can never masquerade as a valid observation.
 */
export const parseSnapshot = (data: unknown): RawUiSnapshot => {
  if (!isRecord(data)) {
    throw new UiAutomationError('observation_failed', 'Observation payload was not an object');
  }
  const rawElements = data['elements'];
  if (!Array.isArray(rawElements)) {
    throw new UiAutomationError('observation_failed', 'Observation payload had no element list');
  }

  const elements: RawUiElement[] = [];
  for (const entry of rawElements) {
    if (!isRecord(entry)) continue;
    const name = asString(entry['name']);
    const controlType = asString(entry['controlType']);
    // A node without a control type cannot be grounded or actuated later.
    if (controlType === '') continue;

    const rawBounds = entry['bounds'];
    let bounds: RawUiBounds | undefined;
    if (isRecord(rawBounds)) {
      const x = asNumber(rawBounds['x']);
      const y = asNumber(rawBounds['y']);
      const width = asNumber(rawBounds['width']);
      const height = asNumber(rawBounds['height']);
      if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
        bounds = { x, y, width, height };
      }
    }

    const automationId = asString(entry['automationId']);
    elements.push({
      ref: asString(entry['ref']) || `${controlType}|${name}`,
      name,
      controlType,
      enabled: asBoolean(entry['enabled']),
      offscreen: asBoolean(entry['offscreen']),
      focused: asBoolean(entry['focused']),
      password: asBoolean(entry['password']),
      invokable: asBoolean(entry['invokable']),
      hasValue: asBoolean(entry['hasValue']),
      value: asString(entry['value']),
      ...(automationId === '' ? {} : { automationId }),
      ...(bounds === undefined ? {} : { bounds }),
    });
  }

  return {
    processName: asString(data['processName'], 'unknown'),
    windowTitle: asString(data['windowTitle']),
    elements,
  };
};

/**
 * The real adapter backend: Windows UI Automation reached through the host
 * shell. Observation and actuation both use accessibility patterns, so the user
 * sees exactly the interaction they would perform themselves.
 */
export class PowerShellUiAutomation implements UiAutomationPort {
  private readonly maxElements: number;
  private readonly timeoutMs: number;
  private readonly shell: string;

  constructor(options: PowerShellUiAutomationOptions = {}) {
    const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxElements =
      Number.isInteger(maxElements) && maxElements > 0 ? maxElements : DEFAULT_MAX_ELEMENTS;
    this.timeoutMs =
      Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.shell = options.shell ?? 'powershell.exe';
  }

  async observe(): Promise<RawUiSnapshot> {
    const envelope = await this.exchange(observeScript(this.maxElements), 'observation_failed');
    if (!envelope.ok) {
      throw new UiAutomationError(envelope.code, envelope.message);
    }
    return parseSnapshot(envelope.data);
  }

  async invoke(request: UiAutomationOperation): Promise<void> {
    const requestJson = JSON.stringify(request);
    // The payload is embedded in a PowerShell here-string, so it must stay a
    // single line. JSON.stringify guarantees that for this shape.
    if (requestJson.includes('\n')) {
      throw new UiAutomationError('actuation_failed', 'Actuation payload was not single-line');
    }
    const envelope = await this.exchange(invokeScript(requestJson), 'actuation_failed');
    if (!envelope.ok) {
      throw new UiAutomationError(envelope.code, envelope.message);
    }
  }

  private async exchange(
    script: string,
    timeoutCode: UiAutomationFailureCode,
  ): Promise<Envelope> {
    const result = await runScript(script, this.shell, this.timeoutMs);
    if (result.timedOut) {
      throw new UiAutomationError(timeoutCode, 'The desktop did not answer in time');
    }
    const envelope = readEnvelope(result.stdout);
    if (envelope === undefined) {
      // A crash, a blocked host or an unreadable answer is a platform failure,
      // never a silent success.
      throw new UiAutomationError(timeoutCode, 'The desktop returned no readable result');
    }
    return envelope;
  }
}
