import {createHash,randomUUID} from 'node:crypto';
import {ControlError,abortable} from './common.js';
export class Consents {
  constructor(native,describe,audit=()=>{}){this.native=native;this.describe=describe;this.audit=audit;this.pending=new Map();this.grants=new Map();this.epochs=new Map();}
  async request(req,next){
    if(req.signal?.aborted)return 'cancelled';
    const owner=String(req.agent?.session?.id??'');if(!owner||req.toolName!=='control_desktop')return next();
    const descriptor=this.describe(owner,req.callId,req.agent);if(!descriptor)return next();
    const key=createHash('sha256').update(JSON.stringify(descriptor.key)).digest('hex'),grantKey=owner+':'+key;
    if(this.grants.has(grantKey)){this.audit({owner,event:'same-request',target:descriptor.summary});return 'allowed-once';}
    if(this.pending.has(owner))return next();
    const id=randomUUID(),epoch=this.epochs.get(owner)??0;let settle;const wait=new Promise(resolve=>settle=resolve),entry={id,owner,key:grantKey,summary:descriptor.summary,settle};this.pending.set(owner,entry);
    try{
      await this.native.call('consent',{owner,requestId:id,summary:descriptor.summary},req.signal);
      const choice=await abortable(()=>wait,req.signal??new AbortController().signal);
      if((this.epochs.get(owner)??0)!==epoch)return 'rejected';
      if(choice==='same'){this.grants.set(grantKey,{summary:descriptor.summary});this.audit({owner,event:'grant-same',target:descriptor.summary});}
      return choice==='same'||choice==='once'?'allowed-once':'rejected';
    }finally{if(this.pending.get(owner)===entry)this.pending.delete(owner);if(this.native.running!==false)await this.native.call('consent-hide',{requestId:id}).catch(()=>{});}
  }
  answer(owner,id,choice){const e=this.pending.get(owner);if(!e||e.id!==id)throw new ControlError('APPROVAL_GONE','请求已结束或属于其他会话');if(!['once','same','reject'].includes(choice))throw new ControlError('INVALID_CHOICE','请选择允许一次、同意相同请求或拒绝');e.settle(choice);}
  status(owner){return {pending:this.pending.has(owner)?{id:this.pending.get(owner).id,summary:this.pending.get(owner).summary}:null,remembered:[...this.grants.entries()].filter(([key])=>key.startsWith(owner+':')).map(([,v])=>v.summary)};}
  clear(owner){this.epochs.set(owner,(this.epochs.get(owner)??0)+1);this.stop(owner);for(const key of this.grants.keys())if(key.startsWith(owner+':'))this.grants.delete(key);}
  stop(owner){this.pending.get(owner)?.settle('reject');}
  dispose(){for(const e of this.pending.values())e.settle('reject');this.grants.clear();}
}
