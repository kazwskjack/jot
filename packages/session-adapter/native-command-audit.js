import {AsyncLocalStorage} from 'node:async_hooks';
import {dshProfilePluginActionSha256 as sha256} from './dsh-profile-plugin-operation.js';
import {validateNativeCommandAudit} from '../skills/command-query-audit.js';

const invocations=new AsyncLocalStorage();
export const nativeCommandEventSha256=event=>sha256(JSON.parse(JSON.stringify(event)));
/** Capture the synchronous original append frame, before yielding to other calls. */
export function observeNativeCommandStart(agent,name,invoke,input=''){
 const session=agent.session;
 const seq=session.seq;
 const token={};
 let start;
 const remove=agent.ctx.on('session/event',(observed,event)=>{
  if(observed===session&&invocations.getStore()===token&&event.seq===seq&&event.type==='command/run'
   &&event.data.name===name&&event.data.source?.kind==='user'&&(event.data.args??'')===input){
   start=event;
  }
 },{prepend:true});
 let running;
 try{
  running=Promise.resolve(invocations.run(token,invoke));
  running.catch(()=>{});
 }finally{
  remove();
 }
 const audit=start?validateNativeCommandAudit({
  command_id:start.data.commandId,
  session_created_at:session.header.createdAt,
  run_event_seq:start.seq,
  run_event_sha256:nativeCommandEventSha256(start),
 }):null;
 return {running,audit};
}
