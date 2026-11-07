import {createHash,randomUUID} from 'node:crypto';
import {ControlError,checkAbort,abortable} from './common.js';
import {batchSteps} from './advanced.js';
import {sessionPermissions} from './policy.js';

const clone=v=>JSON.parse(JSON.stringify(v));
export class BatchPlans {
  constructor(runtime,validate){this.runtime=runtime;this.validate=validate;this.items=new Map();}
  get(owner,kind,args){
    if(Object.keys(args).some(k=>!['action','requestId'].includes(k)))throw new ControlError('BATCH_CHANGED','batch 只接受登记的 requestId，不能覆盖步骤');
    const plan=this.items.get(args.requestId);
    if(!plan||plan.owner!==owner||plan.kind!==kind)throw new ControlError('INVALID_BATCH','批量编号不存在或属于其他会话/工具');
    if(plan.used)throw new ControlError('BATCH_ALREADY_USED','批量计划已尝试执行，不能整批重放；检查结果后为剩余操作重新观察登记');
    if(plan.expiresAt<Date.now())throw new ControlError('STALE_OBSERVATION','批量计划已过期，请重新观察登记');
    return plan;
  }
  async sequence(owner,kind,args,exec,signal){
    const steps=args.steps?.map(step=>({...step,observationId:step.observationId??args.observationId,mode:step.mode??args.mode}));
    const prepared=await this.prepare(owner,kind,{steps},signal,{sequence:true});
    try{return {...await this.execute(owner,kind,prepared.batch,exec,signal),singleCall:true};}
    finally{this.items.delete(prepared.batch.requestId);}
  }
  async prepare(owner,kind,args,signal,options={}){
    const runtime=this.runtime,spec=batchSteps(args.steps),entries=[];let scope,expiresAt=Infinity,textChars=0;
    for(const input of spec){
      checkAbort(signal);const step=kind==='desktop'?runtime.resolvePlan(owner,input):input;this.validate(kind,step);
      if(!step.elementId)throw new ControlError('INVALID_BATCH','批量步骤只接受命名控件，坐标方案请单独操作');
      const freshness=kind==='browser'&&options.sequence?runtime.observations.forRevalidation(owner,step.observationId,runtime.config.browserRevalidationMaxAgeMs):null;
      const observation=freshness?.value??runtime.observations.get(owner,step.observationId,kind,kind==='browser');
      if(observation.scope==='screen')throw new ControlError('INVALID_BATCH','批量控件必须来自具体窗口 observe/locate');
      const element=observation.elements?.find(e=>e.elementId===step.elementId);
      if(!element?.identity||!element.name)throw new ControlError('INVALID_BATCH','批量控件需要可核验身份和名称');
      const waitEnabled=kind==='browser'&&options.sequence&&entries.length>0&&step.action==='click'&&element.disabled===true;
      if((element.enabled===false||element.disabled===true)&&!waitEnabled)throw new ControlError('ELEMENT_DISABLED','批量目标不可用');
      const mode=step.mode??(kind==='desktop'?'uia':'mouse');
      if(kind==='desktop'&&mode==='uia'&&(step.action==='hover'||step.action==='click'&&!element.patterns?.some(p=>['invoke','toggle','select'].includes(p))||step.action==='type'&&!element.patterns?.includes('value')||step.action==='scroll'&&!element.patterns?.includes('scroll')))throw new ControlError('BATCH_UNSUPPORTED','此控件不支持登记的后台动作，未投递任何步骤；请明确选择支持的模式');
      if(kind==='desktop'&&mode==='mouse'&&element.role==='ControlType.Window')throw new ControlError('BATCH_UNSUPPORTED','批量鼠标步骤需具体控件，不能使用整个窗口根节点');
      if(kind==='browser'&&(mode==='dom'&&!['click','type'].includes(step.action)||step.action==='type'&&(element.readonly||!element.editable&&!['input','textarea'].includes(element.tag))))throw new ControlError('BATCH_UNSUPPORTED','浏览器控件不支持登记的操作');
      const key=kind==='desktop'?String(observation.windowId):observation.tabId;
      if(scope!==undefined&&key!==scope)throw new ControlError('BATCH_SCOPE','同一批只操作一个已观察窗口/标签页，跨窗口须分别登记');scope=key;
      if(kind==='desktop')await runtime.native.call('check-element',{nativeObservation:observation.nativeObservation,elementId:step.elementId},signal);
      else {const found=await runtime.browser.validate(owner,observation,step,freshness?.expired===true,{allowDisabled:waitEnabled});await runtime.browser.point(found,{elementId:step.elementId},waitEnabled);}
      const action={action:step.action,mode};
      for(const k of ['text','replace','button','count','deltaX','deltaY'])if(step[k]!==undefined)action[k]=step[k];
      textChars+=action.text?.length??0;if(textChars>40000)throw new ControlError('BATCH_TOO_LARGE','单批文字总数不能超过 40000');
      entries.push({action:clone(action),waitEnabled,initialObservationId:step.observationId,observation:clone({kind,windowId:observation.windowId,tabId:observation.tabId,processId:observation.processId,processStart:observation.processStart,className:observation.className,title:observation.title,url:observation.url,rect:observation.rect,viewport:observation.viewport}),element:clone(element)});
      expiresAt=Math.min(expiresAt,options.sequence?Date.now()+runtime.config.operationTimeoutMs+runtime.config.reviewerTimeoutMs:(observation.observedAt??Date.now())+runtime.observations.maxAge);
    }
    const summary=entries.map((e,i)=>`${i+1}:${e.action.mode} ${e.action.action} ${e.element.name.slice(0,80)}${e.action.text!==undefined?' '+e.action.text.length+'字':''}`).join(' / ');
    const requestId=`批量 ${summary} · ${randomUUID()}`,plan={owner,kind,entries,expiresAt,used:false,sequence:options.sequence===true};this.items.set(requestId,plan);while(this.items.size>64)this.items.delete(this.items.keys().next().value);
    return {batch:{action:'batch',requestId},steps:entries.map(e=>({action:e.action.action,mode:e.action.mode,targetName:e.element.name,identity:e.element.identity,rect:e.element.rect,...(e.action.text===undefined?{}:{textLength:e.action.text.length})})),expiresAt,hint:'原样执行 batch，仅复制 requestId；一次审批覆盖已登记的明确步骤。每步重新核验目标，失败只报告已完成部分，不整批重放。'};
  }
  descriptor(owner,kind,args){
    const plan=this.get(owner,kind,args);
    return {steps:plan.entries.map(e=>({target:e.observation,element:{identity:e.element.identity,name:e.element.name,role:e.element.role??e.element.tag,rect:e.element.rect},input:{...e.action,text:e.action.text===undefined?undefined:{length:e.action.text.length,sha256:createHash('sha256').update(e.action.text).digest('hex')}}}))};
  }
  async rebound(owner,kind,entry,signal,allowDisabled=false){
    const runtime=this.runtime,o=entry.observation;
    const fresh=await runtime.capture(owner,kind,{action:'observe',windowId:o.windowId,tabId:o.tabId},signal);
    for(const k of kind==='desktop'?['windowId','processId','processStart','className','title']:['tabId','url','title'])if(fresh[k]!==o[k])throw new ControlError('BATCH_TARGET_CHANGED','批量执行中窗口/页面身份已变化');
    if(kind==='desktop'&&['x','y','width','height'].some(k=>fresh.rect[k]!==o.rect[k]))throw new ControlError('BATCH_TARGET_CHANGED','批量执行中窗口移动或缩放');
    const element=fresh.elements.find(e=>e.identity===entry.element.identity);
    if(!element||element.name!==entry.element.name||(element.role??element.tag)!==(entry.element.role??entry.element.tag)||(kind==='browser'&&['tag','role','href','type','editable','editingHost'].some(k=>element[k]!==entry.element[k]))||(kind==='desktop'&&['x','y','width','height'].some(k=>Math.abs(element.rect[k]-entry.element.rect[k])>1))||(!allowDisabled&&(element.enabled===false||element.disabled===true)))throw new ControlError('BATCH_TARGET_CHANGED','批量目标身份、名称、语义或可用状态已改变；停止剩余步骤');
    return {observation:fresh,args:{...entry.action,observationId:fresh.observationId,elementId:element.elementId}};
  }
  async execute(owner,kind,args,exec,signal){
    const runtime=this.runtime,plan=this.get(owner,kind,args),completed=[];let acquired=false,startedStep=null;
    const permission=sessionPermissions(runtime.ctx,exec),settings=JSON.stringify(runtime.gate.settings(owner));
    const initial=async()=>{for(const entry of plan.entries){const fresh=kind==='browser'&&plan.sequence?runtime.observations.forRevalidation(owner,entry.initialObservationId,runtime.config.browserRevalidationMaxAgeMs):null,observed=fresh?.value??runtime.observations.get(owner,entry.initialObservationId,kind,kind==='browser'),element=observed.elements.find(e=>e.identity===entry.element.identity);if(!element)throw new ControlError('BATCH_TARGET_CHANGED','登记的目标已失效');if(kind==='desktop')await runtime.native.call('check-element',{nativeObservation:observed.nativeObservation,elementId:element.elementId},signal);else await runtime.browser.validate(owner,observed,{...entry.action,elementId:element.elementId},fresh?.expired===true,{allowDisabled:entry.waitEnabled});}};
    await initial();
    // All exact targets and inputs are supplied to the plugin review and host ask.
    await runtime.gate.authorize(owner,exec,{kind,action:'batch',arguments:args,steps:plan.entries},signal);
    await initial();
    for(const entry of plan.entries)await this.rebound(owner,kind,entry,signal,entry.waitEnabled);
    checkAbort(signal);this.get(owner,kind,args);runtime.presence.check(owner);
    plan.used=true;
    try{
      const mouse=kind==='browser'||plan.entries.some(e=>e.action.mode==='mouse');await runtime.presence.start(owner,kind==='browser'?'browser':mouse?'mouse':'uia',signal);
      if(kind==='desktop'){await runtime.native.call('begin',{owner,kind:mouse?'mouse':'uia'},signal);acquired=true;}
      for(let i=0;i<plan.entries.length;i++){
        checkAbort(signal);runtime.presence.check(owner);
        if(JSON.stringify(sessionPermissions(runtime.ctx,exec))!==JSON.stringify(permission)||JSON.stringify(runtime.gate.settings(owner))!==settings)throw new ControlError('PERMISSION_CHANGED','批量执行期间权限或审批设置改变，停止剩余操作');
        if(plan.entries[i].waitEnabled){const pending=await this.rebound(owner,kind,plan.entries[i],signal,true),found=runtime.browser.cited(owner,pending.observation),handle=found.elements.get(pending.args.elementId);try{await abortable(()=>handle.waitForElementState('enabled',{timeout:5000}),signal);}catch(error){checkAbort(signal);throw new ControlError('STEP_NOT_READY','后续按钮未在 5 秒内启用，停止剩余步骤');}}
        const bound=await this.rebound(owner,kind,plan.entries[i],signal);startedStep=i+1;
        const result=kind==='desktop'?await runtime.native.call(bound.args.action,{...bound.args,nativeObservation:bound.observation.nativeObservation},signal):await runtime.browser.execute(owner,bound.args.action,bound.args,bound.observation,signal);
        completed.push({step:i+1,action:bound.args.action,targetName:plan.entries[i].element.name,performed:result.performed===true});startedStep=null;
        runtime.audit({owner,kind,action:'batch-step',step:i+1,result:'success'});
      }
      const o=plan.entries[0].observation,postObservation=await runtime.capture(owner,kind,{action:'observe',windowId:o.windowId,tabId:o.tabId},signal).catch(()=>null);
      return {performed:true,completed,total:plan.entries.length,postObservation};
    }catch(error){error.partial={completed,total:plan.entries.length,failedStep:completed.length+1,mayHavePartialEffect:startedStep!==null,replayAllowed:false};runtime.audit({owner,kind,action:'batch',result:'error',completed:completed.length,code:error.code??'ERROR'});throw error;}
    finally{if(acquired)await runtime.native.call('end',{idleMs:signal.aborted?0:runtime.config.indicatorIdleMs}).catch(()=>{});}
  }
}
