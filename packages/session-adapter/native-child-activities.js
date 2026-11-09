import {createHash} from 'node:crypto';
import {nativeToolResultObservation} from './native-tool-result.js';
import {nativeChildLogJson as json} from './native-child-closure.js';

/** Replay a verified closed prefix without loading or retaining an Agent. */
export async function replayNativeChildActivities({binding,bridge,persistence,signal}){
 const source=await bridge.request('native-child-activities',binding,{action:'source'},signal);
 if(!source||source.protocol!==1||source.execution_authorized!==false||source.run_id!==binding.runId||source.session_ref!==binding.sessionRef
  ||typeof persistence?.open!=='function'||!Number.isSafeInteger(source.source_start)||source.source_start<0
  ||!Number.isSafeInteger(source.source_end)||source.source_end<source.source_start
  ||typeof source.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.log_sha256)
  ||source.last_event_seq!==null&&(!Number.isSafeInteger(source.last_event_seq)||source.last_event_seq<source.source_start||source.last_event_seq>=source.source_end)
  ||typeof source.complete!=='boolean')throw Error('native_activity_source_invalid');
 if(source.complete)return source;
 signal?.throwIfAborted();const handle=await persistence.open(binding.sessionRef,'read',{signal});
 try{
  if(handle.id!==binding.sessionRef||handle.access!=='read'||handle.header?.parentSession!==source.parent_session_ref)throw Error('native_activity_prefix_changed');
  const hash=createHash('sha256').update(json({...handle.header,delegationDepth:handle.header?.delegationDepth??0})+'\n');
  for(let seq=0;seq<source.source_end;seq++){
   signal?.throwIfAborted();const result=await handle.read(seq,1,{signal}),event=result?.events?.[0];
   if(result?.events?.length!==1||event?.seq!==seq)throw Error('native_activity_prefix_changed');
   hash.update(json(event)+'\n');
  }
  if(hash.digest('hex')!==source.log_sha256)throw Error('native_activity_prefix_changed');
  let last=source.last_event_seq;
  for(let seq=source.source_start;seq<source.source_end;seq++){
   signal?.throwIfAborted();if(seq<=Number(last??-1))continue;
   const result=await handle.read(seq,1,{signal}),event=result?.events?.[0];
   if(result?.events?.length!==1||event?.seq!==seq)throw Error('native_activity_prefix_changed');
   if(!['tool/call','tool/result'].includes(event.type)
    ||event.type==='tool/result'&&event.surfaceOp!==undefined&&event.surfaceOp!=='append')continue;
   const sha=createHash('sha256').update(json(event)).digest('hex');
   const observation=event.type==='tool/result'?nativeToolResultObservation(event):{event};
   const evidence=event.type==='tool/result'?{event_format:'public-result-v1',source_event_sha256:sha}:{};
   const transportSha=event.type==='tool/result'?createHash('sha256').update(json(observation)).digest('hex'):sha;
   const receipt=await bridge.request('native-child-activities',binding,{action:'append',source_log_sha256:source.log_sha256,
    ...observation,...evidence,event_sha256:transportSha},signal);
   if(!receipt||receipt.accepted!==true||receipt.execution_authorized!==false||receipt.run_id!==binding.runId||receipt.session_ref!==binding.sessionRef
    ||receipt.event_seq!==seq||receipt.event_sha256!==sha||typeof receipt.activity_id!=='string')throw Error('native_activity_receipt_invalid');
   last=seq;
  }
  signal?.throwIfAborted();const completed=await bridge.request('native-child-activities',binding,{action:'complete',source_log_sha256:source.log_sha256,expected_last_event_seq:last},signal);
  if(!completed||completed.complete!==true||completed.execution_authorized!==false||completed.run_id!==binding.runId||completed.session_ref!==binding.sessionRef
   ||completed.log_sha256!==source.log_sha256||completed.source_start!==source.source_start||completed.source_end!==source.source_end
   ||completed.last_event_seq!==last)throw Error('native_activity_receipt_invalid');
  return completed;
 }finally{await handle.close();}
}
