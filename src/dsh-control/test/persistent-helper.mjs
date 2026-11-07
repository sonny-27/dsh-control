// Isolated controller used only by the restart integration test.
import {ControlRuntime} from '../index.js';
const input=JSON.parse(process.argv[2]),services={agents:{get:()=>({cancel:()=>{}})},sandboxPolicy:{resolve:()=>({mode:'danger-full-access'})},permissionPresets:{current:()=> 'danger-full-access'},approval:{effectivePolicy:()=> 'never'}};
const runtime=new ControlRuntime({get:k=>services[k]},input.config);
const exec=owner=>({agent:{session:{id:owner,title:'Persistent '+owner}},signal:new AbortController().signal});
async function dispatch(command){
  if(command.op==='stop'){await runtime.dispose();return {stopped:true};}
  if(command.op==='status')return runtime.status(exec(command.owner).agent);
  if(command.op==='resume')return runtime.command(exec(command.owner).agent,'resume');
  if(command.op==='release')return runtime.browser.release(command.owner);
  if(command.op==='seed-grant'){runtime.consents.grants.set(command.owner+':test',{summary:'test'});return true;}
  return await runtime.call('browser',command.args,exec(command.owner));
}
process.on('message',async message=>{try{const result=await dispatch(message);process.send?.({id:message.id,ok:true,result});if(message.op==='stop')setTimeout(()=>process.exit(0),20);}catch(error){process.send?.({id:message.id,ok:false,error:{code:error.code,message:error.message}});}});
process.send?.({ready:true});
