import {ControlError, checkAbort} from './common.js';

// Visual presence is separate from the short-lived input lease.
export class Presence {
  constructor(native, browser, cancel,audit=()=>{},idlePolicy={}) {
    this.native=native;this.browser=browser;this.cancel=cancel;this.audit=audit;this.blocked=new Set();this.generation=0;this.channels=new Map();
    this.idleTimeoutMs=15*60*1000;this.idlePolicy=idlePolicy;
  }
  get status(){return {owner:this.owner??null,phase:this.phase??null,kind:this.owner?this.channels.get(this.owner)??'desktop':null,native:this.indicator??null,lastError:this.lastError??null};}
  check(owner){if(this.blocked.has(owner))throw new ControlError('CONTROL_STOPPED','人工已结束本轮电脑干预；请等待用户重新发起任务，不能自动重试。');}
  async start(owner,phase,signal,kind){
    this.check(owner);checkAbort(signal);
    if(kind&&this.owner===owner&&this.channels.get(owner)&&this.channels.get(owner)!==kind)await this.finish(owner);
    if(kind)this.channels.set(owner,kind);const channel=this.channels.get(owner)??'desktop';
    if(this.owner&&this.owner!==owner)await this.finish(this.owner);
    this.owner=owner;this.phase=phase;const generation=++this.generation;
    this.armIdle(owner,generation);
    if(channel==='browser'){
      const group=this.browser.groupStatus?.(owner),record=this.browser.sessions?.get(owner),page=record?.active?record.tabs.get(record.active):null;
      if(page){await this.browser.show(owner,page,{phase});if(group?.processId)await this.native.call('browser-watch',{owner,processId:group.processId,watchHuman:phase!=='approval'},signal);}
      this.indicator=null;this.audit({owner,phase,event:'page-shown',location:'browser-page',visible:!!page});this.watch();return;
    }
    try{const result=await this.native.call('visual',{owner,phase,generation,watchHuman:phase!=='approval'},signal);
      if(result.visible===false)throw new ControlError('INDICATOR_UNAVAILABLE','操作提示未显示，暂停查看和输入，请检查交互式桌面');
      if(this.generation===generation){this.indicator=result;this.lastError=null;this.audit({owner,phase,event:'shown',visible:result.visible,monitor:result.monitor,rect:result.rect});}
    }catch(error){if(this.generation===generation)this.lastError={owner,code:error.code??'INDICATOR_ERROR',message:error.message};throw error;}
    this.check(owner);checkAbort(signal);this.watch();
  }
  armIdle(owner,generation){
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>{void this.releaseIdle(owner,generation).catch(()=>{});},this.idleTimeoutMs);this.timer.unref?.();
  }
  async releaseIdle(owner,generation){
    if(this.owner!==owner||this.generation!==generation)return false;
    if(this.phase==='approval'||this.idlePolicy.isBusy?.(owner)){this.armIdle(owner,generation);return false;}
    // No browser call for a while does not mean the user cancelled the task.
    // Release the monitor and grants, never call cancel() or latch blocked.
    this.audit({owner,event:'released',reason:'idle-timeout'});
    try{this.idlePolicy.onIdle?.(owner);}finally{await this.finish(owner,'idle-timeout');}
    return true;
  }
  watch(){
    if(this.healthTimer)return;
    this.healthTimer=setInterval(async()=>{
      if(!this.owner||this.healthChecking||this.native.pending?.size)return;
      const owner=this.owner,generation=this.generation;this.healthChecking=true;
      if(this.channels.get(owner)==='browser'){try{await this.browser.heartbeat?.(owner);}catch{/* the next input still requires a live browser connection */}finally{this.healthChecking=false;}return;}
      try{const health=await this.native.call('visual-health',{owner,generation});
        if(this.owner===owner&&this.generation===generation&&health.visible===false){this.lastError={owner,code:'INDICATOR_UNAVAILABLE',message:'悬浮提示已消失，停止电脑干预'};await this.stop(owner,'indicator-unavailable');}
      }catch(error){if(this.owner===owner&&this.generation===generation){this.lastError={owner,code:error.code??'INDICATOR_ERROR',message:error.message};await this.stop(owner,'indicator-unavailable').catch(()=>{});}}
      finally{this.healthChecking=false;}
    },1000);this.healthTimer.unref?.();
  }
  async idle(owner,phase='thinking'){
    if(this.owner!==owner||this.blocked.has(owner))return;
    await this.start(owner,phase);await this.browser.idle?.(owner);
  }
  async stop(owner,reason='user'){
    if(this.owner&&this.owner!==owner)throw new ControlError('NOT_OWNER','只能停止本会话的操控提示与操作');
    this.cancel(owner,reason);this.blocked.add(owner);this.audit({owner,event:'stopped',reason});await this.finish(owner,reason);
  }
  async finish(owner,reason='finished'){
    if(this.owner!==owner)return;
    this.owner=undefined;this.phase=undefined;this.indicator=undefined;const generation=++this.generation;clearTimeout(this.timer);clearInterval(this.healthTimer);this.healthTimer=undefined;this.audit({owner,event:'hidden',reason});
    await Promise.allSettled([this.native.running===false?Promise.resolve():this.native.call(this.channels.get(owner)==='browser'?'browser-watch-stop':'visual-stop',{owner,reason,generation}),this.browser.hide?.(owner)]);
  }
  async newTurn(owner){this.blocked.delete(owner);await this.finish(owner);}
  async dispose(){if(this.owner)await this.finish(this.owner);clearTimeout(this.timer);}
}
