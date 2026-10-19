import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateOrdinarySteeringAttachmentSource} from './ordinary-steering-attachments.js';
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const digest=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>{throw Error('ordinary_steering_observation_unconfirmed');};
const sourceKeys='command_id,command_sha256,command_status,conversation_id,execution_authorized,input_message_id,input_sha256,kind,native_acceptance,native_content_sha256,original_input_message_id,original_input_sha256,owner_id,product_message_present,protocol,run_id,run_status,run_version,session_id';
function validateScope(scope){
 if(!scope||typeof scope!=='object'||Array.isArray(scope)||Object.keys(scope).sort().join(',')!=='command_id,conversation_id,expected_run_version,owner_id,run_id,session_ref'
  ||!['command_id','conversation_id','owner_id','run_id','session_ref'].every(k=>valid(scope[k]))||scope.command_id===scope.run_id||!Number.isSafeInteger(scope.expected_run_version)||scope.expected_run_version<1)fail();
}
export function normalizeOrdinaryHistoryScope(scope){validateScope(scope);return structuredClone(scope);}
function validateSource(row,scope,attachmentEnabled){
 const attachment=row?.protocol===2,keys=attachment?sourceKeys.split(',').filter(key=>key!=='native_content_sha256').concat(['attachment_manifest','attachment_manifest_sha256','text_sha256']).sort().join(','):sourceKeys;
 if(!row||Object.keys(row).sort().join(',')!==keys||(!attachment&&row.protocol!==1)||(attachment&&!attachmentEnabled)||row.kind!=='ordinary_steer_history'||row.execution_authorized!==false||row.native_acceptance!=='unverified'
  ||row.run_id!==scope.run_id||row.command_id!==scope.command_id||row.conversation_id!==scope.conversation_id||row.owner_id!==scope.owner_id||row.session_id!==scope.session_ref||row.run_version!==scope.expected_run_version
  ||!['succeeded','failed','cancelled','interrupted','partial'].includes(row.run_status)||!['pending','applied','superseded','rejected'].includes(row.command_status)
  ||!valid(row.original_input_message_id)||row.input_message_id!=='message-'+scope.command_id||!['original_input_sha256','command_sha256','input_sha256',...(attachment?[]:['native_content_sha256'])].every(k=>hash(row[k]))
  ||typeof row.product_message_present!=='boolean'||row.command_status==='applied'&&!row.product_message_present)fail();
 if(attachment)validateOrdinarySteeringAttachmentSource({...row,kind:'ordinary_steer_attachments'});return structuredClone(row);
}

/** Read-only historical facts. It never resolves an Agent, creates a Session
 * store entry, repairs an inbox/ACK, prompts, reserves, flushes or settles cost.
 * Neither absent input nor an absent reservation authorizes redelivery. */
export function createOrdinarySteeringObservationReader({bridge,persistence,admissions,agents,sessions,Session,validateLog,ordinaryPresets,attachmentSteeringProtocol}){
 if(attachmentSteeringProtocol!==undefined&&attachmentSteeringProtocol!==1||attachmentSteeringProtocol===1&&admissions?.steeringAttachmentAdmissionProtocol!==1)fail();
 if(typeof bridge?.request!=='function'||typeof persistence?.open!=='function'||admissions?.entryInspectionProtocol!==1||typeof admissions.read!=='function'||typeof admissions.inspectEntry!=='function'
  ||typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof Session?.create!=='function'||typeof validateLog!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size)fail();
 return async({scope:input,signal,protocol=1,expectedSourceSha256})=>{
  if(![1,2].includes(protocol)||protocol===1&&expectedSourceSha256!==undefined||protocol===2&&!hash(expectedSourceSha256))fail();
  const scope=normalizeOrdinaryHistoryScope(input);if(!signal)fail();
  const check=()=>{signal.throwIfAborted();if(agents.get(scope.session_ref)!==undefined||sessions.get(scope.session_ref)!==undefined)fail();};
  const readSource=async()=>{check();const value=await bridge.request('ordinary-steering-history',{runId:scope.run_id,sessionRef:scope.session_ref},
   {owner_id:scope.owner_id,conversation_id:scope.conversation_id,command_id:scope.command_id,expected_run_version:scope.expected_run_version},signal);check();return validateSource(value?.history,scope,attachmentSteeringProtocol===1&&protocol===2);};
  const source=await readSource(),sourceHash=digest(canonical(source));if(protocol===2&&sourceHash!==expectedSourceSha256)fail();
  const readRaw=async()=>{
   check();const handle=await persistence.open(scope.session_ref,'read',{signal});
   try{check();const read=await handle.read(0,undefined,{signal});check();return structuredClone({header:handle.header,inheritedEventCount:handle.inheritedEventCount,events:read.events});}
   finally{await handle.close();}
  };
  const raw=await readRaw(),header=raw.header,events=raw.events;
  if(header?.id!==scope.session_ref||!Number.isSafeInteger(header.createdAt)||header.createdAt<0||header.isSeeded!==false||raw.inheritedEventCount!==0||header.parentSession!==undefined||header.origin==='subagent'||!ordinaryPresets.has(header.agentPreset)
   ||!Array.isArray(events)||events.some((e,i)=>e?.seq!==i||typeof e.type!=='string'))fail();
  // Detached construction may add a neutral end-seed marker. Only the original
  // raw prefix below is used for digests, sequence facts and answer evidence.
  const detached=Session.create(scope.session_ref,structuredClone(events),structuredClone(header),0);
  if((await validateLog(detached,{signal}))?.validated!==true)fail();check();
  const candidates=new Map(),committed=new Map();let openTurn=null,lastEnd=null;
  const observe=message=>{
   if(message?.source?.kind!=='user'||![scope.run_id,scope.command_id].includes(message.source.rpcId))return;
   if(!valid(message.id)||message.role!=='user'||!Array.isArray(message.content))fail();
   const old=candidates.get(message.source.rpcId);if(old&&!isDeepStrictEqual(old,message))fail();candidates.set(message.source.rpcId,structuredClone(message));
  };
  for(const event of events){
   if(event.type==='turn/start'){if(openTurn!==null||!Number.isSafeInteger(event.data?.turn)||event.data.turn<0)fail();openTurn=event.data.turn;}
   if(event.type==='turn/end'){if(openTurn===null||event.data?.turn!==openTurn)fail();lastEnd=event;openTurn=null;}
   if(event.type==='agent/inbox/spliced'){if(!Array.isArray(event.data?.inserted))fail();for(const message of event.data.inserted)observe(message);}
   if(event.type==='user/message'){observe(event.data);const rpc=event.data?.source?.rpcId;if(event.data?.source?.kind==='user'&&[scope.run_id,scope.command_id].includes(rpc)){if(openTurn===null||committed.has(rpc))fail();committed.set(rpc,{seq:event.seq,turn:openTurn});}}
  }
  const root=candidates.get(scope.run_id),command=candidates.get(scope.command_id);if(command&&!root)fail();
  let profile=null,originalEntry=null,commandEntry=null;
  const session={id:scope.session_ref,header};
  const verify=async(message,steering)=>{
   const request={session,runId:scope.run_id,messageId:message.id,signal},stamp=await admissions.read(request);check();
   if(!hash(stamp?.profile_fingerprint)||profile!==null&&stamp.profile_fingerprint!==profile)fail();profile=stamp.profile_fingerprint;
   const attachment=steering&&source.protocol===2;
   const expected={protocol:steering?(attachment?4:3):2,run_id:scope.run_id,input_message_id:steering?source.input_message_id:source.original_input_message_id,conversation_id:scope.conversation_id,owner_id:scope.owner_id,
    session_id:scope.session_ref,session_created_at:header.createdAt,input_sha256:steering?source.input_sha256:source.original_input_sha256,native_message_id:message.id,native_message_sha256:digest(canonical(message)),profile_fingerprint:profile,
    ...(steering?{request_id:scope.command_id,original_input_message_id:source.original_input_message_id,original_input_sha256:source.original_input_sha256,command_sha256:source.command_sha256,native_content_sha256:attachment?digest(JSON.stringify(message.content)):source.native_content_sha256,...(attachment?{attachment_manifest_sha256:source.attachment_manifest_sha256}:{})}:{})};
   if(!isDeepStrictEqual(stamp,expected))fail();
   if(steering&&!attachment&&(message.content.length!==1||message.content[0]?.type!=='text'||Object.keys(message.content[0]).sort().join(',')!=='text,type'||digest(JSON.stringify(message.content))!==source.native_content_sha256))fail();
   const view=await admissions.inspectEntry(request);check();
   if(!view||Object.keys(view).sort().join(',')!=='admission_sha256,entry,execution_authorized,protocol,state'||view.protocol!==1||view.execution_authorized!==false||!['reserved','unreserved'].includes(view.state)||view.admission_sha256!==digest(canonical(stamp))||view.state==='unreserved'&&view.entry!==null||view.state==='reserved'&&view.entry?.admission_sha256!==view.admission_sha256)fail();
   if(!isDeepStrictEqual(await admissions.read(request),stamp))fail();check();return view.state;
  };
  if(root)originalEntry=await verify(root,false);if(command)commandEntry=await verify(command,true);
  const entered=committed.get(scope.command_id);let answer=null;
  if(entered&&committed.get(scope.run_id)?.seq<entered.seq&&openTurn===null&&lastEnd?.data.reason?.kind==='completed'&&lastEnd.data.turn===entered.turn){
   const final=events.findLast(e=>e.type==='assistant/message'&&e.data?.turn===entered.turn&&e.seq>entered.seq&&e.seq<lastEnd.seq);
   const text=final?.data?.message?.content?.filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join('').trim();
   if(text&&!events.some(e=>e.type==='user/message'&&e.seq>entered.seq&&e.seq<final.seq&&e.data?.source?.kind==='user'&&![scope.run_id,scope.command_id].includes(e.data.source.rpcId)))answer={answer_sha256:digest(text),answer_seq:final.seq,turn_end_seq:lastEnd.seq};
  }
  if(!isDeepStrictEqual(await readRaw(),raw)||!isDeepStrictEqual(await readSource(),source))fail();check();
  return{protocol,...(protocol===2?{source_sha256:sourceHash}:{}),kind:'ordinary_steer_observation',run_id:scope.run_id,command_id:scope.command_id,session_id:scope.session_ref,run_version:source.run_version,run_status:source.run_status,command_status:source.command_status,
   native_state:entered?'committed':command?'admitted':'unproven',original_native_message_id:root?.id??null,command_native_message_id:command?.id??null,
   profile_fingerprint:profile,raw_event_count:events.length,raw_sha256:digest(canonical(raw)),original_entry:originalEntry,command_entry:commandEntry,answer,execution_authorized:false};
 };
}
