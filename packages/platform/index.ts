/**
 * Platform boundary.
 *
 * This barrel stays platform-neutral on purpose: it publishes only the
 * deterministic mock used by the existing test suite. The real Windows backend
 * lives in `packages/platform/windows` and is imported explicitly by composition
 * code, so nothing that merely needs the `PlatformAdapter` contract ends up
 * loading OS-specific code.
 */

import type {Action, ActionResult, PlatformAdapter} from '../core/index.js';
export class MockPlatformAdapter implements PlatformAdapter {readonly executed: Action[]=[];async observe(){return {mock:true}}async execute(action:Action):Promise<ActionResult>{this.executed.push(action);return {ok:true,message:'Mock execution only'}}}
