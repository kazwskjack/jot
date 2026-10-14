import {createHash} from 'node:crypto';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const json=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const headerJson=header=>json({...header,delegationDepth:header?.delegationDepth??0});
function batchWebCall(data){
 const name=data?.name??data?.tool;if(!['universe_read_page','universe_browse','universe_execute'].includes(name))return null;
 let args=data?.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{return {name};}
 if(!args||typeof args!=='object'||Array.isArray(args))return {name};
 if(name==='universe_read_page')return Object.hasOwn(args,'urls')?{name}:null;
 return args.inputs&&Object.hasOwn(args.inputs,'items')?{name}:null;
}
function settledWebOperation(proof,sessionRef,callId){
 if(proof?.session_ref!==sessionRef||proof.request_id!==callId||!/^web-[A-Za-z0-9-]{8,128}$/.test(proof.operation_id)
   ||!Number.isSafeInteger(proof.revision)||proof.revision<1||!['succeeded','partial','failed','cancelled'].includes(proof.status)
   ||!Number.isSafeInteger(proof.accepted_count)||proof.accepted_count<0||!Array.isArray(proof.items)||proof.items.length!==proof.accepted_count)return false;
 const count=proof.accepted_count;
 return new Set(proof.items.map(item=>item?.item_id)).size===count&&new Set(proof.items.map(item=>item?.position)).size===count
  &&proof.items.every(item=>typeof item?.item_id==='string'&&ID.test(item.item_id)&&Number.isSafeInteger(item.position)&&item.position>=0&&item.position<count&&['succeeded','failed','cancelled'].includes(item.status));
}
/** Recover publication metadata only, never resume or admit an Agent. The
 * official active edge follows durable acceptance of the initial message. */
export async function recoverNativePublication({parent,childId,request,providerName,persistence,teams,signal}){
 const fail=()=>{throw new Error('native_role_publication_pending');};
 if(!parent?.session||parent.session.id!==parent.id||!ID.test(childId)||typeof persistence?.flush!=='function'||typeof persistence?.open!=='function'||typeof teams?.listMembers!=='function'||!Array.isArray(request?.prompt))return fail();
 signal?.throwIfAborted();await persistence.flush();
 const session=parent.session,count=session.seq,handle=await persistence.open(parent.id,'read',{signal});let active;
 try{
  if(handle.id!==parent.id||handle.access!=='read'||headerJson(handle.header)!==headerJson(session.header))return fail();
  for(let offset=0;offset<count;){const length=Math.min(256,count-offset),result=await handle.read(offset,length,{signal});if(result?.events?.length!==length)return fail();
   for(const event of result.events){if(event.seq!==offset||json(event)!==json(session.eventAt(offset)))return fail();
    if(event.type==='team/member'&&event.data?.version===2&&event.data.teamId===parent.id&&event.data.member?.id===childId)active=event.data.member;
    offset++;
   }
  }
 }finally{await handle.close();}
 if(active?.phase!=='active'||active.provider!==providerName||active.name!==request.name?.trim()||active.description!==request.description?.trim()||active.context!=='fresh'||request.context!=='fresh')return fail();
 const child=await persistence.open(childId,'read',{signal});let descriptor,accepted=false,firstUserSeen=false;const inbox={'next-turn':[],'next-step':[]};
 try{
  if(child.id!==childId||child.access!=='read'||child.header?.parentSession!==parent.id)return fail();
  for(let offset=0;;){const result=await child.read(offset,256,{signal});if(!Array.isArray(result?.events))return fail();if(!result.events.length)break;
   for(const event of result.events){if(event.seq!==offset)return fail();offset++;
    if(event.type==='subagent/descriptor'&&descriptor===undefined)descriptor=event.data;
    if(event.type==='agent/inbox/spliced'){
     const d=event.data;if(!inbox[d?.target]||!Number.isSafeInteger(d.start)||!Array.isArray(d.inserted))return fail();
     inbox[d.target].splice(d.start,d.removedCount??0,...d.inserted);
    }
    if(!firstUserSeen&&event.type==='user/message'&&event.data?.source?.kind==='user'){
     firstUserSeen=true;const content=event.data.content;if(!Array.isArray(content)||json(content.slice(0,request.prompt.length))!==json(request.prompt))return fail();accepted=true;
    }
   }
   if(descriptor&&accepted)break;
  }
  if(!firstUserSeen){const initial=[...inbox['next-turn'],...inbox['next-step']].find(message=>message.source?.kind==='user');accepted=Array.isArray(initial?.content)&&json(initial.content.slice(0,request.prompt.length))===json(request.prompt);}
 }finally{await child.close();}
 if(descriptor?.version!==3||descriptor.mode!=='continuable'||descriptor.provider!==providerName||descriptor.label!==active.description||!accepted)return fail();
 signal?.throwIfAborted();if(parent.session!==session)return fail();
 const row=teams.listMembers(parent).find(member=>member.id===childId);
 if(!row||row.role!=='teammate'||!['running','inactive'].includes(row.status)||row.name!==active.name||row.description!==active.description||row.provider!==active.provider||row.context!==active.context||row.diagnostics?.length!==0)return fail();
 // The original response was never committed. Persist the recovered current
 // official view once; subsequent retries return that exact immutable view.
 const {id,name,role,status,description,provider,context,model,diagnostics}=row;
 return {member:{id,name,role,status,description,provider,context,...(model===undefined?{}:{model}),diagnostics:[...diagnostics]}};
}
/** Verify the previous activation's immutable log prefix while the new Agent
 * is held behind publication barriers. A live resumed handle is expected. */
export async function verifyNativeChildPrefix({agent,parentSessionRef,persistence,proof,signal}){
 const session=agent?.session,count=proof?.seq_exclusive;
 if(!session||agent.id!==session.id||session.header.parentSession!==parentSessionRef||proof?.session_ref!==agent.id||proof?.parent_session_ref!==parentSessionRef
  ||!Number.isSafeInteger(count)||count<1||count>session.seq||!Number.isSafeInteger(proof.turn_end_seq)||proof.turn_end_seq<0||proof.turn_end_seq>=count
  ||typeof proof.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.log_sha256)||typeof persistence?.flush!=='function'||typeof persistence?.open!=='function')throw new Error('native_child_prefix_invalid');
 await persistence.flush();signal?.throwIfAborted();const handle=await persistence.open(agent.id,'read',{signal});
 const remoteCalls=new Map();
 const hash=createHash('sha256').update(headerJson(session.header)+'\n');
 try{
  if(handle.id!==agent.id||handle.access!=='read'||headerJson(handle.header)!==headerJson(session.header))throw new Error('native_child_prefix_changed');
  for(let offset=0;offset<count;){const length=Math.min(256,count-offset),result=await handle.read(offset,length,{signal});
   if(result?.events?.length!==length)throw new Error('native_child_prefix_changed');
   for(const event of result.events){if(event.seq!==offset||json(event)!==json(session.eventAt(offset)))throw new Error('native_child_prefix_changed');hash.update(json(event)+'\n');if(event.type==='tool/call'){const batch=batchWebCall(event.data);if(batch){const callId=event.data?.callId;if(typeof callId!=='string'||!ID.test(callId)||remoteCalls.has(callId))throw Error('native_child_prefix_remote_unresolved');remoteCalls.set(callId,batch.name);}}offset++;}
  }
  if(hash.digest('hex')!==proof.log_sha256||session.eventAt(proof.turn_end_seq)?.type!=='turn/end')throw new Error('native_child_prefix_changed');
  const operations=proof.remote_operations??[];
  if(!Array.isArray(operations)||operations.length!==remoteCalls.size||new Set(operations.map(p=>p?.request_id)).size!==remoteCalls.size
   ||operations.some(p=>!p||typeof p!=='object'||p.tool_name!==remoteCalls.get(p?.request_id)||!settledWebOperation(p,agent.id,p.request_id)))throw Error('native_child_prefix_remote_unresolved');
 }finally{await handle.close();}
 signal?.throwIfAborted();if(agent.session!==session)throw new Error('native_child_prefix_changed');
}
/** Read back the exact durable child log after native runtime detachment.
 * This is a host observation, not an LLM completion or business verdict.
 */
export async function captureNativeChildClosure(input){return captureNativeQuiescence(input,false);}
export async function captureNativeHandoffQuiescence(input){return captureNativeQuiescence(input,true);}
async function captureNativeQuiescence({agent,parentSessionRef,registry,persistence,projections,signal,reconcileOperations},resident){
 if(!agent||typeof agent.whenIdle!=='function'||typeof registry?.get!=='function'||typeof persistence?.flush!=='function'||typeof persistence?.open!=='function'||typeof projections?.stateOf!=='function'
  ||!ID.test(agent.id)||agent.session?.id!==agent.id||(!resident&&(!ID.test(parentSessionRef)||agent.session.header.parentSession!==parentSessionRef)))throw new Error('native_child_closure_host_invalid');
 await agent.whenIdle();signal?.throwIfAborted();
 if((resident?registry.get(agent.id)!==agent:registry.get(agent.id)!==undefined)||agent.status!=='idle')throw new Error('native_child_not_detached');
 const session=agent.session,count=session.seq,inbox=projections.stateOf(session,'inbox');
 if(!Number.isSafeInteger(count)||count<(resident?0:1)||!Array.isArray(inbox?.['next-turn'])||!Array.isArray(inbox?.['next-step'])||inbox['next-turn'].length||inbox['next-step'].length)throw new Error('native_child_pending_inbox');
 await persistence.flush();signal?.throwIfAborted();const handle=await persistence.open(agent.id,'read',{signal});
 let openTurn=false,lastEnd=-1,executionSeen=false;const tools=new Set(),remoteCalls=new Map(),hash=createHash('sha256').update(headerJson(session.header)+'\n');
 try{
  if(handle.id!==agent.id||handle.access!=='read'||headerJson(handle.header)!==headerJson(session.header))throw new Error('native_child_storage_changed');
  for(let offset=0;offset<count;){
   signal?.throwIfAborted();const length=Math.min(256,count-offset),result=await handle.read(offset,length,{signal});
   if(result?.events?.length!==length)throw new Error('native_child_storage_changed');
   for(const event of result.events){
    if(event.seq!==offset||json(event)!==json(session.eventAt(offset)))throw new Error('native_child_storage_changed');
    hash.update(json(event)+'\n');
    if(event.type.startsWith('turn/')||event.type.startsWith('tool/')||event.type.startsWith('llm/'))executionSeen=true;
    if(event.type==='turn/start')openTurn=true;
    if(event.type==='turn/end'){openTurn=false;lastEnd=event.seq;}
    if(event.type==='tool/call'){
     tools.add(event.data?.callId);const batch=batchWebCall(event.data);
     if(batch){const callId=event.data?.callId;if(typeof callId!=='string'||!ID.test(callId)||remoteCalls.has(callId))throw new Error('native_child_remote_effects_unresolved');remoteCalls.set(callId,batch.name);}
    }
    if(event.type==='tool/result'){
     if(event.data?.error?.code==='TOOL_OUTCOME_UNKNOWN')throw new Error('native_child_tool_unknown');
     tools.delete(event.data?.message?.source?.callId??event.data?.message?.toolCallId??event.data?.callId);
    }
    offset++;
   }
  }
  if((await handle.read(count,1,{signal})).events?.length!==0||openTurn||tools.size||(lastEnd<0&&(!resident||executionSeen)))throw new Error('native_child_log_not_quiescent');
 }finally{await handle.close();}
 const remoteOperations=[];
 for(const [callId,toolName] of remoteCalls){
  if(typeof reconcileOperations!=='function')throw new Error('native_child_remote_effects_unresolved');
  signal?.throwIfAborted();let proof;
  try{proof=await reconcileOperations(Object.freeze({sessionRef:agent.id,callId,toolName,signal}));}
  catch{signal?.throwIfAborted();throw new Error('native_child_remote_effects_unresolved');}
  if(!settledWebOperation(proof,agent.id,callId))throw new Error('native_child_remote_effects_unresolved');
  remoteOperations.push({session_ref:agent.id,request_id:callId,tool_name:toolName,operation_id:proof.operation_id,revision:proof.revision,status:proof.status,accepted_count:proof.accepted_count,items:proof.items.map(item=>({item_id:item.item_id,position:item.position,status:item.status}))});
 }
 signal?.throwIfAborted();
 if((resident?registry.get(agent.id)!==agent:registry.get(agent.id)!==undefined)||session.seq!==count||agent.session!==session||agent.status!=='idle')throw new Error('native_child_live_changed');
 const fresh=projections.stateOf(session,'inbox');if(fresh?.['next-turn']?.length!==0||fresh?.['next-step']?.length!==0)throw new Error('native_child_pending_inbox');
 const facts={protocol:1,session_ref:agent.id,seq_exclusive:count,turn_end_seq:lastEnd,log_sha256:hash.digest('hex'),inbox_pending:0,...(remoteOperations.length?{remote_operations:remoteOperations}:{})};
 return resident?{...facts,driver_idle:true}:{...facts,parent_session_ref:parentSessionRef,driver_nonresident:true};
}
