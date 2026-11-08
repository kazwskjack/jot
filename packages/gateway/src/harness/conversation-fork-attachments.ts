import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,open,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {AttachmentResolver} from '../artifacts/resolver.ts';
import {attachmentKindForMime,inspectPinnedAttachmentManifest} from '../artifacts/pinned-manifest.ts';
import type {ForkAttachment,ForkSourceScope} from './conversation-fork.ts';
import {validateForkAttachmentSet} from './fork-attachment-limits.ts';
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

/** Bytes are durable before the single fork transaction publishes any target
 * reference. Uncommitted copies are inert; retries reuse deterministic identity. */
export async function prepareForkAttachmentClones(db:DatabaseSync,rootInput:string,scope:ForkSourceScope,pins:readonly ForkAttachment[],key:string,signal?:AbortSignal){
 const root=resolve(rootInput),resolver=new AttachmentResolver(db,root),lease='fork-clone-'+randomUUID();
 const unique=validateForkAttachmentSet(pins),entries:Array<{source:ForkAttachment;target:ForkAttachment;path:string}>=[];
 for(const pin of unique){
  const manifest={protocol:1,attachments:[{...pin,kind:attachmentKindForMime(pin.media_type)}]};
  let snapshot;
  try{
   snapshot=await resolver.snapshotInputForMessage(scope.owner_id,scope.conversation_id,manifest,lease,signal);
   const id='artifact-fork-'+createHash('sha256').update(canonical([scope.owner_id,scope.conversation_id,key,pin])).digest('hex').slice(0,40);
   const directory=join(root,'forks',id);for(const path of [root,join(root,'forks'),directory]){await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('fork_attachment_path_invalid');}
   const destination=join(directory,'version-1'),temporary=join(directory,'pending-'+randomUUID());let file;
   try{
    file=await open(temporary,'wx',0o600);for await(const bytes of snapshot.sources[0]!.stream(signal)){let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset);if(!result.bytesWritten)throw Error('fork_attachment_write_failed');offset+=result.bytesWritten;}}
    await file.sync();await file.close();file=undefined;signal?.throwIfAborted();
    const existing=await lstat(destination).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw Error('fork_attachment_path_invalid');
    await rename(temporary,destination);
   }finally{await file?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
   entries.push({source:pin,target:{...pin,artifact_id:id,version:1},path:destination});
  }finally{await snapshot?.dispose();resolver.releaseLease(lease);}
 }
 return{
  remap(pin:ForkAttachment){const entry=entries.find(e=>canonical(e.source)===canonical(pin));if(!entry)throw Error('fork_attachment_clone_missing');return entry.target;},
  commit(target:string){
   const conversation=db.prepare('SELECT workspace_id FROM ga_conversations WHERE id=? AND owner_id=?').get(target,scope.owner_id);if(!conversation)throw Error('fork_target_unavailable');
   const now=new Date().toISOString();for(const entry of entries){
    inspectPinnedAttachmentManifest(db,scope.owner_id,scope.conversation_id,{protocol:1,attachments:[{...entry.source,kind:attachmentKindForMime(entry.source.media_type)}]});
    const sourceVersion=db.prepare('SELECT metadata_json FROM ga_artifact_versions WHERE artifact_id=? AND version=?')
     .get(entry.source.artifact_id,entry.source.version) as {metadata_json:string}|undefined;
    if(!sourceVersion)throw Error('attachment_manifest_changed');
    const metadata=JSON.parse(sourceVersion.metadata_json) as Record<string,unknown>;
    db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(entry.target.artifact_id,target,scope.owner_id,'file',now,now);
    db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,1,?,?,?,?,?,?)').run(entry.target.artifact_id,entry.path,entry.target.sha256,entry.target.size_bytes,entry.target.media_type,JSON.stringify({status:'ready',file_name:entry.target.file_name,...(typeof metadata.relative_path==='string'?{relative_path:metadata.relative_path}:{}),origin:'conversation_fork',source_conversation_id:scope.conversation_id,source_attachment:entry.source,workspace_id:conversation.workspace_id}),now);
    db.prepare("INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,'pending','present',?,?,?)").run(entry.target.artifact_id,now,now,now);
   }
  }
 };
}
