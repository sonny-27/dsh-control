import z from '@deepseek-ai/schemastery';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {ControlError, Coordinator, Observations, abortable, checkAbort, integer, ownerOf} from './lib/common.js';
import {MODES, PermissionGate, sessionPermissions} from './lib/policy.js';
import {Native} from './lib/native.js';
import {Browser, validUrl} from './lib/browser.js';
import {mountGui} from './lib/gui.js';
import {Presence} from './lib/presence.js';
import {Evidence} from './lib/evidence.js';
import {Consents} from './lib/consent.js';
import {BatchPlans} from './lib/batch.js';
import {Vision,VISION_FIELDS,visionSettings} from './lib/vision.js';
import {waitOptions,captureOptions,imagePoint,strokeOptions,batchSteps,waitConditions} from './lib/advanced.js';

export const name = 'dsh-control';
export const inject = ['tools', 'approval', 'sandboxPolicy', 'llm'];
export const Config = z.object({
  permissionMode: z.union(MODES).default('follow-session').description('权限策略（始终受当前 DSH 会话权限约束）'),
  reviewerProvider: z.string().default('').description('审批模型供应商；留空跟随当前会话'),
  reviewerModel: z.string().default('').description('审批模型名称；留空跟随当前会话'),
  reviewerTimeoutMs: z.natural().min(1000).max(120000).default(30000),
  visionMode:z.union(['off','assist']).default('off').description('独立视觉辅助，为非视觉主模型返回截图文字和定位候选'),
  visionProvider:z.string().default('').description('视觉模型供应商，使用 DSH 已配置连接'),
  visionModel:z.string().default('').description('支持图片输入的视觉模型 ID'),
  visionTimeoutMs:z.natural().min(1000).max(120000).default(30000),
  operationTimeoutMs: z.natural().min(1000).max(120000).default(30000),
  observationMaxAgeMs: z.natural().min(1000).max(300000).default(60000),
  browserRevalidationMaxAgeMs:z.natural().min(60000).max(1800000).default(600000).description('浏览器超时观察的精确目标重新核验上限；不续期旧截图'),
  indicatorIdleMs: z.natural().max(30000).default(5000),
  browserChannel: z.union(['chrome', 'msedge', 'chromium']).default('chrome'),
  browserExecutable: z.string().default(''),
  browserProfileDir: z.string().default(''),
  preserveBrowserOnExit:z.boolean().default(true).description('专用浏览器独立运行，DSH 重启时保留窗口和标签'),
  browserApproval:z.union(['session-sites','per-action']).default('session-sites').description('浏览器站点浏览授权复用或每次审批'),
  stateDir: z.string().default('')
});
export function resolveConfig(raw = {}) {
  const config = {permissionMode: 'follow-session', reviewerProvider: '', reviewerModel: '', reviewerTimeoutMs: 30000, visionMode:'off',visionProvider:'',visionModel:'',visionTimeoutMs:30000,operationTimeoutMs: 30000, observationMaxAgeMs: 60000, indicatorIdleMs: 5000, browserChannel: 'chrome', browserExecutable: '', browserProfileDir: '',browserApproval:'session-sites', stateDir: '', ...raw};
  config.browserRevalidationMaxAgeMs??=600000;
  config.preserveBrowserOnExit??=true;
  if(typeof config.preserveBrowserOnExit!=='boolean')throw new ControlError('INVALID_CONFIG','preserveBrowserOnExit 必须为布尔值');
  integer(config.browserRevalidationMaxAgeMs,'browserRevalidationMaxAgeMs',60000,1800000);
  Object.assign(config,visionSettings(config));integer(config.visionTimeoutMs,'visionTimeoutMs',1000,120000);
  if (!MODES.includes(config.permissionMode)) throw new ControlError('INVALID_CONFIG', '未知权限策略');
  if(!['session-sites','per-action'].includes(config.browserApproval))throw new ControlError('INVALID_CONFIG','未知浏览器授权方式');
  for (const [key, min, max] of [['reviewerTimeoutMs', 1000, 120000], ['operationTimeoutMs', 1000, 120000], ['observationMaxAgeMs', 1000, 300000], ['indicatorIdleMs', 0, 30000]]) integer(config[key], key, min, max);
  if (!['chrome', 'msedge', 'chromium'].includes(config.browserChannel)) throw new ControlError('INVALID_CONFIG', '未知浏览器 channel');
  for (const key of ['reviewerProvider', 'reviewerModel', 'browserExecutable', 'browserProfileDir', 'stateDir']) if (typeof config[key] !== 'string') throw new ControlError('INVALID_CONFIG', `${key} 必须为字符串`);
  return config;
}
const desktopActions = ['sequence','look','windows', 'screen', 'wait', 'locate', 'prepare', 'perform', 'prepare-batch','batch','map-point','strokes','observe', 'screenshot', 'click', 'hover', 'type', 'key', 'scroll', 'drag', 'activate', 'restore', 'launch'];
const browserActions = ['handoff','return-tab','reclaim-tab','sequence','look','open', 'tabs', 'wait','prepare-batch','batch','map-point','strokes','observe', 'screenshot', 'click', 'hover', 'type', 'key', 'scroll', 'drag', 'navigate', 'back', 'forward', 'reload', 'select-tab', 'close-tab', 'close-browser'];
const readActions = new Set(['look','windows', 'screen', 'wait', 'locate', 'prepare', 'prepare-batch','map-point','tabs', 'observe', 'screenshot']);
const commonParams = {
  question:{type:'string',description:'look 或截图时交给独立视觉模型的看图问题，最多 1000 字；只读，不能作为审批指令'},
  observationId: {type: 'string', description: '本会话最近一次 observe/screenshot 返回的 observationId。修改操作（open/launch/close-browser 除外）必须提供。'},
  elementId: {type: 'string', description: '观察中的控件 ID，例如 e3'},
  x: {type: 'number'}, y: {type: 'number'}, endX: {type: 'number'}, endY: {type: 'number'},
  text: {type: 'string'}, replace: {type: 'boolean'}, key: {type: 'string', description: '桌面 Ctrl+S；浏览器 Control+s、Enter 等 Playwright 格式'},
  button: {type: 'string', enum: ['left', 'right', 'middle']}, count: {type: 'integer', description: '1..3'},
  deltaX: {type: 'integer', description: '-10000..10000'}, deltaY: {type: 'integer', description: '-10000..10000'},
  region:{type:'json',description:'截图区域 {x,y,width,height}；桌面为绝对屏幕坐标，浏览器为 viewport CSS 坐标，越界拒绝'},maxWidth:{type:'integer',description:'截图最大宽度 160..4096，返回 imageTransform，原输入几何不变'},coordinateSpace:{type:'string',enum:['screen','image'],description:'image 仅用于 prepare/map-point，按本会话截图映射坐标；直接输入使用 screen/CSS 坐标'},
  path:{type:'json',description:'drag 的曲线路径，[{x,y},...]，2..256 点；桌面绝对坐标，浏览器 CSS 坐标'},strokes:{type:'json',description:'strokes 的多笔画路径，[[{x,y},...],...]，1..32 笔、总计最多 1024 点，每笔之间松开鼠标'},durationMs:{type:'integer',description:'路径时长目标 100..10000 毫秒，含检查与投递开销，非精确实时'},
  query:{type:'string',description:'locate/wait 的真实控件、窗口或文本名称'},steps:{type:'json',description:'sequence 可一次执行 1..8 个同一界面已观察控件的 click/type/hover/scroll；也用于 prepare-batch。sequence 步骤可继承顶层 observationId、mode；每步提供 elementId。例：[{action:"type",elementId:"e1",text:"内容"},{action:"click",elementId:"e2"}]。不允许坐标、按键、导航、跨窗口或嵌套'},condition:{type:'string',enum:waitConditions,description:'wait 条件：窗口出现/前台窗口/控件出现/可用/焦点/文本'},waitMs:{type:'integer',description:'wait 200..10000 毫秒，完成或超时都返回新观察与截图'},requestId:{type:'string',description:'perform 或 batch 原样复制主机登记的 requestId，不可覆盖目标或步骤'}
};
function validateAction(kind, args) {
  const valid = kind === 'desktop' ? desktopActions : browserActions;
  if (!valid.includes(args.action)) throw new ControlError('INVALID_ACTION', '未知动作');
  if(['handoff','return-tab','reclaim-tab'].includes(args.action)){if(typeof args.tabId!=='string'||!args.tabId||args.tabId.length>256)throw new ControlError('INVALID_ARGUMENT','交接需要 tabId');if(args.action==='handoff'&&(typeof args.targetSessionId!=='string'||!args.targetSessionId||args.targetSessionId.length>256))throw new ControlError('INVALID_ARGUMENT','handoff 需要直接子会话 targetSessionId');if(args.action!=='handoff'&&(typeof args.loanId!=='string'||!args.loanId))throw new ControlError('INVALID_ARGUMENT','归还/收回需要本次 loanId');}
  if(args.action==='wait')waitOptions(args);
  if(['look','screen','screenshot','wait'].includes(args.action))captureOptions(args);
  if(args.question!==undefined&&(typeof args.question!=='string'||args.question.length>1000))throw new ControlError('INVALID_QUESTION','看图问题最多 1000 字');
  if(args.action==='prepare-batch')batchSteps(args.steps);
  if(args.action==='sequence'){if(!Array.isArray(args.steps))throw new ControlError('INVALID_BATCH','sequence 需要 steps 列表');batchSteps(args.steps.map(step=>({...step,observationId:step.observationId??args.observationId,mode:step.mode??args.mode})));}
  if(args.action==='batch'&&(typeof args.requestId!=='string'||args.requestId.length>2048))throw new ControlError('INVALID_BATCH','batch 需要已登记的 requestId');
  if(args.action==='strokes'||args.action==='drag'&&(args.path||args.strokes)){strokeOptions(args,kind);if(args.endX!==undefined||args.endY!==undefined)throw new ControlError('INVALID_PATH','路径操作不能同时指定 endX/endY');}
  if(args.coordinateSpace!==undefined&&!['screen','image'].includes(args.coordinateSpace))throw new ControlError('INVALID_COORDINATE_SPACE','coordinateSpace 为 screen 或 image');
  if(args.coordinateSpace==='image'&&!['prepare','map-point'].includes(args.action))throw new ControlError('INVALID_COORDINATE_SPACE','截图像素请先 map-point 或 prepare，不直接发送输入');
  if (args.count !== undefined) integer(args.count, 'count', 1, 3);
  if (args.mode !== undefined && !(kind === 'desktop' ? ['uia', 'mouse'] : ['mouse', 'dom']).includes(args.mode)) throw new ControlError('INVALID_MODE', '操作模式无效');
  if (args.action === 'type' && (typeof args.text !== 'string' || args.text.length > 20000)) throw new ControlError('INVALID_TEXT', '输入 text 为字符串，最多 20000 字符');
  if (args.action === 'key' && (typeof args.key !== 'string' || !args.key.length || args.key.length > 100)) throw new ControlError('INVALID_KEY', 'key 必须为有效按键组合');
  for (const key of ['x', 'y', 'endX', 'endY']) if (args[key] !== undefined && !Number.isFinite(args[key])) throw new ControlError('INVALID_COORDINATE', '坐标必须为有限数字');
  for (const key of ['deltaX', 'deltaY']) if (args[key] !== undefined) integer(args[key], key, -10000, 10000);
  if (kind === 'desktop') {
    if(args.action==='locate'&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>200))throw new ControlError('QUERY_REQUIRED','locate 需要要找的控件/应用名称 query');
    for (const key of ['x', 'y', 'endX', 'endY']) if (args[key] !== undefined&&!(args.coordinateSpace==='image'&&['x','y'].includes(key))&&!(args.action==='map-point'&&['x','y'].includes(key))) integer(args[key], key);
    if (args.windowId !== undefined) integer(args.windowId, 'windowId', 1, Number.MAX_SAFE_INTEGER);
    if (args.action === 'launch' && (typeof args.file !== 'string' || !args.file || typeof (args.arguments ?? '') !== 'string')) throw new ControlError('INVALID_APP', 'launch 需要可执行文件 file');
    if (args.action === 'observe') integer(args.windowId, 'windowId', 1, Number.MAX_SAFE_INTEGER);
  } else if (args.action === 'open' || args.action === 'navigate') validUrl(args.url ?? (args.action === 'open' ? 'about:blank' : ''));
}

export class ControlRuntime {
  constructor(ctx, raw = {}, dependencies = {}) {
    this.ctx = ctx; this.config = resolveConfig(raw);
    this.coordinator = dependencies.coordinator ?? new Coordinator();
    this.native = dependencies.native ?? new Native(this.config.operationTimeoutMs);
    this.browser = dependencies.browser ?? new Browser(this.config);
    this.observations = new Observations(this.config.observationMaxAgeMs);
    this.evidence = new Evidence(this.observations);this.previews=new Map();this.plans=new Map();this.planPerform=new WeakMap();this.callPlans=new Map();
    this.batches=new BatchPlans(this,validateAction);this.uiVersions=new Map();this.changeCounts={desktop:0,browser:0,focus:0};
    this.vision=dependencies.vision??new Vision(ctx);
    this.consents=new Consents(this.native,(owner,id,agent)=>this.approvalDescriptor(owner,id,agent),event=>this.audit({kind:'consent',...event}));
    this.stateDir = this.config.stateDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-control');
    this.gate = new PermissionGate(ctx, this.config, event => this.audit(event),(phase,owner,signal)=>this.presence.start(owner,phase,signal));
    this.loadedSettings = new Set();
    this.presence = new Presence(this.native,this.browser,(owner,reason)=>{
      this.coordinator.stop(owner);
      this.consents.stop(owner);this.consents.clear(owner);
      this.gate.clearBrowser(owner);
      if(reason!=='cancelled'){try{this.ctx.get('agents')?.get(owner)?.cancel?.({kind:'user'},{keepInbox:true});}catch{/* input cancellation remains effective if the agent already ended */}}
    },event=>this.audit({kind:'presence',...event}),{
      isBusy:owner=>this.coordinator.status.owner===owner||this.consents.pending.has(owner),
      onIdle:owner=>{this.consents.clear(owner);this.gate.clearBrowser(owner);}
    });
    this.native.onEscape = () => { const owner=this.presence.owner??this.coordinator.status.owner;if(owner)void this.presence.stop(owner,'escape').catch(()=>{}); };
    this.native.onTakeover = ({owner,reason}) => { if(owner&&this.presence.owner===owner)void this.presence.stop(owner,reason).catch(()=>{}); };
    this.native.onConsent = ({owner,id,choice}) => {try{this.consents.answer(owner,id,choice);}catch{/* late replies cannot grant permissions */}};
    this.native.onUIChange = change=>{this.uiVersions.set(`desktop:${change.sourcePid}:${change.windowId}`,change.version);this.observations.invalidate('desktop',change);this.changeCounts.desktop++;};
    this.native.onFocusChange = change=>{this.observations.invalidateFocus(change.windowId);this.changeCounts.focus++;};
    this.browser.onUIChange = change=>{this.uiVersions.set(`browser:${change.owner}:${change.tabId}:${change.sourceId}`,change.version);this.observations.invalidate('browser',change);this.changeCounts.browser++;};
    this.browser.onStop = owner => {void this.presence.stop(owner,'browser-stop').catch(()=>{});};
  }
  audit(event) {
    try {
      mkdirSync(this.stateDir, {recursive: true}); const file = join(this.stateDir, 'audit.ndjson');
      if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, join(this.stateDir, 'audit.previous.ndjson'));
      appendFileSync(file, JSON.stringify({at: new Date().toISOString(), ...event}) + '\n');
    } catch { /* audit cannot leave input stuck; DSH also logs canonical tool calls */ }
  }
  settingsFile(owner) { return join(this.stateDir, 'settings', createHash('sha256').update(owner).digest('hex') + '.json'); }
  loadSettings(owner) {
    if (this.loadedSettings.has(owner)) return;
    this.loadedSettings.add(owner);
    try {
      const value = JSON.parse(readFileSync(this.settingsFile(owner), 'utf8'));
      if (!MODES.includes(value.permissionMode) || typeof value.reviewerProvider !== 'string' || typeof value.reviewerModel !== 'string') return;
      this.gate.set(owner, {permissionMode: value.permissionMode, reviewerProvider: value.reviewerProvider, reviewerModel: value.reviewerModel,browserApproval:['session-sites','per-action'].includes(value.browserApproval)?value.browserApproval:this.config.browserApproval,...visionSettings(value)});
    } catch { /* default settings apply on first use */ }
  }
  saveSettings(owner, value) {
    const dir = join(this.stateDir, 'settings'); mkdirSync(dir, {recursive: true});
    const file = this.settingsFile(owner), temp = file + '.tmp'; writeFileSync(temp, JSON.stringify(value, null, 2)); renameSync(temp, file);
  }
  status(agent) {
    const owner=ownerOf({agent}); this.loadSettings(owner);
    const settings=this.gate.settings(owner), permission=sessionPermissions(this.ctx,{agent});
    return {owner,permission,control:this.coordinator.status,presence:this.presence.status,preview:this.previews.get(owner)??null,consent:this.consents.status(owner),browserGroup:this.browser.groupStatus?.(owner)??null,browserLoans:this.browser.loanStatus?.(owner)??[],browserSites:this.gate.browserStatus(owner),stopped:this.presence.blocked.has(owner),settings:{permissionMode:settings.permissionMode,reviewerProvider:settings.reviewerProvider,reviewerModel:settings.reviewerModel,browserApproval:settings.browserApproval,...visionSettings(settings)},effectiveReview:permission.preset==='auto'?'dsh-auto-review':settings.permissionMode==='model-review'?'plugin-model-review':settings.permissionMode==='user-approval'?'user-approval':'session'};
  }
  handoffChildren(agent){const owner=ownerOf({agent});return (this.ctx.get('agents')?.list?.()??[]).filter(a=>a.session?.header?.origin==='subagent'&&a.session.header.parentSession===owner).map(a=>({id:a.session.id,title:a.session.title??a.session.meta?.title??a.session.id}));}
  async transferTab(exec,args,signal,human=false){
    const owner=ownerOf(exec);validateAction('browser',args);let sourceOwner,targetOwner,loan;
    if(args.action==='handoff'){
      const child=this.ctx.get('agents')?.get(args.targetSessionId)?.session??this.ctx.get('sessions')?.get(args.targetSessionId);
      if(!child||child.id===owner||child.header?.origin!=='subagent'||child.header.parentSession!==owner)throw new ControlError('HANDOFF_RELATION_REQUIRED','只能交给当前会话的真实直接子代理，不能交给无关会话');
      sourceOwner=owner;targetOwner=child.id;await this.browser.resume(sourceOwner);
      if(this.browser.loanStatus(owner).some(l=>l.tabId===args.tabId))throw new ControlError('LOAN_ALREADY_ACTIVE','此标签已有交接，请先归还或收回');
      const record=this.browser.record(owner);
      if(!human){const obs=this.observations.forRevalidation(owner,args.observationId,this.config.browserRevalidationMaxAgeMs).value;if(obs.tabId!==args.tabId)throw new ControlError('INVALID_OBSERVATION','交接观察必须属于该 tabId');await this.browser.validate(owner,obs,{action:'select-tab'});}
      loan={loanId:randomUUID(),tabId:args.tabId,parentSessionId:owner,childSessionId:targetOwner,parentTitle:record.groupTitle,parentColor:record.color};
    }else{
      loan=this.browser.loan(args.loanId,args.tabId);
      if(args.action==='return-tab'&&loan.childSessionId!==owner||args.action==='reclaim-tab'&&loan.parentSessionId!==owner)throw new ControlError('HANDOFF_NOT_OWNER','只能归还自己借用的标签，或收回自己交出的标签');
      sourceOwner=loan.childSessionId;targetOwner=loan.parentSessionId;await this.browser.resume(sourceOwner);
    }
    const page=this.browser.page(sourceOwner,args.tabId);await this.browser.checkPage(sourceOwner,page);
    const url=page.url(),documentTime=await page.evaluate(()=>performance.timeOrigin),target={tabId:args.tabId,url,title:await page.title(),fromSessionId:sourceOwner,toSessionId:targetOwner};
    if(!human)await this.gate.authorize(owner,exec,{kind:'browser',action:args.action,arguments:args,target},signal);
    checkAbort(signal);this.presence.check(owner);
    if(page.isClosed()||page.url()!==url||await page.evaluate(()=>performance.timeOrigin)!==documentTime)throw new ControlError('UI_CHANGED','审批期间页面已导航，未交接，请重新观察');
    await this.browser.checkPage(sourceOwner,page);await this.presence.finish(owner);
    const result=await this.browser.transferPage(sourceOwner,targetOwner,args.tabId,loan);
    this.observations.dropBrowserTab(args.tabId);for(const id of [sourceOwner,targetOwner]){this.consents.clear(id);this.gate.clearBrowser(id);}
    this.audit({owner,kind:'browser',action:args.action,fromSessionId:sourceOwner,toSessionId:targetOwner,tabId:args.tabId,result:'success'});return result;
  }
  async handoffGui(agent,args){const owner=ownerOf({agent});this.loadSettings(owner);this.presence.check(owner);return this.coordinator.run(owner,'browser:'+args.action,undefined,signal=>this.transferTab({agent,name:'control_browser',signal},args,signal,true));}
  updateSettings(owner, changes) {
    this.loadSettings(owner);
    if(this.coordinator.status.owner===owner) throw new ControlError('CONTROL_BUSY','请先停止当前操作再修改设置');
    if(!changes || typeof changes!=='object' || Array.isArray(changes) || Object.keys(changes).some(k=>!['permissionMode','reviewerProvider','reviewerModel','browserApproval',...VISION_FIELDS].includes(k))) throw new ControlError('INVALID_SETTING','设置字段无效');
    const value={...this.gate.settings(owner),...changes};
    if(!MODES.includes(value.permissionMode)) throw new ControlError('INVALID_SETTING','未知权限策略');
    if(!['session-sites','per-action'].includes(value.browserApproval))throw new ControlError('INVALID_SETTING','未知浏览器授权方式');
    for(const key of ['reviewerProvider','reviewerModel']) if(typeof value[key]!=='string'||value[key].length>512||/[\r\n\0]/.test(value[key])) throw new ControlError('INVALID_SETTING','审批模型字段无效');
    const saved={permissionMode:value.permissionMode,reviewerProvider:value.reviewerProvider.trim(),reviewerModel:value.reviewerModel.trim(),browserApproval:value.browserApproval,...visionSettings(value)};
    if(Boolean(saved.reviewerProvider)!==Boolean(saved.reviewerModel)) throw new ControlError('INVALID_SETTING','审批供应商和模型需要一起选择，或一起跟随会话');
    this.consents.clear(owner);this.gate.clearBrowser(owner);this.saveSettings(owner,saved); this.gate.set(owner,saved); return saved;
  }
  remember(owner, data) {const observed={...data,observedAt:Date.now()},id=this.observations.add(owner,Object.fromEntries(Object.entries(observed).filter(([key])=>key!=='pngBase64')));const key=data.kind==='desktop'?`desktop:${data.uiSourcePid}:${data.windowId}`:`browser:${owner}:${data.tabId}:${data.uiSourceId}`,version=this.uiVersions.get(key);if(data.kind==='browser'&&version!==undefined&&data.uiVersion!==undefined&&data.uiVersion<version)this.observations.invalidate(data.kind,{windowId:data.windowId,tabId:data.tabId,sourceId:data.uiSourceId,version});return {...observed,observationId:id};}
  plan(owner,observation,target,count=1,coordinates={}){
    const args={action:'click',mode:'mouse',windowId:target.windowId??observation.windowId,button:'left',count,...coordinates};
    if(target.elementId)args.elementId=target.elementId;
    const targetEvidence=this.evidence.sign(owner,observation.observationId,observation,args,target);
    const click={...args,observationId:observation.observationId,targetEvidence};
    const name=(target.name||observation.title||'已观察目标').slice(0,120),requestId=`${count===2?'鼠标双击':'鼠标单击'} ${name} · ${target.source??'window-element'} · HWND ${args.windowId} · ${randomUUID()}`;
    this.plans.set(requestId,{owner,click});while(this.plans.size>128)this.plans.delete(this.plans.keys().next().value);
    this.planPerform.set(click,{action:'perform',requestId});return click;
  }
  resolvePlan(owner,args){
    if(args.action==='perform'){
      if(Object.keys(args).some(k=>!['action','requestId'].includes(k)))throw new ControlError('TARGET_PLAN_CHANGED','perform 只接受 requestId，不能覆盖已登记方案');
      const plan=this.plans.get(args.requestId);if(!plan||plan.owner!==owner)throw new ControlError('INVALID_PLAN','请求编号不存在或属于其他会话，请重新定位');
      return this.evidence.resolve(owner,plan.click).args;
    }
    return args.targetEvidence?this.evidence.resolve(owner,args).args:args;
  }
  preview(owner,args){
    try{args=this.resolvePlan(owner,args);const facts=this.evidence.verify(owner,args),preview={valid:true,action:'鼠标点击',targetName:facts.name,windowTitle:facts.windowTitle,source:facts.source,count:facts.plan.count,button:facts.plan.button,rect:facts.rect,observedAt:facts.observedAt};this.previews.set(owner,preview);return preview;}
    catch(error){if(args.targetEvidence)this.previews.set(owner,{valid:false,message:error.message});else this.previews.delete(owner);return null;}
  }
  bindCall(owner,id,args,kind='desktop'){if(id){this.callPlans.set(owner+':'+id,{kind,args});while(this.callPlans.size>128)this.callPlans.delete(this.callPlans.keys().next().value);}}
  approvalDescriptor(owner,id,agent){
    try{const call=this.callPlans.get(owner+':'+id);if(!call||this.gate.settings(owner).permissionMode!=='user-approval')return null;
      if(call.args.action==='batch'){const descriptor=this.batches.descriptor(owner,call.kind,call.args);return {key:{batch:descriptor,permission:sessionPermissions(this.ctx,{agent}),permissionMode:'user-approval'},summary:'批量 '+descriptor.steps.map(s=>s.input.action+' '+s.element.name).join(' / ')+'（同一界面，逐步核验）'};}
      let args=call.kind==='desktop'?this.resolvePlan(owner,call.args):call.args;if(!['click','hover','scroll','key','type'].includes(args.action))return null;
      const observation=this.observations.get(owner,args.observationId,call.kind),element=observation.elements?.find(e=>e.elementId===args.elementId),facts=args.targetEvidence?this.evidence.verify(owner,args):null;
      const identity=element?.identity??element?.automationId??(call.kind==='browser'?JSON.stringify([element?.name,element?.role,element?.rect]):null);if(!identity&&!facts?.name)return null;
      const permission=sessionPermissions(this.ctx,{agent}),settings=this.gate.settings(owner);
      const target={kind:call.kind,windowId:observation.windowId,processId:observation.processId,processStart:observation.processStart,className:observation.className,name:element?.name??facts?.name,role:element?.role??facts?.role,identity:identity??facts?.plan.elementId,windowTitle:observation.title,url:observation.url,tabId:observation.tabId};
      const input={action:args.action,mode:args.mode??'uia',button:args.button??'left',count:args.count??1,key:args.key??null,replace:args.replace??null,textHash:args.text===undefined?null:createHash('sha256').update(args.text).digest('hex'),deltaX:args.deltaX??0,deltaY:args.deltaY??0};
      return {key:{target,input,permission,permissionMode:settings.permissionMode},summary:`${input.mode==='mouse'?'鼠标':'后台'} ${input.action} · ${target.name||target.windowTitle} · ${input.count===2?'双击':'单次'}（本会话同目标同参数）`};
    }catch{return null;}
  }
  sessionEvent(session,event){
    const owner=String(session.id);
    if(event.type==='user/message'&&event.data?.source?.kind==='user')void this.presence.newTurn(owner);
    if(['tool/call','tool/ptc-dispatch-start'].includes(event.type)&&['control_desktop','control_browser'].includes(event.data?.name)){
      let args=event.data.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{args={};}args=args??{};
      this.preview(owner,args);void this.presence.start(owner,readActions.has(args.action)?'observe':'review',undefined,event.data.name==='control_browser'?'browser':'desktop').catch(error=>this.audit({owner,kind:'presence',event:'show-failed',code:error.code??'ERROR'}));
      this.bindCall(owner,event.data.callId??event.data.subCallId,args,event.data.name==='control_browser'?'browser':'desktop');
    }
    if(event.type==='approval/asked'&&this.presence.owner===owner)void this.presence.start(owner,'approval').catch(()=>{});
    if(event.type==='approval/decided'&&this.presence.owner===owner)void this.presence.start(owner,'thinking').catch(()=>{});
    if(event.type==='turn/end'){this.previews.delete(owner);void this.presence.finish(owner);}
    if(['permission/preset','sandbox/mode','approval/policy'].includes(event.type)){this.consents.clear(owner);this.gate.clearBrowser(owner);}
  }
  async capture(owner, kind, args, signal) {
    if(args.action==='look'){
      if(this.gate.settings(owner).visionMode!=='assist')throw new ControlError('VISION_NOT_CONFIGURED','请先在电脑操控 GUI 开启视觉辅助，并选择视觉供应商和模型');
      args={...args,action:kind==='desktop'&&args.windowId===undefined?'screen':'screenshot',maxWidth:args.maxWidth??1280};
    }
    if(args.action==='prepare-batch')return await this.batches.prepare(owner,kind,args,signal);
    if(args.action==='map-point'){const observed=this.observations.get(owner,args.observationId,kind,true);return {point:imagePoint(observed,args.x,args.y),coordinates:kind==='desktop'?'absolute screen pixels':'viewport CSS pixels',observationId:args.observationId,hint:'只换算该历史截图的像素，不执行输入；实际点击仍核验当前目标和几何。',...(observed.windowId===undefined?{}:{windowId:observed.windowId}),...(observed.tabId===undefined?{}:{tabId:observed.tabId})};}
    if(args.action==='wait'){const wait=kind==='desktop'?await this.native.call('wait-for',waitOptions(args),signal):await this.browser.wait(owner,args.tabId,args,signal);return {...await this.capture(owner,kind,{action:kind==='desktop'?'screen':'screenshot',tabId:args.tabId,...captureOptions(args)},signal),wait,hint:wait.matched?'指定界面条件已满足，使用这次新观察继续。':'等待上限已到；根据新截图判断，不查询进程或盲目重复启动。'};}
    if (kind === 'desktop') {
      if(args.action==='locate'){
        const result=await this.native.call('locate',{query:args.query,windowId:args.windowId},signal),candidates=[];
        for(const group of result.groups??[]){const observation=this.remember(owner,{kind,...group.observation,coordinates:'absolute screen pixels'});
          for(const target of group.matches){const count=target.source==='desktop-shortcut'?2:1,click=this.plan(owner,observation,target,count);candidates.push({...target,windowId:observation.windowId,perform:this.planPerform.get(click),click});}}
        const priority=t=>t.visibleAtPoint?(t.source==='taskbar-application'?0:t.source==='notification-area'?3:1):4;
        candidates.sort((a,b)=>priority(a)-priority(b));
        return {query:args.query,candidates,matchingWindows:result.matchingWindows??[],hint:candidates.length?'选择名称与用户目标一致且 visibleAtPoint:true 的 candidate，直接复制其 perform（action 和 requestId），无需再次 prepare、observe 或拼接 click 证据；实际点击使用 mouse。桌面图标被挡时，可 locate 显示桌面并用鼠标点击，再重新定位应用。':'没有找到可见的匹配控件；可 screen 后 prepare 检查已观察坐标。不要猜系统托盘图标、扫描快捷方式文件或修改审批设置。'};
      }
      if(args.action==='prepare'){
        const observation=this.observations.get(owner,args.observationId,'desktop');
        if(args.coordinateSpace==='image')args={...args,...imagePoint(observation,args.x,args.y)};
        const target=await this.native.call('inspect',{nativeObservation:observation.nativeObservation,windowId:args.windowId??observation.windowId,elementId:args.elementId,x:args.x,y:args.y},signal);
        const source=target.window?.nativeObservation?this.remember(owner,{kind,...target.window}):{...observation,...(target.window??{}),observationId:args.observationId};
        const point=target.elementId?{}:{x:args.x,y:args.y};const click=this.plan(owner,source,target,args.count??1,point);
        this.preview(owner,click);return {target,perform:this.planPerform.get(click),click,hint:'优先调用 perform，只复制 requestId 即可；不能覆盖方案。只绑定观察事实，不授予权限，DSH Auto Review 仍判断当前任务。'};
      }
      if (args.action === 'windows') return await this.native.call('windows', {}, signal);
      const screen = args.action === 'screen' || (args.action === 'screenshot' && args.windowId === undefined);
      const data = await this.native.call(screen ? 'screen' : 'observe', screen ? {} : {windowId: args.windowId}, signal);
      const pixels=screen||args.action==='screenshot'||this.gate.settings(owner).visionMode==='assist'?await this.native.call('screenshot',{...(screen?{nativeObservation:data.nativeObservation}:{windowId:args.windowId}),...captureOptions({...args,maxWidth:args.maxWidth??(this.gate.settings(owner).visionMode==='assist'?1280:undefined)})},signal):{};
      return this.remember(owner,{kind,...data,...pixels,coordinates:'absolute screen pixels; imageTransform maps returned image pixels to screen'});
    }
    if (args.action === 'tabs') return await this.browser.tabs(owner);
    const data=await this.browser.observe(owner,args.tabId),pixels=args.action==='screenshot'||this.gate.settings(owner).visionMode==='assist'?await this.browser.capture(owner,data.tabId,{...args,maxWidth:args.maxWidth??(this.gate.settings(owner).visionMode==='assist'?1280:undefined)}):{};
    return this.remember(owner,{...data,...pixels});
  }
  async assist(owner,data,args,signal) {
    const settings=this.gate.settings(owner);
    if(settings.visionMode!=='assist')return data;
    if(data.pngBase64){
      try {
        data.vision=await this.vision.describe(data,settings,args.question,signal);
        this.presence.check(owner);checkAbort(signal);
        // Never expose coordinates whose observation expired or changed while
        // the helper model was reading it. The normal input gate still applies.
        this.observations.get(owner,data.observationId,data.kind);
      }catch(error){
        checkAbort(signal);this.presence.check(owner);
        data.vision={ok:false,error:{code:error.code??'VISION_FAILED',message:error.message},hint:'本次视觉结果不可用于输入。可使用已核验无障碍树，或解决问题后重新 look；不要猜测坐标或自动重放操作。'};
      }
      delete data.pngBase64;delete data.image;data.visualAssistance=true;
    }
    if(data.postObservation)data.postObservation=await this.assist(owner,data.postObservation,args,signal);
    return data;
  }
  async call(kind, args, exec) {
    const owner = ownerOf(exec); this.loadSettings(owner);this.presence.check(owner);if(kind==='browser'){await this.browser.resume?.(owner);this.browser.setLabel?.(owner,exec.agent.session.title??exec.agent.session.meta?.title??'');if(args.action==='select-tab'&&!args.observationId&&args.tabId){const current=await this.capture(owner,'browser',{action:'observe',tabId:args.tabId},exec.signal);args={...args,observationId:current.observationId};}}if(kind==='desktop')args=this.resolvePlan(owner,args);validateAction(kind, args);this.bindCall(owner,exec.callId,args,kind);
    this.presence.check(owner);
    return await this.coordinator.run(owner, `${kind}:${args.action}`, exec.signal, async inputSignal => {
      const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(this.config.operationTimeoutMs + this.config.reviewerTimeoutMs + (this.gate.settings(owner).visionMode==='assist'?this.config.visionTimeoutMs:0))]);
      let idlePhase='thinking';
      try {
      await this.presence.start(owner,readActions.has(args.action)?'observe':'review',signal,kind);
      if(kind==='browser'&&['handoff','return-tab','reclaim-tab'].includes(args.action))return await this.transferTab(exec,args,signal);
      if (readActions.has(args.action)) {
        if(kind==='browser'&&args.action!=='tabs')await this.browser.show(owner,this.browser.page(owner,args.tabId),{phase:'observe'});
        return await abortable(async () => this.assist(owner,await this.capture(owner, kind, args, signal),args,signal), signal, () => kind === 'browser' ? this.browser.pause?.(owner) : undefined);
      }
      if(args.action==='batch')return await this.assist(owner,await this.batches.execute(owner,kind,args,exec,signal),args,signal);
      if(args.action==='sequence')return await this.assist(owner,await this.batches.sequence(owner,kind,args,exec,signal),args,signal);
      const noObservation = args.action === 'open' || args.action === 'launch' || args.action === 'close-browser';
      const revalidatable=kind==='browser'&&['click','hover','scroll','type'].includes(args.action);
      let freshness=revalidatable?this.observations.forRevalidation(owner,args.observationId,this.config.browserRevalidationMaxAgeMs):null;
      const observation = noObservation ? undefined : freshness?.value??this.observations.get(owner,args.observationId,kind,kind==='browser'&&(args.action==='type'||!!args.elementId||['navigate','back','forward','reload','select-tab','close-tab'].includes(args.action)));
      let observationCheck;
      // Resolve actual target facts before authorizing; text and names are data.
      if (kind === 'desktop' && observation?.scope === 'screen') {
        if (args.mode !== 'mouse') throw new ControlError('SCREEN_REQUIRES_MOUSE', '全屏观察用于真实鼠标操作，请设置 mode:mouse；后台操作请先 observe 具体窗口');
        integer(args.windowId, 'windowId', 1, Number.MAX_SAFE_INTEGER);
        if (!observation.windows?.some(w => w.windowId === args.windowId)) throw new ControlError('TARGET_NOT_OBSERVED', 'windowId 必须来自此全屏观察的 windows 列表');
        if (!['click', 'hover', 'scroll', 'drag','strokes', 'key'].includes(args.action)) throw new ControlError('SCREEN_ACTION_UNSUPPORTED', '全屏观察支持鼠标/按键；输入文字、激活或还原请 observe 具体窗口');
      }
      if(kind==='browser'&&observation){
        if(args.action==='type')args=await this.browser.resolveType(owner,observation,args);
        else if(revalidatable)args=await this.browser.bindObservedPoint(owner,observation,args);
        if(freshness?.expired&&!args.elementId)throw new ControlError('STALE_OBSERVATION','旧截图坐标无法绑定同一已观察控件，请重新观察；没有执行输入');
        await this.browser.validate(owner,observation,args,freshness?.expired===true);
        if(freshness?.expired)observationCheck={revalidated:true,observationId:args.observationId,ageMs:freshness.ageMs,scope:'same-dom-target'};
      }
      const target = observation?.scope === 'screen' ? observation.windows.find(w => w.windowId === args.windowId) : observation;
      if(kind==='desktop'&&args.targetEvidence)this.evidence.verify(owner,args);
      this.preview(owner,args);
      const pending = {kind, action: args.action, arguments: args, target: target ? {windowId: target.windowId, title: target.title, className: target.className, tabId: target.tabId, url: target.url, element: target.elements?.find(e => e.elementId === args.elementId)} : undefined};
      await this.gate.authorize(owner, exec, pending, signal);
      checkAbort(signal);
      // Approval may take long enough for the observation to expire.
      if(!noObservation){
        if(revalidatable){freshness=this.observations.forRevalidation(owner,args.observationId,this.config.browserRevalidationMaxAgeMs);if(freshness.expired){if(!args.elementId)throw new ControlError('STALE_OBSERVATION','审批期间观察已过期且没有可核验控件，请重新观察');await this.browser.validate(owner,observation,args,true);observationCheck={revalidated:true,observationId:args.observationId,ageMs:freshness.ageMs,scope:'same-dom-target'};}}
        else this.observations.get(owner,args.observationId,kind,kind==='browser'&&(!!args.elementId||['navigate','back','forward','reload','select-tab','close-tab'].includes(args.action)));
      }
      this.presence.check(owner);
      await this.presence.start(owner,kind==='browser'?'browser':args.mode==='mouse'||['hover','drag','strokes','key','activate','restore'].includes(args.action)?'mouse':'uia',signal);
      let acquired = false;
      try {
        if(kind==='desktop'){await this.native.call('begin',{owner,kind:args.mode==='mouse'||['hover','drag','strokes','key','activate','restore'].includes(args.action)?'mouse':'uia'},signal);acquired=true;}
        let data;
        if (kind === 'desktop') {
          const mode = args.mode ?? (['hover', 'drag','strokes', 'key', 'activate', 'restore'].includes(args.action) ? 'mouse' : 'uia');
          data = await this.native.call(args.action, {...args, mode, ...(observation ? {nativeObservation: observation.nativeObservation} : {})}, signal);
          if (observation) {
            try { data.postObservation = this.gate.settings(owner).visionMode==='assist'?await this.capture(owner,kind,{action:observation.scope==='screen'?'screen':'screenshot',windowId:observation.scope==='screen'?undefined:observation.windowId,maxWidth:1280},signal):this.remember(owner, {kind, ...await this.native.call(observation.scope === 'screen' ? 'screen' : 'observe', observation.scope === 'screen' ? {} : {windowId: observation.windowId}, signal), coordinates: 'absolute screen pixels'}); }
            catch (error) { data.postObservationUnavailable = error.message; }
          }
        } else {
          data = await this.browser.execute(owner, args.action, args, observation, signal);
          if (!['close-tab', 'close-browser'].includes(args.action)) {
            try { data.postObservation = this.gate.settings(owner).visionMode==='assist'?await this.capture(owner,kind,{action:'screenshot',tabId:data.tabId||observation?.tabId,maxWidth:1280},signal):this.remember(owner, await this.browser.observe(owner, data.tabId || observation?.tabId)); }
            catch (error) { data.postObservationUnavailable = error.message; }
          }
        }
        if(observationCheck)data.observationCheck=observationCheck;
        this.audit({owner, kind, action: args.action, result: 'success',...(observationCheck?{revalidated:true,observationAgeMs:observationCheck.ageMs}:{})}); return await this.assist(owner,data,args,signal);
      } catch (error) {
        this.audit({owner, kind, action: args.action, result: 'error', code: error.code ?? 'ERROR'}); throw error;
      } finally {
        if (acquired) {
          try { await this.native.call('end', {idleMs: signal.aborted ? 0 : this.config.indicatorIdleMs}); } catch { /* helper was killed by Esc/timeout */ }
        }
      }
      } catch(error) {
        if(signal.aborted)await this.presence.stop(owner,'cancelled');
        else if(error.code==='HUMAN_INPUT_BUSY')await this.presence.stop(owner,'human-input');
        else if(['NATIVE_EXIT','NATIVE_TIMEOUT','INDICATOR_UNAVAILABLE'].includes(error.code))await this.presence.stop(owner,'indicator-unavailable');
        else idlePhase='blocked';
        throw error;
      } finally {await this.presence.idle(owner,idlePhase).catch(()=>{});}
    });
  }
  async renderImage(data) {
    if (!data.pngBase64) return data;
    const attachments = this.ctx.get('attachments');
    if (!attachments) { delete data.pngBase64; return {...data, imageUnavailable: 'DSH 附件服务未挂载'}; }
    const attachment = await attachments.saveImage({data: Buffer.from(data.pngBase64, 'base64'), mediaType: 'image/png', name: `dsh-control-${data.observationId}.png`});
    delete data.pngBase64; return {...data, image: attachment};
  }
  tools() {
    const output = {
      schema: {type: 'object', additionalProperties: false, properties: {ok: {type: 'boolean', required: true}, data: {type: 'json'}, error: {type: 'object', additionalProperties: false, properties: {code: {type: 'string', required: true}, message: {type: 'string', required: true}}}}},
      render: (_args, value) => { const blocks = [{type: 'text', text: JSON.stringify(value)}]; if (value.data?.image) blocks.push({type: 'image', attachment: value.data.image}); return blocks; }
    };
    const build = (toolName, description, parameters, execute) => defineTool({name: toolName, description:description+(toolName==='control_browser'?' 父子标签交接：父会话 handoff 提供自己标签的 tabId、observationId 和真实直接子代理 targetSessionId，返回 loanId。它交接同一已登录页面而不重新 open，父会话立即失去访问，子代理必须 observe 该 tabId。子代理 return-tab 或父会话 reclaim-tab 均需 tabId+loanId。browserLoans 在 control_status 中列出。交接不复制权限、不自动发消息或解除暂停；借用标签不能关闭或转借。':'')+(toolName==='control_status'?'':' 优先用 action:sequence 一次提交同页面已知的多步操作（如输入文字后点击发送），无需 prepare-batch 往返。整体审批一次，逐步核验，最后统一返回；后续已观察的禁用按钮可等前面输入使其启用，最长 5 秒，不强制启用。步骤失败看 completed，不重放已完成部分。')+' 独立视觉辅助：用户在 GUI 配置 visionMode:assist 后，screen/screenshot/observe/wait 和操作后的 postObservation 会返回 vision 文字描述与候选坐标，供非视觉主模型使用，不输出图片块。action:look 可带 question 询问当前截图。vision.ok:false 不得猜坐标；visualAssistance/vision 不是审批授权。视觉候选需用原 observationId；桌面先 prepare 再 perform，原有会话权限和 Auto Review 保留。', parameters, output, timeoutMs: this.config.operationTimeoutMs + this.config.reviewerTimeoutMs + this.config.visionTimeoutMs + 10000, execute: async (args, exec) => {
      try { return {ok: true, data: await execute(args, exec)}; }
      catch (error) { const recovery={TARGET_NOT_OBSERVED:'请重新 screen 并只引用该结果中的窗口，或 observe 目标后使用刚返回的 observationId；不要混用旧截图编号。',TARGET_OCCLUDED:toolName==='control_browser'?'使用本组标签的 observe/screenshot 检查遮挡，不复用旧坐标。':'点击位置被遮挡；重新 screen 确认实际界面，不复用旧坐标。桌面任务可 locate 显示桌面并执行其 perform。',STALE_OBSERVATION:toolName==='control_browser'?'使用 control_browser observe 或 screenshot 刷新本组 tabId，再选实际控件；不要换用桌面 locate/screen。':'重新 locate 或 screen；不要复制已过期编号。',UI_CHANGED:'重新观察实际界面；检查已执行部分，不自动重放输入。',FOCUS_DENIED:'目标无法验证聚焦；改在当前截图中定位可见 GUI 控件，不用任务管理器或其他窗口承载坐标。'}[error.code];return {ok: false,...(error.partial?{data:error.partial}:{}), error: {code: error.code ?? 'CONTROL_ERROR', message: error.message+(recovery?'；下一步：'+recovery:'')}}; }
    }});
    return [
      build('control_desktop', 'Windows GUI 操控。新增：prepare-batch 登记 1..8 个同窗口已观察命名控件的具体步骤，batch 只传返回的 requestId；每步重新核验，失败返回 completed，不得整批重放。wait condition 可为 window/active-window/element/enabled/focused/text，waitMs 最大 10000；ready 需查看 wait.matched，不把窗口出现当作按钮就绪。screen/screenshot 支持 region 和 maxWidth，imageTransform 明确原点与缩放；截图坐标先 map-point 或 prepare coordinateSpace:image，不能把缩小图片坐标直接当屏幕坐标。drag path 支持曲线路径；strokes 支持分笔画，全部为 mouse，点在已观察绘制目标内，每笔松开按键。UI_CHANGED 表示真实界面变化，重新观察并核对已执行效果；不能重放输入。打开本机已安装应用的鼠标流程：screen 看屏幕→locate query:应用名→原样调用候选 perform（只复制 requestId），实际点击使用 SendInput 鼠标。UIA 读取只用于定位，不等于 UIA 后台点击。优先 visibleAtPoint:true；桌面被挡时可 locate 显示桌面→鼠标点击→重新 locate 应用，不要把右下角按钮凭位置猜成其它系统设置。Steam/SP 可依据返回的真实控件名称识别；名称不确定时向用户核实。不要为 GUI 任务查询记忆、加载旧 dsh-click 放行技能、扫描快捷方式文件、执行截图裁剪脚本或改审批配置。已有确定截图坐标但没有命名控件时，prepare + observationId + windowId + x,y 只做命中检查，返回新 click 方案。targetEvidence 是插件签发的观察事实，执行前验签并核对会话、观察、动作、点击次数及目标几何；它不授权新任务，不替代 Auto Review。事实应与用户任务一起判断，桌面快捷方式启动既有软件和“显示桌面”均为普通可逆 GUI 操作，不是安装软件或修改系统设置。perform 从主机登记方案执行，不再手工拼接签名 JSON 或添加坐标；旧 click 接口仍兼容签名方案。方案过期则重新定位。windows/observe/screenshot 支持现有窗口；截图像素加 rect 原点，勿混用裁剪缩放坐标。明确要求鼠标时所有输入 mode:mouse，禁止偷偷改 UIA/launch/命令行。已观察的具体窗口按钮可 locate query:按钮名 + windowId（省略 windowId 只查桌面/任务栏）。启动后用 wait query:实际窗口标题 waitMs:5000 等待并获取新截图，不用 pwsh/进程查询。screen 的 windows 中已有目标不等于在前台；在截图确认后只恢复必要窗口，不重复启动已有应用。observe 返回的新 observationId 必须直接使用，不回退到旧 screen 编号。成功用 postObservation 继续；重复同一失败就报告阻碍。屏幕顶部置顶悬浮提示覆盖 PTC 审批前、查看、输入及间隔；人工审批可点允许一次或同意本会话相同请求，授权不跨会话且目标或参数改变需重问；Esc/停止随时结束。CONTROL_STOPPED 后不得自行恢复或换工具绕过。', {
        action: {type: 'string', enum: desktopActions, required: true},waitMs:{type:'integer',description:'wait 专用，200..5000 毫秒；按 GUI 窗口标题 query 等待，随后返回新截图，不查询进程'},requestId:{type:'string',description:'perform 专用：原样复制 locate/prepare 返回的 perform.requestId。仅需 action:perform 与此字段，主机执行登记的不可修改鼠标方案'}, query:{type:'string',description:'locate：要找的真实控件/应用名称'},targetEvidence:{type:'json',description:'兼容旧点击方案的签名证据；推荐 perform 避免手工复制复杂对象'}, windowId: {type: 'integer', description: 'observe 的目标窗口；全屏鼠标操作时必须是该 screen.windows 中点击位置所属的 windowId'}, mode: {type: 'string', enum: ['uia', 'mouse']}, file: {type: 'string'}, arguments: {type: 'string'}, ...commonParams
      }, async (args, exec) => this.renderImage(await this.call('desktop', args, exec))),
      build('control_browser', '浏览器会话组操作：同一专用窗口中，每个 DSH 会话有不同颜色原生标签组。只允许操作该会话归属的标签和 popup；tabs 只列本组，不能猜测或借用其他组的 tabId/observationId。状态、动画、虚拟指针和停止按钮仅在所属页面内显示，不弹桌面悬浮。GUI 可连接用户已有 Chrome/Edge，必须由用户选择要交接的标签；连接本身不向模型开放全部用户标签。人工接管暂停 AI、保留窗口和标签，恢复后重新观察。sharedCookies:true 表示同窗口资料目录共享登录状态。browserApproval:session-sites 默认首次批准站点浏览范围后，复用该会话该站点（含合法子域）的链接导航、搜索、滚动与切换；未知写操作、发布、购买、上传等仍审批，Auto Review 每次照常执行。权限或停止会清除授权。select-tab 可直接用 tabs 返回的本组 tabId，无需多取截图。页面无关动画更新不应重试；插件会核验同一控件身份、名称、链接、可用性和几何，目标变化时 UI_CHANGED 必须重新观察。输入默认 mouse（浏览器虚拟鼠标），DOM click/fill 显式 mode:dom；不移动系统光标。截图区域和 maxWidth 返回 imageTransform，map-point 映射为 viewport CSS 坐标。wait 的 window/active-window/element/enabled/focused/text 条件最多 10000 毫秒。prepare-batch 登记本标签已观察控件的 1..8 个步骤，batch 只复制 requestId，部分失败不可整批重放。drag path 和 strokes 支持曲线及多笔画，仅在已观察目标内；每笔与取消都松开输入。CONTROL_STOPPED 不得自行恢复。', {
        action: {type: 'string', enum: browserActions, required: true}, url: {type: 'string'}, tabId: {type: 'string'}, targetSessionId:{type:'string',description:'handoff 的接收方，必须是当前会话真实直接子代理 ID'},loanId:{type:'string',description:'handoff 返回的本次交接编号，return-tab/reclaim-tab 必须原样提供'},mode: {type: 'string', enum: ['mouse', 'dom']}, ...commonParams,
        observationId:{type:'string',description:'优先使用最新 postObservation/observe/screenshot 的编号。只传 elementId 的点击、输入、悬停等会在执行前重新计算同一可见控件的位置，适应窗口移动、尺寸变化与页面重排；显式 x/y、端点或路径仍绑定旧几何。坐标变化后不要照抄旧点。click/hover/scroll/type 超过 60 秒时，10 分钟内可重新核验同一 DOM 控件；目标语义、输入值改变或超过上限则需新观察，不延长整张旧截图。结果可带 observationCheck 和 targetGeometry。'},
        text:{type:'string',description:'type 的文字。目标优先用本次观察的输入框 elementId；坐标会绑定已观察的可编辑控件；两者都省略时只使用该观察中已聚焦且现在仍聚焦的输入框。点击后使用 postObservation。焦点转移/目标替换则重新观察，不自动换框。replace:false 追加，否则全选替换。光标或无关 DOM 闪烁不使已核验输入框失效。'}
      }, async (args, exec) => this.renderImage(await this.call('browser', args, exec))),
      build('control_status', '查看本会话的操控设置、审批模型和 DSH 有效权限；设置只能由用户通过 GUI 或 /control 命令修改。', {}, async (_args, exec) => {
        return this.status(exec.agent);
      })
    ];
  }
  async command(agent, rawInput) {
    const owner = ownerOf({agent}); this.loadSettings(owner);
    const parts = rawInput.trim().split(/\s+/), [action, first, ...rest] = parts;
    if (!action || action === 'status') { const s = this.gate.settings(owner); return {kind: 'success', text: JSON.stringify({permission: sessionPermissions(this.ctx, {agent}), mode: s.permissionMode, reviewerProvider: s.reviewerProvider || '(会话模型)', reviewerModel: s.reviewerModel || '(会话模型)'}, null, 2)}; }
    if (action === 'stop') { await this.presence.stop(owner); return {kind: 'success', text: '已停止本轮操控；模型不能自行重新接管'}; }
    if (action === 'resume') { if(this.coordinator.status.owner)throw new ControlError('CONTROL_BUSY','请等待当前操作结束');await this.presence.newTurn(owner);return {kind:'success',text:'已允许本会话的新操控任务'}; }
    if (this.coordinator.status.owner === owner) throw new ControlError('CONTROL_BUSY', '请先停止当前操作再修改设置');
    let changes;
    if (action === 'mode' && MODES.includes(first)) changes = {permissionMode: first};
    else if (action === 'reviewer' && first === 'session') changes = {reviewerProvider: '', reviewerModel: ''};
    else if (action === 'reviewer' && first && rest.length) changes = {reviewerProvider: first, reviewerModel: rest.join(' ')};
    else if (action === 'models' && first) return {kind: 'success', text: JSON.stringify(await this.ctx.get('llm').listModels(first), null, 2)};
    else return {kind: 'error', text: '用法：/control status | mode follow-session/model-review/user-approval/full-access | reviewer <provider> <model> | reviewer session | models <provider> | stop'};
    this.updateSettings(owner,changes);
    return {kind: 'success', text: `已设置 ${JSON.stringify(changes)}。有效操作权限仍跟随当前 DSH 会话。`};
  }
  async dispose() { this.coordinator.dispose();this.consents.dispose(); await this.presence.dispose(); await this.browser.dispose(); await this.native.dispose(); }
}
export function apply(ctx, config) {
  const runtime = new ControlRuntime(ctx, config);
  for (const tool of runtime.tools()) ctx.effect(() => ctx.tools.register(tool), `dsh-control:${tool.name}`);
  ctx.effect(() => () => runtime.dispose(), 'dsh-control:dispose');
  ctx.inject(['webServer','sessions'], scope=>{mountGui(scope,runtime);});
  ctx.on('session/event',(session,event)=>runtime.sessionEvent(session,event));
  ctx.on('approval/request',(req,next)=>runtime.consents.request(req,next),{prepend:true});
  ctx.inject(['commands'], scope => {
    scope.commands.register({definitionId: 'dsh-control', name: 'control', description: '电脑/浏览器操控设置及停止', input: {hint: 'status | mode | reviewer | models | stop | resume'}, handler: async ({agent, rawInput}) => {
      try { return await runtime.command(agent, rawInput); } catch (error) { return {kind: 'error', text: `${error.code ?? 'ERROR'}: ${error.message}`}; }
    }});
  });
  ctx.on('agent/disposed', payload => { const agent=payload.agent??payload;const owner = String(agent.session?.id ?? agent.id); runtime.gate.overrides.delete(owner); runtime.loadedSettings.delete(owner);if(runtime.coordinator.status.owner===owner)runtime.coordinator.stop(owner);void runtime.presence.finish(owner);const preserve=runtime.config.preserveBrowserOnExit||(runtime.browser.loanStatus?.(owner)??[]).some(l=>l.childSessionId===owner);void Promise.resolve(preserve?runtime.browser.suspend?.(owner):runtime.browser.close(owner)).catch(error=>runtime.audit({owner,event:'browser-dispose-error',code:error.code??'ERROR'})); });
}
export default {name, inject, Config, apply};
