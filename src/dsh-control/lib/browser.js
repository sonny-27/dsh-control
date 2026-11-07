import {chromium} from 'playwright-core';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {ControlError, checkAbort, integer} from './common.js';
import {strokeOptions,captureOptions,waitOptions} from './advanced.js';
import {NativeGroups} from './tab-groups.js';
import {ManagedBrowser} from './managed-browser.js';
import {readFileSync} from 'node:fs';

function domWatch(){
  const key='__dshControlDOMWatchV1';if(window[key])return window[key].version;
  const state=window[key]={version:0,sourceId:crypto.randomUUID?.()??(Date.now()+'-'+Math.random().toString(36)),sequence:0,ids:new WeakMap(),timer:null};
  const own=node=>node?.nodeType===1&&(node.matches?.('[data-dsh-control]')||node.closest?.('[data-dsh-control]'));
  const changed=()=>{state.version++;clearTimeout(state.timer);state.timer=setTimeout(()=>{window.__dshControlChanged?.({version:state.version,sourceId:state.sourceId}).catch(()=>{});},30);};
  const observer=new MutationObserver(records=>{if(records.some(r=>!own(r.target)&&!(r.type==='childList'&&[...r.addedNodes,...r.removedNodes].length&&[...r.addedNodes,...r.removedNodes].every(own))))changed();});
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','disabled','aria-disabled','aria-label','aria-expanded','value','name','type','href']});
  document.addEventListener('input',e=>{if(!own(e.target))changed();},true);document.addEventListener('change',e=>{if(!own(e.target))changed();},true);
  window.addEventListener('resize',changed);window.addEventListener('scroll',changed,true);state.observer=observer;return state.version;
}

// Editable contents and focus/caret decoration are values, not control names.
// Use the same fingerprint when observing and revalidating the exact DOM node.
function elementInfo(el) {
  const w=window.__dshControlDOMWatchV1;if(!w.ids.has(el))w.ids.set(el,'dom-'+(++w.sequence));
  const tag=el.tagName.toLowerCase(),editable=el.isContentEditable;
  const label=(el.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim();
  const labels=el.labels?[...el.labels].map(label=>label.innerText||label.textContent||'').join(' ').trim():'';
  const name=(el.getAttribute('aria-label')||label||labels||el.getAttribute('alt')||(!(editable||tag==='input'||tag==='textarea')?el.innerText:'')||el.getAttribute('placeholder')||el.getAttribute('data-placeholder')||el.getAttribute('name')||'').slice(0,300);
  const value=el.type==='password'?undefined:editable?el.textContent:['input','textarea','select'].includes(tag)?el.value:undefined;
  const controlState=[el.checked??null,el.getAttribute('aria-checked'),el.getAttribute('aria-pressed'),el.getAttribute('aria-expanded')];
  const privateState=value!==undefined||controlState.some(v=>v!==null)?JSON.stringify([value??null,...controlState]):undefined;
  return {identity:w.ids.get(el),tag,role:el.getAttribute('role'),name,href:el.href??null,search:el.type==='search'||!!el.closest('[role=search]')||/搜索|search/i.test(name),type:el.getAttribute('type'),editable,editingHost:editable&&(!el.parentElement?.isContentEditable||el.hasAttribute('tabindex')),readonly:!!el.readOnly||el.getAttribute('aria-readonly')==='true',disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true',focused:document.activeElement===el,password:el.type==='password',...(privateState===undefined?{}:{_value:privateState.length>32768?null:privateState})};
}
const isTextTarget=e=>e&&(e.editable&&e.editingHost!==false||e.tag==='textarea'||e.tag==='input'&&['','text','search','email','password','tel','url','number'].includes((e.type??'').toLowerCase()));
const semanticTarget=args=>!!args.elementId&&![args.x,args.y,args.endX,args.endY,args.path,args.strokes].some(v=>v!==undefined);
function typingState(el){return {connected:el.isConnected,focused:document.activeElement===el,readonly:!!el.readOnly||el.getAttribute('aria-readonly')==='true',disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true'};}

// The border is a visual affordance, never an authorization boundary.
function visual(payload) {
  const key = '__dshControlVisualV1';
  let v = window[key];
  if (!v || !v.host.isConnected) {
    const host = document.createElement('div');
    host.setAttribute('data-dsh-control', 'indicator');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({mode: 'closed'});
    const style=document.createElement('style');style.textContent='@keyframes dsh-pulse{0%,100%{opacity:.55}50%{opacity:1}}@keyframes dsh-spin{to{transform:rotate(360deg)}}@keyframes dsh-ring{from{box-shadow:0 0 0 0 #3cd2ce99}to{box-shadow:0 0 0 14px #3cd2ce00}}';
    const border = document.createElement('div');
    border.style.cssText = 'position:absolute;inset:0;border:3px solid #3cd2ce;box-shadow:inset 0 0 18px #3cd2ce33;box-sizing:border-box;pointer-events:none;animation:dsh-pulse 1.6s ease-in-out infinite';
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;top:12px;right:20px;background:#141a27;color:white;padding:11px 15px;font:13px sans-serif;border:1px solid #3cd2ce;border-radius:9px;pointer-events:none';
    const spinner=document.createElement('span');spinner.style.cssText='display:inline-block;width:12px;height:12px;vertical-align:middle;border:2px solid #3cd2ce44;border-top-color:#3cd2ce;border-radius:50%;margin-right:8px;animation:dsh-spin 1s linear infinite';
    const caption=document.createElement('span');label.append(spinner,caption);
    const pointer = document.createElement('div');
    pointer.style.cssText = 'position:absolute;width:18px;height:18px;border:2px solid #3cd2ce;background:#3cd2ce33;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;display:none;animation:dsh-ring .8s ease-out infinite';
    const stop = document.createElement('button'); stop.textContent = '停止';
    stop.style.cssText = 'position:absolute;top:58px;right:20px;background:#141a27;color:white;border:1px solid #3cd2ce;border-radius:6px;padding:5px 13px;pointer-events:auto';
    stop.addEventListener('click', e => { if (e.isTrusted) window.__dshControlStop?.(); });
    window.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Escape' && !v.keyboardInjected && host.style.display !== 'none') window.__dshControlStop?.(); }, true);
    root.append(style,border, label, pointer, stop); document.documentElement.append(host);
    v = window[key] = {host, pointer, label:caption, timer: null};
  }
  clearTimeout(v.timer);if(payload.keyboardInjection!==undefined)v.keyboardInjected=payload.keyboardInjection;
  v.owner=payload.owner??v.owner;v.lastHeartbeat=Date.now();
  if(!v.watchdog)v.watchdog=setInterval(()=>{if(Date.now()-v.lastHeartbeat>15000)v.host.style.display='none';},2000);
  v.host.style.display = payload.visible === false ? 'none' : '';
  const phase=payload.phase??'browser';v.host.dataset.phase=phase;
  v.label.textContent = `${payload.group?.title??'DSH'} · ${phase==='observe'?'正在查看页面':phase==='thinking'?'正在分析 · 操控待续':phase==='approval'?'等待审批':phase==='review'?'正在审查':phase==='blocked'?'操作受阻 · 等待下一步':'正在操作浏览器'} · Esc 停止`;
  if(phase==='thinking'||phase==='observe')v.pointer.style.display='none';
  if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) { v.pointer.style.left = `${payload.x}px`; v.pointer.style.top = `${payload.y}px`; v.pointer.style.display = ''; }
  if (payload.idleMs !== undefined) v.timer = setTimeout(() => { v.host.style.display = 'none'; }, payload.idleMs);
  return true;
}

export function validUrl(value) {
  let url; try { url = new URL(value); } catch { throw new ControlError('INVALID_URL', 'URL 无效'); }
  if (!['http:', 'https:', 'about:'].includes(url.protocol) || (url.protocol === 'about:' && url.href !== 'about:blank')) throw new ControlError('INVALID_URL', '只支持 http、https 和 about:blank');
  if (url.username || url.password) throw new ControlError('INVALID_URL', 'URL 不能包含用户名或密码');
  return url.href;
}
export class Browser {
  constructor(config){this.config=config;this.sessions=new Map();this.launches=new Map();this.hosts=new Map();this.hostLaunches=new Map();this.pageOwners=new WeakMap();this.labels=new Map();this.userCandidates=new Map();this.typing=new WeakMap();this.revalidations=new WeakSet();this.locations=new WeakMap();this.loans=new Map();this.manager=config.preserveBrowserOnExit===false?null:new ManagedBrowser(config);}
  async setupHost(context,key,managed,browser,manager){
    const groups=new NativeGroups(context,manager?.extension);await groups.init();const host={key,context,browser:browser??context.browser(),managed,manager,groups,windowId:null,queue:Promise.resolve(),persistence:Promise.resolve(),admissions:new Set()};this.hosts.set(key,host);
    context.on('close',()=>{if(this.hosts.get(key)===host)this.hosts.delete(key);for(const [owner,r] of this.sessions)if(r.host===host)this.sessions.delete(owner);});
    context.on('page',page=>{const task=(async()=>{const opener=await page.opener();const owner=opener?this.pageOwners.get(opener):null;if(owner&&this.sessions.get(owner)?.host===host)await this.admit(owner,page,true);})().catch(()=>{});host.admissions.add(task);void task.finally(()=>host.admissions.delete(task));});
    await context.exposeBinding('__dshControlStop',source=>{const owner=this.pageOwners.get(source.page);if(owner)this.onStop?.(owner);});
    await context.exposeBinding('__dshControlChanged',(source,payload)=>{const owner=this.pageOwners.get(source.page);if(owner&&Number.isSafeInteger(payload?.version)&&typeof payload.sourceId==='string')this.onUIChange?.({owner,tabId:this.track(this.record(owner),source.page),version:payload.version,sourceId:payload.sourceId,kind:'dom'});});
    return host;
  }
  async managedHost(){
    if(this.hosts.has('managed'))return this.hosts.get('managed');if(this.hostLaunches.has('managed'))return this.hostLaunches.get('managed');
    if(this.manager){const task=(async()=>{const {context,browser}=await this.manager.connect();try{return await this.setupHost(context,'managed',true,browser,this.manager);}catch(error){await browser.close();throw error;}})();this.hostLaunches.set('managed',task);try{return await task;}finally{this.hostLaunches.delete('managed');}}
    const task=(async()=>{const profile=join(this.config.browserProfileDir||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'dsh-control','browsers'),'shared-groups');const options={headless:false,viewport:null,timeout:this.config.operationTimeoutMs,ignoreDefaultArgs:['--disable-extensions'],args:['--force-renderer-accessibility']};if(this.config.browserExecutable)options.executablePath=this.config.browserExecutable;else options.channel=this.config.browserChannel;const context=await chromium.launchPersistentContext(profile,options);context.setDefaultTimeout(this.config.operationTimeoutMs);context.setDefaultNavigationTimeout(this.config.operationTimeoutMs);try{return await this.setupHost(context,'managed',true);}catch(error){await context.close();throw error;}})();this.hostLaunches.set('managed',task);try{return await task;}finally{this.hostLaunches.delete('managed');}
  }
  async context(owner){let record=this.sessions.get(owner);if(record)return record;const host=await this.managedHost();record=this.createRecord(owner,host);await this.restoreRecord(record);return record;}
  async resume(owner){if(this.sessions.has(owner)||!this.manager?.saved(owner))return;await this.context(owner);}
  createRecord(owner,host){
    const colors=['blue','green','purple','cyan','orange','pink','red','yellow','grey'],used=new Set([...this.sessions.values()].filter(r=>r.host===host).map(r=>r.color).concat(host.manager?.entries().map(r=>r.color)??[])),color=colors.find(c=>!used.has(c))??colors[this.sessions.size%colors.length];
    const record={owner,host,context:host.context,tabs:new Map(),observations:new Map(),ready:new Map(),active:null,color,groupTitle:`DSH · ${this.labels.get(owner)||owner.slice(-8)}`,group:null};this.sessions.set(owner,record);return record;
  }
  setLabel(owner,label){if(typeof label==='string'&&label.trim())this.labels.set(owner,label.trim().slice(0,45)+' · '+owner.slice(-6));}
  track(record,page,savedId){
    const existing=this.pageOwners.get(page);if(existing&&existing!==record.owner)throw new ControlError('TAB_NOT_OWNED','此标签属于另一个 DSH 会话');
    for(const [id,known] of record.tabs)if(known===page)return id;
    this.pageOwners.set(page,record.owner);const id=savedId??randomUUID();record.tabs.set(id,page);page.on('close',()=>{record.tabs.delete(id);record.ready.delete(page);if(this.pageOwners.get(page)===record.owner)this.pageOwners.delete(page);this.loans.delete(id);if(record.active===id)record.active=record.tabs.keys().next().value??null;if(this.sessions.get(record.owner)===record)void this.persistRecord(record).catch(()=>{});});return id;
  }
  async admit(owner,page,popup=false){
    const record=this.record(owner),id=this.track(record,page);if(record.ready.has(page)){await record.ready.get(page);return id;}
    const ready=record.host.queue.catch(()=>{}).then(async()=>{const group=await record.host.groups.assign(page,record,record.host.windowId??undefined);record.host.windowId??=group.windowId;});record.host.queue=ready;record.ready.set(page,ready);await ready;if(record.active===null||popup)record.active=id;await this.persistRecord(record);return id;
  }
  async persistRecord(record){
    if(!record.host.manager)return;
    const save=record.host.persistence.catch(()=>{}).then(async()=>{
      if(this.sessions.get(record.owner)!==record)return;const tabs=[];
      for(const [id,page] of record.tabs){if(page.isClosed())continue;try{await record.host.groups.check(page,record);tabs.push({id,targetId:await record.host.groups.target(page),...(this.loans.has(id)?{loan:this.loans.get(id)}:{})});}catch(error){if(error.code==='TAB_GROUP_CHANGED')continue;return;}}
      if(record.group)record.host.manager.save(record.owner,{title:record.groupTitle,color:record.color,group:record.group,tabs,active:record.active});
    });record.host.persistence=save;await save;
  }
  async restoreRecord(record){
    const saved=record.host.manager?.saved(record.owner);if(!saved)return;
    record.group=saved.group;record.color=saved.color;record.groupTitle=saved.title;
    const expected=new Map(saved.tabs.filter(t=>typeof t.id==='string'&&typeof t.targetId==='string').map(t=>[t.targetId,t]));
    for(const page of record.context.pages()){
      if(page.isClosed()||this.pageOwners.has(page))continue;const target=await record.host.groups.target(page),entry=expected.get(target);if(!entry)continue;
      try{await record.host.groups.check(page,record);}catch{continue;}
      this.track(record,page,entry.id);if(entry.loan?.childSessionId===record.owner&&entry.loan.tabId===entry.id&&typeof entry.loan.parentSessionId==='string'&&typeof entry.loan.loanId==='string')this.loans.set(entry.id,entry.loan);record.ready.set(page,Promise.resolve());record.host.windowId??=saved.group.windowId;
    }
    record.active=record.tabs.has(saved.active)?saved.active:record.tabs.keys().next().value??null;
    if(!record.tabs.size){record.group=null;record.host.manager.forget(record.owner);}
    // Existing page objects survive a DSH restart, but observations and approvals do not.
    await this.hide(record.owner);await this.persistRecord(record);
  }
  async checkPage(owner,page){const record=this.record(owner);if(record.host.manager&&!record.host.manager.isCurrent())throw new ControlError('BROWSER_CONTROL_REPLACED','浏览器已由更新的 DSH 实例接管，请在新实例继续');if(this.pageOwners.get(page)!==owner)throw new ControlError('TAB_NOT_OWNED','此标签不属于当前会话');await record.ready.get(page);return await record.host.groups.check(page,record);}
  loanStatus(owner){
    const loans=new Map([...this.loans.values()].map(l=>[l.loanId,l]));
    for(const entry of this.manager?.entries()??[])for(const tab of entry.tabs??[]){const l=tab.loan;if(l?.childSessionId===entry.owner&&l.tabId===tab.id&&typeof l.loanId==='string')loans.set(l.loanId,l);}
    return [...loans.values()].filter(l=>l.parentSessionId===owner||l.childSessionId===owner).map(l=>({loanId:l.loanId,tabId:l.tabId,parentSessionId:l.parentSessionId,childSessionId:l.childSessionId}));
  }
  loan(loanId,tabId){
    let loan=this.loans.get(tabId);
    if(!loan)for(const entry of this.manager?.entries()??[])for(const tab of entry.tabs??[])if(tab.id===tabId&&tab.loan?.childSessionId===entry.owner&&tab.loan.loanId===loanId){loan=tab.loan;this.loans.set(tabId,loan);}
    if(!loan||loan.loanId!==loanId||loan.tabId!==tabId)throw new ControlError('LOAN_NOT_FOUND','交接编号不存在或已结束，请查看本会话 browserLoans');return loan;
  }
  async invalidatePage(record,page){for(const [id,found] of record.observations)if(found.page===page){record.observations.delete(id);await Promise.allSettled([...found.elements.values()].map(h=>h.dispose()));}}
  async transferPage(sourceOwner,targetOwner,tabId,loan){
    const source=this.record(sourceOwner),page=this.page(sourceOwner,tabId);await this.checkPage(sourceOwner,page);
    await this.resume(targetOwner);let target=this.sessions.get(targetOwner);
    if(target&&target.host!==source.host)throw new ControlError('BROWSER_HOST_MISMATCH','接收会话已有不同浏览器连接，请先断开后再交接');
    target??=this.createRecord(targetOwner,source.host);
    if(!target.tabs.size&&loan?.parentSessionId===targetOwner){target.groupTitle=loan.parentTitle;target.color=loan.parentColor;}
    const previous=this.loans.get(tabId),sourceActive=source.active,targetActive=target.active;
    await this.hide(sourceOwner);
    try{
      await source.host.groups.assign(page,target,source.host.windowId??undefined);
      if(page.isClosed())throw new ControlError('TAB_NOT_OWNED','交接期间标签已关闭');
      source.tabs.delete(tabId);source.ready.delete(page);if(source.active===tabId)source.active=source.tabs.keys().next().value??null;
      this.pageOwners.delete(page);this.track(target,page,tabId);target.ready.set(page,Promise.resolve());target.active=tabId;
      if(loan&&targetOwner===loan.childSessionId)this.loans.set(tabId,loan);else this.loans.delete(tabId);
      await this.invalidatePage(source,page);await this.invalidatePage(target,page);
      await this.persistRecord(target);await this.persistRecord(source);
      return {handedOff:true,tabId,fromSessionId:sourceOwner,toSessionId:targetOwner,loanId:loan?.loanId,requiresObservation:true,group:this.groupStatus(targetOwner),hint:'同一页面已独占交接，没有重新导航或复制登录数据。接收方必须使用 tabId 重新 observe；交出方旧观察已失效。'};
    }catch(error){
      if(!page.isClosed())try{await source.host.groups.assign(page,source,source.host.windowId??undefined);target.tabs.delete(tabId);target.ready.delete(page);target.active=targetActive;this.pageOwners.delete(page);this.track(source,page,tabId);source.ready.set(page,Promise.resolve());source.active=sourceActive;if(previous)this.loans.set(tabId,previous);else this.loans.delete(tabId);await this.persistRecord(source);await this.persistRecord(target);}catch{/* A failed rollback cannot pass the subsequent native group check. */}
      throw error;
    }
  }
  async pendingPages(record){await Promise.allSettled([...record.host.admissions]);}
  groupStatus(owner){const r=this.sessions.get(owner),saved=!r?this.manager?.saved(owner):null;return r?{owner,title:r.groupTitle,color:r.color,nativeGroupId:r.group?.id??null,windowId:r.group?.windowId??null,mode:r.host.managed?'managed':'user-browser',persistent:!!r.host.manager,sharedCookies:true,tabs:r.tabs.size,processId:r.host.groups.processId}:saved?{owner,title:saved.title,color:saved.color,nativeGroupId:saved.group.id,windowId:saved.group.windowId,mode:'managed',persistent:true,reconnectPending:true,sharedCookies:true,tabs:saved.tabs.length}:null;}
  async connectUser(owner,endpoint='auto'){
    if(this.sessions.has(owner)||this.manager?.saved(owner))throw new ControlError('BROWSER_ALREADY_OPEN','请先在 GUI 断开本会话当前组，再连接用户浏览器；不会自动关闭用户标签');
    if(endpoint==='auto'){const folder=this.config.browserChannel==='msedge'?join(process.env.LOCALAPPDATA,'Microsoft','Edge','User Data'):join(process.env.LOCALAPPDATA,'Google','Chrome','User Data');let lines;try{lines=readFileSync(join(folder,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);}catch{throw new ControlError('BROWSER_CONNECT_REQUIRED','请在正在使用的 Chrome/Edge 打开 chrome://inspect/#remote-debugging 并开启远程调试，再连接；保留浏览器的原生许可确认。');}if(!/^\d+$/.test(lines[0])||!/^\/devtools\/browser\//.test(lines[1]??''))throw new ControlError('BROWSER_CONNECT_REQUIRED','浏览器调试端点尚未就绪');endpoint=`ws://127.0.0.1:${lines[0]}${lines[1]}`;}
    let url;try{url=new URL(endpoint);}catch{throw new ControlError('INVALID_ENDPOINT','需要本机 Chrome/Edge 调试地址');}
    if(!['http:','ws:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new ControlError('INVALID_ENDPOINT','仅连接本机无凭据的调试地址');
    const key='user-'+createHash('sha256').update(endpoint).digest('hex').slice(0,20);let host=this.hosts.get(key);
    if(!host){const browser=await chromium.connectOverCDP(endpoint,{timeout:15000,noDefaults:true}),context=browser.contexts()[0];if(!context){await browser.close();throw new ControlError('BROWSER_CONNECT_REQUIRED','浏览器没有可连接的用户上下文');}try{host=await this.setupHost(context,key,false,browser);}catch(error){await browser.close();throw error;}}
    const record=this.createRecord(owner,host);return {group:this.groupStatus(owner),available:await this.userTabs(owner)};
  }
  async userTabs(owner){const record=this.record(owner);if(record.host.managed)throw new ControlError('NOT_USER_BROWSER','当前使用插件专用浏览器');const result=[];for(const page of record.context.pages()){if(page.isClosed()||this.pageOwners.has(page))continue;const token=randomUUID();this.userCandidates.set(token,{owner,host:record.host,page,expiresAt:Date.now()+120000});result.push({id:token,title:await page.title(),url:page.url()});}while(this.userCandidates.size>256)this.userCandidates.delete(this.userCandidates.keys().next().value);return result;}
  async adopt(owner,token){const candidate=this.userCandidates.get(token),record=this.record(owner);if(!candidate||candidate.owner!==owner||candidate.host!==record.host||candidate.expiresAt<Date.now()||candidate.page.isClosed())throw new ControlError('TAB_SELECTION_EXPIRED','标签选择已过期或属于其他会话，请重新查看列表');if(this.pageOwners.has(candidate.page))throw new ControlError('TAB_NOT_OWNED','此标签已归属另一会话');this.userCandidates.delete(token);record.active=await this.admit(owner,candidate.page);return {tabId:record.active,group:this.groupStatus(owner)};}
  async pause(owner){const record=this.sessions.get(owner);if(!record)return;for(const page of record.tabs.values()){if(page.isClosed())continue;const cdp=await record.context.newCDPSession(page).catch(()=>null);if(cdp){await Promise.race([cdp.send('Page.stopLoading').catch(()=>{}),new Promise(r=>setTimeout(r,1000))]);await cdp.detach().catch(()=>{});}}await this.hide(owner);}
  async release(owner){const record=this.sessions.get(owner);if(!record){this.manager?.forget(owner);return {released:true,preservedTabs:true};}await this.hide(owner);this.sessions.delete(owner);for(const page of record.tabs.values())this.pageOwners.delete(page);await record.host.persistence.catch(()=>{});this.manager?.forget(owner);if(![...this.sessions.values()].some(r=>r.host===record.host)&&!record.host.managed){await record.host.groups.dispose(!record.host.managed);this.hosts.delete(record.host.key);await record.host.browser.close().catch(()=>{});}return {released:true,preservedTabs:true};}
  async suspend(owner){const record=this.sessions.get(owner);if(!record)return;if(!record.host.manager){if([...record.tabs.keys()].some(id=>this.loans.get(id)?.childSessionId===owner)){await this.hide(owner);return;}return this.release(owner);}await this.persistRecord(record);await this.hide(owner);this.sessions.delete(owner);for(const page of record.tabs.values())this.pageOwners.delete(page);}
  record(owner) {
    const record = this.sessions.get(owner);
    if (!record) throw new ControlError('BROWSER_NOT_OPEN', '先使用 control_browser open');
    return record;
  }
  page(owner, tabId) {
    const record = this.record(owner), page = record.tabs.get(tabId || record.active);
    if (!page || page.isClosed()) throw new ControlError('TAB_NOT_OWNED', '标签页不存在或不属于本会话');
    return page;
  }
  async tabs(owner) {
    const record = this.record(owner), result = [];
    await this.pendingPages(record);for (const [id,page] of record.tabs) { await this.checkPage(owner,page); result.push({tabId: id, title: await page.title(), url: page.url(), active: record.active === id}); }
    return {tabs:result,group:this.groupStatus(owner)};
  }
  async observe(owner, tabId) {
    const record = this.record(owner), page = this.page(owner, tabId);
    await this.checkPage(owner,page);const uiVersion=await page.evaluate(domWatch),uiSourceId=await page.evaluate(()=>window.__dshControlDOMWatchV1.sourceId);
    const elements = new Map(), visible = [],values=new Map();
    const handles = await page.$$('button, a[href], input, textarea, select, [role], [contenteditable]:not([contenteditable="false"]), summary');
    for (const handle of handles) {
      if (visible.length >= 300) { await handle.dispose(); continue; }
      const box = await handle.boundingBox();
      if (!box || box.width < 1 || box.height < 1) { await handle.dispose(); continue; }
      const info = await handle.evaluate(elementInfo);
      const id = `e${visible.length}`;if(Object.hasOwn(info,'_value')){values.set(id,info._value===null?null:createHash('sha256').update(info._value).digest('hex'));delete info._value;}elements.set(id, handle); visible.push({elementId: id, ...info, rect: box});
    }
    const token = randomUUID(), id = this.track(record, page);
    record.observations.set(token, {page, elements, values,url: page.url(),uiVersion,uiSourceId,expected:new Map(visible.map(e=>[e.elementId,e]))});
    while (record.observations.size > 8) {
      const key = record.observations.keys().next().value, old = record.observations.get(key); record.observations.delete(key);
      await Promise.allSettled([...old.elements.values()].map(e => e.dispose()));
    }
    const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
    const text = await page.locator('body').innerText().catch(() => '');
    return {kind: 'browser',group:this.groupStatus(owner), nativeObservation: token, tabId: id, url: page.url(), title: await page.title(), viewport,uiVersion,uiSourceId,changeMonitoring:true,captureChanged:await page.evaluate(domWatch)!==uiVersion, text: text.slice(0, 12000), elements: visible, coordinates: 'viewport CSS pixels'};
  }
  cited(owner, observation) {
    const record = this.record(owner), found = record.observations.get(observation.nativeObservation);
    if (!found || found.page.isClosed() || found.page !== this.page(owner, observation.tabId) || found.url !== found.page.url()) throw new ControlError('STALE_OBSERVATION', '标签页已关闭、导航或观察已淘汰，请重新观察');
    return found;
  }
  async point(found, args,allowDisabled=false) {
    let x = args.x, y = args.y;
    if (args.elementId) {
      const handle = found.elements.get(args.elementId);
      if (!handle || !await handle.evaluate(el => el.isConnected)) throw new ControlError('ELEMENT_GONE', '控件已不存在，请重新观察');
      const box = await handle.boundingBox(); if (!box) throw new ControlError('ELEMENT_HIDDEN', '控件不可见');
      if(!allowDisabled&&await handle.evaluate(el=>!!el.disabled||el.getAttribute('aria-disabled')==='true'))throw new ControlError('ELEMENT_DISABLED','控件当前不可用');
      const expected=found.expected?.get(args.elementId),moved=expected&&['x','y','width','height'].some(k=>Math.abs(expected.rect[k]-box[k])>1);
      if(moved&&!semanticTarget(args))throw new ControlError('ELEMENT_MOVED','控件位置已改变，旧坐标或路径不能继续使用；请重新观察或只指定 elementId');
      if(x===undefined&&y===undefined){x=box.x+box.width/2;y=box.y+box.height/2;}
      else if(!Number.isFinite(x)||!Number.isFinite(y)||x<box.x||y<box.y||x>=box.x+box.width||y>=box.y+box.height)throw new ControlError('TARGET_POINT_MISMATCH','坐标必须位于指定控件内；只传 elementId 时自动使用控件中心');
      const hittable = await handle.evaluate((el, p) => { const hit = document.elementFromPoint(p.x, p.y); return hit === el || el.contains(hit); }, {x, y});
      if (!hittable) throw new ControlError('TARGET_OCCLUDED', '控件被其他元素遮挡');
      if(semanticTarget(args))this.locations.set(args,{elementId:args.elementId,identity:expected?.identity,relocated:!!moved,observedRect:{...expected?.rect},currentRect:{x:box.x,y:box.y,width:box.width,height:box.height},point:{x,y},coordinates:'viewport CSS pixels'});
    }
    if(x===undefined&&y===undefined)throw new ControlError('TARGET_REQUIRED','请提供观察中的 elementId 或完整 x/y；输入文字也可使用观察中已聚焦的输入框');
    const viewport = await found.page.evaluate(() => ({w: innerWidth, h: innerHeight}));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.w || y >= viewport.h) throw new ControlError('OUT_OF_VIEWPORT', '坐标必须处于浏览器可视区域，单位 CSS 像素');
    return {x, y};
  }
  async preparePointer(owner,observation,args,signal){
    const found=this.cited(owner,observation);
    // Hovering can itself trigger a responsive layout or animation. Recompute
    // before pressing a button; these retries never replay a click or typing.
    for(let attempt=0;attempt<3;attempt++){
      checkAbort(signal);await this.validate(owner,observation,args);
      const point=await this.point(found,args);await this.show(owner,found.page,point);
      await found.page.mouse.move(point.x,point.y,{steps:8});
      checkAbort(signal);await this.validate(owner,observation,args);
      const current=await this.point(found,args);
      if(Math.abs(current.x-point.x)<=.5&&Math.abs(current.y-point.y)<=.5)return current;
    }
    throw new ControlError('TARGET_MOVING','控件仍在移动，本次没有按下鼠标或输入文字；请等待布局稳定后重新观察');
  }
  async resolveType(owner,observation,args){
    const found=this.cited(owner,observation);await this.checkPage(owner,found.page);let id=args.elementId;
    const hasPoint=args.x!==undefined||args.y!==undefined,focusOnly=!id&&!hasPoint;
    if(hasPoint&&(!Number.isFinite(args.x)||!Number.isFinite(args.y)))throw new ControlError('TARGET_REQUIRED','文字输入的坐标需要同时提供 x 和 y');
    if(!id){
      const candidates=(observation.elements??[]).filter(isTextTarget).filter(e=>focusOnly?e.focused:args.x>=e.rect.x&&args.y>=e.rect.y&&args.x<e.rect.x+e.rect.width&&args.y<e.rect.y+e.rect.height).sort((a,b)=>a.rect.width*a.rect.height-b.rect.width*b.rect.height);
      for(const e of candidates){
        const handle=found.elements.get(e.elementId);if(!handle)continue;
        if(focusOnly||await handle.evaluate((el,p)=>{const hit=document.elementFromPoint(p.x,p.y);return hit===el||el.contains(hit);},{x:args.x,y:args.y})){id=e.elementId;break;}
      }
    }
    const expected=found.expected?.get(id),handle=found.elements.get(id);
    if(!handle||!isTextTarget(expected))throw new ControlError('INPUT_TARGET_REQUIRED','未找到此观察中可编辑的输入目标；请先观察并指定输入框 elementId，或点击后使用 postObservation 中已聚焦的输入框');
    const bound={...args,elementId:id};this.typing.set(bound,{focusOnly});
    await this.checkTyping(found,bound,focusOnly);return bound;
  }
  async bindObservedPoint(owner,observation,args){
    if(args.elementId||!Number.isFinite(args.x)||!Number.isFinite(args.y))return args;
    const found=this.cited(owner,observation);await this.checkPage(owner,found.page);
    const candidates=(observation.elements??[]).filter(e=>args.x>=e.rect.x&&args.y>=e.rect.y&&args.x<e.rect.x+e.rect.width&&args.y<e.rect.y+e.rect.height).sort((a,b)=>a.rect.width*a.rect.height-b.rect.width*b.rect.height);
    for(const e of candidates){const handle=found.elements.get(e.elementId);if(handle&&await handle.evaluate((el,p)=>{const hit=document.elementFromPoint(p.x,p.y);return el.isConnected&&(hit===el||el.contains(hit));},{x:args.x,y:args.y}))return {...args,elementId:e.elementId};}
    return args;
  }
  async checkTyping(found,args,requireFocus){
    const handle=found.elements.get(args.elementId),expected=found.expected?.get(args.elementId);
    if(!handle||!isTextTarget(expected))throw new ControlError('INPUT_TARGET_REQUIRED','文字输入必须绑定已观察的可编辑控件');
    const state=await handle.evaluate(typingState);
    if(!state.connected)throw new ControlError('UI_CHANGED','输入目标已被替换，请重新观察');
    if(state.readonly)throw new ControlError('INPUT_READ_ONLY','输入框是只读的，未发送文字');
    if(state.disabled)throw new ControlError('ELEMENT_DISABLED','输入框已禁用，未发送文字');
    if(requireFocus&&!state.focused)throw new ControlError('FOCUS_CHANGED','输入焦点已离开此观察中的输入框，未发送文字；请重新观察，不自动改投其他输入框');
  }
  async show(owner,page,point={}){const record=this.sessions.get(owner);if(record?.host.manager&&!record.host.manager.isCurrent())throw new ControlError('BROWSER_CONTROL_REPLACED','浏览器已由更新的 DSH 实例接管');await page.evaluate(visual,{owner,group:this.groupStatus(owner),...point});}
  async hide(owner, idleMs = 0) {
    const record = this.sessions.get(owner); if (!record) return;
    if(record.host.manager&&!record.host.manager.isCurrent())return;
    await Promise.allSettled([...record.tabs.values()].map(page=>Promise.race([page.evaluate(visual,{owner,idleMs,...(idleMs===0?{visible:false}:{})}).catch(()=>{}),new Promise(r=>setTimeout(r,1000))])));
  }
  async idle(owner){const record=this.sessions.get(owner);if(!record)return;await Promise.allSettled([...record.tabs.values()].map(page=>this.show(owner,page,{phase:'thinking'})));}
  async heartbeat(owner){const record=this.sessions.get(owner);if(!record||record.host.manager&&!record.host.manager.isCurrent())return;await Promise.allSettled([...record.tabs.values()].filter(page=>!page.isClosed()).map(page=>page.evaluate(owner=>{const v=window.__dshControlVisualV1;if(v?.owner===owner&&v.host.style.display!=='none')v.lastHeartbeat=Date.now();},owner)));}
  async screenshot(owner, tabId) {
    const page = this.page(owner, tabId);
    try { const buffer = await page.screenshot({type: 'png', scale: 'css'}); return {pngBase64: buffer.toString('base64'), coordinates: 'viewport CSS pixels'}; }
    finally { await this.show(owner,page,{phase:'observe'}).catch(()=>{}); }
  }
  async capture(owner,tabId,args={}){
    captureOptions(args);const page=this.page(owner,tabId),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    const r=args.region??{x:0,y:0,...viewport};
    if(r.x<0||r.y<0||r.x+r.width>viewport.width||r.y+r.height>viewport.height)throw new ControlError('INVALID_REGION','截图区域必须处于当前浏览器可视区域');
    const width=Math.min(r.width,args.maxWidth??r.width),height=Math.max(1,Math.round(r.height*width/r.width));
    // Chromium screenshot scaling preserves CSS viewport/input geometry.
    const cdp=await page.context().newCDPSession(page),scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
    try{await page.evaluate(visual,{visible:false});let scale=width/r.width,shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:r.x+scroll.x,y:r.y+scroll.y,width:r.width,height:r.height,scale}}),buffer=Buffer.from(shot.data,'base64');
      if(buffer.readUInt32BE(16)!==width){scale*=width/buffer.readUInt32BE(16);shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:r.x+scroll.x,y:r.y+scroll.y,width:r.width,height:r.height,scale}});buffer=Buffer.from(shot.data,'base64');}
      const actualWidth=buffer.readUInt32BE(16),actualHeight=buffer.readUInt32BE(20);return {pngBase64:shot.data,width:actualWidth,height:actualHeight,captureRect:r,imageTransform:{originX:r.x,originY:r.y,scaleX:r.width/actualWidth,scaleY:r.height/actualHeight,imageWidth:actualWidth,imageHeight:actualHeight,units:'viewport CSS pixels'}};}
    finally{await cdp.detach();await this.show(owner,page,{phase:'observe'}).catch(()=>{});}
  }
  async wait(owner,tabId,args,signal){
    const options=waitOptions(args),page=this.page(owner,tabId),started=Date.now();let matched=false,target=null,polls=0;
    do{checkAbort(signal);polls++;if(options.condition==='window'||options.condition==='active-window'){matched=(await page.title()).startsWith(options.query)&&!!options.query;if(options.condition==='active-window')matched=matched&&this.record(owner).active===this.track(this.record(owner),page)&&await page.evaluate(()=>document.visibilityState==='visible');}
      else{target=await page.evaluate(({condition,query})=>{if(condition==='text')return (document.body?.innerText??'').includes(query)?{textMatched:true}:null;for(const el of document.querySelectorAll('button,a[href],input,textarea,select,[role],[contenteditable="true"],summary')){const name=el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||el.getAttribute('name')||'';const rect=el.getBoundingClientRect();if(!name.includes(query)||rect.width<1||rect.height<1||rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth)continue;if(condition==='enabled'&&(el.disabled||el.getAttribute('aria-disabled')==='true'))continue;if(condition==='focused'&&document.activeElement!==el)continue;return {name,enabled:!el.disabled,focused:document.activeElement===el};}return null;},options);matched=!!target;}
      if(matched)break;await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()-started<options.waitMs);
    return {matched,timedOut:!matched,elapsedMs:Date.now()-started,condition:options.condition,query:options.query,polls,target};
  }
  async validate(owner,observation,args={},revalidate=false,options={}){
    revalidate=revalidate||this.revalidations.has(args);if(revalidate)this.revalidations.add(args);
    const found=this.cited(owner,observation);await this.checkPage(owner,found.page);
    const version=await found.page.evaluate(domWatch),source=await found.page.evaluate(()=>window.__dshControlDOMWatchV1.sourceId);
    if(source!==found.uiSourceId)throw new ControlError('UI_CHANGED','页面文档已替换，请重新观察');
    if(args.action==='type')await this.checkTyping(found,args,this.typing.get(args)?.focusOnly===true);
    if(!revalidate&&(version===found.uiVersion&&!args.elementId&&args.action!=='type'||['navigate','back','forward','reload','select-tab','close-tab'].includes(args.action)))return found;
    const expected=found.expected?.get(args.elementId),handle=found.elements.get(args.elementId);
    if(expected&&handle){const current=await handle.evaluate(elementInfo),connected=await handle.evaluate(el=>el.isConnected);
      if(connected&&(!current.disabled||options.allowDisabled)&&['identity','tag','role','name','href','type','editable','editingHost'].every(k=>current[k]===expected[k])){
        if(revalidate&&expected.password)throw new ControlError('STALE_OBSERVATION','密码输入框需要新观察，不自动延长旧观察');
        if(revalidate&&found.values?.has(args.elementId)&&(found.values.get(args.elementId)===null||typeof current._value!=='string'||createHash('sha256').update(current._value).digest('hex')!==found.values.get(args.elementId)))throw new ControlError('TARGET_VALUE_CHANGED','输入内容已在观察后改变，请重新观察，未执行输入');
        await this.point(found,args,options.allowDisabled===true);return found;
      }
    }
    throw new ControlError('UI_CHANGED','操作目标或页面已改变，请重新观察；无关页面动画不影响已核验的同一控件');
  }

  async paths(owner,args,observation,signal){
    const found=await this.validate(owner,observation,args),page=found.page,{strokes,durationMs}=strokeOptions(args,'browser');const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    let bound={x:0,y:0,...viewport},drawingHandle;if(args.elementId){drawingHandle=found.elements.get(args.elementId);if(!drawingHandle)throw new ControlError('ELEMENT_GONE','绘制控件不存在');bound=await drawingHandle.boundingBox();if(!bound)throw new ControlError('ELEMENT_HIDDEN','绘制控件不可见');}
    const pointCheck=p=>{if(p.x<bound.x||p.y<bound.y||p.x>=bound.x+bound.width||p.y>=bound.y+bound.height)throw new ControlError('OUT_OF_VIEWPORT','路径超出已观察绘制目标');};for(const path of strokes)for(const p of path)pointCheck(p);
    const hit=async points=>{if(!drawingHandle)return;const safe=await drawingHandle.evaluate((el,{points,bound})=>{const r=el.getBoundingClientRect();if(!el.isConnected||['x','y','width','height'].some(k=>Math.abs(r[k]-bound[k])>1))return false;return points.every(p=>{const found=document.elementFromPoint(p.x,p.y);return found===el||el.contains(found);});},{points,bound});if(!safe)throw new ControlError('TARGET_OCCLUDED','绘制控件移动、移除或被遮挡，停止路径');};
    await hit(strokes.flat());
    const count=strokes.reduce((n,p)=>n+p.length-1,0),started=Date.now();let completedStrokes=0;
    for(const path of strokes){checkAbort(signal);await this.point(found,path[0]);await hit([path[0]]);await page.mouse.move(path[0].x,path[0].y);await this.show(owner,page,path[0]);await page.mouse.down({button:args.button??'left'});
      try{for(let i=1;i<path.length;i++){checkAbort(signal);await this.point(found,path[i]);await hit([path[i]]);await page.mouse.move(path[i].x,path[i].y,{steps:Math.min(8,Math.max(1,Math.ceil(Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y)/4)))});await this.show(owner,page,path[i]);await new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.floor(durationMs/count))));}completedStrokes++;}
      finally{await page.mouse.up({button:args.button??'left'}).catch(()=>{});}
    }
    return {performed:true,mode:'mouse',tabId:observation.tabId,completedStrokes,elapsedMs:Date.now()-started};
  }
  async execute(owner, action, args, observation, signal) {
    checkAbort(signal);
    const onAbort = () => { void this.pause(owner); };
    signal.addEventListener('abort', onAbort, {once: true});
    try {
      if (action === 'open') {
        const url = validUrl(args.url ?? 'about:blank'), record = await this.context(owner);
        checkAbort(signal);
        const page=await record.context.newPage();record.active=await this.admit(owner,page);
        await this.show(owner, page); await page.goto(url, {waitUntil: 'domcontentloaded'}); await this.show(owner, page);
        return {tabId: record.active};
      }
      if (action === 'close-browser') {if([...(this.sessions.get(owner)?.tabs.keys()??[])].some(id=>this.loans.get(id)?.childSessionId===owner))throw new ControlError('BORROWED_TAB_CLOSE','当前持有借用标签，请先 return-tab 归还，不能关闭主会话页面');await this.close(owner); return {closed: true}; }
      if(action==='type'&&!this.typing.has(args))args=await this.resolveType(owner,observation,args);
      const found=await this.validate(owner,observation,args),page=found.page;
      if(action==='strokes'||action==='drag'&&(args.path||args.strokes))return await this.paths(owner,args,observation,signal);
      if (action === 'navigate') { await this.show(owner, page); await page.goto(validUrl(args.url), {waitUntil: 'domcontentloaded'}); await this.show(owner, page); return {url: page.url()}; }
      if (action === 'select-tab') { await page.bringToFront(); this.record(owner).active = observation.tabId; await this.persistRecord(this.record(owner));await this.show(owner, page); return {tabId: observation.tabId}; }
      if (action === 'close-tab') {if(this.loans.get(observation.tabId)?.childSessionId===owner)throw new ControlError('BORROWED_TAB_CLOSE','这是借用标签，请用 return-tab 归还，不能关闭主会话页面');await page.close();await this.persistRecord(this.record(owner));return {closed: true}; }
      if (action === 'back' || action === 'forward' || action === 'reload') { await this.show(owner, page); await page[action === 'back' ? 'goBack' : action === 'forward' ? 'goForward' : 'reload']({waitUntil: 'domcontentloaded'}); await this.show(owner, page); return {url: page.url()}; }
      const mode = args.mode ?? 'mouse';
      if (!['mouse', 'dom'].includes(mode)) throw new ControlError('INVALID_MODE', '浏览器模式必须为 mouse 或 dom');
      if (mode === 'dom') {
        const element = found.elements.get(args.elementId);
        if (!element || !await element.evaluate(el => el.isConnected)) throw new ControlError('ELEMENT_REQUIRED', 'DOM 后台操作需要有效 elementId');
        await this.show(owner, page);
        if (action === 'click') await element.evaluate(el => { if (el.disabled) throw new Error('控件已禁用'); el.click(); });
        else if (action === 'type') {await this.checkTyping(found,args,this.typing.get(args)?.focusOnly===true);await element.fill(args.text);}
        else throw new ControlError('DOM_UNSUPPORTED', 'DOM 模式支持 click 和 type；其他动作使用 mouse 模式');
      } else if(action==='key'){await this.show(owner,page,{keyboardInjection:true});try{await page.keyboard.press(args.key);}finally{await page.evaluate(visual,{keyboardInjection:false}).catch(()=>{});}}
      else {
        const focusOnly=action==='type'&&this.typing.get(args)?.focusOnly;
        const point = focusOnly?await this.point(found,args):await this.preparePointer(owner,observation,args,signal);await this.show(owner,page,point);
        if (action === 'click') await page.mouse.click(point.x, point.y, {button: args.button ?? 'left', clickCount: integer(args.count ?? 1, 'count', 1, 3)});
        else if (action === 'hover') { /* preparePointer already performed and verified the hover */ }
        else if (action === 'type') {
          if(!this.typing.get(args)?.focusOnly)await page.mouse.click(point.x, point.y);
          await this.validate(owner,observation,args);await this.checkTyping(found,args,true);checkAbort(signal);
          if (args.replace !== false){await page.keyboard.press('ControlOrMeta+A');await this.validate(owner,observation,args);await this.checkTyping(found,args,true);checkAbort(signal);}
          await page.keyboard.insertText(args.text);
        } else if (action === 'scroll') await page.mouse.wheel(args.deltaX ?? 0, args.deltaY ?? 0);
        else if (action === 'drag') {
          const end = await this.point(found, {x: args.endX, y: args.endY});
          await page.mouse.move(point.x, point.y); await page.mouse.down({button: args.button ?? 'left'});
          try { await page.mouse.move(end.x, end.y, {steps: 20}); } finally { await page.mouse.up({button: args.button ?? 'left'}); }
          await this.show(owner, page, end);
        } else throw new ControlError('UNKNOWN_ACTION', '未知浏览器动作');
      }
      await this.pendingPages(this.record(owner));checkAbort(signal);const geometry=this.locations.get(args);return {performed:true,mode,tabId:this.record(owner).active??observation.tabId,...(geometry?{targetGeometry:geometry}:{})};
    } catch (error) {
      if (signal.aborted || error.name === 'TimeoutError') {
        await this.pause(owner).catch(() => {});
        throw new ControlError(signal.aborted ? 'CANCELLED' : 'OPERATION_TIMEOUT', '浏览器操作已暂停，保留标签与窗口；重新观察后继续，不能重放未确认动作');
      }
      throw error;
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  async close(owner) {
    const launching = this.launches.get(owner); if (launching) await launching.catch(() => {});
    const record = this.sessions.get(owner);
    if(record){await this.hide(owner);this.sessions.delete(owner);for(const page of record.tabs.values()){this.pageOwners.delete(page);if(record.host.managed)await page.close().catch(()=>{});}await record.host.persistence.catch(()=>{});this.manager?.forget(owner);if(![...this.sessions.values()].some(r=>r.host===record.host)){if(record.host.manager&&!record.host.manager.entries().length&&record.context.pages().every(p=>p.url()==='about:blank'))await Promise.race([record.host.groups.cdp.send('Browser.close').catch(()=>{}),new Promise(r=>setTimeout(r,2000))]);await record.host.groups.dispose(!record.host.managed);this.hosts.delete(record.host.key);await record.host.browser.close().catch(()=>{});}}else this.manager?.forget(owner);
  }
  async dispose(){await Promise.allSettled([...this.hostLaunches.values(),...this.launches.values()]);await Promise.allSettled([...this.sessions.keys()].map(owner=>this.manager?this.suspend(owner):this.close(owner)));for(const host of this.hosts.values()){await host.groups.dispose(!host.managed);await host.browser.close().catch(()=>{});}this.hosts.clear();}
}
