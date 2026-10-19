import {mkdir,open,lstat,link,unlink,opendir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const keys='conversation_id,input_message_id,input_sha256,native_message_id,native_message_sha256,owner_id,profile_fingerprint,protocol,run_id,session_created_at,session_id';
const steeringKeys=(keys+',request_id,original_input_message_id,original_input_sha256,command_sha256,native_content_sha256').split(',').sort().join(',');
const attachmentSteeringKeys=(steeringKeys+',attachment_manifest_sha256').split(',').sort().join(',');
const fail=()=>{throw Error('ordinary_admission_invalid');};
function identity(session,runId,messageId){if(!valid(session?.id)||!valid(runId)||!valid(messageId)||!Number.isSafeInteger(session.header?.createdAt)||session.header.createdAt<0)fail();return {session_id:session.id,session_created_at:session.header.createdAt,run_id:runId,native_message_id:messageId};}
function validate(value,scope){if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==(value.protocol===4?attachmentSteeringKeys:value.protocol===3?steeringKeys:keys)||![2,3,4].includes(value.protocol)||[3,4].includes(value.protocol)&&(!valid(value.request_id)||value.request_id===value.run_id||!valid(value.original_input_message_id)||!['original_input_sha256','command_sha256','native_content_sha256'].every(k=>/^[a-f0-9]{64}$/.test(value[k]??'')))||value.protocol===4&&!/^[a-f0-9]{64}$/.test(value.attachment_manifest_sha256??'')||!['conversation_id','input_message_id','native_message_id','owner_id','run_id','session_id'].every(k=>valid(value[k]))||!['input_sha256','native_message_sha256','profile_fingerprint'].every(k=>/^[a-f0-9]{64}$/.test(value[k]??''))||!Object.keys(scope).every(k=>value[k]===scope[k]))fail();return value;}
/** Operator-owned private metadata, outside Agent workspaces and native logs.
 * One immutable hash-only record per Session incarnation/run/native message.
 * Creating a record is allowed only on original admission, never recovery. */
export function createOrdinaryInputAdmissions({root}={}){
 if(typeof root!=='string'||!isAbsolute(root))fail();
 const pathFor=scope=>join(root,createHash('sha256').update(JSON.stringify(scope)).digest('hex')+'.json');
 const existingRoot=async()=>{const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())fail();};
 const safeRoot=async()=>{await mkdir(root,{recursive:true,mode:0o700});await existingRoot();};
 const readPath=async(path,signal)=>{signal?.throwIfAborted();const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)fail();let handle;
  try{handle=await open(path,'r');const opened=await handle.stat();if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size>4096)fail();const value=JSON.parse(await handle.readFile({encoding:'utf8',signal}));signal?.throwIfAborted();return value;}finally{await handle?.close();}
 };
 const readJson=async(scope,suffix,signal)=>{signal?.throwIfAborted();await existingRoot();return readPath(pathFor(scope).replace(/\.json$/,suffix),signal);};
 const read=async({session,runId,messageId,signal})=>{const scope=identity(session,runId,messageId);return validate(await readJson(scope,'.json',signal),scope);};
 const publish=async(scope,value,suffix,conflict,signal)=>{signal?.throwIfAborted();const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>4096)fail();await safeRoot();signal?.throwIfAborted();const temporary=join(root,'.pending-'+randomUUID());let handle;
  try{handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes,{signal});await handle.sync();await handle.close();handle=undefined;signal?.throwIfAborted();
   try{await link(temporary,pathFor(scope).replace(/\.json$/,suffix));}catch(error){if(error.code!=='EEXIST')throw error;if(!isDeepStrictEqual(await readJson(scope,suffix,signal),value))throw Error(conflict);}
   if(process.platform!=='win32'){const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}}
  }finally{await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}signal?.throwIfAborted();
 };
 const unreserved=async(scope,signal)=>{signal?.throwIfAborted();try{await lstat(pathFor(scope).replace(/\.json$/,'.entry.json'));}catch(error){if(error.code==='ENOENT'){signal?.throwIfAborted();return;}throw error;}throw Error('ordinary_input_entry_reserved');};
 const canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
 const requestScope=({session,runId,requestId})=>{if(!valid(session?.id)||!Number.isSafeInteger(session.header?.createdAt)||session.header.createdAt<0||!valid(runId)||!valid(requestId)||requestId===runId)fail();return{session_id:session.id,session_created_at:session.header.createdAt,run_id:runId,request_id:requestId};};
 return Object.freeze({entryReservationProtocol:1,steeringAdmissionProtocol:1,steeringAttachmentAdmissionProtocol:1,entryInspectionProtocol:1,requestInspectionProtocol:1,read,
  /** Same original store, reverse metadata lookup only. Missing indexes from
   * legacy/partial copies fall back to a bounded-memory primary receipt scan;
   * absent logical surface messages never establish non-admission. */
  async readRequestAdmission(request){const scope=requestScope(request),signal=request.signal;signal?.throwIfAborted();await existingRoot();
   const indexed=async()=>{let raw;try{raw=await readJson(scope,'.request-ref',signal);}catch(error){if(error.code!=='ENOENT')throw error;await existingRoot();return undefined;}const row=validate(raw,scope);if(row.protocol!==4)fail();const primary=await read({session:request.session,runId:request.runId,messageId:row.native_message_id,signal});if(!isDeepStrictEqual(primary,row)||!isDeepStrictEqual(await readJson(scope,'.request-ref',signal),row))fail();return{state:'admitted',admission:structuredClone(row)};};
   const first=await indexed();if(first)return first;
   let found=null;const directory=await opendir(root);for await(const entry of directory){signal?.throwIfAborted();if(!/^[a-f0-9]{64}\.json$/.test(entry.name))continue;const row=await readPath(join(root,entry.name),signal);if(!Number.isSafeInteger(row?.session_created_at)||row.session_created_at<0)fail();const identityScope=identity({id:row.session_id,header:{createdAt:row.session_created_at}},row.run_id,row.native_message_id);validate(row,identityScope);if(pathFor(identityScope)!==join(root,entry.name))fail();if(row.protocol!==4||!Object.keys(scope).every(key=>row[key]===scope[key]))continue;if(found)fail();found=await read({session:request.session,runId:request.runId,messageId:row.native_message_id,signal});if(!isDeepStrictEqual(found,row))fail();}
   signal?.throwIfAborted();await existingRoot();const latest=await indexed();if(latest)return latest;
   return found?{state:'admitted',admission:structuredClone(found)}:{state:'unproven',admission:null};
  },
  /** A reservation observation is never dispatch, usage, completion or replay
   * authority. Missing admissions refuse; no directory or receipt is created. */
  async inspectEntry(request){
   const scope=identity(request.session,request.runId,request.messageId),stamp=await read(request),digest=createHash('sha256').update(canonical(stamp)).digest('hex');let entry=null,present=true;
   try{entry=await readJson(scope,'.entry.json',request.signal);}catch(error){if(error.code!=='ENOENT')throw error;present=false;
    // Missing storage must not masquerade as an absent reservation.
    await existingRoot();
   }
   if(present){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))fail();
    const lease=entry.execution_lease;
    if(Object.keys(entry).sort().join(',')!=='admission_sha256,execution_lease,native_message_id,observer_id,protocol,run_id,session_created_at,session_id'
     ||entry.protocol!==1||!Object.keys(scope).every(k=>entry[k]===scope[k])||entry.admission_sha256!==digest||!valid(entry.observer_id)
     ||!lease||Object.keys(lease).sort().join(',')!=='generation,owner'||!valid(lease.owner)||!Number.isSafeInteger(lease.generation)||lease.generation<1)fail();
   }
   if(!isDeepStrictEqual(await read(request),stamp))fail();request.signal?.throwIfAborted();
   return Object.freeze({protocol:1,state:entry?'reserved':'unreserved',admission_sha256:digest,entry:entry?structuredClone(entry):null,execution_authorized:false});
  },
  async create(session,value,{signal}={}){const scope=identity(session,value?.run_id,value?.native_message_id),stamp=structuredClone(validate(value,scope));if(stamp.protocol===4)await publish(requestScope({session,runId:stamp.run_id,requestId:stamp.request_id}),stamp,'.request-ref','ordinary_admission_request_conflict',signal);return publish(scope,stamp,'.json','ordinary_admission_conflict',signal);},
  async readReplayCandidate(request){const scope=identity(request.session,request.runId,request.messageId);await unreserved(scope,request.signal);const value=await read(request);await unreserved(scope,request.signal);return value;},
  async reserveEntry(session,value,attempt,{signal}={}){
   signal?.throwIfAborted();const scope=identity(session,value?.run_id,value?.native_message_id),stamp=structuredClone(validate(value,scope)),lease=attempt?.execution_lease;
   if(!attempt||Object.keys(attempt).sort().join(',')!=='execution_lease,observer_id'||!valid(attempt.observer_id)||!lease||Object.keys(lease).sort().join(',')!=='generation,owner'||!valid(lease.owner)||!Number.isSafeInteger(lease.generation)||lease.generation<1)fail();
   const entry={protocol:1,...scope,admission_sha256:createHash('sha256').update(canonical(stamp)).digest('hex'),execution_lease:{owner:lease.owner,generation:lease.generation},observer_id:attempt.observer_id};
   if(!isDeepStrictEqual(await read({session,runId:scope.run_id,messageId:scope.native_message_id,signal}),stamp))fail();return publish(scope,entry,'.entry.json','ordinary_input_entry_reserved',signal);
  }
 });
}
