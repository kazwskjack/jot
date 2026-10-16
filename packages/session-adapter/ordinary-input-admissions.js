import {mkdir,open,lstat,link,unlink} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const keys='conversation_id,input_message_id,input_sha256,native_message_id,native_message_sha256,owner_id,profile_fingerprint,protocol,run_id,session_created_at,session_id';
const steeringKeys=(keys+',request_id,original_input_message_id,original_input_sha256,command_sha256,native_content_sha256').split(',').sort().join(',');
const fail=()=>{throw Error('ordinary_admission_invalid');};
function identity(session,runId,messageId){if(!valid(session?.id)||!valid(runId)||!valid(messageId)||!Number.isSafeInteger(session.header?.createdAt)||session.header.createdAt<0)fail();return {session_id:session.id,session_created_at:session.header.createdAt,run_id:runId,native_message_id:messageId};}
function validate(value,scope){if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==(value.protocol===3?steeringKeys:keys)||![2,3].includes(value.protocol)||value.protocol===3&&(!valid(value.request_id)||value.request_id===value.run_id||!valid(value.original_input_message_id)||!['original_input_sha256','command_sha256','native_content_sha256'].every(k=>/^[a-f0-9]{64}$/.test(value[k]??'')))||!['conversation_id','input_message_id','native_message_id','owner_id','run_id','session_id'].every(k=>valid(value[k]))||!['input_sha256','native_message_sha256','profile_fingerprint'].every(k=>/^[a-f0-9]{64}$/.test(value[k]??''))||!Object.keys(scope).every(k=>value[k]===scope[k]))fail();return value;}
/** Operator-owned private metadata, outside Agent workspaces and native logs.
 * One immutable hash-only record per Session incarnation/run/native message.
 * Creating a record is allowed only on original admission, never recovery. */
export function createOrdinaryInputAdmissions({root}={}){
 if(typeof root!=='string'||!isAbsolute(root))fail();
 const pathFor=scope=>join(root,createHash('sha256').update(JSON.stringify(scope)).digest('hex')+'.json');
 const safeRoot=async()=>{await mkdir(root,{recursive:true,mode:0o700});const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())fail();};
 const readJson=async(scope,suffix,signal)=>{signal?.throwIfAborted();await safeRoot();const path=pathFor(scope).replace(/\.json$/,suffix),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)fail();let handle;
  try{handle=await open(path,'r');const opened=await handle.stat();if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size>4096)fail();const value=JSON.parse(await handle.readFile({encoding:'utf8',signal}));signal?.throwIfAborted();return value;}finally{await handle?.close();}
 };
 const read=async({session,runId,messageId,signal})=>{const scope=identity(session,runId,messageId);return validate(await readJson(scope,'.json',signal),scope);};
 const publish=async(scope,value,suffix,conflict,signal)=>{signal?.throwIfAborted();const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>4096)fail();await safeRoot();signal?.throwIfAborted();const temporary=join(root,'.pending-'+randomUUID());let handle;
  try{handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes,{signal});await handle.sync();await handle.close();handle=undefined;signal?.throwIfAborted();
   try{await link(temporary,pathFor(scope).replace(/\.json$/,suffix));}catch(error){if(error.code!=='EEXIST')throw error;if(!isDeepStrictEqual(await readJson(scope,suffix,signal),value))throw Error(conflict);}
   if(process.platform!=='win32'){const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}}
  }finally{await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}signal?.throwIfAborted();
 };
 const unreserved=async(scope,signal)=>{signal?.throwIfAborted();try{await lstat(pathFor(scope).replace(/\.json$/,'.entry.json'));}catch(error){if(error.code==='ENOENT'){signal?.throwIfAborted();return;}throw error;}throw Error('ordinary_input_entry_reserved');};
 const canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
 return Object.freeze({entryReservationProtocol:1,steeringAdmissionProtocol:1,read,
  async create(session,value,{signal}={}){const scope=identity(session,value?.run_id,value?.native_message_id),stamp=structuredClone(validate(value,scope));return publish(scope,stamp,'.json','ordinary_admission_conflict',signal);},
  async readReplayCandidate(request){const scope=identity(request.session,request.runId,request.messageId);await unreserved(scope,request.signal);const value=await read(request);await unreserved(scope,request.signal);return value;},
  async reserveEntry(session,value,attempt,{signal}={}){
   signal?.throwIfAborted();const scope=identity(session,value?.run_id,value?.native_message_id),stamp=structuredClone(validate(value,scope)),lease=attempt?.execution_lease;
   if(!attempt||Object.keys(attempt).sort().join(',')!=='execution_lease,observer_id'||!valid(attempt.observer_id)||!lease||Object.keys(lease).sort().join(',')!=='generation,owner'||!valid(lease.owner)||!Number.isSafeInteger(lease.generation)||lease.generation<1)fail();
   const entry={protocol:1,...scope,admission_sha256:createHash('sha256').update(canonical(stamp)).digest('hex'),execution_lease:{owner:lease.owner,generation:lease.generation},observer_id:attempt.observer_id};
   if(!isDeepStrictEqual(await read({session,runId:scope.run_id,messageId:scope.native_message_id,signal}),stamp))fail();return publish(scope,entry,'.entry.json','ordinary_input_entry_reserved',signal);
  }
 });
}
