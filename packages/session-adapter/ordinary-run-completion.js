import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=v=>createHash('sha256').update(v).digest('hex');
const fail=()=>{throw Error('ordinary_run_completion_unconfirmed');};
const sourceKeys='candidates,canonical,commands,conversation_id,conversation_state_sha256,execution_authorized,input_message_id,input_sha256,kind,owner_id,protocol,run_id,run_state_sha256,run_status,run_version,runtime_binding_sha256,session_binding_sha256,session_id,worker_lease_sha256';
const commandKeys='command_id,command_sha256,command_status,conversation_id,execution_authorized,input_message_id,input_sha256,kind,native_acceptance,native_content_sha256,original_input_message_id,original_input_sha256,owner_id,position,product_message_present,protocol,record_sha256,run_id,run_status,run_version,session_id';
function validateSource(row,scope){
 if(!row||Object.keys(row).sort().join(',')!==sourceKeys||row.protocol!==1||row.kind!=='ordinary_run_history'||row.execution_authorized!==false
  ||row.owner_id!==scope.owner_id||row.conversation_id!==scope.conversation_id||row.session_id!==scope.session_ref||row.run_id!==scope.run_id||row.run_version!==scope.expected_run_version
  ||!['succeeded','failed','interrupted','partial'].includes(row.run_status)||!valid(row.input_message_id)||!['input_sha256','run_state_sha256','conversation_state_sha256','session_binding_sha256'].every(k=>hash(row[k]))
  ||!['runtime_binding_sha256','worker_lease_sha256'].every(k=>row[k]===null||hash(row[k]))||!Array.isArray(row.commands)||!Array.isArray(row.candidates))fail();
 const ids=new Set();for(const [position,c] of row.commands.entries()){
  if(!c||Object.keys(c).sort().join(',')!==commandKeys||c.protocol!==1||c.kind!=='ordinary_steer_history'||c.execution_authorized!==false||c.native_acceptance!=='unverified'
   ||c.owner_id!==row.owner_id||c.conversation_id!==row.conversation_id||c.session_id!==row.session_id||c.run_id!==row.run_id||c.run_status!==row.run_status||c.run_version!==row.run_version
   ||c.original_input_message_id!==row.input_message_id||c.original_input_sha256!==row.input_sha256||!valid(c.command_id)||c.command_id===row.run_id||ids.has(c.command_id)||c.position!==position
   ||c.input_message_id!=='message-'+c.command_id||!['pending','applied','superseded','rejected'].includes(c.command_status)||typeof c.product_message_present!=='boolean'||c.command_status==='applied'&&!c.product_message_present
   ||!['command_sha256','input_sha256','native_content_sha256','record_sha256'].every(k=>hash(c[k])))fail();ids.add(c.command_id);
 }
 if(row.canonical!==null){const c=row.canonical;if(!c||Object.keys(c).sort().join(',')!=='content_sha256,message_id,record_sha256,status'||!valid(c.message_id)||!['complete','streaming','partial','failed'].includes(c.status)||!hash(c.content_sha256)||!hash(c.record_sha256))fail();}
 for(const c of row.candidates)if(!c||Object.keys(c).sort().join(',')!=='attempt,evidence_sha256,id,record_sha256,source_sha256,source_version_sha256,status,text_sha256'||!valid(c.id)||!Number.isSafeInteger(c.attempt)||c.attempt<1||!['pending','verified','partial','failed','outcome_unknown'].includes(c.status)||!['evidence_sha256','record_sha256','source_sha256','source_version_sha256','text_sha256'].every(k=>hash(c[k])))fail();
 return structuredClone(row);
}
/** Raw, detached historical completion facts only. No Agent resolution, model,
 * tool, wake, flush, lease acquisition, product publication or fee settlement.
 * Output events are scoped native evidence for the shared Gateway interpreter;
 * they do not certify output ownership, integrity or successful business work. */
export function createOrdinaryRunCompletionReader({bridge,persistence,admissions,agents,sessions,Session,validateLog,projections,ordinaryPresets}){
 if(typeof bridge?.request!=='function'||typeof persistence?.open!=='function'||admissions?.entryInspectionProtocol!==1||typeof admissions.read!=='function'||typeof admissions.inspectEntry!=='function'
  ||typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof Session?.create!=='function'||typeof validateLog!=='function'||typeof projections?.snapshot!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size)fail();
 return async({scope,expectedSourceSha256,signal})=>{
  if(!scope||Object.keys(scope).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id,session_ref'||!['owner_id','conversation_id','run_id','session_ref'].every(k=>valid(scope[k]))||!Number.isSafeInteger(scope.expected_run_version)||scope.expected_run_version<1||!hash(expectedSourceSha256)||!signal)fail();
  scope=structuredClone(scope);
  const check=()=>{signal.throwIfAborted();if(agents.get(scope.session_ref)!==undefined||sessions.get(scope.session_ref)!==undefined)fail();};
  const readSource=async()=>{check();const result=await bridge.request('ordinary-run-history',{runId:scope.run_id,sessionRef:scope.session_ref},{owner_id:scope.owner_id,conversation_id:scope.conversation_id,expected_run_version:scope.expected_run_version},signal);check();return validateSource(result?.history,scope);};
  const source=await readSource();if(sha(canonical(source))!==expectedSourceSha256)fail();
  const readRaw=async()=>{check();const handle=await persistence.open(scope.session_ref,'read',{signal});try{check();const result=await handle.read(0,undefined,{signal});check();return structuredClone({header:handle.header,inheritedEventCount:handle.inheritedEventCount,events:result.events});}finally{await handle.close();}};
  const raw=await readRaw(),{header,events}=raw;
  if(header?.id!==scope.session_ref||!Number.isSafeInteger(header.createdAt)||header.createdAt<0||header.isSeeded!==false||raw.inheritedEventCount!==0||header.parentSession!==undefined||header.origin==='subagent'||!ordinaryPresets.has(header.agentPreset)||!Array.isArray(events)||events.some((e,i)=>e?.seq!==i||typeof e.type!=='string'))fail();
  const detached=Session.create(scope.session_ref,structuredClone(events),structuredClone(header),0);
  if((await validateLog(detached,{signal}))?.validated!==true)fail();check();
  const snapshot=projections.snapshot(detached,['inbox','goal']),inbox=snapshot?.values?.inbox,goal=snapshot?.values?.goal;
  if(snapshot?.asOfSeq!==detached.seq-1||!inbox||Object.keys(inbox).sort().join(',')!=='next-step,next-turn'||!['next-step','next-turn'].every(k=>Array.isArray(inbox[k])&&inbox[k].length===0)||goal===undefined)fail();
  if(goal!==null){const g=goal?.goal;if(!g||g.phase!=='complete'||!valid(g.id)||!Number.isSafeInteger(g.revision)||g.revision<1||typeof g.objective!=='string'||!g.objective||!Number.isSafeInteger(goal.roundsStarted)||goal.roundsStarted<0||!Number.isSafeInteger(g.maxGoalRounds)||g.maxGoalRounds<1||goal.roundsStarted>g.maxGoalRounds||!Number.isFinite(goal.createdAt)||!Number.isFinite(goal.updatedAt)||goal.updatedAt<goal.createdAt)fail();}
  let openTurn=null,openStep=null,lastEnd=null,lastStart=null;const committed=new Map(),allHumans=[],insertedHumans=[],pendingTools=new Map(),toolIds=new Set();
  for(const e of events){
   if(e.type==='turn/start'){if(openTurn!==null||!Number.isSafeInteger(e.data?.turn))fail();openTurn=e.data.turn;lastStart=e;}
   if(e.type==='step/start'){if(openTurn===null||openStep!==null||e.data?.turn!==openTurn||!Number.isSafeInteger(e.data.step))fail();openStep=e.data.step;}
   if(e.type==='step/end'){if(openStep===null||e.data?.turn!==openTurn||e.data?.step!==openStep)fail();openStep=null;}
   if(e.type==='turn/end'){if(openTurn===null||openStep!==null||e.data?.turn!==openTurn)fail();lastEnd=e;openTurn=null;}
   if(e.type==='agent/inbox/spliced'){if(!Array.isArray(e.data?.inserted))fail();for(const message of e.data.inserted)if(message?.source?.kind==='user')insertedHumans.push({seq:e.seq,message});}
   if(e.type==='user/message'&&e.data?.source?.kind==='user'){allHumans.push(e);const rpc=e.data.source.rpcId;if(rpc===scope.run_id||source.commands.some(c=>c.command_id===rpc)){if(openTurn===null||committed.has(rpc)||!valid(e.data.id)||e.data.role!=='user'||!Array.isArray(e.data.content))fail();committed.set(rpc,e);}}
  }
  if(openTurn!==null||openStep!==null||!lastStart||!lastEnd||lastStart.seq>lastEnd.seq||lastEnd.data?.reason?.kind!=='completed')fail();
  const root=committed.get(scope.run_id);if(!root)fail();const originalInsertion=insertedHumans.find(e=>isDeepStrictEqual(e.message,root.data));if(!originalInsertion||originalInsertion.seq>=root.seq)fail();const boundary=originalInsertion.seq;
  const wanted=source.commands.filter(c=>['pending','applied'].includes(c.command_status)),rpcs=new Set([scope.run_id,...wanted.map(c=>c.command_id)]);
  if(source.commands.some(c=>!rpcs.has(c.command_id)&&committed.has(c.command_id))||allHumans.some(e=>e.seq>=boundary&&!rpcs.has(e.data.source.rpcId))
   ||insertedHumans.some(e=>e.seq>=boundary&&(!rpcs.has(e.message.source.rpcId)||!isDeepStrictEqual(committed.get(e.message.source.rpcId)?.data,e.message))))fail();
  const answer=events.findLast(e=>e.type==='assistant/message'&&e.data?.turn===lastEnd.data.turn&&e.seq>lastStart.seq&&e.seq<lastEnd.seq),parts=answer?.data?.message?.content;
  const text=Array.isArray(parts)?parts.map(p=>p?.type==='text'&&typeof p.text==='string'?p.text:'').join('').trim():'';if(!text)fail();
  // Match live delivery's settled-step rule: a later nonempty draft from a
  // different, unsettled step invalidates the older answer. Chunks for a step
  // whose durable assistant message already arrived do not replace that fact.
  const settledSteps=new Set();let lastUnsettled=-1;
  for(const e of events){const key=e.data?.turn+':'+e.data?.step;if(e.type==='assistant/message'&&Array.isArray(e.data?.message?.content)&&e.data.message.content.some(p=>p?.type==='text'&&typeof p.text==='string'&&p.text.trim()))settledSteps.add(key);if(e.type==='assistant/chunk'&&['text-delta','reasoning-delta'].includes(e.data?.chunk?.type)&&typeof e.data.chunk.text==='string'&&e.data.chunk.text&&!settledSteps.has(key))lastUnsettled=e.seq;}
  if(lastUnsettled>answer.seq)fail();
  const proofs=[],nativeIds=[];let profile=null;
  for(const c of [null,...wanted]){
   const rpc=c?c.command_id:scope.run_id,event=committed.get(rpc),message=event?.data;if(!event||event.seq>=answer.seq||c&&event.seq<=root.seq)fail();
   const request={session:{id:scope.session_ref,header},runId:scope.run_id,messageId:message.id,signal},stamp=await admissions.read(request);check();
   if(!hash(stamp?.profile_fingerprint)||profile!==null&&profile!==stamp.profile_fingerprint)fail();profile=stamp.profile_fingerprint;
   const expected={protocol:c?3:2,run_id:scope.run_id,input_message_id:c?c.input_message_id:source.input_message_id,conversation_id:scope.conversation_id,owner_id:scope.owner_id,session_id:scope.session_ref,session_created_at:header.createdAt,input_sha256:c?c.input_sha256:source.input_sha256,native_message_id:message.id,native_message_sha256:sha(canonical(message)),profile_fingerprint:profile,...(c?{request_id:c.command_id,original_input_message_id:source.input_message_id,original_input_sha256:source.input_sha256,command_sha256:c.command_sha256,native_content_sha256:c.native_content_sha256}:{})};
   if(!isDeepStrictEqual(stamp,expected)||c&&(message.content.length!==1||Object.keys(message.content[0]).sort().join(',')!=='text,type'||message.content[0].type!=='text'||sha(JSON.stringify(message.content))!==c.native_content_sha256))fail();
   const entry=await admissions.inspectEntry(request);check();if(!entry||Object.keys(entry).sort().join(',')!=='admission_sha256,entry,execution_authorized,protocol,state'||entry.protocol!==1||entry.execution_authorized!==false||entry.admission_sha256!==sha(canonical(stamp))||!['reserved','unreserved'].includes(entry.state)||entry.state==='unreserved'&&entry.entry!==null||entry.state==='reserved'&&entry.entry?.admission_sha256!==entry.admission_sha256)fail();
   proofs.push({request,stamp,entry});nativeIds.push(message.id);
  }
  const outputEvents=[];for(const e of events.filter(e=>e.seq>boundary&&e.seq<lastEnd.seq)){
   if(e.type==='tool/call'){const id=e.data?.callId;if(!valid(id)||toolIds.has(id))fail();toolIds.add(id);pendingTools.set(id,e);}
   if(e.type==='tool/result'){if(e.data?.error?.code==='TOOL_OUTCOME_UNKNOWN')fail();const id=e.data?.message?.source?.callId??e.data?.message?.toolCallId??e.data?.callId;if(!valid(id))fail();if(e.surfaceOp!==undefined&&e.surfaceOp!=='append')continue;if(!pendingTools.delete(id)&&!(e.data?.message?.isError===true&&e.data?.error?.code==='TOOL_NOT_STARTED'))fail();outputEvents.push(e);}
   if(e.type==='deliverables/presented')outputEvents.push(e);
  }
  if(pendingTools.size)fail();
  for(const p of proofs){if(!isDeepStrictEqual(await admissions.read(p.request),p.stamp)||!isDeepStrictEqual(await admissions.inspectEntry(p.request),p.entry))fail();check();}
  if(!isDeepStrictEqual(await readRaw(),raw)||!isDeepStrictEqual(await readSource(),source))fail();check();
  return{protocol:1,kind:'ordinary_run_completion',run_id:scope.run_id,session_id:scope.session_ref,run_version:source.run_version,source_sha256:expectedSourceSha256,raw_sha256:sha(canonical(raw)),raw_event_count:events.length,profile_fingerprint:profile,command_ids:wanted.map(c=>c.command_id),native_message_ids:nativeIds,answer_sha256:sha(text),answer_seq:answer.seq,turn_end_seq:lastEnd.seq,answer_event:structuredClone(answer),output_events:structuredClone(outputEvents),execution_authorized:false};
 };
}
