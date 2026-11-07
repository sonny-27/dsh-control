import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {chromium} from '../../dsh-control/node_modules/playwright-core/index.mjs'
import {fixture} from './fixture.js'
import {createHandlers} from '../http.js'
const dependencies=fileURLToPath(new URL('../../../work/gui-test-runtime/',import.meta.url)),require=createRequire(join(dependencies,'package.json')),esbuild=require('esbuild')
const evidence=fileURLToPath(new URL('../../test-evidence/',import.meta.url));mkdirSync(evidence,{recursive:true})
const report={checks:[],runtime:'Real Chrome + React, shipped Panel and supervisor HTTP handler'}
const cleanups=[],f=await fixture({after:fn=>cleanups.push(fn)}),parent=f.add('parent'),child=f.add('child','parent',{label:'Child fixture'})
child.session.append('turn/start',{turn:1})
const handlers=createHandlers(f.supervisor),client=readFileSync(new URL('../client.js',import.meta.url),'utf8')
const bootstrap=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';window.startPanel=()=>createRoot(document.getElementById('root')).render(React.createElement(window.supervisorPlugin.Panel,{ctx:{sidebarRight:{openResource:()=>{}}},sessionId:'parent'}));window.__ModuleLoader__={load:({factory})=>{const UI=new Proxy({},{get:()=>()=>React.createElement('span')});window.supervisorPlugin=factory(name=>name==='react'?React:UI);}};`,resolveDir:dependencies},bundle:true,write:false,format:'iife'})
const server=createServer((req,res)=>{if(req.url.startsWith('/api/dsh-agent-supervisor/state'))return void handlers.state(req,res);res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><div id="root" style="height:720px;width:490px"></div><script>'+bootstrap.outputFiles[0].text+'</script><script>'+client+'</script><script>const style=document.createElement("style");style.textContent=supervisorPlugin.css;document.head.append(style);startPanel()</script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r))
let browser
async function check(label,fn){await fn();report.checks.push({label,result:'pass'});console.log('PASS '+label)}
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:520,height:780}});await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const row=page.locator('.das-row'),refresh=async()=>{await page.getByRole('button',{name:'刷新子代理'}).click()}
  await check('running child is rendered as running',async()=>{await row.getByText('运行中',{exact:true}).waitFor()})
  await check('delivered message does not render a stopped child',async()=>{child.session.append('tool/call',{name:'send_message'});child.session.append('tool/result',{message:{content:[{type:'text',text:'message delivered'}]}});await refresh();await row.getByText('运行中',{exact:true}).waitFor();assert.equal(await row.getByText('已中止',{exact:true}).count(),0)})
  await check('completion during asynchronous snapshot renders completed instead of stopped',async()=>{const original=f.ctx.sessionProjections.snapshot;let armed=true;f.ctx.sessionProjections.snapshot=session=>{const value=original(session);if(session===child.session&&armed){armed=false;queueMicrotask(()=>{child.session.append('turn/end',{turn:1,reason:{kind:'completed'}});child.status='idle'})}return value};await refresh();await row.getByText('已完成',{exact:true}).waitFor();assert.equal(await row.getByText('已中止',{exact:true}).count(),0);f.ctx.sessionProjections.snapshot=original})
  await check('unconfirmed open log is shown as syncing with a clear explanation',async()=>{child.session.append('turn/start',{turn:2});child.status='idle';await refresh();await row.getByText('同步中',{exact:true}).waitFor();await row.getByText(/等待运行状态同步/).waitFor();await page.screenshot({path:join(evidence,'subagent-status-syncing.png')})})
  await check('running-only filter retains syncing tasks instead of hiding them',async()=>{await page.getByLabel('仅运行中').check();assert.equal(await row.count(),1);await page.getByLabel('仅运行中').uncheck()})
  await check('real manual cancellation still renders stopped with its reason',async()=>{child.controller=new AbortController();child.status='running';await f.preStep(child,2);child.cancel({kind:'user'},{keepInbox:true});child.session.append('turn/end',{turn:2,reason:{kind:'aborted',reason:{kind:'user'}}});await refresh();await row.getByText('已中止',{exact:true}).waitFor();await row.getByText(/本任务处于暂停锁定状态/).waitFor();await page.screenshot({path:join(evidence,'subagent-status-stopped-reason.png')})})
  report.passed=true
}catch(error){report.passed=false;report.failure=error.stack;console.error(error);process.exitCode=1}
finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));for(const fn of cleanups)await fn();writeFileSync(join(evidence,'subagent-status-gui-report.json'),JSON.stringify(report,null,2))}
