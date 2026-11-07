import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {Native} from '../lib/native.js';
import {ControlRuntime} from '../index.js';

const report = {startedAt: new Date().toISOString(), checks: []};
const outputDir = resolve(fileURLToPath(new URL('../../test-evidence', import.meta.url)));
mkdirSync(outputDir, {recursive: true});
const temp = mkdtempSync(join(tmpdir(), 'dsh-control-live-')), statePath = join(temp, 'fixture-state.json');
const fixture = spawn(`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('fixture.ps1', import.meta.url)), '-StatePath', statePath], {windowsHide: true});
let fixtureError = ''; fixture.stderr.on('data', b => fixtureError += b);
function state() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } }
async function until(predicate, label, timeout = 6000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await predicate()) return; await sleep(50); } throw new Error(`${label}: timed out ${fixtureError}, current state: ${JSON.stringify(state())}`); }
async function fixtureCommand(action, extra = {}) { const file = statePath + '.command'; await until(() => !existsSync(file), 'fixture command queue'); writeFileSync(file, JSON.stringify({action, ...extra})); await until(() => !existsSync(file), action); await sleep(action === 'escape' ? 350 : 120); }
async function check(label, fn) { await fn(); report.checks.push({label, result: 'pass'}); console.log(`PASS ${label}`); }
const session = {id: 'live-fixture-session', header: {origin: 'web'}, requestHeader: () => ({config: {provider: 'test', model: 'test'}})};
const exec = {name: 'control_desktop', callId: 'live-test', agent: {id: session.id, session}, signal: new AbortController().signal};
const services = {sandboxPolicy: {resolve: () => ({mode: 'danger-full-access'})}, permissionPresets: {current: () => 'danger-full-access'}, approval: {effectivePolicy: () => 'never'}};
const runtime = new ControlRuntime({get: name => services[name]}, {stateDir: join(temp, 'state'), preserveBrowserOnExit:false,browserProfileDir: join(temp, 'browser'), indicatorIdleMs: 1000});
const server = createServer((req, res) => {
  if (req.url === '/slow') { res.setTimeout(15000); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>DSH Browser Test Fixture</title><style>body{font:20px sans-serif;margin:60px}button,input{font:20px sans-serif;padding:12px;margin:8px}#drag{width:80px;height:80px;background:#1476ed;color:white;touch-action:none}#scroll{width:450px;height:150px;overflow:auto;border:1px solid #888;margin:15px}#inside{height:1800px;background:linear-gradient(white,#aaa)}</style></head><body><h1>DSH 浏览器实机测试</h1><button id="button">Fixture button</button><input aria-label="Fixture input" id="input"><p id="result">Clicks: 0</p><div id="drag" role="button">Drag</div><div id="scroll" role="region" aria-label="Fixture scroll"><div id="inside">Scroll test</div></div><script>window.clicks=0;window.trusted=0;window.doubles=0;window.rights=0;window.moves=0;window.dragged=0;button.onclick=e=>{clicks++;trusted+=e.isTrusted?1:0;result.textContent='Clicks: '+clicks};button.ondblclick=()=>doubles++;button.oncontextmenu=e=>{e.preventDefault();rights++};button.onmousemove=()=>moves++;drag.onpointerdown=e=>{drag.setPointerCapture(e.pointerId)};drag.onpointermove=e=>{if(e.buttons)dragged++};</script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let observed;
try {
  await until(() => state().windowId, 'fixture launch');
  const hwnd = state().windowId;
  await check('Windows window inventory contains real fixture', async () => { const r = await runtime.call('desktop', {action: 'windows'}, exec); assert.ok(r.windows.some(w => w.windowId === hwnd), JSON.stringify({state: state(), fixturePid: fixture.pid, windows: r.windows.filter(w => w.title.includes('DSH Control'))})); });
  await check('GUI wait observes an existing window and absent-window timeout with fresh screen evidence',async()=>{
    const title=(await runtime.call('desktop',{action:'windows'},exec)).windows.find(w=>w.windowId===hwnd).title,before=await runtime.native.call('ping');
    const ready=await runtime.call('desktop',{action:'wait',query:title,waitMs:200},exec);assert.equal(ready.wait.matched,true);assert.equal(ready.scope,'screen');assert.ok(ready.pngBase64);
    const absent=await runtime.call('desktop',{action:'wait',query:'DSH Nonexistent Fixture '+Date.now(),waitMs:200},exec);assert.equal(absent.wait.timedOut,true);assert.ok(absent.wait.elapsedMs>=200);assert.notEqual(absent.observationId,ready.observationId);
    const after=await runtime.native.call('ping');assert.equal(after.lease,false);assert.deepEqual(after.cursor,before.cursor);assert.equal(after.foreground,before.foreground);
  });
  await check('UI Automation observes Button and Edit capabilities', async () => { observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec); assert.ok(observed.elements.find(e => e.name === 'Fixture button').patterns.includes('invoke')); assert.ok(observed.elements.find(e => e.name === 'Fixture input').patterns.includes('value')); });
  await fixtureCommand('cover');
  await check('background UIA clicks fully covered window without moving mouse or stealing focus', async () => {
    const before = await runtime.native.call('ping');
    const receipt = await runtime.call('desktop', {action: 'click', mode: 'uia', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId}, exec);
    await until(() => state().clicks === 1, 'UIA click');
    const after = await runtime.native.call('ping'); assert.deepEqual(after.cursor, before.cursor); assert.equal(after.foreground, before.foreground, JSON.stringify({state: state(), before, after, diagnostic: receipt.focusDiagnostic}));
  });
  await check('background Unicode text input does not require foreground', async () => {
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    await runtime.call('desktop', {action: 'type', mode: 'uia', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture input').elementId, text: '后台输入 DSH ✓ 中文'}, exec);
    await until(() => state().text === '后台输入 DSH ✓ 中文', 'UIA text');
  });
  await check('physical mouse rejects topmost occlusion', async () => {
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    await assert.rejects(runtime.call('desktop', {action: 'click', mode: 'mouse', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId}, exec), error => ['TARGET_OCCLUDED', 'FOCUS_DENIED'].includes(error.code));
    assert.equal(state().clicks, 1);
  });
  await fixtureCommand('uncover');
  await check('real SendInput mouse clicks correct application', async () => {
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    await runtime.call('desktop', {action: 'click', mode: 'mouse', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId}, exec);
    await until(() => state().clicks === 2, 'physical click');
  });
  await check('real keyboard Unicode input and Ctrl+A replace', async () => {
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    await runtime.call('desktop', {action: 'type', mode: 'mouse', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture input').elementId, replace: true, text: '鼠标输入 DSH ✓'}, exec);
    await until(() => state().text === '鼠标输入 DSH ✓', 'physical type, observed: ' + JSON.stringify(state()));
  });
  await check('desktop hover and drag move the real system pointer and deliver button events', async () => {
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    const drag = observed.elements.find(e => e.name === 'Fixture drag');
    await runtime.call('desktop', {action: 'hover', mode: 'mouse', observationId: observed.observationId, elementId: drag.elementId}, exec);
    const cursor = (await runtime.native.call('ping')).cursor;
    assert.ok(Math.abs(cursor.x - (drag.rect.x + drag.rect.width / 2)) <= 2);
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    await runtime.call('desktop', {action: 'drag', mode: 'mouse', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture drag').elementId, endX: cursor.x + 110, endY: cursor.y + 20}, exec);
    await until(() => state().drags > 0, 'desktop drag');
  });
  await check('desktop scroll delivers wheel input to the target control', async () => {
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    const scroll = observed.elements.find(e => e.name === 'Fixture scroll');
    // Focus the read-only fixture edit so legacy Windows wheel routing is explicit.
    await runtime.call('desktop', {action: 'click', mode: 'mouse', observationId: observed.observationId, elementId: scroll.elementId}, exec);
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    await runtime.call('desktop', {action: 'scroll', mode: 'mouse', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture scroll').elementId, deltaY: 240}, exec);
    await until(() => state().firstVisibleLine > 0, 'desktop wheel scroll result');
    assert.equal(state().nativeWheel, -240);
    assert.equal(state().wheelTarget, state().scrollHandle);
  });
  await check('physical input rejects an overlapping control inside the same application', async () => {
    await fixtureCommand('cover-element');
    try {
      observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
      await assert.rejects(runtime.call('desktop', {action: 'scroll', mode: 'mouse', observationId: observed.observationId, elementId: observed.elements.find(e => e.name === 'Fixture scroll').elementId, deltaY: 240}, exec), {code: 'TARGET_OCCLUDED'});
      assert.equal(state().nativeWheel, -240);
    } finally { await fixtureCommand('uncover-element'); }
  });
  await check('cancelling desktop drag releases the injected mouse button', async () => {
    observed = await runtime.call('desktop', {action: 'observe', windowId: hwnd}, exec);
    const drag=observed.elements.find(e => e.name === 'Fixture drag'), previous=state().drags, controller=new AbortController();
    const promise=runtime.call('desktop', {action:'drag', mode:'mouse', observationId:observed.observationId, elementId:drag.elementId, endX:Math.round(drag.rect.x+drag.rect.width-10), endY:Math.round(drag.rect.y+drag.rect.height/2)}, {...exec,signal:controller.signal});
    void promise.catch(() => {});
    await until(() => state().drags>previous, 'in-flight desktop drag'); controller.abort();
    await assert.rejects(promise, {code:'CANCELLED'});
    await until(() => state().capture === false, 'mouse button released');
    assert.equal(runtime.coordinator.status.owner,null); await sleep(350);
    await assert.rejects(runtime.call('desktop',{action:'windows'},exec),{code:'CONTROL_STOPPED'});
    await runtime.command(exec.agent,'resume');
  });
  await check('background PrintWindow screenshot contains PNG and correct coordinate mapping', async () => {
    const shot = await runtime.call('desktop', {action: 'screenshot', windowId: hwnd}, exec);
    const b = Buffer.from(shot.pngBase64, 'base64'); assert.equal(b.subarray(1,4).toString(), 'PNG'); assert.equal(shot.width, shot.rect.width); writeFileSync(join(outputDir, 'desktop-fixture.png'), b);
  });
  await check('cross-process mutex rejects simultaneous controllers and releases on finish', async () => {
    await runtime.presence.finish(session.id);
    const other = new Native();
    try { await runtime.native.call('begin', {owner: 'a', kind: 'mouse'}); await assert.rejects(other.call('begin', {owner: 'b'}), {code: 'CONTROL_BUSY'}); assert.equal((await runtime.native.call('ping')).indicatorVisible, true); const shot=await runtime.native.call('visual-screenshot');writeFileSync(join(outputDir,'desktop-indicator.png'),Buffer.from(shot.pngBase64,'base64')); await runtime.native.call('end', {idleMs: 0}); await other.call('begin', {owner: 'b'}); await other.call('end', {idleMs: 0}); }
    finally { await other.dispose(); }
  });
  await check('Esc hides native banner and rejects continued input', async () => {
    let escaped = false; const old = runtime.native.onEscape; runtime.native.onEscape = () => { escaped = true; };
    try { await runtime.native.call('begin', {owner: 'escape-test'}); await fixtureCommand('escape'); await until(() => escaped, 'escape'); assert.equal((await runtime.native.call('ping')).indicatorVisible, false); await assert.rejects(runtime.native.call('click', {nativeObservation: observed.nativeObservation, elementId: observed.elements.find(e => e.name === 'Fixture button').elementId, mode: 'uia'}), {code: 'CANCELLED'}); await runtime.native.call('end', {idleMs: 0}); }
    finally { runtime.native.onEscape = old; }
  });
  await check('window inventory includes real untitled taskbar and its class', async () => {
    const r=await runtime.call('desktop',{action:'windows'},exec);
    assert.ok(r.windows.some(w=>w.kind==='taskbar'&&w.className==='Shell_TrayWnd'));
  });
  await check('screen and screenshot without windowId capture visible full desktop including taskbar', async () => {
    for(const action of ['screen','screenshot']) {
      const shot=await runtime.call('desktop',{action},exec),png=Buffer.from(shot.pngBase64,'base64');
      assert.equal(shot.scope,'screen');assert.equal(shot.capture,'visible-screen');assert.equal(png.readUInt32BE(16),shot.rect.width);
      const tray=shot.windows.find(w=>w.kind==='taskbar');assert.ok(tray);assert.ok(tray.rect.y+tray.rect.height<=shot.rect.y+shot.height);
      assert.ok(shot.windows.some(w=>w.windowId===hwnd));
    } // Do not save the user's whole desktop into test evidence.
  });
  await check('restore operation restores minimized window and returns a fresh usable observation', async () => {
    await fixtureCommand('minimize');await until(()=>state().minimized,'fixture minimized');
    const before=await runtime.call('desktop',{action:'observe',windowId:hwnd},exec);assert.equal(before.minimized,true);
    const result=await runtime.call('desktop',{action:'restore',mode:'mouse',observationId:before.observationId},exec);
    assert.equal(result.restored,true);assert.equal(result.activated,false);assert.equal(result.postObservation.minimized,false);
    assert.notEqual(result.postObservation.observationId,before.observationId);
    await assert.rejects(runtime.call('desktop',{action:'hover',mode:'mouse',observationId:before.observationId,x:200,y:250},exec),{code:'INVALID_OBSERVATION'});
  });
  await check('activate automatically restores minimized application, then physical click uses postObservation', async () => {
    await fixtureCommand('minimize');await until(()=>state().minimized,'fixture re-minimized');
    const before=await runtime.call('desktop',{action:'observe',windowId:hwnd},exec),clicks=state().clicks;
    const result=await runtime.call('desktop',{action:'activate',mode:'mouse',observationId:before.observationId},exec);
    assert.equal(result.restored,true);assert.equal(result.postObservation.foreground,true);
    await runtime.call('desktop',{action:'click',mode:'mouse',observationId:result.postObservation.observationId,elementId:result.postObservation.elements.find(e=>e.name==='Fixture button').elementId},exec);
    await until(()=>state().clicks===clicks+1,'click immediately after restore');
  });
  await check('screen mouse directly clicks background window with no title or caption', async () => {
    await fixtureCommand('borderless');
    const shot=await runtime.call('desktop',{action:'screen'},exec),w=shot.windows.find(w=>w.windowId===state().borderId);
    assert.ok(w);assert.equal(w.title,'');assert.equal(w.foreground,false);
    const result=await runtime.call('desktop',{action:'click',mode:'mouse',observationId:shot.observationId,windowId:w.windowId,x:w.rect.x+100,y:w.rect.y+60},exec);
    await until(()=>state().borderClicks===1,'borderless real mouse click');assert.equal(result.postObservation.scope,'screen');
  });
  await check('screen rejects wrong target carrier and foreground occlusion without side effects', async () => {
    const shot=await runtime.call('desktop',{action:'screen'},exec),w=shot.windows.find(w=>w.windowId===state().borderId),clicks=state().borderClicks;
    await assert.rejects(runtime.call('desktop',{action:'click',mode:'mouse',observationId:shot.observationId,windowId:hwnd,x:w.rect.x+100,y:w.rect.y+60},exec),{code:'OUT_OF_WINDOW'});
    await fixtureCommand('cover');
    const blocked=await runtime.call('desktop',{action:'screen'},exec),target=blocked.windows.find(w=>w.windowId===hwnd);
    await assert.rejects(runtime.call('desktop',{action:'click',mode:'mouse',observationId:blocked.observationId,windowId:hwnd,x:target.rect.x+100,y:target.rect.y+130},exec),{code:'TARGET_OCCLUDED'});
    assert.equal(state().borderClicks,clicks);await fixtureCommand('uncover');
  });
  await check('screen rejects stale moved target before physical delivery', async () => {
    const shot=await runtime.call('desktop',{action:'screen'},exec),w=shot.windows.find(w=>w.windowId===state().borderId);
    await fixtureCommand('border-move');
    await assert.rejects(runtime.call('desktop',{action:'click',mode:'mouse',observationId:shot.observationId,windowId:w.windowId,x:w.rect.x+100,y:w.rect.y+60},exec),{code:'WINDOW_MOVED'});
    assert.equal(state().borderClicks,1);await fixtureCommand('border-hide');
  });
  await check('screen keyboard rejects borrowing a nonforeground window', async () => {
    await fixtureCommand('background');const shot=await runtime.call('desktop',{action:'screen'},exec);
    await assert.rejects(runtime.call('desktop',{action:'key',mode:'mouse',observationId:shot.observationId,windowId:hwnd,key:'Control+A'},exec),{code:'FOCUS_CHANGED'});
  });
  await check('real taskbar pointer hover works without title-bar focus verification', async () => {
    const shot=await runtime.call('desktop',{action:'screen'},exec),w=shot.windows.find(w=>w.className==='Shell_TrayWnd');
    const x=w.rect.x+2,y=w.rect.y+Math.floor(w.rect.height/2);
    await runtime.call('desktop',{action:'hover',mode:'mouse',observationId:shot.observationId,windowId:w.windowId,x,y},exec);
    const pointer=(await runtime.native.call('ping')).cursor;assert.ok(Math.abs(pointer.x-x)<=2&&Math.abs(pointer.y-y)<=2);
  });
  await check('real taskbar mouse right click opens its GUI menu, then Esc closes it', async () => {
    const shot=await runtime.call('desktop',{action:'screen'},exec),tray=shot.windows.find(w=>w.className==='Shell_TrayWnd'),known=new Set(shot.windows.map(w=>w.windowId));
    try {
      await runtime.call('desktop',{action:'click',mode:'mouse',observationId:shot.observationId,windowId:tray.windowId,x:tray.rect.x+10,y:tray.rect.y+Math.floor(tray.rect.height/2),button:'right'},exec);
      await until(async()=>{const r=await runtime.call('desktop',{action:'windows'},exec);return r.windows.some(w=>!known.has(w.windowId)&&/32768|Xaml|CoreWindow|Popup/i.test(w.className));},'taskbar GUI menu visible');
    } finally {await fixtureCommand('escape');await runtime.command(exec.agent,'resume');}
  });
  await check('first screen read starts animated continuous indicator without moving cursor or acquiring lease',async()=>{
    const before=await runtime.native.call('ping');await runtime.call('desktop',{action:'screen'},exec);
    const first=await runtime.native.call('ping');assert.equal(first.indicatorVisible,true);assert.equal(first.phase,'thinking');assert.equal(first.lease,false);assert.equal(first.haloVisible,false);assert.ok(first.edgeCount>=4);assert.equal(first.captureExcluded,false);assert.equal(first.takeoverHooks,true);assert.deepEqual(first.cursor,before.cursor);assert.equal(first.foreground,before.foreground);
    const frames=[];for(let i=0;i<12;i++){const shot=await runtime.native.call('visual-screenshot');frames.push(shot.frame);writeFileSync(join(outputDir,`animation-frame-${i}.png`),Buffer.from(shot.pngBase64,'base64'));await sleep(100);}
    assert.ok(new Set(frames).size>1);await sleep(1100);assert.equal((await runtime.native.call('ping')).indicatorVisible,true);
  });
  await check('actual desktop compositor displays the top HUD after changing foreground windows',async()=>{
    await fixtureCommand('activate');await sleep(400);
    const before=await runtime.native.call('ping'),proof=await runtime.native.call('visual-desktop-proof');
    assert.equal(proof.affinity,0);assert.equal(proof.remoteVisible,true);assert.equal(proof.compositorVerified,true,JSON.stringify({darkSamples:proof.darkSamples,rect:before.indicatorRect}));writeFileSync(join(outputDir,'desktop-compositor-hud.png'),Buffer.from(proof.pngBase64,'base64'));
    const after=await runtime.native.call('ping');assert.equal(after.foreground,before.foreground);assert.deepEqual(after.cursor,before.cursor);assert.equal(after.captureExcluded,false);
  });
  await check('ordinary recorder can capture HUD while own screenshots briefly omit it and restore it',async()=>{
    const before=await runtime.native.call('ping'),proof=await runtime.native.call('capture-policy-proof');assert.equal(proof.remoteVisibleBefore,true);assert.equal(proof.remoteVisibleAfter,true);assert.equal(proof.ownCaptureOmittedHUD,true,JSON.stringify(proof));assert.equal(proof.captureSuspended,false);const after=await runtime.native.call('ping');assert.equal(after.remoteVisible,true);assert.equal(after.captureExcluded,false);assert.equal(after.lease,false);assert.equal(after.foreground,before.foreground);assert.deepEqual(after.cursor,before.cursor);writeFileSync(join(outputDir,'remote-capture-policy.json'),JSON.stringify(proof,null,2));
  });
  await check('recoverable occlusion keeps an amber top HUD during model recovery',async()=>{
    await fixtureCommand('cover');try{const obs=await runtime.call('desktop',{action:'observe',windowId:hwnd},exec);await assert.rejects(runtime.call('desktop',{action:'click',mode:'mouse',observationId:obs.observationId,elementId:obs.elements.find(e=>e.name==='Fixture button').elementId},exec),error=>['TARGET_OCCLUDED','FOCUS_DENIED'].includes(error.code));
      const status=await runtime.native.call('ping');assert.equal(status.indicatorVisible,true);assert.equal(status.phase,'blocked');assert.equal(status.lease,false);await sleep(1100);assert.equal((await runtime.native.call('ping')).indicatorVisible,true);
    }finally{await fixtureCommand('uncover');}
  });
  await check('actual HUD remains above a competing topmost foreground window',async()=>{
    const rect=(await runtime.native.call('ping')).indicatorRect;await fixtureCommand('cover-at-hud',{x:rect.x,y:rect.y});
    try{await sleep(450);const proof=await runtime.native.call('visual-desktop-proof');assert.equal(proof.affinity,0);assert.equal(proof.remoteVisible,true);assert.equal(proof.compositorVerified,true,JSON.stringify({darkSamples:proof.darkSamples}));writeFileSync(join(outputDir,'desktop-topmost-hud.png'),Buffer.from(proof.pngBase64,'base64'));assert.equal((await runtime.native.call('ping')).lease,false);}finally{await fixtureCommand('uncover');}
  });
  await check('native stale show cannot reopen a finished segment',async()=>{
    await runtime.presence.finish(session.id);const before=await runtime.native.call('ping');
    const result=await runtime.native.call('visual',{owner:session.id,phase:'observe',generation:0});assert.equal(result.stale,true);assert.equal((await runtime.native.call('ping')).indicatorVisible,false);assert.deepEqual((await runtime.native.call('ping')).cursor,before.cursor);
    await runtime.call('desktop',{action:'windows'},exec);
  });
  await check('input lease releases between steps while presence remains, and mouse halo appears only during mouse phase',async()=>{
    const shot=await runtime.call('desktop',{action:'screen'},exec);await runtime.native.call('begin',{owner:session.id,kind:'mouse'});
    try{const state=await runtime.native.call('ping');assert.equal(state.haloVisible,true);assert.equal(state.phase,'mouse');const badge=await runtime.native.call('visual-screenshot');writeFileSync(join(outputDir,'desktop-mouse-indicator.png'),Buffer.from(badge.pngBase64,'base64'));}finally{await runtime.native.call('end',{idleMs:0});}
    const idle=await runtime.native.call('ping');assert.equal(idle.indicatorVisible,true);assert.equal(idle.haloVisible,false);assert.equal(idle.lease,false);assert.equal(shot.scope,'screen');
  });
  await check('native stop button works from observation, blocks next tool and explicit human resume restores access',async()=>{
    await runtime.call('desktop',{action:'observe',windowId:hwnd},exec);const status=await runtime.native.call('ping');
    await fixtureCommand('indicator-stop',{x:status.indicatorRect.x+465,y:status.indicatorRect.y+36});await until(()=>runtime.status(exec.agent).stopped,'native operator button stops segment');
    assert.equal((await runtime.native.call('ping')).indicatorVisible,false);await assert.rejects(runtime.call('desktop',{action:'screen'},exec),{code:'CONTROL_STOPPED'});
    await runtime.command(exec.agent,'resume');await runtime.call('desktop',{action:'windows'},exec);assert.equal((await runtime.native.call('ping')).indicatorVisible,true);
  });
  await check('Esc during observation gap hides all visuals and blocks automatic restart',async()=>{
    await runtime.call('desktop',{action:'screen'},exec);await fixtureCommand('escape');await until(()=>runtime.status(exec.agent).stopped,'Esc observation stop');
    const status=await runtime.native.call('ping');assert.equal(status.indicatorVisible,false);assert.equal(status.haloVisible,false);assert.equal(status.edgeCount,0);
    await assert.rejects(runtime.call('desktop',{action:'windows'},exec),{code:'CONTROL_STOPPED'});await runtime.command(exec.agent,'resume');
  });
  await check('native event classifier distinguishes physical takeover from AI-injected input',async()=>{
    const result=spawnSync(`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('native-input.ps1',import.meta.url))],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS native/);
  });
  await check('segment completion removes animation and restores an unobstructed desktop without changing cursor',async()=>{
    await runtime.call('desktop',{action:'windows'},exec);const before=await runtime.native.call('ping');await runtime.presence.finish(session.id);
    const after=await runtime.native.call('ping');assert.equal(after.indicatorVisible,false);assert.equal(after.edgeCount,0);assert.equal(after.haloVisible,false);assert.deepEqual(after.cursor,before.cursor);
  });
  await check('animated HUD body allows real mouse click through to the application underneath',async()=>{
    const hud=(await runtime.native.call('ping')).indicatorRect;await fixtureCommand('border-at-hud',{x:hud.x,y:hud.y});
    const shot=await runtime.call('desktop',{action:'screen'},exec),target=shot.windows.find(w=>w.windowId===state().borderId),before=state().borderClicks;
    try{await runtime.call('desktop',{action:'click',mode:'mouse',observationId:shot.observationId,windowId:target.windowId,x:target.rect.x+100,y:target.rect.y+60},exec);await until(()=>state().borderClicks===before+1,'click underneath animated HUD');}finally{await fixtureCommand('border-hide');}
  });
  await check('locate reads named real GUI control and signed plan delivers only a physical mouse click',async()=>{
    await fixtureCommand('activate');const found=await runtime.call('desktop',{action:'locate',windowId:hwnd,query:'Fixture button'},exec),before=state().clicks;
    const target=found.candidates.find(c=>c.name==='Fixture button');assert.ok(target);assert.equal(target.visibleAtPoint,true);assert.equal(target.click.targetEvidence.facts.name,'Fixture button');assert.equal(target.click.mode,'mouse');await runtime.call('desktop',target.click,exec);await until(()=>state().clicks===before+1,'named GUI mouse click');
  });
  await check('changed signed click plan is rejected before input is injected',async()=>{
    const found=await runtime.call('desktop',{action:'locate',windowId:hwnd,query:'Fixture button'},exec),target=found.candidates.find(c=>c.name==='Fixture button'),before=state().clicks;
    await assert.rejects(runtime.call('desktop',{...target.click,count:2},exec),{code:'TARGET_PLAN_CHANGED'});assert.equal(state().clicks,before);
  });
  await check('prepare reads actual point target and clicking fresh exact evidence succeeds',async()=>{
    const observed=await runtime.call('desktop',{action:'observe',windowId:hwnd},exec),target=observed.elements.find(e=>e.name==='Fixture button'),before=state().clicks;
    const prepared=await runtime.call('desktop',{action:'prepare',observationId:observed.observationId,windowId:hwnd,x:Math.round(target.rect.x+target.rect.width/2),y:Math.round(target.rect.y+target.rect.height/2)},exec);
    assert.equal(prepared.target.name,'Fixture button');assert.equal(prepared.click.targetEvidence.facts.name,'Fixture button');await runtime.call('desktop',prepared.click,exec);await until(()=>state().clicks===before+1,'prepared physical click');
  });
  await check('perform executes stored plan with a single request id, without copied signature fields',async()=>{const found=await runtime.call('desktop',{action:'locate',windowId:hwnd,query:'Fixture button'},exec),target=found.candidates.find(c=>c.name==='Fixture button'),before=state().clicks;await runtime.call('desktop',target.perform,exec);await until(()=>state().clicks===before+1,'perform exact plan');});
  await check('floating top consent allows same request once and clears without touching other apps',async()=>{
    const old=runtime.consents.describe;runtime.consents.describe=()=>({key:{target:'fixture-only',action:'click',count:1},summary:'测试请求：同目标单击（不会点击其他应用）'});
    try{await runtime.presence.start(session.id,'approval');const request={agent:exec.agent,toolName:'control_desktop',callId:'floating-consent-test',signal:new AbortController().signal},pending=runtime.consents.request(request,async()=>{throw new Error('unexpected fallback');});void pending.catch(()=>{});
      await until(async()=>!!(await runtime.native.call('ping')).consentVisible,'native approval popup');const status=await runtime.native.call('ping');assert.ok(status.indicatorRect.x>0);assert.ok(status.indicatorRect.y<100);await fixtureCommand('indicator-stop',{x:status.consentRect.x+258,y:status.consentRect.y+76});assert.equal(await pending,'allowed-once');assert.equal(runtime.consents.status(session.id).remembered.length,1);assert.equal(await runtime.consents.request(request,async()=>{throw new Error('cached request must not prompt');}),'allowed-once');runtime.consents.clear(session.id);assert.equal(runtime.consents.status(session.id).remembered.length,0);
    }finally{runtime.consents.describe=old;await runtime.presence.finish(session.id);}
  });
  let browserObservation, page;
  const browserExec = {...exec, name: 'control_browser'};
  const refresh = async () => { browserObservation = await runtime.call('browser', {action: 'observe'}, browserExec); return browserObservation; };
  const find = name => browserObservation.elements.find(e => e.name === name).elementId;
  await check('real Chrome launches a separate session profile and opens local test page', async () => { const r = await runtime.call('browser', {action: 'open', url}, browserExec); browserObservation = r.postObservation; assert.equal(browserObservation.title, 'DSH Browser Test Fixture'); page = runtime.browser.page(session.id, browserObservation.tabId); });
  await check('browser mouse produces trusted events without moving OS cursor', async () => {
    const before = await runtime.native.call('ping'); await refresh(); await runtime.call('browser', {action: 'click', observationId: browserObservation.observationId, elementId: find('Fixture button')}, browserExec); assert.equal(await page.evaluate(() => trusted), 1); assert.deepEqual((await runtime.native.call('ping')).cursor, before.cursor);
  });
  await check('browser overlay and virtual pointer are visible during control', async () => { await runtime.browser.show(session.id, page, {x: 200, y: 250}); assert.equal(await page.evaluate(() => document.querySelector('[data-dsh-control]').style.display), ''); await page.screenshot({path: join(outputDir, 'browser-indicator.png'), scale: 'css'}); });
  await check('browser double click and right click work', async () => { await refresh(); await runtime.call('browser', {action: 'click', observationId: browserObservation.observationId, elementId: find('Fixture button'), count: 2}, browserExec); assert.equal(await page.evaluate(() => doubles), 1); await refresh(); await runtime.call('browser', {action: 'click', observationId: browserObservation.observationId, elementId: find('Fixture button'), button: 'right'}, browserExec); assert.equal(await page.evaluate(() => rights), 1); });
  await check('browser Unicode typing and keyboard shortcuts work', async () => { await refresh(); await runtime.call('browser', {action: 'type', observationId: browserObservation.observationId, elementId: find('Fixture input'), text: '浏览器鼠标输入 ✓'}, browserExec); assert.equal(await page.locator('#input').inputValue(), '浏览器鼠标输入 ✓'); await refresh(); await runtime.call('browser', {action: 'key', observationId: browserObservation.observationId, key: 'Control+a'}, browserExec); });
  await check('DOM background click/fill work and click is distinguishable as synthetic', async () => { const before = await page.evaluate(() => ({clicks, trusted})); await refresh(); await runtime.call('browser', {action: 'click', mode: 'dom', observationId: browserObservation.observationId, elementId: find('Fixture button')}, browserExec); assert.deepEqual(await page.evaluate(() => ({clicks, trusted})), {clicks: before.clicks + 1, trusted: before.trusted}); await refresh(); await runtime.call('browser', {action: 'type', mode: 'dom', observationId: browserObservation.observationId, elementId: find('Fixture input'), text: 'DOM 后台 ✓'}, browserExec); assert.equal(await page.locator('#input').inputValue(), 'DOM 后台 ✓'); });
  await check('browser hover, drag and scroll use real input primitives', async () => {
    await refresh(); await runtime.call('browser', {action: 'hover', observationId: browserObservation.observationId, elementId: find('Fixture button')}, browserExec); assert.ok(await page.evaluate(() => moves > 0));
    await refresh(); const drag = browserObservation.elements.find(e => e.name === 'Drag'); await runtime.call('browser', {action: 'drag', observationId: browserObservation.observationId, elementId: drag.elementId, endX: drag.rect.x + 160, endY: drag.rect.y + 50}, browserExec); assert.ok(await page.evaluate(() => dragged > 0));
    await refresh(); await runtime.call('browser', {action: 'scroll', observationId: browserObservation.observationId, elementId: find('Fixture scroll'), deltaY: 500}, browserExec); await until(() => page.locator('#scroll').evaluate(el => el.scrollTop > 0), 'scroll feedback');
  });
  await check('browser screenshot is readable PNG with CSS coordinate scale', async () => { const shot = await runtime.call('browser', {action: 'screenshot'}, browserExec); const b = Buffer.from(shot.pngBase64, 'base64'); assert.equal(b.readUInt32BE(16), shot.viewport.width); writeFileSync(join(outputDir, 'browser-fixture.png'), b); });
  await check('tabs are isolated by DSH session and stable identifiers', async () => { assert.throws(() => runtime.browser.page('another-session', browserObservation.tabId), {code: 'BROWSER_NOT_OPEN'}); const tabs = await runtime.call('browser', {action: 'tabs'}, browserExec); assert.ok(tabs.tabs.some(t => t.tabId === browserObservation.tabId)); });
  await check('navigation, back and reload restore page control', async () => { await refresh(); await runtime.call('browser', {action: 'navigate', observationId: browserObservation.observationId, url: url + '?second'}, browserExec); await refresh(); await runtime.call('browser', {action: 'back', observationId: browserObservation.observationId}, browserExec); assert.equal(page.url(), url); await refresh(); await runtime.call('browser', {action: 'reload', observationId: browserObservation.observationId}, browserExec); assert.equal(await page.title(), 'DSH Browser Test Fixture'); });
  await check('Esc cancels in-flight navigation, releases ownership and permits the next operation', async () => {
    await refresh();await page.bringToFront();const own=(await runtime.native.call('windows')).windows.find(w=>w.processId===runtime.browser.groupStatus(session.id).processId&&w.className==='Chrome_WidgetWin_1');assert.ok(own);await fixtureCommand('activate-owned-browser',{windowId:own.windowId}); const promise = runtime.call('browser', {action: 'navigate', observationId: browserObservation.observationId, url: url + 'slow'}, browserExec);
    void promise.catch(() => {});
    await until(() => runtime.native.call('ping').then(s => s.browserWatching), 'browser monitor');await fixtureCommand('escape');
    await assert.rejects(promise); assert.equal(runtime.coordinator.status.owner, null); assert.equal(runtime.browser.sessions.has(session.id),true);assert.ok(runtime.browser.page(session.id,browserObservation.tabId));
    await assert.rejects(runtime.call('desktop',{action:'windows'},exec),{code:'CONTROL_STOPPED'});await runtime.command(exec.agent,'resume');
    observed=await runtime.call('desktop',{action:'observe',windowId:hwnd},exec);
    await runtime.call('desktop',{action:'type',mode:'uia',observationId:observed.observationId,elementId:observed.elements.find(e=>e.name==='Fixture input').elementId,text:'停止后恢复 ✓'},exec);
    await until(()=>state().text==='停止后恢复 ✓','resumed control after Esc');
  });
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; console.error(error); process.exitCode = 1; }
finally {
  await runtime.dispose(); await fixtureCommand('close').catch(() => {}); fixture.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString(); writeFileSync(join(outputDir, 'live-report.json'), JSON.stringify(report, null, 2));
}
