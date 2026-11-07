import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {ControlError} from './common.js';
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
const json=value=>JSON.stringify(stable(value));
// Facts are signed; signatures never grant permission or replace host review.
export class Evidence {
  #key=randomBytes(32);
  constructor(observations){this.observations=observations;}
  sign(owner,observationId,observation,plan,target){
    const facts={version:1,owner,observationId,observedAt:observation.observedAt??Date.now(),expiresAt:(observation.observedAt??Date.now())+this.observations.maxAge,windowId:plan.windowId,windowTitle:observation.title??'',className:observation.className??'',processId:observation.processId??null,source:target.source??'window-element',name:target.name??'',role:target.role??'',rect:target.rect??null,nativeClass:target.nativeClass??'',plan};
    return {facts,proof:this.mac(facts)};
  }
  mac(facts){return createHmac('sha256',this.#key).update(json(facts)).digest('base64url');}
  resolve(owner,args){
    let receipt=args.targetEvidence;
    if(receipt&&!receipt.facts&&receipt.proof){const {proof,...facts}=receipt;receipt={facts,proof};}
    if(!receipt||typeof receipt.proof!=='string'||!/^[\w-]{43}$/.test(receipt.proof)||!receipt.facts||JSON.stringify(receipt).length>12000)throw new ControlError('INVALID_TARGET_EVIDENCE','请原样使用 locate/prepare 返回的点击方案与目标证据');
    const {facts,proof}=receipt,expected=this.mac(facts);
    if(!timingSafeEqual(Buffer.from(expected),Buffer.from(proof))||facts.owner!==owner||(args.observationId!==undefined&&facts.observationId!==args.observationId)||facts.expiresAt<Date.now())throw new ControlError('INVALID_TARGET_EVIDENCE','目标证据被更改、过期或属于其他会话；请重新定位');
    this.observations.get(owner,facts.observationId,'desktop');
    const normalized={...facts.plan,...args,observationId:facts.observationId,targetEvidence:receipt};
    const plan={action:normalized.action,mode:normalized.mode,windowId:normalized.windowId,button:normalized.button,count:normalized.count};
    for(const key of ['elementId','x','y'])if(normalized[key]!==undefined)plan[key]=normalized[key];
    // Extra x/y never change an element-bound action: native input uses its verified centre.
    if(facts.plan.elementId){delete plan.x;delete plan.y;delete normalized.x;delete normalized.y;}
    if(json(plan)!==json(facts.plan))throw new ControlError('TARGET_PLAN_CHANGED','动作、模式、目标、坐标或点击次数与观察方案不一致，请重新 prepare');
    return {facts,args:normalized};
  }
  verify(owner,args){return this.resolve(owner,args).facts;}
}
