import {prepareOrdinarySteeringAttachments,validateOrdinarySteeringAttachmentWire} from './ordinary-steering-attachments.js';
import {readOrdinarySteeringAuthority,hashNativeSteeringContent} from './ordinary-steering-authority.js';
import {verifyNativeInputAttachments} from './native-input-attachments.js';
import {AsyncLocalStorage} from 'node:async_hooks';import {createHash,randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
import {normalizeHostExecutionLease} from './workbench.js';import {readOrdinaryInputAuthority} from './ordinary-input-resume.js';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const digest=value=>createHash('sha256').update(JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item)).digest('hex');
const fail=()=>{throw Error('ordinary_input_admission_unconfirmed');};
function wait(promise,signal){const source=Promise.resolve(promise);if(signal.aborted){source.catch(()=>{});signal.throwIfAborted();}return new Promise((done,reject)=>{const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});source.then(value=>{cleanup();done(value);},error=>{cleanup();reject(error);});});}
/** Observe the actual Controller's final native message. Persist its hash before
 * the original pre-step may enter, without changing attachment admission/send. */
export function createOrdinaryInputAdmissionHost({ctx,agents,bridge,profile,admissions,ordinaryPresets,modelSelector,contextSelector,webSelector,beforeInput,attachmentSteeringProtocol}){
 if(attachmentSteeringProtocol!==undefined&&attachmentSteeringProtocol!==1||attachmentSteeringProtocol===1&&(admissions?.steeringAttachmentAdmissionProtocol!==1||admissions?.requestInspectionProtocol!==1||typeof admissions.readRequestAdmission!=='function'))fail();
 if(beforeInput!==undefined&&typeof beforeInput!=='function')fail();
 if(modelSelector!==undefined&&typeof modelSelector!=='function')fail();
 if(contextSelector!==undefined&&typeof contextSelector!=='function')fail();
 if(webSelector!==undefined&&(typeof webSelector!=='function'||typeof webSelector.prepareAgent!=='function'))fail();
 if(typeof ctx?.on!=='function'||typeof ctx.sessions?.flush!=='function'||typeof agents?.get!=='function'||typeof bridge?.request!=='function'||typeof profile?.read!=='function'||typeof admissions?.create!=='function'||typeof admissions?.read!=='function'||admissions.entryReservationProtocol!==1||typeof admissions.reserveEntry!=='function'||typeof admissions.readReplayCandidate!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size)fail();
 const storage=new AsyncLocalStorage(),records=new Map(),busy=new Set(),pending=new Set(),modelHooks=new Map(),shutdown=new AbortController();let disposed=false;
 const check=record=>{record.signal.throwIfAborted();if(disposed||agents.get(record.agent.id)!==record.agent||record.agent.session!==record.session||record.agent.id!==record.binding.sessionRef||record.session.id!==record.binding.sessionRef||!ordinaryPresets.has(record.session.header.agentPreset))fail();};
 const readAuthority=record=>(record.steering?readOrdinarySteeringAuthority:readOrdinaryInputAuthority)({bridge,binding:record.binding,signal:record.signal,assertActive:()=>check(record),...(record.steering&&attachmentSteeringProtocol===1?{attachmentProtocol:1}:{})});
 const audit=async record=>{check(record);const authority=await readAuthority(record);if(record.authority&&!isDeepStrictEqual(authority,record.authority))fail();record.authority??=authority;
  const reviewed=await wait(profile.read({presetId:record.session.header.agentPreset,agent:record.agent,phase:'bound',signal:record.signal}),record.signal);check(record);
  if(!reviewed||Object.keys(reviewed).sort().join(',')!=='audit_id,fingerprint,preset_id,profile_id,protocol'||reviewed.protocol!==1||!valid(reviewed.profile_id)||!valid(reviewed.audit_id)||reviewed.preset_id!==record.session.header.agentPreset||!/^[a-f0-9]{64}$/.test(reviewed.fingerprint??''))fail();if(record.profile&&!isDeepStrictEqual(reviewed,record.profile))fail();record.profile??=freeze(structuredClone(reviewed));
  if(!isDeepStrictEqual(await readAuthority(record),record.authority))fail();check(record);
 };
 const contentHash=content=>createHash('sha256').update(JSON.stringify(content)).digest('hex');
 const verifyContent=(record,content)=>{if(!record.steering)return;if(record.authority.protocol===2){if(!record.expectedNativeSha256&&!record.recovered||record.expectedNativeSha256&&contentHash(content)!==record.expectedNativeSha256)fail();}else if(hashNativeSteeringContent(content)!==record.authority.native_content_sha256)fail();};
 const receipt=(record,message)=>({protocol:record.steering?(record.authority.protocol===2?4:3):2,...(record.steering?{request_id:record.requestId,original_input_message_id:record.authority.original_input_message_id,original_input_sha256:record.authority.original_input_sha256,command_sha256:record.authority.command_sha256,native_content_sha256:record.authority.protocol===2?contentHash(message.content):record.authority.native_content_sha256,...(record.authority.protocol===2?{attachment_manifest_sha256:record.authority.attachment_manifest_sha256}:{})}:{}),run_id:record.authority.run_id,input_message_id:record.authority.input_message_id,conversation_id:record.authority.conversation_id,owner_id:record.authority.owner_id,session_id:record.session.id,session_created_at:record.session.header.createdAt,input_sha256:record.authority.input_sha256,native_message_id:message.id,native_message_sha256:digest(message),profile_fingerprint:record.profile.fingerprint});
 const verify=async record=>{check(record);if(record.error||!record.message||!record.persisting)fail();await wait(record.persisting,record.signal);check(record);if(digest(record.native)!==digest(record.message))fail();await audit(record);verifyContent(record,record.message.content);};
 const preserve=(record,payload)=>{if(payload.signal?.aborted||agents.get(record.agent.id)!==record.agent)return;const events=record.session.snapshotEvents(0),entered=new Set(events.filter(e=>e.type==='user/message').map(e=>e.data?.id));for(const native of [...payload.messages].toReversed()){
  if(native?.role!=='user'||native.source?.kind!=='user'||entered.has(native.id))continue;const message=native.id===record.message?.id?record.message:native,existing=[...record.agent.inbox.nextStep,...record.agent.inbox.nextTurn].filter(m=>m.id===message.id);if(existing.length){if(existing.length!==1||!isDeepStrictEqual(existing[0],message))fail();}else record.agent.inbox.prepend('next-step',message);
 }};
 const reject=(record,payload)=>{try{preserve(record,payload);}finally{if(agents.get(record.agent.id)===record.agent&&!payload.signal?.aborted)record.agent.cancel({kind:'parent'},{keepInbox:true});}return {kind:'reject'};};
 const removers=[];const on=(name,fn)=>removers.push(ctx.on(name,fn,{prepend:true}));
 on('agent/inbox/inserted',({agent,message})=>{const record=storage.getStore();if(!record||record.agent!==agent||message?.source?.kind!=='user')return;
  record.observed.add(message.id);if(record.closed||record.message||message.source.rpcId!==record.requestId||!valid(message.id)){record.error=true;return;}
  record.native=message;record.message=freeze(structuredClone(message));record.persisting=Promise.resolve().then(async()=>{check(record);verifyContent(record,record.message.content);if(await wait(ctx.sessions.flush(record.session),record.signal)!==true)fail();check(record);return admissions.create(record.session,receipt(record,record.message),{signal:record.signal});});record.persisting.catch(()=>{});
 });
 const ensureModelHook=agent=>{webSelector?.prepareAgent(agent);if(!modelSelector||modelHooks.has(agent))return;modelSelector.prepareAgent?.(agent);const remove=agent.ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const owned=[...(records.get(context.agent)??[])];if(!owned.length)return next();
  const original=owned[0],signal=AbortSignal.any([original.signal,...(context.signal?[context.signal]:[])]);
  try{
   if(owned.some(record=>record.binding.runId!==original.binding.runId||!isDeepStrictEqual(record.binding.executionLease,original.binding.executionLease)))fail();
   await wait(modelSelector({agent:context.agent,binding:original.binding,signal,check:async()=>{for(const record of owned)await verify(record);}}),signal);
   return await next();
  }catch(error){reject(original,{agent:context.agent,signal:context.signal,messages:owned.map(record=>record.message).filter(Boolean)});throw error;}
 },{prepend:true});modelHooks.set(agent,remove);};
 on('agent/pre-step',async(payload,next)=>{const owned=[...(records.get(payload.agent)??[])].filter(r=>payload.messages?.some(m=>r.observed.has(m.id)||m.id===r.message?.id||m.source?.kind==='user'&&m.source.rpcId===r.requestId));
  for(const record of owned){record.context=payload;try{payload.signal?.throwIfAborted();await verify(record);payload.signal?.throwIfAborted();}catch{try{return reject(record,payload);}finally{record.context=null;}}}
  let decision=await next();if(decision.kind==='reject'){for(const record of owned)record.context=null;return decision;}
  if(contextSelector&&owned.length){
   const original=owned[0],signal=AbortSignal.any([original.signal,...(payload.signal?[payload.signal]:[])]);
   try{
    if(owned.some(record=>record.binding.runId!==original.binding.runId||record.binding.sessionRef!==original.binding.sessionRef||!isDeepStrictEqual(record.binding.executionLease,original.binding.executionLease)))fail();
    const prepared=await wait(contextSelector({agent:payload.agent,binding:{runId:original.binding.runId,sessionRef:original.binding.sessionRef,executionLease:original.binding.executionLease},signal,check:async()=>{for(const record of owned)await verify(record);}}),signal);
    if(prepared!==undefined){
     if(!prepared||!['startsRequestSeries','contextMessage,startsRequestSeries'].includes(Object.keys(prepared).sort().join(','))||prepared.startsRequestSeries!==true)fail();
     if(prepared.contextMessage!==undefined){const message=prepared.contextMessage;if(message?.role!=='user'||message.source?.kind!=='jot-chat-context'||message.source.run_id!==original.binding.runId||typeof message.source.context_sha256!=='string'||!/^[a-f0-9]{64}$/.test(message.source.context_sha256)||!Array.isArray(message.content)||message.content.length!==1||message.content[0]?.type!=='text'||typeof message.content[0].text!=='string'||message.content[0].text.length>14000||decision.messages.some(item=>item.id===message.id))fail();decision={...decision,messages:[message,...decision.messages]};}
     decision={...decision,startsRequestSeries:true};
    }
   }catch{try{return reject(original,{...payload,messages:[...payload.messages,...(decision.messages??[])]});}finally{for(const record of owned)record.context=null;}}
  }
  if(webSelector&&owned.length){
   const original=owned[0],signal=AbortSignal.any([original.signal,...(payload.signal?[payload.signal]:[])]);
   try{
    if(owned.some(record=>record.binding.runId!==original.binding.runId||record.binding.sessionRef!==original.binding.sessionRef||!isDeepStrictEqual(record.binding.executionLease,original.binding.executionLease)))fail();
    await wait(webSelector({agent:payload.agent,binding:{runId:original.binding.runId,sessionRef:original.binding.sessionRef,executionLease:original.binding.executionLease},signal,check:async()=>{for(const record of owned)await verify(record);}}),signal);
   }catch{try{return reject(original,{...payload,messages:[...payload.messages,...(decision.messages??[])]});}finally{for(const record of owned)record.context=null;}}
  }
  for(const record of owned){try{payload.signal?.throwIfAborted();await verify(record);payload.signal?.throwIfAborted();const originals=decision.messages?.filter(m=>m.id===record.message.id);if(originals?.length!==1||digest(originals[0])!==digest(record.message))fail();await wait(admissions.reserveEntry(record.session,receipt(record,record.message),record.entry,{signal:record.signal}),record.signal);await audit(record);payload.signal?.throwIfAborted();}catch{return reject(record,{...payload,messages:[...payload.messages,...(decision.messages??[])]});}finally{record.context=null;}}return decision;
 });
 on('session/event',(session,event)=>{if(event.type!=='user/message')return;for(const record of records.get(agents.get(session.id))??[]){if(record.session===session&&record.message?.id===event.data?.id){record.entered=true;records.get(record.agent).delete(record);if(!records.get(record.agent).size)records.delete(record.agent);}}});
 on('agent/disposed',({agent})=>{records.delete(agent);modelHooks.get(agent)?.();modelHooks.delete(agent);webSelector?.disposeAgent?.(agent);});
 const submit=({binding,signal=new AbortController().signal,content},operation,steering=false)=>{const task=(async()=>{
   if(disposed||!binding||Object.keys(binding).sort().join(',')!==(steering?'commandId,executionLease,runId,sessionRef':'executionLease,runId,sessionRef')||steering&&(!valid(binding.commandId)||binding.commandId===binding.runId||admissions.steeringAdmissionProtocol!==1)||!valid(binding.runId)||!valid(binding.sessionRef)||typeof operation!=='function'||busy.has(binding.sessionRef))fail();
   const requestId=steering?binding.commandId:binding.runId,expectedContent=steering?freeze(structuredClone(content)):undefined;const owned=freeze({runId:binding.runId,sessionRef:binding.sessionRef,...(steering?{commandId:binding.commandId}:{}),executionLease:normalizeHostExecutionLease(binding.executionLease)}),agent=agents.get(owned.sessionRef),session=agent?.session;
   if(!session||!Number.isSafeInteger(session.header?.createdAt)||session.header.createdAt<0||session.header.parentSession!==undefined||session.header.origin==='subagent')fail();
   ensureModelHook(agent);
   const record={binding:owned,requestId,steering,agent,session,signal:AbortSignal.any([signal,shutdown.signal]),entry:freeze({execution_lease:owned.executionLease,observer_id:randomUUID()}),observed:new Set(),closed:false};busy.add(owned.sessionRef);
   try{await audit(record);if(steering){if(record.authority.protocol===2)validateOrdinarySteeringAttachmentWire(record.authority,expectedContent);else if(hashNativeSteeringContent(expectedContent)!==record.authority.native_content_sha256)fail();}if(beforeInput){await wait(beforeInput({agent,binding:owned,signal:record.signal}),record.signal);await audit(record);}const previous=[...(records.get(agent)??[])].filter(r=>r.binding.runId===owned.runId&&r.requestId===requestId);if(previous.length){if(previous.length!==1||!isDeepStrictEqual(previous[0].binding,owned))fail();await verify(previous[0]);return {accepted:true};}const history=session.snapshotEvents(0),existing=[...history.filter(e=>e.type==='user/message').map(e=>e.data),...agent.inbox.nextStep,...agent.inbox.nextTurn].filter(m=>m.source?.kind==='user'&&m.source.rpcId===requestId);if(existing.length>1)fail();
    if(existing.length){const row=await wait(admissions.read({session,runId:owned.runId,messageId:existing[0].id,signal:record.signal}),record.signal);if(!isDeepStrictEqual(row,receipt(record,existing[0])))fail();await audit(record);if(steering&&record.authority.protocol===2)return{accepted:true};return await wait(Promise.resolve().then(()=>{check(record);return operation();}),record.signal);}
    if(history.some(e=>e.type==='agent/inbox/spliced'&&e.data?.inserted?.some(m=>m.source?.kind==='user'&&m.source.rpcId===requestId)))fail();
    if(steering&&record.authority.protocol===2){const prepared=await wait(prepareOrdinarySteeringAttachments({ctx,agent,authority:record.authority,content:expectedContent,signal:record.signal,assertActive:()=>check(record)}),record.signal);record.expectedNativeSha256=prepared.native_content_sha256;await audit(record);}
    if(!records.has(agent))records.set(agent,new Set());records.get(agent).add(record);
    const value=await storage.run(record,()=>wait(Promise.resolve().then(()=>{check(record);return operation();}),record.signal));await verify(record);return value;
   }finally{record.closed=true;busy.delete(owned.sessionRef);}
  })();pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});return task;
 };
 return{entryReservationProtocol:1,...(attachmentSteeringProtocol===1?{steeringAttachmentAdmissionProtocol:1}:{}),
  async observeSteeringAdmission({binding,signal=new AbortController().signal}){
   if(attachmentSteeringProtocol!==1||disposed||!binding||Object.keys(binding).sort().join(',')!=='commandId,executionLease,runId,sessionRef'||!valid(binding.runId)||!valid(binding.commandId)||binding.commandId===binding.runId||!valid(binding.sessionRef)||busy.has(binding.sessionRef))fail();
   const owned=freeze({runId:binding.runId,commandId:binding.commandId,sessionRef:binding.sessionRef,executionLease:normalizeHostExecutionLease(binding.executionLease)}),agent=agents.get(owned.sessionRef),session=agent?.session;
   if(!session||!Number.isSafeInteger(session.header?.createdAt)||session.header.createdAt<0||session.header.parentSession!==undefined||session.header.origin==='subagent')fail();
   const record={binding:owned,requestId:owned.commandId,steering:true,agent,session,signal:AbortSignal.any([signal,shutdown.signal])};await audit(record);if(record.authority.protocol!==2)fail();
   const snapshot=()=>{check(record);if(busy.has(owned.sessionRef))fail();return structuredClone({seq:session.seq,history:session.snapshotEvents(0),pending:[...agent.inbox.nextStep,...agent.inbox.nextTurn]});},before=snapshot(),matches=[...before.history.filter(e=>e.type==='user/message').map(e=>e.data),...before.pending].filter(m=>m?.source?.kind==='user'&&m.source.rpcId===owned.commandId);
   if(matches.length>1)fail();const view=await wait(admissions.readRequestAdmission({session,runId:owned.runId,requestId:owned.commandId,signal:record.signal}),record.signal);let state='unproven';
   if(!view||Object.keys(view).sort().join(',')!=='admission,state'||!['admitted','unproven'].includes(view.state))fail();
   if(view.state==='admitted'){const stamp=view.admission;if(!valid(stamp?.native_message_id)||!['native_message_sha256','native_content_sha256'].every(key=>/^[a-f0-9]{64}$/.test(stamp[key]??'')))fail();
    const expected={protocol:4,request_id:record.requestId,original_input_message_id:record.authority.original_input_message_id,original_input_sha256:record.authority.original_input_sha256,command_sha256:record.authority.command_sha256,native_content_sha256:stamp.native_content_sha256,attachment_manifest_sha256:record.authority.attachment_manifest_sha256,run_id:record.authority.run_id,input_message_id:record.authority.input_message_id,conversation_id:record.authority.conversation_id,owner_id:record.authority.owner_id,session_id:session.id,session_created_at:session.header.createdAt,input_sha256:record.authority.input_sha256,native_message_id:stamp.native_message_id,native_message_sha256:stamp.native_message_sha256,profile_fingerprint:record.profile.fingerprint};
    if(!isDeepStrictEqual(stamp,expected)||!isDeepStrictEqual(await wait(admissions.read({session,runId:owned.runId,messageId:stamp.native_message_id,signal:record.signal}),record.signal),stamp))fail();
    if(matches.length){const message=freeze(structuredClone(matches[0]));if(!valid(message.id)||message.role!=='user'||!Array.isArray(message.content)||!isDeepStrictEqual(stamp,receipt(record,message)))fail();}state='accepted';
   }else if(view.admission!==null||matches.length||before.history.some(e=>e.type==='agent/inbox/spliced'&&e.data?.inserted?.some(m=>m?.source?.kind==='user'&&m.source.rpcId===owned.commandId)))fail();
   await audit(record);const after=snapshot();if(after.seq!==before.seq||!isDeepStrictEqual(after.pending,before.pending)||!isDeepStrictEqual(after.history,before.history))fail();
   return{protocol:1,kind:'ordinary_steering_admission',run_id:owned.runId,command_id:owned.commandId,session_id:owned.sessionRef,source_sha256:digest(record.authority),state,execution_authorized:false};
  },
  withPrompt:(request,operation)=>submit(request,operation),
  withSteer:(request,operation)=>submit(request,operation,true),
  async ownsNativeInput({agent,message,binding}){const found=[...(records.get(agent)??[])].filter(r=>r.message?.id===message?.id&&r.binding.runId===binding.runId&&r.binding.sessionRef===agent.id&&isDeepStrictEqual(r.binding.executionLease,binding.executionLease));if(found.length!==1)return false;const record=found[0];if(digest(message)!==digest(record.message))fail();await verify(record);return true;},
  async adoptRecovered({agent,binding,signal=new AbortController().signal}){
   if(disposed||!binding||Object.keys(binding).sort().join(',')!=='executionLease,runId,sessionRef'||!valid(binding.runId)||!valid(binding.sessionRef)||!agent||agent.id!==binding.sessionRef||agents.get(agent.id)!==agent||agent.status!=='idle'||!Number.isSafeInteger(agent.session?.seq)||busy.has(agent.id))fail();
   ensureModelHook(agent);
   const owned=freeze({runId:binding.runId,sessionRef:binding.sessionRef,executionLease:normalizeHostExecutionLease(binding.executionLease)}),session=agent.session,seq=session.seq,pendingMessages=[...agent.inbox.nextStep,...agent.inbox.nextTurn],prepared=[];
   const idle=()=>{signal.throwIfAborted();if(disposed||agents.get(agent.id)!==agent||agent.session!==session||agent.status!=='idle'||session.seq!==seq)fail();};
   if(!pendingMessages.length||new Set(pendingMessages.map(m=>m.id)).size!==pendingMessages.length)fail();
   const rpcIds=new Set();busy.add(agent.id);try{for(const message of pendingMessages){idle();if(!valid(message?.id)||message.role!=='user'||message.source?.kind!=='user'||!valid(message.source.rpcId)||rpcIds.has(message.source.rpcId))fail();rpcIds.add(message.source.rpcId);const requestId=message.source.rpcId,steering=requestId!==owned.runId;if(steering&&admissions.steeringAdmissionProtocol!==1)fail();
    const record={binding:steering?freeze({...owned,commandId:requestId}):owned,requestId,steering,recovered:true,agent,session,signal:AbortSignal.any([signal,shutdown.signal]),entry:freeze({execution_lease:owned.executionLease,observer_id:randomUUID()}),observed:new Set([message.id]),native:message,message:freeze(structuredClone(message)),persisting:Promise.resolve(),closed:true};
    await audit(record);idle();const row=await wait(admissions.readReplayCandidate({session,runId:owned.runId,messageId:message.id,signal:record.signal}),record.signal);idle();if(!isDeepStrictEqual(row,receipt(record,record.message)))fail();await verify(record);idle();prepared.push(record);
   }
   const attachmentSignal=AbortSignal.any([signal,shutdown.signal]);await wait(verifyNativeInputAttachments(prepared.map(record=>record.message),{attachments:typeof ctx.get==='function'?ctx.get('attachments'):ctx.attachments,signal:attachmentSignal}),attachmentSignal);idle();for(const record of prepared){await verify(record);idle();}
   // The old execution is idle and the exact original messages have no entry
   // reservation. Rebind only their local guards to the currently proven lease.
   const prior=records.get(agent)??new Set();for(const record of [...prior])if(record.binding.runId===owned.runId)prior.delete(record);for(const record of prepared)prior.add(record);records.set(agent,prior);
   return{execution_authorized:false,message_ids:prepared.map(record=>record.message.id)};
   }finally{busy.delete(agent.id);}
  },
  async dispose(){if(disposed)return;disposed=true;shutdown.abort(Error('ordinary_admission_host_disposed'));for(const group of records.values())for(const record of group){if(record.context)try{preserve(record,record.context);}catch{}if(agents.get(record.agent.id)===record.agent)record.agent.cancel({kind:'parent'},{keepInbox:true});}await Promise.allSettled([...pending]);for(const remove of modelHooks.values())remove();modelHooks.clear();if(!records.size){removers.forEach(remove=>remove());storage.disable();}}
 };
}
