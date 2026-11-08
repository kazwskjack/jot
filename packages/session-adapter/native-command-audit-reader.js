import {isDeepStrictEqual} from 'node:util';
import {nativeCommandEventSha256} from './native-command-audit.js';
import {normalizeSkillReadScope} from './skill-read-scope.js';
import {validateNativeCommandQuery} from '../skills/command-query.js';
import {validateNativeCommandAudit,validateNativeCommandRecovery} from '../skills/command-query-audit.js';

/** Observe the original native log through a read handle, including retired Agents. */
export async function readNativeCommandAudit({packet,persistence,sessions,bridge,signal}){
 const scope=normalizeSkillReadScope(packet.scope);
 const request=validateNativeCommandQuery(packet.request);
 const audit=validateNativeCommandAudit(packet.audit);
 const original={scope,request,audit};
 const binding={runId:scope.run_id,sessionRef:scope.session_ref};
 const check=async()=>{
  signal.throwIfAborted();
  const response=await bridge.request('native-command-query-audit',binding,original,signal);
  if(response?.execution_authorized!==false||!isDeepStrictEqual(response.audit,audit))throw Error('native_command_query_audit_changed');
  signal.throwIfAborted();
 };
 await check();
 const live=sessions.get(scope.session_ref);
 if(live){
  if(live.header.createdAt!==audit.session_created_at)throw Error('native_command_query_audit_changed');
  if(await sessions.flush(live)!==true)throw Error('native_command_query_audit_unavailable');
 }
 const handle=await persistence.open(scope.session_ref,'read',{signal});
 try{
  if(handle.id!==scope.session_ref||handle.header.createdAt!==audit.session_created_at)throw Error('native_command_query_audit_changed');
  const {events}=await handle.read(audit.run_event_seq,1,{signal});
  const start=events[0];
  if(events.length!==1||start.seq!==audit.run_event_seq||start.type!=='command/run'||start.data.commandId!==audit.command_id
   ||start.data.name!==request.name||start.data.source?.kind!=='user'||start.data.args!==undefined&&start.data.args!==''
   ||nativeCommandEventSha256(start)!==audit.run_event_sha256){
   throw Error('native_command_query_audit_changed');
  }
  let cursor=audit.run_event_seq+1;
  for(;;){
   signal.throwIfAborted();
   const {events}=await handle.read(cursor,256,{signal});
   if(events.length>256||events.some((event,index)=>event.seq!==cursor+index))throw Error('native_command_query_audit_changed');
   const duplicate=events.some(event=>event.type==='command/run'&&event.data.commandId===audit.command_id);
   const done=events.filter(event=>event.type==='command/done'&&event.data.commandId===audit.command_id);
   if(duplicate||done.length>1)throw Error('native_command_query_audit_changed');
   if(done.length){
    const end=done[0];
    const data=end.data;
    const recovery=validateNativeCommandRecovery({
     audit,
     result:{
      commandId:audit.command_id,
      result:{
       kind:data.kind,
       ...(data.text===undefined?{}:{text:data.text}),
       ...(data.sourceEventSeq===undefined?{}:{sourceEventSeq:data.sourceEventSeq}),
      },
     },
     end_event_seq:end.seq,
     end_event_sha256:nativeCommandEventSha256(end),
    });
    await check();
    return {request_id:request.request_id,execution_authorized:false,recovery};
   }
   if(events.length<256){
    await check();
    return {request_id:request.request_id,execution_authorized:false,recovery:null};
   }
   cursor+=events.length;
  }
 }finally{
  await handle.close();
 }
}
