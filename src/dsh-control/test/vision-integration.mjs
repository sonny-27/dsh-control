// Real DSH services, durable attachments, Windows capture and Chrome input.
// The local test adapter locates a colored shape by decoding the received image;
// this tests the multimodal plumbing without a paid provider or claimed AI OCR.
import {boot} from '@deepseek-ai/dsh-app-boot';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {ControlRuntime} from '../index.js';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local')),sharp=require('sharp');
const temp=mkdtempSync(join(tmpdir(),'dsh-vision-live-')),out=fileURLToPath(new URL('../../test-evidence/',import.meta.url));mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),runtime:'real DSH tools/LLM/attachments + Windows + installed Chrome',visionAdapter:'deterministic image decoder, no remote AI/OCR acceptance claimed',checks:[]};
const rows=['dsh-system-prompt','dsh-tools','dsh-session','dsh-session-projection','dsh-sandbox-policy','dsh-user-approval','dsh-llm','dsh-attachment-local'].map(p=>({id:p,name:import.meta.resolve('@deepseek-ai/'+p),config:p==='dsh-sandbox-policy'?{mode:'danger-full-access'}:p==='dsh-user-approval'?{policy:'never'}:p==='dsh-attachment-local'?{dshHome:join(temp,'home')}:{}}));
rows.push({id:'test-shell',name:new URL('test-shell.mjs',import.meta.url).href});writeFileSync(join(temp,'cordis.yml'),JSON.stringify(rows));
let ctx,runtime,fixture,serial=0;const received=[];
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Vision Canvas Fixture</title><style>html,body{margin:0;background:white}canvas{display:block}</style><canvas width="700" height="500"></canvas><script>const c=document.querySelector('canvas'),g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,700,500);g.fillStyle='#ff0000';g.fillRect(220,180,100,70);window.hit=0;c.onclick=e=>{if(e.offsetX>=220&&e.offsetX<320&&e.offsetY>=180&&e.offsetY<250){hit++;g.fillStyle='#00aa00';g.fillRect(220,180,100,70)}};</script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
async function check(label,body){await body();report.checks.push({label,result:'pass'});console.log('PASS '+label);}
class ImageDecoder extends LlmAdapter {
  async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:model==='text-only'?['text']:['text','image']};}
  async *stream(options){
    assert.equal(options.provider,'local-vision-slot');assert.equal(options.model,'image-decoder');assert.equal(options.tools,undefined);
    const image=options.messages[0].content.find(b=>b.type==='image');assert.ok(image,'actual image block survives real LLM service');
    const stored=await ctx.attachments.readImage(image.attachment,options.signal),{data,info}=await sharp(Buffer.from(stored.data)).removeAlpha().raw().toBuffer({resolveWithObject:true});
    let x0=info.width,y0=info.height,x1=-1,y1=-1;
    for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){const i=(y*info.width+x)*info.channels;if(data[i]>200&&data[i+1]<70&&data[i+2]<70){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}}
    const elements=x1<0?[]:[{label:'red target from actual pixels',text:'',x:(x0+x1)/2/info.width*1000,y:(y0+y1)/2/info.height*1000,confidence:1}];
    received.push({width:info.width,height:info.height,elements:elements.length});
    yield {type:'text-delta',index:0,text:JSON.stringify({summary:elements.length?'A red target is visible':'No red target remains',uncertainty:'Local deterministic fixture; not a general vision model',elements})};yield {type:'finish',reason:{kind:'stop'}};
  }
}
try{
  ctx=await boot('dsh-vision-live',join(temp,'cordis.yml'),[]);ctx.llm.registerAdapter(['local-vision-slot'],new ImageDecoder());
  const session=ctx.sessions.create('vision-session',{meta:{cwd:temp}}),agent={id:session.id,session,ctx,inject:()=>{},isQuiescent:()=>true};
  runtime=new ControlRuntime(ctx,{stateDir:join(temp,'state'),preserveBrowserOnExit:false,browserProfileDir:join(temp,'browser'),visionMode:'assist',visionProvider:'local-vision-slot',visionModel:'image-decoder'});
  for(const tool of runtime.tools())ctx.tools.register(tool);
  const call=async(name,args)=>{const result=await ctx.tools.execute({name,arguments:args,agent,signal:new AbortController().signal,callId:'vision-'+ ++serial});assert.ok(result.content.every(b=>b.type==='text'),'text-only main model gets no image blocks');const value=JSON.parse(result.content[0].text);assert.equal(value.ok,true,JSON.stringify(value));assert.doesNotMatch(result.content[0].text,/pngBase64|data:image/);return value.data;};
  let opened,looked;
  await check('real DSH routes screenshots to a separate image-capable slot',async()=>{opened=await call('control_browser',{action:'open',url:`http://127.0.0.1:${server.address().port}/`});assert.equal(opened.postObservation.vision.ok,true,JSON.stringify(opened));assert.ok(received.length);});
  await check('text-only main model can locate a target drawn in a nameless canvas',async()=>{looked=await call('control_browser',{action:'look',tabId:opened.tabId,question:'Find the red shape'});assert.equal(looked.vision.ok,true,JSON.stringify(looked.vision));assert.equal(looked.vision.elements.length,1);const p=looked.vision.elements[0].point;assert.ok(Math.abs(p.x-270)<3&&Math.abs(p.y-215)<3,JSON.stringify(p));assert.equal(looked.vision.observationId,looked.observationId);});
  await check('visual coordinates drive a real browser virtual-mouse click and a fresh text result',async()=>{const point=looked.vision.elements[0].point;const result=await call('control_browser',{action:'click',observationId:looked.observationId,tabId:opened.tabId,...point});assert.equal(result.performed,true);assert.equal(await runtime.browser.page(session.id,opened.tabId).evaluate(()=>hit),1);assert.equal(result.postObservation.vision.ok,true);assert.equal(result.postObservation.vision.elements.length,0);await runtime.browser.page(session.id,opened.tabId).screenshot({path:join(out,'vision-canvas-result.png')});});
  await runtime.presence.finish(session.id);await runtime.browser.close(session.id);
  const statePath=join(temp,'fixture.json');fixture=spawn(`${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`,['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('vision-fixture.ps1',import.meta.url)),'-StatePath',statePath],{windowsHide:true});
  let windowId,fixtureError='';fixture.stderr.on('data',b=>fixtureError+=b);for(let i=0;i<100&&!windowId;i++){try{windowId=JSON.parse(readFileSync(statePath,'utf8')).windowId;}catch{}await sleep(60);}assert.ok(windowId,'fixture startup '+fixtureError);
  await sleep(400); // Shown fires before the first compositor frame is painted.
  let desktop;
  await check('real Windows visible-screen crop traverses the durable image slot with scaled coordinates',async()=>{const window=await runtime.native.call('observe',{windowId});desktop=await call('control_desktop',{action:'look',region:window.rect,maxWidth:480,question:'Find the red panel'});assert.equal(desktop.vision.ok,true,JSON.stringify(desktop.vision));assert.equal(desktop.vision.elements.length,1);assert.ok(desktop.imageTransform.scaleX>1);const p=desktop.vision.elements[0].point;assert.ok(p.x>window.rect.x&&p.x<window.rect.x+window.rect.width);});
  await check('desktop visual target still requires the native inspect/prepare binding',async()=>{const point=desktop.vision.elements[0].point;const prepared=await call('control_desktop',{action:'prepare',observationId:desktop.observationId,windowId,...point});assert.equal(prepared.click.windowId,windowId);assert.ok(prepared.perform.requestId);assert.equal(runtime.coordinator.status.owner,null);});
  await check('a visible Windows fixture also supports the background-window screenshot route',async()=>{const window=await call('control_desktop',{action:'look',windowId,maxWidth:480});assert.equal(window.vision.ok,true,JSON.stringify(window.vision));assert.equal(window.vision.elements.length,1);assert.equal(window.vision.elements[0].windowId,windowId);});
  await check('known non-visual slot is rejected by real model capability metadata',async()=>{runtime.updateSettings(session.id,{visionModel:'text-only'});const result=await call('control_desktop',{action:'look',windowId});assert.equal(result.vision.error.code,'VISION_MODEL_TEXT_ONLY');});
  report.passed=true;report.imagesRead=received.length;
}catch(error){report.passed=false;report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{await runtime?.dispose();fixture?.kill();server.closeAllConnections();await new Promise(r=>server.close(r));await ctx?.fiber.dispose();report.finishedAt=new Date().toISOString();writeFileSync(join(out,'vision-integration-report.json'),JSON.stringify(report,null,2));}
