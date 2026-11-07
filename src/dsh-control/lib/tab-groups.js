import {fileURLToPath} from 'node:url';
import {ControlError} from './common.js';
export class NativeGroups{
  constructor(context,extensionPath){this.context=context;this.extensionPath=extensionPath;this.targets=new WeakMap();this.seenWorkers=new WeakSet();}
  async init(){
    this.cdp=await this.context.browser().newBrowserCDPSession();
    try{const loaded=await this.cdp.send('Extensions.loadUnpacked',{path:this.extensionPath??fileURLToPath(new URL('../browser-extension/',import.meta.url))});this.id=loaded.id;
      await this.readyWorker();
      const processes=await this.cdp.send('SystemInfo.getProcessInfo');this.processId=Number(processes.processInfo.find(p=>p.type==='browser')?.id??0);
    }catch(error){throw new ControlError('TAB_GROUP_UNAVAILABLE','当前浏览器无法创建原生会话标签组：'+error.message);}
  }
  async target(page){let id=this.targets.get(page);if(!id){const cdp=await this.context.newCDPSession(page);try{id=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;this.targets.set(page,id);}finally{await cdp.detach();}}return id;}
  async readyWorker(){
    const until=Date.now()+15000;
    do{
      const worker=this.context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${this.id}/`));
      if(worker){if(!this.seenWorkers.has(worker)){this.seenWorkers.add(worker);worker.on('close',()=>{if(this.worker===worker)this.worker=null;});}try{if(await worker.evaluate(()=>typeof globalThis.dshGroups==='function')){this.worker=worker;return worker;}}catch{}}
      await new Promise(r=>setTimeout(r,100));
    }while(Date.now()<until);
    throw new ControlError('TAB_GROUP_UNAVAILABLE','原生标签组服务未就绪，请重试连接');
  }
  async command(args){for(let attempt=0;attempt<2;attempt++){const worker=await this.readyWorker();try{return await worker.evaluate(args=>dshGroups(args),args);}catch(error){if(attempt||!/closed|destroyed/i.test(error.message))throw error;this.worker=null;}}}
  async assign(page,record,windowId){const group=await this.command({op:'assign',targetId:await this.target(page),...(record.group?.id===undefined?{}:{groupId:record.group.id}),title:record.groupTitle,color:record.color,...(windowId===undefined?{}:{windowId})});record.group=group;return group;}
  async check(page,record){const tab=await this.command({op:'check',targetId:await this.target(page)});if(tab.groupId!==record.group?.id||tab.windowId!==record.group?.windowId)throw new ControlError('TAB_GROUP_CHANGED','标签已被移出所属会话组，暂停操作，不能使用其他组的标签');return tab;}
  async dispose(uninstall=false){if(uninstall&&this.id)await this.cdp?.send('Extensions.uninstall',{id:this.id}).catch(()=>{});await this.cdp?.detach().catch(()=>{});}
}
