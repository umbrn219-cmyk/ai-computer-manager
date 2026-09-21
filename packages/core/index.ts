export type TaskState = 'CREATED'|'PLANNING'|'READY'|'RUNNING'|'VERIFYING'|'WAITING'|'NEEDS_USER'|'COMPLETED'|'FAILED';
export type RiskDomain = 'OBSERVATION'|'UI'|'FILESYSTEM'|'NETWORK'|'CREDENTIAL'|'FINANCIAL'|'SYSTEM';
export type ActionType = 'CLICK'|'TYPE'|'KEY_PRESS'|'SCROLL'|'OPEN'|'SELECT'|'WAIT'|'OBSERVE';
export type Action = Readonly<{type: ActionType; domain: string; target?: string; payload?: Readonly<Record<string, unknown>>}>;
export type ActionResult = Readonly<{ok: boolean; message?: string; data?: Readonly<Record<string, unknown>>}>;
export type TaskStep = Readonly<{id: string; description: string; action?: Action; verified: boolean}>;
export type Task = Readonly<{id: string; goal: string; state: TaskState; steps: readonly TaskStep[]; attempts: number; maxAttempts: number; version: number}>;
export interface TaskEngine { getTask(id:string): Task|undefined; createTask(goal:string,maxAttempts?:number):Task; transition(id:string,next:TaskState):Task; }
export interface PlatformAdapter { observe():Promise<Readonly<Record<string, unknown>>>; execute(action:Action):Promise<ActionResult>; }
export interface StorageEngine { get(id:string):Task|undefined; put(task:Task):void; delete(id:string):void; list():readonly Task[]; }
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
