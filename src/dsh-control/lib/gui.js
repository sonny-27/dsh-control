import {randomBytes,timingSafeEqual} from 'node:crypto';
import {ControlError,abortable} from './common.js';

export const GUI_GLOBAL='__DSH_CONTROL_GUI_V1__';
export function createGuiApi(ctx,runtime,token=randomBytes(32).toString('hex')) {
  const config={version:'1.12.0',endpoint:'/dsh-control/gui',token};
  const send=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(value));};
  const agentFor=id=>{
    if(typeof id!=='string'||id.length>256) throw new ControlError('SESSION_REQUIRED','需要当前 DSH 会话');
    const session=ctx.get('sessions')?.get(id);
    if(!session) throw new ControlError('SESSION_NOT_FOUND','会话尚未打开，请先打开会话');
    if(session.header?.origin==='subagent') throw new ControlError('NOT_OWNER','请在主会话配置操控设置');
    return ctx.get('agents')?.get(id)??{id,session};
  };
  const read=async req=>{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192) throw new ControlError('BODY_TOO_LARGE','设置请求过长');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
  const handler=async(req,res)=>{
    try {
      const supplied=String(req.headers['x-dsh-control-token']??'');
      if(Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) return send(res,403,{ok:false,error:{code:'GUI_AUTH_REQUIRED',message:'请刷新 DSH 页面后再打开操控设置'}});
      const origin=req.headers.origin;
      if(origin){let parsed;try{parsed=new URL(origin);}catch{return send(res,403,{ok:false,error:{code:'GUI_ORIGIN',message:'页面来源无效'}});}if(parsed.host!==req.headers.host) return send(res,403,{ok:false,error:{code:'GUI_ORIGIN',message:'只允许当前 DSH 页面修改设置'}});}
      if(req.method!=='POST') return send(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'只支持 POST'}});
      if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json')) return send(res,415,{ok:false,error:{code:'CONTENT_TYPE',message:'需要 JSON 请求'}});
      const input=await read(req),agent=agentFor(input.sessionId);
      if(input.action==='status') return send(res,200,{ok:true,data:runtime.status(agent)});
      if(input.action==='preview-indicator'){
        const previewMs=input.previewMs??10000;if(!Number.isInteger(previewMs)||previewMs<1000||previewMs>30000)throw new ControlError('INVALID_ARGUMENT','提示预览限 1..30 秒');
        if(runtime.presence.owner||runtime.coordinator.status.owner)throw new ControlError('CONTROL_BUSY','正在操控，请在任务结束后测试提示');
        await runtime.presence.start(agent.session.id,'observe',undefined,'desktop');const generation=runtime.presence.generation;
        const timer=setTimeout(()=>{if(runtime.presence.owner===agent.session.id&&runtime.presence.generation===generation)void runtime.presence.finish(agent.session.id,'preview-ended');},previewMs);timer.unref?.();
        return send(res,200,{ok:true,data:runtime.status(agent)});
      }
      if(input.action==='indicator-diagnostics'){
        if(runtime.presence.owner!==agent.session.id)throw new ControlError('NOT_OWNER','请先在本会话显示提示，再检查自己的提示');
        if(runtime.coordinator.status.owner)throw new ControlError('CONTROL_BUSY','输入执行期间不能运行显示诊断');
        const policy=await runtime.native.call('capture-policy-proof'),surface=await runtime.native.call('visual-desktop-proof');
        return send(res,200,{ok:true,data:{policy,surface}});
      }
      if(input.action==='save') {runtime.updateSettings(agent.session.id,input.settings);return send(res,200,{ok:true,data:runtime.status(agent)});}
      if(input.action==='stop'){await runtime.command(agent,'stop');return send(res,200,{ok:true,data:runtime.status(agent)});}
      if(input.action==='resume'){await runtime.command(agent,'resume');return send(res,200,{ok:true,data:runtime.status(agent)});}
      if(input.action==='consent'){runtime.consents.answer(agent.session.id,input.requestId,input.choice);return send(res,200,{ok:true,data:runtime.status(agent)});}
      if(input.action==='clear-consents'){runtime.consents.clear(agent.session.id);runtime.gate.clearBrowser(agent.session.id);return send(res,200,{ok:true,data:runtime.status(agent)});}
      if(input.action==='handoff-state'){
        await runtime.browser.resume?.(agent.session.id);let tabs=[];if(runtime.browser.sessions?.has(agent.session.id))tabs=(await runtime.browser.tabs(agent.session.id)).tabs;
        return send(res,200,{ok:true,data:{...runtime.status(agent),handoffState:{children:runtime.handoffChildren(agent),tabs,loans:runtime.browser.loanStatus?.(agent.session.id)??[]}}});
      }
      if(input.action==='handoff-tab'||input.action==='reclaim-tab'){
        const moved=await runtime.handoffGui(agent,{action:input.action==='handoff-tab'?'handoff':'reclaim-tab',tabId:input.tabId,targetSessionId:input.targetSessionId,loanId:input.loanId});
        return send(res,200,{ok:true,data:{...runtime.status(agent),handoffResult:moved}});
      }
      if(['browser-connect','browser-candidates','browser-adopt','browser-release'].includes(input.action)){
        if(runtime.coordinator.status.owner)throw new ControlError('CONTROL_BUSY','请先停止正在执行的操作，再交接浏览器标签');
        const owner=agent.session.id;runtime.browser.setLabel?.(owner,agent.session.title??agent.session.meta?.title??'用户协同');let result;
        if(input.action==='browser-connect')result=await runtime.browser.connectUser(owner,input.endpoint??'auto');
        if(input.action==='browser-candidates')result={available:await runtime.browser.userTabs(owner)};
        if(input.action==='browser-adopt')result=await runtime.browser.adopt(owner,input.tabSelection);
        if(input.action==='browser-release'){await runtime.presence.finish(owner);runtime.gate.clearBrowser(owner);result=await runtime.browser.release(owner);}
        return send(res,200,{ok:true,data:{...runtime.status(agent),handoff:result??{released:true}}});
      }
      if(input.action==='models') {
        const llm=ctx.get('llm'),providers=llm.listProviders(),groups=[],failures=[];
        await Promise.all(providers.map(async provider=>{try{const models=await abortable(()=>llm.listModels(provider.id),AbortSignal.timeout(5000));groups.push({id:provider.id,name:provider.name||provider.id,models:models.map(m=>({id:m.id,name:m.name||m.id,...(m.inputModalities?{inputModalities:m.inputModalities}:{})}))});}catch{failures.push({id:provider.id,message:'模型列表获取失败或超时'});}}));
        groups.sort((a,b)=>a.id.localeCompare(b.id));return send(res,200,{ok:true,data:{groups,failures}});
      }
      throw new ControlError('INVALID_ACTION','未知设置动作');
    }catch(error){send(res,400,{ok:false,error:{code:error.code??'GUI_ERROR',message:error.message}});}
  };
  return {config,handler};
}
export function mountGui(ctx,runtime) {
  const api=createGuiApi(ctx,runtime);
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:api.config.endpoint,handler:api.handler}),'dsh-control:gui-api');
  ctx.on('webserver/index-inject',table=>table.push({kind:'global',name:GUI_GLOBAL,value:api.config}));
  return api;
}
