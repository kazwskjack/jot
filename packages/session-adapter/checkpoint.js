import {createHash} from 'node:crypto';
import {nativeGoalsFor} from './workbench-goal.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const KEYS=['session_ref','seq_exclusive','turn_end_seq','goal_id','goal_revision','log_sha256'];
const validId=value=>typeof value==='string' && ID.test(value);
// Persistence codecs may reorder object properties; JSON values and array order
// determine the prefix identity, rather than the decoder's insertion order.
const json=value=>JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
 ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
// The official JSONL writer materializes the optional native header depth as 0.
// Normalize only this documented default; changed identity/metadata still fail.
const headerJson=header=>json({...header,delegationDepth:header?.delegationDepth===undefined?0:header.delegationDepth});
function goalFor(agent){
 const goal=nativeGoalsFor(agent)?.get?.(agent);
 if(!goal || !validId(goal.id) || !Number.isSafeInteger(goal.revision) || goal.revision<1)throw new Error('checkpoint_goal_invalid');
 return goal;
}
function validate(receipt){
 if(!receipt || typeof receipt!=='object' || Array.isArray(receipt) || Object.keys(receipt).some(k=>!KEYS.includes(k))
  || !validId(receipt.session_ref) || !validId(receipt.goal_id)
  || !Number.isSafeInteger(receipt.seq_exclusive) || receipt.seq_exclusive<1
  || !Number.isSafeInteger(receipt.turn_end_seq) || receipt.turn_end_seq<0 || receipt.turn_end_seq>=receipt.seq_exclusive
  || !Number.isSafeInteger(receipt.goal_revision) || receipt.goal_revision<1
  || typeof receipt.log_sha256!=='string' || !/^[a-f0-9]{64}$/.test(receipt.log_sha256))throw new Error('checkpoint_receipt_invalid');
}
async function inspect(agent,sessions,persistence,turnEndSeq,prefixCount,signal){
 signal?.throwIfAborted();
 if(typeof agent?.whenIdle!=='function' || typeof sessions?.flush!=='function' || typeof persistence?.open!=='function' || typeof persistence?.flush!=='function')throw new Error('checkpoint_persistence_unavailable');
 await agent.whenIdle();signal?.throwIfAborted();
 const session=agent.session,count=session?.seq,goal=goalFor(agent);
 if(!session || !validId(session.id) || !Number.isSafeInteger(count) || count<1 || typeof session.eventAt!=='function'
  || !Number.isSafeInteger(turnEndSeq) || turnEndSeq<0 || turnEndSeq>=count || session.eventAt(turnEndSeq)?.type!=='turn/end'
  || (prefixCount!==undefined && (!Number.isSafeInteger(prefixCount) || prefixCount<1 || prefixCount>count)))throw new Error('checkpoint_boundary_invalid');
 const prefix=prefixCount??count;
 if(await sessions.flush(session)!==true)throw new Error('checkpoint_persistence_unavailable');
 // A participating Session listener could be telemetry. The actual backend's
 // service-wide barrier flushes its owned write handles; no read handle claims
 // write ownership and no assumption about which listener participated is used.
 await persistence.flush();
 signal?.throwIfAborted();
 const handle=await persistence.open(session.id,'read',{signal});
 let digest;const pending=new Set();let openTurn=false;
 try{
  if(handle.id!==session.id || handle.access!=='read' || headerJson(handle.header)!==headerJson(session.header))throw new Error('checkpoint_storage_conflict');
  const hash=createHash('sha256').update(headerJson(session.header)+'\n');
  for(let offset=0;offset<count;){
   signal?.throwIfAborted();
   const length=Math.min(256,count-offset,prefix>offset?prefix-offset:count-offset);
   const result=await handle.read(offset,length,{signal});
   if(!Array.isArray(result?.events) || result.events.length!==length)throw new Error('checkpoint_storage_conflict');
   for(const event of result.events){
    if(event.seq!==offset || json(event)!==json(session.eventAt(offset)))throw new Error('checkpoint_storage_conflict');
    if(offset<prefix)hash.update(json(event)+'\n');
    if(event.type==='turn/start')openTurn=true;
    if(event.type==='turn/end')openTurn=false;
    if(event.type==='tool/call')pending.add(event.data?.callId);
    if(event.type==='tool/result'){
     if(event.data?.error?.code==='TOOL_OUTCOME_UNKNOWN')throw new Error('checkpoint_outcome_unknown');
     pending.delete(event.data?.message?.source?.callId??event.data?.callId);
    }
    offset++;
   }
   if(offset===prefix)digest=hash.digest('hex');
  }
  if(pending.size || openTurn)throw new Error('checkpoint_outcome_unknown');
 }finally{await handle.close();}
 signal?.throwIfAborted();
 const fresh=goalFor(agent);
 if(agent.session!==session || session.seq!==count || fresh.id!==goal.id || fresh.revision!==goal.revision)throw new Error('checkpoint_live_changed');
 return {session_ref:session.id,seq_exclusive:prefix,turn_end_seq:turnEndSeq,goal_id:goal.id,goal_revision:goal.revision,log_sha256:digest};
}
/** A host-only persistence readback, never a model-supplied success assertion. */
export async function captureSessionCheckpoint(agent,sessions,persistence,turnEndSeq,signal){
 return inspect(agent,sessions,persistence,turnEndSeq,undefined,signal);
}
/** Restore the latest persistent Session, proving it retains the saved prefix; no rewind. */
export async function verifySessionCheckpoint(agent,sessions,persistence,receipt,signal){
 validate(receipt);
 if(agent.session?.id!==receipt.session_ref)throw new Error('checkpoint_identity_conflict');
 const goal=goalFor(agent);
 if(goal.id!==receipt.goal_id || goal.revision<receipt.goal_revision)throw new Error('checkpoint_identity_conflict');
 const observed=await inspect(agent,sessions,persistence,receipt.turn_end_seq,receipt.seq_exclusive,signal);
 if(observed.log_sha256!==receipt.log_sha256)throw new Error('checkpoint_storage_conflict');
}
