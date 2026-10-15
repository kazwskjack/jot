import {mkdir,open,lstat,link,unlink} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function key(session){if(typeof session?.id!=='string'||!ID.test(session.id)||!Number.isSafeInteger(session.header?.createdAt)||session.header.createdAt<0)throw Error('native_replay_provenance_scope_invalid');return {session_id:session.id,created_at:session.header.createdAt};}
/** Private host metadata, never a conversation event, prompt or workspace file.
 * The configured root must be operator-owned and inaccessible to Agent tools.
 * Entries are write-once; only complete synced temporary files are published. */
export function createNativeReplayProvenance({root}={}){
 if(typeof root!=='string'||!isAbsolute(root))throw Error('native_replay_provenance_config_invalid');
 const pathFor=session=>join(root,createHash('sha256').update(JSON.stringify(key(session))).digest('hex')+'.json');
 async function safeRoot(){await mkdir(root,{recursive:true,mode:0o700});const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('native_replay_provenance_root_invalid');}
 return Object.freeze({
  async create(session,stamp,{signal}={}){
   signal?.throwIfAborted();await safeRoot();const value={...key(session),stamp},bytes=JSON.stringify(value);if(!stamp||typeof stamp!=='object'||Array.isArray(stamp)||Buffer.byteLength(bytes)>4096)throw Error('native_replay_provenance_invalid');signal?.throwIfAborted();
   const temporary=join(root,'.pending-'+randomUUID());let handle;
   try{
    handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes,{signal});await handle.sync();await handle.close();handle=undefined;signal?.throwIfAborted();
    try{await link(temporary,pathFor(session));}
    catch(error){if(error?.code!=='EEXIST')throw error;const current=await this.read(session,{signal});if(JSON.stringify(current)!==JSON.stringify(stamp))throw Error('native_replay_provenance_conflict');}
    if(process.platform!=='win32'){const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}}
   }finally{await handle?.close();await unlink(temporary).catch(error=>{if(error?.code!=='ENOENT')throw error;});}signal?.throwIfAborted();
  },
  async read(session,{signal}={}){
   signal?.throwIfAborted();await safeRoot();const path=pathFor(session),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('native_replay_provenance_invalid');
   // Compare the opened inode to the checked path; read through that handle.
   let handle,value;try{handle=await open(path,'r');const opened=await handle.stat();if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size>4096)throw Error('native_replay_provenance_invalid');value=JSON.parse(await handle.readFile({encoding:'utf8',signal}));}finally{await handle?.close();}const identity=key(session);
   if(!value||Object.keys(value).sort().join(',')!=='created_at,session_id,stamp'||value.session_id!==identity.session_id||value.created_at!==identity.created_at)throw Error('native_replay_provenance_scope_changed');
   return value.stamp;
  },
 });
}
