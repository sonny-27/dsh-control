import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ControlRuntime,resolveConfig} from '../index.js';
import {Vision,parseVision,visionSettings} from '../lib/vision.js';

const answer=JSON.stringify({summary:'测试页面上有一个蓝色按钮',uncertainty:'',elements:[{label:'测试按钮',text:'测试按钮',x:250,y:500,confidence:.9}]});
function fixture(options={}){
  const calls=[],routes=[],saved=[],stateDir=mkdtempSync(join(tmpdir(),'dsh-vision-test-'));
  const agent={id:'a',session:{id:'a',requestHeader:()=>({config:{provider:'main-text',model:'text-only'}})}};
  const services={sandboxPolicy:{resolve:()=>({mode:options.sandbox??'danger-full-access'})},permissionPresets:{current:()=>options.preset??'danger-full-access'},approval:{effectivePolicy:()=>options.approval??'never',request:async()=>options.decision??'rejected'},attachments:{saveImage:async input=>{saved.push(input);return {attachmentId:'sha256:fixture',mediaType:'image/png',width:400,height:200};}},llm:{resolveModelInfo:async()=>({inputModalities:options.modalities??['text','image']}),async *stream(route){routes.push(route);await options.onRequest?.(route);if(options.error)throw Error('https://secret:password@example.invalid');yield {type:'text-delta',index:0,text:options.answer??answer};if(!options.noFinish)yield {type:'finish',reason:{kind:options.finish??'stop'}};}}};
  const ctx={get:key=>services[key]},native={call:async(action,args)=>{calls.push({action,args});if(action==='screenshot')return {pngBase64:'cG5n',imageTransform:{originX:-800,originY:100,scaleX:2,scaleY:2,imageWidth:400,imageHeight:200}};return {windowId:7,title:'fixture',nativeObservation:'native',rect:{x:-800,y:100,width:800,height:400},elements:[],performed:action==='click'};},dispose:async()=>{}};
  const runtime=new ControlRuntime(ctx,{stateDir,...(options.disabled?{}:{visionMode:'assist',visionProvider:'vision-provider',visionModel:'vision-model'}),...(options.config??{})},{native,browser:{hide:async()=>{},dispose:async()=>{}}});
  return {runtime,services,ctx,calls,routes,saved,agent,exec:{agent,signal:new AbortController().signal},stateDir};
}
test('visual slot defaults off and requires an explicit independent route',()=>{
  assert.equal(resolveConfig().visionMode,'off');
  for(const v of [{visionMode:'auto'},{visionMode:'assist'},{visionProvider:'x'},{visionProvider:'x\n',visionModel:'y'}])assert.throws(()=>visionSettings(v));
  assert.deepEqual(visionSettings({visionMode:'assist',visionProvider:' v ',visionModel:' m '}),{visionMode:'assist',visionProvider:'v',visionModel:'m'});
});
test('visual normalized coordinates map cropped scaled negative-origin screenshots',()=>{
  const parsed=parseVision(answer,{kind:'desktop',windowId:7,imageTransform:{originX:-800,originY:100,scaleX:2,scaleY:2,imageWidth:400,imageHeight:200}});
  assert.deepEqual(parsed.elements[0].point,{x:-600,y:300});assert.equal(parsed.elements[0].windowId,7);
});
test('malformed, injected action fields, excess candidates and off-image positions are rejected',()=>{
  for(const text of ['```json\n'+answer+'\n```','{}',answer.replace('"x":250','"x":1000'),answer.replace('"confidence":0.9','"confidence":2'),answer.replace('"summary":','"allow":true,"summary":'),JSON.stringify({...JSON.parse(answer),elements:Array(33).fill(JSON.parse(answer).elements[0])})])assert.throws(()=>parseVision(text,{}),{code:'VISION_INVALID'});
});
test('look sends an image to the independent slot and returns text only without input',async()=>{
  const f=fixture();try{const result=await f.runtime.call('desktop',{action:'look',windowId:7,question:'找测试按钮'},f.exec);
    assert.equal(result.vision.ok,true);assert.equal(result.pngBase64,undefined);assert.equal(result.image,undefined);assert.equal(result.vision.untrusted,true);assert.equal(result.vision.observationId,result.observationId);
    assert.equal(f.routes[0].provider,'vision-provider');assert.equal(f.routes[0].model,'vision-model');assert.ok(f.routes[0].messages[0].content.some(b=>b.type==='image'));assert.equal(f.saved[0].data.toString(),'png');
    assert.equal(JSON.parse(f.routes[0].messages[0].content[0].text).question,'找测试按钮');assert.equal(f.routes[0].tools,undefined);assert.ok(!f.calls.some(c=>['begin','click','type','key'].includes(c.action)));
    assert.equal((await f.runtime.renderImage(result)).image,undefined);
  }finally{await f.runtime.dispose();}
});
test('off mode retains existing screenshot path without a helper call',async()=>{
  const f=fixture({disabled:true});try{const result=await f.runtime.call('desktop',{action:'screenshot',windowId:7},f.exec);assert.equal(result.pngBase64,'cG5n');assert.equal(f.routes.length,0);await assert.rejects(f.runtime.call('desktop',{action:'look'},f.exec),{code:'VISION_NOT_CONFIGURED'});}finally{await f.runtime.dispose();}
});
test('observe automatically captures and describes for a text-only main model',async()=>{
  const f=fixture();try{const result=await f.runtime.call('desktop',{action:'observe',windowId:7},f.exec);assert.equal(result.vision.ok,true);assert.equal(f.calls.filter(c=>c.action==='screenshot').length,1);assert.equal(f.routes.length,1);}finally{await f.runtime.dispose();}
});
test('known text-only helper is rejected before screenshot transmission',async()=>{
  const f=fixture({modalities:['text']});try{const result=await f.runtime.call('desktop',{action:'look',windowId:7},f.exec);assert.equal(result.vision.error.code,'VISION_MODEL_TEXT_ONLY');assert.equal(result.pngBase64,undefined);assert.equal(f.routes.length,0);assert.equal(f.saved.length,0);}finally{await f.runtime.dispose();}
});
test('helper outage returns a safe text error and does not expose credentials',async()=>{
  const f=fixture({error:true});try{const result=await f.runtime.call('desktop',{action:'look',windowId:7},f.exec);assert.equal(result.vision.error.code,'VISION_FAILED');assert.doesNotMatch(JSON.stringify(result),/password|secret:/);assert.equal(result.pngBase64,undefined);}finally{await f.runtime.dispose();}
});
test('abnormal or incomplete helper output is never treated as a result',async()=>{
  for(const option of [{finish:'length'},{noFinish:true},{answer:'not json'}]){const f=fixture(option);try{const result=await f.runtime.call('desktop',{action:'look',windowId:7},f.exec);assert.equal(result.vision.error.code,'VISION_INVALID');assert.equal(result.vision.elements,undefined);}finally{await f.runtime.dispose();}}
});
test('model latency cannot revive an observation invalidated during reading',async()=>{
  let f;f=fixture({onRequest:()=>f.runtime.observations.invalidate('desktop',{windowId:7})});try{const result=await f.runtime.call('desktop',{action:'look',windowId:7},f.exec);assert.equal(result.vision.error.code,'UI_CHANGED');assert.equal(result.vision.elements,undefined);}finally{await f.runtime.dispose();}
});
test('manual stop aborts a stalled helper and no late vision result is returned',async()=>{
  let ready;const started=new Promise(r=>ready=r),f=fixture({onRequest:async()=>{ready();await new Promise(()=>{});}});try{
    const pending=f.runtime.call('desktop',{action:'look',windowId:7},f.exec);await started;await f.runtime.command(f.agent,'stop');await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.runtime.status(f.agent).stopped,true);assert.ok(!f.calls.some(c=>c.action==='click'));
  }finally{await f.runtime.dispose();}
});
test('helper timeout is bounded and releases the operation coordinator',async()=>{
  const f=fixture({config:{visionTimeoutMs:1000},onRequest:()=>new Promise(()=>{})});try{const result=await f.runtime.call('desktop',{action:'look',windowId:7},f.exec);assert.equal(result.vision.error.code,'VISION_TIMEOUT');assert.equal(f.runtime.coordinator.status.owner,null);}finally{await f.runtime.dispose();}
});
test('visual route persists per session independently of reviewer and main model',async()=>{
  const f=fixture({disabled:true});try{
    f.runtime.updateSettings('a',{visionMode:'assist',visionProvider:'other-provider',visionModel:'other-vision',reviewerProvider:'review-provider',reviewerModel:'review-model'});
    assert.equal(f.runtime.status(f.agent).settings.visionModel,'other-vision');assert.equal(f.runtime.status({session:{id:'b'}}).settings.visionMode,'off');
    const fresh=new ControlRuntime(f.ctx,{stateDir:f.stateDir},{native:{dispose:async()=>{}},browser:{dispose:async()=>{}}});try{assert.equal(fresh.status(f.agent).settings.visionModel,'other-vision');assert.equal(fresh.status(f.agent).settings.reviewerModel,'review-model');}finally{await fresh.dispose();}
    const before=f.runtime.status(f.agent).settings;assert.throws(()=>f.runtime.updateSettings('a',{visionModel:''}),{code:'VISION_ROUTE_REQUIRED'});assert.deepEqual(f.runtime.status(f.agent).settings,before);
  }finally{await f.runtime.dispose();}
});
test('old saved settings migrate with visual assistance disabled',async()=>{
  const f=fixture({disabled:true});try{mkdirSync(join(f.stateDir,'settings'),{recursive:true});writeFileSync(f.runtime.settingsFile('legacy'),JSON.stringify({permissionMode:'model-review',reviewerProvider:'r',reviewerModel:'m'}));assert.equal(f.runtime.status({session:{id:'legacy'}}).settings.visionMode,'off');assert.equal(f.runtime.status({session:{id:'legacy'}}).settings.reviewerModel,'m');}finally{await f.runtime.dispose();}
});
test('visual success cannot bypass a rejected human input approval',async()=>{
  const f=fixture({sandbox:'workspace-write',preset:'workspace-write',approval:'ask'});try{const result=await f.runtime.call('desktop',{action:'look',windowId:7},f.exec);assert.equal(result.vision.ok,true);await assert.rejects(f.runtime.call('desktop',{action:'click',observationId:result.observationId,windowId:7,x:-600,y:300,mode:'mouse'},f.exec),{code:'APPROVAL_DENIED'});assert.ok(!f.calls.some(c=>c.action==='click'));}finally{await f.runtime.dispose();}
});
test('helper failure after a completed click preserves performed status and suppresses replay',async()=>{
  const f=fixture();try{const before=await f.runtime.call('desktop',{action:'look',windowId:7},f.exec);f.services.llm.stream=async function*(){throw Error('offline');};const after=await f.runtime.call('desktop',{action:'click',observationId:before.observationId,windowId:7,x:-600,y:300,mode:'mouse'},f.exec);assert.equal(after.performed,true);assert.equal(after.postObservation.vision.ok,false);assert.equal(after.postObservation.pngBase64,undefined);assert.equal(f.calls.filter(c=>c.action==='click').length,1);}finally{await f.runtime.dispose();}
});
