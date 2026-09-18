import type {Action,PolicyDecision,PolicyEngine,RiskDomain} from '../core/index.js';
import {Authorization} from '../core/index.js';
const domains=new Set<string>(['OBSERVATION','UI','FILESYSTEM','NETWORK','CREDENTIAL','FINANCIAL','SYSTEM']);
const high=new Set<RiskDomain>(['CREDENTIAL','FINANCIAL','SYSTEM']);
const AUTHORIZATION_TOKEN=Symbol('authorization-token');
export class SafetyKernel implements PolicyEngine {
  classify(action:Action):RiskDomain{
    if(!domains.has(action.domain))throw new Error('Unknown risk domain: fail closed');
    return action.domain as RiskDomain
  }
  authorize(action:Action,_modelAdvice?:Readonly<Record<string,unknown>>):PolicyDecision{
    const risk=this.classify(action);
    if(risk==='FINANCIAL'){
      return {allowed:false,risk,reason:'Financial actions are blocked by the foundation safety boundary'};
    }
    if(risk==='CREDENTIAL'){
      return {allowed:false,risk,reason:'Credential actions are blocked by the foundation safety boundary'};
    }
    if(high.has(risk)){
      return {allowed:false,risk,reason:'High-risk actions require an unavailable policy authorization flow'};
    }
    return {allowed:true,risk,reason:'Allowed by deterministic policy',authorization:new Authorization(risk,'HIGH',AUTHORIZATION_TOKEN)};
  }
}
