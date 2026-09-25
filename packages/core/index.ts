export type TaskState = 'CREATED'|'PLANNING'|'READY'|'RUNNING'|'VERIFYING'|'WAITING'|'NEEDS_USER'|'COMPLETED'|'FAILED';
export type RiskDomain = 'OBSERVATION'|'UI'|'FILESYSTEM'|'NETWORK'|'CREDENTIAL'|'FINANCIAL'|'SYSTEM';
export type ActionType = 'CLICK'|'TYPE'|'KEY_PRESS'|'SCROLL'|'OPEN'|'SELECT'|'WAIT'|'OBSERVE';
export type Action = Readonly<{
  type: ActionType;
  domain: string;
  target?: string;
  payload?: Readonly<Record<string, unknown>>;
  stateSignature?: string;
  retryable?: boolean;
}>;
export type ActionResult = Readonly<{ok: boolean; message?: string; data?: Readonly<Record<string, unknown>>}>;
export type TaskStep = Readonly<{id: string; description: string; action?: Action; verified: boolean}>;
export type Task = Readonly<{id: string; goal: string; state: TaskState; steps: readonly TaskStep[]; attempts: number; maxAttempts: number; version: number}>;
export interface TaskEngine { getTask(id:string): Task|undefined; createTask(goal:string,maxAttempts?:number):Task; transition(id:string,next:TaskState):Task; }
export interface PlatformAdapter { observe():Promise<Readonly<Record<string, unknown>>>; execute(action:Action):Promise<ActionResult>; }
export interface StorageEngine extends CheckpointStore { get(id:string):Task|undefined; put(task:Task):void; delete(id:string):void; list():readonly Task[]; }
export type ModelCapability = 'PLAN'|'UNDERSTAND_INTENT'|'VERIFY_OUTCOME'|'SUMMARISE'|'DESCRIBE_SCREEN';
export interface ModelProvider { supports(capability:ModelCapability):boolean; request(capability:ModelCapability,input:Readonly<Record<string,unknown>>):Promise<Readonly<Record<string,unknown>>>; }
export interface ModelRouter { request(capability:ModelCapability,input:Readonly<Record<string,unknown>>):Promise<Readonly<Record<string,unknown>>>; }
export class Authorization {
  readonly domain: RiskDomain;
  readonly risk: 'HIGH' | 'BLOCKED';
  readonly token: symbol;

  constructor(domain: RiskDomain, risk: 'HIGH' | 'BLOCKED', token: symbol) {
    this.domain = domain;
    this.risk = risk;
    this.token = token;
  }
}
export interface PolicyDecision { readonly allowed:boolean; readonly risk:RiskDomain; readonly reason:string; readonly authorization?:Authorization; }
export interface PolicyEngine { classify(action:Action):RiskDomain; authorize(action:Action,modelAdvice?:Readonly<Record<string,unknown>>):PolicyDecision; }
export const freeze = <T>(value:T):Readonly<T> => { const seen = new WeakSet<object>(); const visit=(v:any):any=>{if(v && typeof v==='object' && !seen.has(v)){seen.add(v); for(const key of Reflect.ownKeys(v)) visit(v[key]); Object.freeze(v);} return v;}; return visit(value); };
export type SemanticRole = 'BUTTON'|'TEXT_INPUT'|'CHECKBOX'|'RADIO'|'SELECT'|'LINK'|'MENU'|'MENU_ITEM'|'DIALOG'|'WINDOW'|'TAB'|'TOOLBAR'|'SLIDER'|'SPINNER'|'LABEL'|'HEADING'|'LIST'|'LIST_ITEM'|'TABLE'|'CELL'|'TOOLTIP'|'ALERT'|'NOTIFICATION'|'unknown';
export type InteractionState = 'enabled'|'disabled'|'focused'|'selected'|'pressed'|'checked'|'expanded'|'collapsed'|'busy'|'readonly';
export type UIElement = Readonly<{id: string; role: SemanticRole; label: string; text?: string; bounds?: Readonly<{x: number; y: number; width: number; height: number}>; states: readonly InteractionState[]; parentId?: string; childIds: readonly string[]; metadata: Readonly<Record<string, unknown>>}>;
export type UIStateGraph = Readonly<{readonly windowId: string; readonly title: string; readonly application?: string; readonly elements: ReadonlyArray<UIElement>; readonly rootElementId?: string; readonly timestamp: number; readonly stateSignature: string}>;
export type PerceptionProvider = {readonly providerKind: string; observe(): Promise<UIStateGraph>};

/* ── Phase 8: durable execution checkpoint contract ──────────────────────────
 * Minimal recovery state only. It deliberately cannot express screenshots, OCR
 * dumps, model prompts/responses, credentials, OTP/PIN values, payment data or
 * per-input traces: the type has no such fields, so none can be persisted.
 * `checkpointVersion` is the CHECKPOINT SCHEMA version and is unrelated to the
 * TaskEngine `taskVersion` (task state version).
 */
export const CHECKPOINT_SCHEMA_VERSION = 1;
export type CheckpointStatus = 'RUNNING'|'NEEDS_USER'|'FAILED'|'COMPLETED';
export type CheckpointStepAttempts = Readonly<{index:number; attempts:number}>;
export type ExecutionCheckpoint = Readonly<{
  taskId:string;
  /** TaskEngine task version this checkpoint was taken against. */
  taskVersion:number;
  /** Deterministic fingerprint of the plan the checkpoint belongs to. */
  planVersion:string;
  /** Index of the active planned step. */
  activeStepIndex:number;
  /** Bounded per-step attempt counters, only for indexes already entered. */
  stepAttempts:readonly CheckpointStepAttempts[];
  /** Steps already verified - never replayed on resume. */
  verifiedStepIds:readonly string[];
  status:CheckpointStatus;
  /**
   * True when an actuation may have been submitted for the active step without
   * a confirmable result. Resume must reconcile before replaying anything.
   */
  reconcilePending:boolean;
  /** Checkpoint schema version - NOT the task version. */
  checkpointVersion:number;
  /** Optional non-sensitive orchestration reason for a paused/failed state. */
  reason?:string;
}>;
export interface CheckpointStore {
  saveCheckpoint(checkpoint:ExecutionCheckpoint):void;
  loadCheckpoint(taskId:string):ExecutionCheckpoint|undefined;
  deleteCheckpoint(taskId:string):void;
}
export class CheckpointRejectedError extends Error {
  readonly reason:string;
  constructor(reason:string){super(reason);this.name='CheckpointRejectedError';this.reason=reason;}
}
export type CheckpointValidation = Readonly<{valid:true}>|Readonly<{valid:false; reason:string}>;
export const validateCheckpoint = (value:unknown, expectedTaskId?:string):CheckpointValidation => {
  const bad = (reason:string):CheckpointValidation => ({valid:false, reason});
  const isRecord = (v:unknown):v is Record<string,unknown> => typeof v==='object' && v!==null && !Array.isArray(v);
  const isInt = (v:unknown):v is number => typeof v==='number' && Number.isInteger(v);
  if(!isRecord(value)) return bad('checkpoint must be an object');
  if(value['checkpointVersion']!==CHECKPOINT_SCHEMA_VERSION) return bad(`unknown checkpoint schema version: ${String(value['checkpointVersion'])}`);
  const taskId = value['taskId'];
  if(typeof taskId!=='string' || taskId.trim()==='') return bad('taskId must be a non-empty string');
  if(expectedTaskId!==undefined && taskId!==expectedTaskId) return bad(`taskId mismatch: expected ${expectedTaskId}, got ${taskId}`);
  const taskVersion = value['taskVersion'];
  if(!isInt(taskVersion) || taskVersion<0) return bad('taskVersion must be a non-negative integer');
  const planVersion = value['planVersion'];
  if(typeof planVersion!=='string' || planVersion.trim()==='') return bad('planVersion must be a non-empty string');
  const activeStepIndex = value['activeStepIndex'];
  if(!isInt(activeStepIndex) || activeStepIndex<0) return bad('activeStepIndex must be a non-negative integer');
  const stepAttempts = value['stepAttempts'];
  if(!Array.isArray(stepAttempts)) return bad('stepAttempts must be an array');
  const indexes = new Set<number>();
  for(const entry of stepAttempts){
    if(!isRecord(entry)) return bad('stepAttempts entries must be objects');
    const index = entry['index']; const attempts = entry['attempts'];
    if(!isInt(index) || index<0) return bad('stepAttempts index must be a non-negative integer');
    if(!isInt(attempts) || attempts<1) return bad('stepAttempts attempts must be a positive integer');
    if(indexes.has(index)) return bad(`duplicate stepAttempts entry for index ${index}`);
    if(index>activeStepIndex) return bad(`stepAttempts index ${index} is beyond the active step ${activeStepIndex}`);
    indexes.add(index);
  }
  const verifiedStepIds = value['verifiedStepIds'];
  if(!Array.isArray(verifiedStepIds)) return bad('verifiedStepIds must be an array');
  const ids = new Set<string>();
  for(const id of verifiedStepIds){
    if(typeof id!=='string' || id.trim()==='') return bad('verifiedStepIds must contain non-empty strings');
    if(ids.has(id)) return bad(`duplicate verified step id: ${id}`);
    ids.add(id);
  }
  const status = value['status'];
  if(status!=='RUNNING' && status!=='NEEDS_USER' && status!=='FAILED' && status!=='COMPLETED') return bad(`unknown checkpoint status: ${String(status)}`);
  if(typeof value['reconcilePending']!=='boolean') return bad('reconcilePending must be a boolean');
  const reason = value['reason'];
  if(reason!==undefined && (typeof reason!=='string' || reason.trim()==='')) return bad('reason must be a non-empty string when present');
  return {valid:true};
};
export const materializeCheckpoint = (checkpoint:ExecutionCheckpoint):ExecutionCheckpoint => freeze({
  taskId: checkpoint.taskId,
  taskVersion: checkpoint.taskVersion,
  planVersion: checkpoint.planVersion,
  activeStepIndex: checkpoint.activeStepIndex,
  stepAttempts: checkpoint.stepAttempts.map((entry) => ({index: entry.index, attempts: entry.attempts})),
  verifiedStepIds: [...checkpoint.verifiedStepIds],
  status: checkpoint.status,
  reconcilePending: checkpoint.reconcilePending,
  checkpointVersion: checkpoint.checkpointVersion,
  ...(checkpoint.reason !== undefined ? {reason: checkpoint.reason} : {}),
});
