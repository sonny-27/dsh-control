// Uses the real Cordis loader, DSH tools, sessions, approval and LLM services.
// The review adapter is deterministic so this test never calls a paid API.
import {boot} from '@deepseek-ai/dsh-app-boot';
import {LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm';
import {setSandboxMode} from '@deepseek-ai/dsh-sandbox-policy';
import {setApprovalPolicy} from '@deepseek-ai/dsh-user-approval';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';

const temp = mkdtempSync(join(tmpdir(), 'dsh-control-host-'));
const report = {runtime: JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tools/package.json')))).version, reviewer: 'deterministic test adapter, no external API', checks: []};
const evidence = fileURLToPath(new URL('../../test-evidence', import.meta.url)); mkdirSync(evidence, {recursive: true});
const statePath = join(temp, 'fixture.json');
const fixture = spawn(`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('fixture.ps1', import.meta.url)), '-StatePath', statePath], {windowsHide: true});
let fixtureError = ''; fixture.stderr.on('data', b => fixtureError += b);
function state() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch {return {};} }
async function until(fn) { const deadline = Date.now() + 6000; while(Date.now() < deadline) {if (await fn()) return; await sleep(50);} throw new Error('Fixture timeout '+fixtureError+' state='+JSON.stringify(state())); }
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html;charset=utf-8');if(req.url==='/sequence'){res.end('<!doctype html><title>Sequence host fixture</title><textarea id="entry" aria-label="Message" oninput="document.querySelector(\'button\').disabled=false"></textarea><button disabled onclick="document.querySelector(\'p\').textContent=\'message delivered\'">Send</button><p></p>');return;}res.end('<!doctype html><title>DSH Host Integration Fixture</title><button onclick="this.textContent=\'Host clicked\'">Host button</button>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let ctx;
const config = join(temp, 'cordis.yml');
const rows = ['dsh-system-prompt', 'dsh-tools', 'dsh-session', 'dsh-session-projection', 'dsh-sandbox-policy', 'dsh-user-approval', 'dsh-llm', 'dsh-commands'].map(pkg => ({id: pkg, name: import.meta.resolve(`@deepseek-ai/${pkg}`), config: pkg === 'dsh-sandbox-policy' ? {mode: 'danger-full-access'} : pkg === 'dsh-user-approval' ? {policy: 'never'} : {}}));
rows.push({id: 'dsh-control', name: new URL('../index.js', import.meta.url).href, config: {stateDir: join(temp, 'state'), preserveBrowserOnExit:false,browserProfileDir: join(temp, 'browser'), indicatorIdleMs: 0}});
rows.push({id:'test-shell',name:new URL('test-shell.mjs',import.meta.url).href});
rows.push({id:'dsh-host-webserver',name:import.meta.resolve('@deepseek-ai/dsh-host-webserver'),config:{host:'127.0.0.1',port:0}});
for(const pkg of ['dsh-permission-presets','dsh-experimental-auto-review']) rows.push({id:pkg,name:import.meta.resolve('@deepseek-ai/'+pkg),config:{}});
// JSON is a YAML subset; this exercises the installed loader without a fixture parser.
writeFileSync(config, JSON.stringify(rows, null, 2));
let allow = true, reviewRoutes = [], approvalCount = 0, hostApproval = 'allowed-once', callSerial = 0, autoDecision='allow',autoRoutes=[];
class Reviewer extends LlmAdapter {
  async *stream(options) {
    const auto=options.system.startsWith('REVIEW_POLICY');
    (auto?autoRoutes:reviewRoutes).push({provider:options.provider,model:options.model});
    if(auto&&autoDecision==='offline') throw new Error('test reviewer offline');
    const input=options.messages?.[0]?.content?.[0]?.text??'',hasEvidence=/"proof"\s*:\s*"[\w-]{43}"/.test(input)&&/"name"\s*:\s*"Fixture button"/.test(input);
    const text=auto?(autoDecision==='allow'||autoDecision==='evidence'&&hasEvidence?'{"risk":"low","decision":"allow"}':autoDecision==='malformed'?'bad-json':'{"risk":"medium","decision":"deny","reason":"fixture Auto denial or missing observed target evidence"}'):(allow?'{"decision":"allow"}':'{"decision":"deny","reason":"fixture denial"}');
    yield {type:'text-delta',index:0,text};yield {type:'finish',reason:{kind:'stop'}};
  }
}
async function check(label, body) { await body(); report.checks.push({label, result: 'pass'}); console.log('PASS ' + label); }
try {
  await until(() => state().windowId);
  ctx = await boot('dsh-control-integration', config, []);
  const session = ctx.sessions.create('dsh-integration-session', {meta: {cwd: resolve(temp)}});
  session.append('turn/start', {turn: 1});
  session.append('user/message', createUserMessage({source: {kind: 'user', rpcId: 'test-human-request'}, content: [{type: 'text', text: '请只在 DSH Control Test Fixture 中点击按钮、输入测试文字，并操作本地测试网页。'}]}), {surfaceOp: 'append'});
  const agent = {id: session.id, session, ctx, inject: () => {}, isQuiescent: () => true};
  const signal = new AbortController().signal;
  const call = async (name, args) => {
    const result = await ctx.tools.execute({name, arguments: args, agent, signal, callId: 'dsh-test-' + ++callSerial});
    if (!result.content?.[0]?.text) throw new Error('No DSH tool content: ' + JSON.stringify(result));
    try{return JSON.parse(result.content[0].text);}catch{throw new Error('DSH non-JSON output: '+result.content[0].text);}
  };
  const command = async text => { const r = await ctx.commands.execute(agent, '/control ' + text, [], signal); assert.equal(r.result.kind, 'success', r.result.text); return r; };
  let observed;
  await check('Cordis loader mounts exactly three tools and the /control command', async () => { for (const name of ['control_desktop', 'control_browser', 'control_status']) assert.ok(ctx.tools.get(name)); await command('status'); });
  await check('official DSH webserver mounts GUI bootstrap and authenticated settings route',async()=>{
    await until(()=>ctx.webServer.collectIndexInjections().some(row=>row.name==='__DSH_CONTROL_GUI_V1__'));
    const config=ctx.webServer.collectIndexInjections().find(row=>row.name==='__DSH_CONTROL_GUI_V1__').value;
    const url=`http://127.0.0.1:${ctx.webServer.port}${config.endpoint}`;
    const denied=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);
    const saved=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-dsh-control-token':config.token},body:JSON.stringify({action:'save',sessionId:session.id,settings:{permissionMode:'follow-session'}})});
    assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json()).data.settings.permissionMode,'follow-session');
    assert.equal((await call('control_status',{})).data.settings.permissionMode,'follow-session');
  });
  await check('real DSH registry executes native observations with validated JSON output', async () => { const result = await call('control_desktop', {action: 'observe', windowId: state().windowId}); assert.equal(result.ok, true, JSON.stringify(result)); observed = result.data; assert.ok(observed.elements.length > 0); });
  await check('official DSH observation retains continuous presence after tool completion without input ownership',async()=>{const status=await call('control_status',{});assert.equal(status.data.presence.owner,session.id);assert.equal(status.data.presence.phase,'thinking');assert.equal(status.data.control.owner,null);});
  await check('official human stop remains latched across automatically started turns',async()=>{await command('stop');assert.equal((await call('control_status',{})).data.stopped,true);session.append('turn/end',{turn:1,reason:{kind:'completed'}});session.append('turn/start',{turn:2});const blocked=await call('control_desktop',{action:'windows'});assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'CONTROL_STOPPED');});
  await check('official human message permits new work and turn end removes continuous indicator',async()=>{session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'resume-test-human'},content:[{type:'text',text:'继续测试，只操作测试窗口。'}]}),{surfaceOp:'append'});const next=await call('control_desktop',{action:'observe',windowId:state().windowId});assert.equal(next.ok,true,JSON.stringify(next));observed=next.data;session.append('turn/end',{turn:2,reason:{kind:'completed'}});assert.equal((await call('control_status',{})).data.presence.owner,null);session.append('turn/start',{turn:3});});
  await check('real DSH new screen schema and automatic minimized restore complete without workaround tools',async()=>{
    const screen=await call('control_desktop',{action:'screen'});assert.equal(screen.ok,true,JSON.stringify(screen));assert.equal(screen.data.scope,'screen');assert.ok(screen.data.windows.some(w=>w.className==='Shell_TrayWnd'));
    const file=statePath+'.command';writeFileSync(file,JSON.stringify({action:'minimize'}));await until(()=>!existsSync(file)&&state().minimized);
    const min=await call('control_desktop',{action:'observe',windowId:state().windowId});assert.equal(min.ok,true);assert.equal(min.data.minimized,true);
    const active=await call('control_desktop',{action:'activate',mode:'mouse',observationId:min.data.observationId});assert.equal(active.ok,true,JSON.stringify(active));assert.equal(active.data.restored,true);assert.equal(active.data.postObservation.foreground,true);observed=active.data.postObservation;
  });
  await check('real DSH full-session dispatch clicks actual Windows fixture', async () => { const r = await call('control_desktop', {action: 'click', mode: 'uia', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId}); assert.equal(r.ok, true, JSON.stringify(r)); await until(() => state().clicks === 1); observed = r.data.postObservation; });
  ctx.on('approval/request', async req => { approvalCount++;const s=await ctx.tools.get('control_status').execute({},{agent:req.agent,signal:req.signal});if(s.data.presence.owner===req.agent.session.id)assert.equal(s.data.presence.phase,'approval');return hostApproval; });
  await check('live sandbox/approval session changes flow through official DSH approval events', async () => { setSandboxMode(session, 'workspace-write'); setApprovalPolicy(session, 'ask'); const r = await call('control_desktop', {action: 'type', mode: 'uia', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture input').elementId, text: '真实 DSH 工具调用 ✓'}); assert.equal(r.ok, true, JSON.stringify(r)); await until(() => state().text === '真实 DSH 工具调用 ✓'); observed = r.data.postObservation; assert.equal(approvalCount, 1); assert.ok(session.snapshotEvents().some(e => e.type === 'approval/asked')); assert.ok(session.snapshotEvents().some(e => e.type === 'approval/decided' && e.data.outcome === 'allowed-once')); });
  await check('official DSH approval denial blocks native action', async () => { hostApproval = 'rejected'; const r = await call('control_desktop', {action: 'click', mode: 'uia', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId}); assert.equal(r.ok, false); assert.equal(r.error.code, 'APPROVAL_DENIED'); assert.equal(state().clicks, 1); });
  setSandboxMode(session, 'danger-full-access'); setApprovalPolicy(session, 'never');
  ctx.llm.registerAdapter(['test-reviewer'], new Reviewer());
  await command('reviewer test-reviewer isolated-review-model'); await command('mode model-review');
  await check('human slash-command selects reviewer used by real DSH LLM routing', async () => { const r = await call('control_desktop', {action: 'click', mode: 'uia', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId}); assert.equal(r.ok, true, JSON.stringify(r)); await until(() => state().clicks === 2); assert.deepEqual(reviewRoutes.at(-1), {provider: 'test-reviewer', model: 'isolated-review-model'}); observed = r.data.postObservation; });
  await check('real DSH LLM reviewer deny prevents effect', async () => { allow = false; const r = await call('control_desktop', {action: 'click', mode: 'uia', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId}); assert.equal(r.ok, false); assert.equal(r.error.code, 'MODEL_REJECTED'); assert.equal(state().clicks, 2); allow = true; });
  await command('mode follow-session');
  await check('real DSH registry drives Chrome and browser mouse', async () => { const r = await call('control_browser', {action: 'open', url: `http://127.0.0.1:${server.address().port}/`}); assert.equal(r.ok, true, JSON.stringify(r)); const obs = r.data.postObservation; const clicked = await call('control_browser', {action: 'click', observationId: obs.observationId, elementId: obs.elements.find(e => e.name === 'Host button').elementId}); assert.equal(clicked.ok, true); assert.ok(clicked.data.postObservation.elements.find(e => e.name === 'Host clicked')); await call('control_browser', {action: 'close-browser'}); });
  ctx.llm.registerAdapter(['auto-work-provider'],new Reviewer());
  async function autoClick({decision='allow',approval='ask',override='rejected',evidence=false,tamper=false}={}){
    autoDecision=decision;hostApproval=override;
    const s=ctx.sessions.create('auto-'+(++callSerial),{meta:{cwd:resolve(temp)}});
    const a={...agent,id:s.id,session:s};ctx.permissionPresets.set(s,'auto');setApprovalPolicy(s,approval);
    s.append('turn/start',{turn:1});
    s.append('user/message',createUserMessage({source:{kind:'user',rpcId:'auto-test-human'},content:[{type:'text',text:'点击我创建的 DSH Control Test Fixture 测试按钮，仅一次。'}]}),{surfaceOp:'append'});
    s.append('request/header',{reason:'initial',header:{config:{provider:'auto-work-provider',model:'auto-work-model'},tools:ctx.tools.schemas(a)}});
    const signal=new AbortController().signal;
    // Observe directly to set up the pending click; the click itself uses the real registry gate.
    const obsResult=await ctx.tools.get('control_desktop').execute({action:'observe',windowId:state().windowId},{agent:a,signal});
    assert.equal(obsResult.ok,true,JSON.stringify(obsResult));const obs=obsResult.data;
    let args={action:'click',mode:'uia',observationId:obs.observationId,elementId:obs.elements.find(e=>e.name==='Fixture button').elementId};const callId='auto-call-'+callSerial;
    if(evidence){const p=await ctx.tools.get('control_desktop').execute({action:'prepare',observationId:obs.observationId,windowId:state().windowId,elementId:args.elementId},{agent:a,signal});assert.equal(p.ok,true,JSON.stringify(p));args=p.data.click;if(tamper)args={...args,count:2};}
    const configured=await ctx.commands.execute(a,'/control reviewer test-reviewer isolated-review-model',[],signal);assert.equal(configured.result.kind,'success');
    await ctx.commands.execute(a,'/control mode model-review',[],signal);
    s.append('step/start',{turn:1,step:1});
    const raw=JSON.stringify(args);
    s.append('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'tool-call',id:callId,name:'control_desktop',arguments:raw}]}},{surfaceOp:'append'});
    s.append('tool/call',{turn:1,step:1,callId,name:'control_desktop',arguments:raw});
    const before={clicks:state().clicks,asks:approvalCount,plugin:reviewRoutes.length,auto:autoRoutes.length};
    const result=await ctx.tools.execute({name:'control_desktop',arguments:args,agent:a,signal,callId});
    const parsed=result.isError?null:JSON.parse(result.content[0].text);return {result,parsed,before,session:s};
  }
  await check('native Auto Review allow executes once with session model and no duplicate plugin review',async()=>{const r=await autoClick();assert.equal(r.parsed?.ok,true,JSON.stringify(r.result));await until(()=>state().clicks===r.before.clicks+1);assert.equal(autoRoutes.length,r.before.auto+1);assert.equal(reviewRoutes.length,r.before.plugin);assert.equal(approvalCount,r.before.asks);assert.deepEqual(autoRoutes.at(-1),{provider:'auto-work-provider',model:'auto-work-model'});});
  await check('native Auto deny plus never blocks actual Windows effect even plugin model-review',async()=>{const r=await autoClick({decision:'deny',approval:'never'});assert.equal(r.result.isError,true);assert.match(JSON.stringify(r.result),/AUTO_REVIEW_DENIED/);assert.equal(state().clicks,r.before.clicks);assert.equal(reviewRoutes.length,r.before.plugin);assert.equal(approvalCount,r.before.asks);});
  await check('native Auto deny routes through official human approval and rejection prevents effect',async()=>{const r=await autoClick({decision:'deny'});assert.equal(r.result.isError,true);assert.equal(approvalCount,r.before.asks+1);assert.equal(state().clicks,r.before.clicks);assert.equal(reviewRoutes.length,r.before.plugin);});
  await check('native Auto deny permits explicit human override once without duplicate approval',async()=>{const r=await autoClick({decision:'deny',override:'allowed-once'});assert.equal(r.parsed?.ok,true,JSON.stringify(r.result));await until(()=>state().clicks===r.before.clicks+1);assert.equal(approvalCount,r.before.asks+1);assert.equal(reviewRoutes.length,r.before.plugin);});
  await check('native Auto malformed response fails closed before plugin action',async()=>{const r=await autoClick({decision:'malformed'});assert.equal(r.result.isError,true);assert.equal(state().clicks,r.before.clicks);assert.equal(approvalCount,r.before.asks);assert.equal(reviewRoutes.length,r.before.plugin);});
  await check('native Auto offline fails closed without fallback to full access',async()=>{const r=await autoClick({decision:'offline'});assert.equal(r.result.isError,true);assert.equal(state().clicks,r.before.clicks);assert.equal(approvalCount,r.before.asks);assert.equal(reviewRoutes.length,r.before.plugin);});
  await check('native Auto receives signed observed target facts in pending arguments and allows exact mouse plan',async()=>{const r=await autoClick({decision:'evidence',approval:'never',evidence:true});assert.equal(r.parsed?.ok,true,JSON.stringify(r.result));await until(()=>state().clicks===r.before.clicks+1);assert.equal(approvalCount,r.before.asks);assert.equal(reviewRoutes.length,r.before.plugin);});
  await check('native Auto missing-evidence denial remains final when human approval is disabled',async()=>{const r=await autoClick({decision:'evidence',approval:'never'});assert.equal(r.result.isError,true);assert.equal(state().clicks,r.before.clicks);assert.equal(approvalCount,r.before.asks);});
  await check('signed plan tampering cannot inject input even when deterministic Auto reviewer allows',async()=>{const r=await autoClick({decision:'evidence',approval:'never',evidence:true,tamper:true});assert.equal(r.parsed.ok,false);assert.equal(r.parsed.error.code,'TARGET_PLAN_CHANGED');assert.equal(state().clicks,r.before.clicks);});
  await check('manual same-request consent survives fresh observations and clears on permission changes',async()=>{
    setSandboxMode(session,'workspace-write');setApprovalPolicy(session,'ask');await command('mode user-approval');
    const bootstrap=ctx.webServer.collectIndexInjections().find(r=>r.name==='__DSH_CONTROL_GUI_V1__').value,endpoint=`http://127.0.0.1:${ctx.webServer.port}${bootstrap.endpoint}`;
    const post=async body=>(await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-dsh-control-token':bootstrap.token},body:JSON.stringify({sessionId:session.id,...body})})).json();
    const get=async()=>{const o=await call('control_desktop',{action:'observe',windowId:state().windowId});assert.equal(o.ok,true);return {action:'click',mode:'uia',observationId:o.data.observationId,elementId:o.data.elements.find(e=>e.name==='Fixture button').elementId};};
    const before=state().clicks,first=call('control_desktop',await get());let status;await until(async()=>{status=(await post({action:'status'})).data;return !!status.consent.pending;});
    assert.equal((await post({action:'consent',requestId:status.consent.pending.id,choice:'same'})).ok,true);assert.equal((await first).ok,true);await until(()=>state().clicks===before+1);
    const second=await call('control_desktop',await get());assert.equal(second.ok,true,JSON.stringify(second));await until(()=>state().clicks===before+2);assert.equal((await post({action:'status'})).data.consent.remembered.length,1);
    setSandboxMode(session,'danger-full-access');assert.equal((await post({action:'status'})).data.consent.remembered.length,0);await command('mode follow-session');setApprovalPolicy(session,'never');
  });
  await check('official DSH batch manual approval occurs once and exact fresh plans reuse consent',async()=>{
    setSandboxMode(session,'danger-full-access');setApprovalPolicy(session,'ask');await command('mode user-approval');
    const bootstrap=ctx.webServer.collectIndexInjections().find(r=>r.name==='__DSH_CONTROL_GUI_V1__').value,endpoint=`http://127.0.0.1:${ctx.webServer.port}${bootstrap.endpoint}`;
    const post=async body=>(await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-dsh-control-token':bootstrap.token},body:JSON.stringify({sessionId:session.id,...body})})).json();
    const prepare=async()=>{const o=await call('control_desktop',{action:'observe',windowId:state().windowId});assert.equal(o.ok,true,JSON.stringify(o));const plan=await call('control_desktop',{action:'prepare-batch',steps:['Fixture input','Fixture second input'].map((name,i)=>({action:'type',mode:'uia',observationId:o.data.observationId,elementId:o.data.elements.find(e=>e.name===name).elementId,text:'host batch '+i}))});assert.equal(plan.ok,true,JSON.stringify(plan));return plan.data.batch;};
    const first=call('control_desktop',await prepare());let status;await until(async()=>{status=(await post({action:'status'})).data;return !!status.consent.pending;});assert.match(status.consent.pending.summary,/批量/);assert.equal((await post({action:'consent',requestId:status.consent.pending.id,choice:'same'})).ok,true);const done=await first;assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.data.completed.length,2);
    const second=await call('control_desktop',await prepare());assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.data.completed.length,2);assert.equal((await post({action:'status'})).data.consent.pending,null);await until(()=>state().secondText==='host batch 1');await command('mode follow-session');setApprovalPolicy(session,'never');
  });
  await check('official DSH batch model rejection prevents all effects',async()=>{
    await command('mode model-review');allow=false;const o=await call('control_desktop',{action:'observe',windowId:state().windowId}),plan=await call('control_desktop',{action:'prepare-batch',steps:[{action:'type',mode:'uia',observationId:o.data.observationId,elementId:o.data.elements.find(e=>e.name==='Fixture second input').elementId,text:'forbidden model batch'}]});assert.equal(plan.ok,true,JSON.stringify(plan));const before=state().secondText,rejected=await call('control_desktop',plan.data.batch);assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'MODEL_REJECTED');assert.equal(state().secondText,before);allow=true;await command('mode follow-session');
  });
  await check('native Auto Review reviews the whole batch once and deny remains final',async()=>{
    for(const decision of ['allow','deny']){
      autoDecision=decision;const s=ctx.sessions.create('auto-batch-'+(++callSerial),{meta:{cwd:resolve(temp)}}),a={...agent,id:s.id,session:s},signal=new AbortController().signal;ctx.permissionPresets.set(s,'auto');setApprovalPolicy(s,'never');s.append('turn/start',{turn:1});s.append('user/message',createUserMessage({source:{kind:'user',rpcId:'batch-auto-test'},content:[{type:'text',text:'仅在测试窗口输入两栏测试文字，不操作其他应用。'}]}),{surfaceOp:'append'});s.append('request/header',{reason:'initial',header:{config:{provider:'auto-work-provider',model:'auto-work-model'},tools:ctx.tools.schemas(a)}});
      const tool=ctx.tools.get('control_desktop'),o=await tool.execute({action:'observe',windowId:state().windowId},{agent:a,signal});assert.equal(o.ok,true,JSON.stringify(o));const p=await tool.execute({action:'prepare-batch',steps:['Fixture input','Fixture second input'].map((name,i)=>({action:'type',mode:'uia',observationId:o.data.observationId,elementId:o.data.elements.find(e=>e.name===name).elementId,text:'native batch '+decision+' '+i}))},{agent:a,signal});assert.equal(p.ok,true,JSON.stringify(p));const args=p.data.batch,id='auto-batch-call-'+callSerial;s.append('step/start',{turn:1,step:1});s.append('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'tool-call',id,name:'control_desktop',arguments:JSON.stringify(args)}]}},{surfaceOp:'append'});s.append('tool/call',{turn:1,step:1,callId:id,name:'control_desktop',arguments:JSON.stringify(args)});
      const before={auto:autoRoutes.length,review:reviewRoutes.length,text:state().secondText,asks:approvalCount},result=await ctx.tools.execute({name:'control_desktop',arguments:args,agent:a,signal,callId:id});assert.equal(autoRoutes.length,before.auto+1);assert.equal(reviewRoutes.length,before.review);assert.equal(approvalCount,before.asks);
      if(decision==='deny'){assert.equal(result.isError,true);assert.equal(state().secondText,before.text);}else{const done=JSON.parse(result.content[0].text);assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.data.completed.length,2);await until(()=>state().secondText==='native batch allow 1');}s.append('turn/end',{turn:1,reason:{kind:'completed'}});
    }
  });
  await check('official DSH output contract preserves partial batch receipts without replay',async()=>{
    const file=statePath+'.command';writeFileSync(file,JSON.stringify({action:'activate'}));await until(()=>!existsSync(file));writeFileSync(file,JSON.stringify({action:'arm-move-second'}));await until(()=>!existsSync(file));
    const o=await call('control_desktop',{action:'observe',windowId:state().windowId}),p=await call('control_desktop',{action:'prepare-batch',steps:[{action:'click',mode:'mouse',observationId:o.data.observationId,elementId:o.data.elements.find(e=>e.name==='Fixture button').elementId},{action:'type',mode:'uia',observationId:o.data.observationId,elementId:o.data.elements.find(e=>e.name==='Fixture second input').elementId,text:'forbidden partial'}]});assert.equal(p.ok,true,JSON.stringify(p));const result=await call('control_desktop',p.data.batch);assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.error.code,'BATCH_TARGET_CHANGED');assert.equal(result.data.completed.length,1);assert.equal(result.data.replayAllowed,false);assert.notEqual(state().secondText,'forbidden partial');
    writeFileSync(file,JSON.stringify({action:'reset-second'}));await until(()=>!existsSync(file));
  });
  await check('official regional desktop and browser mapping outputs cross lossless JSON boundary',async()=>{const o=await call('control_desktop',{action:'observe',windowId:state().windowId}),r=o.data.rect,shot=await call('control_desktop',{action:'screenshot',windowId:state().windowId,region:{x:Math.floor(r.x+10),y:Math.floor(r.y+10),width:240,height:120},maxWidth:160});assert.equal(shot.ok,true,JSON.stringify(shot));const p=await call('control_desktop',{action:'map-point',observationId:shot.data.observationId,x:20,y:10});assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.data.point.x,Math.floor(r.x+10)+30);const opened=await call('control_browser',{action:'open',url:`http://127.0.0.1:${server.address().port}/`});assert.equal(opened.ok,true,JSON.stringify(opened));const browser=await call('control_browser',{action:'screenshot',region:{x:0,y:0,width:320,height:160},maxWidth:160});assert.equal(browser.ok,true,JSON.stringify(browser));const bp=await call('control_browser',{action:'map-point',observationId:browser.data.observationId,x:20,y:10});assert.equal(bp.ok,true,JSON.stringify(bp));assert.deepEqual(bp.data.point,{x:40,y:20});});
  await check('official tool schemas expose new waits, batch plans, crop mapping and paths',async()=>{for(const name of ['control_desktop','control_browser']){const schema=ctx.tools.get(name).parameters;assert.ok(schema.properties.action.enum.includes('batch'));const json=JSON.stringify(ctx.tools.schemas(agent));for(const term of ['prepare-batch','map-point','strokes','condition','maxWidth'])assert.ok(json.includes(term),term);} });
  await check('official workspace browser approval grants scoped browsing once without desktop HUD',async()=>{
    setSandboxMode(session,'workspace-write');setApprovalPolicy(session,'ask');hostApproval='allowed-once';await command('mode follow-session');const count=approvalCount,root=`http://127.0.0.1:${server.address().port}`;
    const opened=await call('control_browser',{action:'open',url:root+'/scope'});assert.equal(opened.ok,true,JSON.stringify(opened));assert.equal(approvalCount,count+1);const next=await call('control_browser',{action:'navigate',observationId:opened.data.postObservation.observationId,url:root+'/scope-next'});assert.equal(next.ok,true,JSON.stringify(next));const selected=await call('control_browser',{action:'select-tab',tabId:opened.data.tabId});assert.equal(selected.ok,true,JSON.stringify(selected));assert.equal(approvalCount,count+1);
    const status=await call('control_status',{});assert.equal(status.data.presence.kind,'browser');assert.equal(status.data.presence.native,null);assert.equal(status.data.browserGroup.tabs,2);assert.ok(status.data.browserGroup.nativeGroupId);assert.equal(status.data.browserSites.length,1);setSandboxMode(session,'danger-full-access');setApprovalPolicy(session,'never');assert.equal((await call('control_status',{})).data.browserSites.length,0);
  });
  await check('native Auto keeps reviewing browser group operations and denies without cached override',async()=>{
    autoDecision='allow';const s=ctx.sessions.create('auto-browser-'+(++callSerial),{meta:{cwd:resolve(temp)}}),a={...agent,id:s.id,session:s},signal=new AbortController().signal;ctx.permissionPresets.set(s,'auto');setApprovalPolicy(s,'never');s.append('turn/start',{turn:1});s.append('user/message',createUserMessage({source:{kind:'user',rpcId:'auto-browser-test'},content:[{type:'text',text:'只在本地测试网页验证导航与审批，禁止其他网站操作。'}]}),{surfaceOp:'append'});s.append('request/header',{reason:'initial',header:{config:{provider:'auto-work-provider',model:'auto-work-model'},tools:ctx.tools.schemas(a)}});
    const run=async(args,step)=>{const id='auto-browser-call-'+(++callSerial);s.append('step/start',{turn:1,step});s.append('assistant/message',{turn:1,step,message:{role:'assistant',content:[{type:'tool-call',id,name:'control_browser',arguments:JSON.stringify(args)}]}},{surfaceOp:'append'});s.append('tool/call',{turn:1,step,callId:id,name:'control_browser',arguments:JSON.stringify(args)});return await ctx.tools.execute({name:'control_browser',arguments:args,agent:a,signal,callId:id});};
    const before=autoRoutes.length,first=await run({action:'open',url:`http://127.0.0.1:${server.address().port}/auto-browser`},1),opened=JSON.parse(first.content[0].text);assert.equal(opened.ok,true,JSON.stringify(opened));autoDecision='deny';const denied=await run({action:'navigate',observationId:opened.data.postObservation.observationId,url:`http://127.0.0.1:${server.address().port}/forbidden-auto`},2);assert.equal(denied.isError,true);assert.equal(autoRoutes.length,before+2);assert.match(JSON.stringify(denied),/AUTO_REVIEW_DENIED/);s.append('turn/end',{turn:1,reason:{kind:'completed'}});
  });
  await check('native Auto reviews one direct sequence once and denial blocks the whole sequence',async()=>{
    for(const decision of ['allow','deny']){
      autoDecision=decision;const s=ctx.sessions.create('auto-sequence-'+(++callSerial),{meta:{cwd:resolve(temp)}}),a={...agent,id:s.id,session:s},signal=new AbortController().signal;ctx.permissionPresets.set(s,'auto');setApprovalPolicy(s,'never');s.append('turn/start',{turn:1});s.append('user/message',createUserMessage({source:{kind:'user',rpcId:'sequence-auto-test'},content:[{type:'text',text:'Only type hello and send once in the local test page.'}]}),{surfaceOp:'append'});s.append('request/header',{reason:'initial',header:{config:{provider:'auto-work-provider',model:'auto-work-model'},tools:ctx.tools.schemas(a)}});
      const tool=ctx.tools.get('control_browser'),opened=await tool.execute({action:'open',url:`http://127.0.0.1:${server.address().port}/sequence`},{agent:a,signal}),o=opened.data.postObservation,args={action:'sequence',observationId:o.observationId,mode:'dom',steps:[{action:'type',elementId:o.elements.find(e=>e.name==='Message').elementId,text:'hello'},{action:'click',elementId:o.elements.find(e=>e.name==='Send').elementId}]},id='sequence-'+callSerial;
      s.append('step/start',{turn:1,step:1});s.append('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'tool-call',id,name:'control_browser',arguments:JSON.stringify(args)}]}},{surfaceOp:'append'});s.append('tool/call',{turn:1,step:1,callId:id,name:'control_browser',arguments:JSON.stringify(args)});
      const before=autoRoutes.length,result=await ctx.tools.execute({name:'control_browser',arguments:args,agent:a,signal,callId:id});assert.equal(autoRoutes.length,before+1);if(decision==='allow'){const done=JSON.parse(result.content[0].text);assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.data.completed.length,2);assert.ok(done.data.postObservation.text.includes('message delivered'));}else assert.equal(result.isError,true);
      s.append('turn/end',{turn:1,reason:{kind:'completed'}});
    }
  });
  await check('official session lineage permits handoff and return while excluding the former owner',async()=>{
    ctx.permissionPresets.set(session,'danger-full-access');setApprovalPolicy(session,'never');
    const child=ctx.sessions.create('handoff-child-'+(++callSerial),{meta:{cwd:resolve(temp),origin:'subagent',parentSession:session.id}}),childAgent={...agent,id:child.id,session:child};ctx.permissionPresets.set(child,'danger-full-access');setApprovalPolicy(child,'never');
    const opened=await call('control_browser',{action:'open',url:`http://127.0.0.1:${server.address().port}/`}),o=opened.data.postObservation;
    const handoff=await call('control_browser',{action:'handoff',tabId:opened.data.tabId,observationId:o.observationId,targetSessionId:child.id});assert.equal(handoff.ok,true,JSON.stringify(handoff));
    const denied=await call('control_browser',{action:'observe',tabId:opened.data.tabId});assert.equal(denied.error.code,'TAB_NOT_OWNED');
    const tool=ctx.tools.get('control_browser'),observed=await tool.execute({action:'observe',tabId:opened.data.tabId},{agent:childAgent,signal});assert.equal(observed.ok,true,JSON.stringify(observed));
    const returned=await tool.execute({action:'return-tab',tabId:opened.data.tabId,loanId:handoff.data.loanId},{agent:childAgent,signal});assert.equal(returned.ok,true,JSON.stringify(returned));assert.equal((await call('control_browser',{action:'observe',tabId:opened.data.tabId})).ok,true);
  });
  await check('plugin unload removes tools and command cleanly', async () => { await ctx.fiber.dispose(); assert.equal(ctx.get('tools'), undefined); ctx = null; });
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; console.error(error); process.exitCode = 1; }
finally { if (ctx) await ctx.fiber.dispose(); if (existsSync(statePath)) { writeFileSync(statePath + '.command', '{"action":"close"}'); await sleep(200); } fixture.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.finishedAt = new Date().toISOString(); writeFileSync(join(evidence, 'dsh-report.json'), JSON.stringify(report, null, 2)); }
