import type {Action, ActionResult, PlatformAdapter} from '../core/index.js';
export class MockPlatformAdapter implements PlatformAdapter {readonly executed: Action[]=[];async observe(){return {mock:true}}async execute(action:Action):Promise<ActionResult>{this.executed.push(action);return {ok:true,message:'Mock execution only'}}}
