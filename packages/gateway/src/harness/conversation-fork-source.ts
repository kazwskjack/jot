import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {decodeStoredContent} from '../messages/content.ts';
import {messageAttachmentProjection} from '../messages/pinned-attachments.ts';
import type {ForkSource,ForkSourceScope,ForkAttachment} from './conversation-fork.ts';
type Row=Record<string,unknown>;
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
function fail():never{throw Error('fork_native_source_invalid');}

/** A Controller.inspect port is read-only: it never resolve/resume/create/
 * prompt/cancel an Agent. Source text remains the original owned product
 * transcript; native history contributes only its immutable incarnation/head.
 * Existing attachment witnesses are required; never look up current_version. */
export function createConversationForkSourceReader(db:DatabaseSync,{inspect}:{inspect:(session:string,signal?:AbortSignal)=>Promise<unknown>}){
 return async(scope:ForkSourceScope,signal?:AbortSignal):Promise<ForkSource>=>{
  signal?.throwIfAborted();const conversation=db.prepare('SELECT owner_id,version FROM ga_conversations WHERE id=? AND owner_id=?').get(scope.conversation_id,scope.owner_id);
  if(!conversation||Number(conversation.version)!==scope.conversation_version)fail();
  const raw=structuredClone(await inspect(scope.session_id,signal)) as {meta?:Row;inheritedEventCount?:unknown;events?:Row[]};signal?.throwIfAborted();
  const meta=raw?.meta,events=raw?.events;
  if(!meta||meta.id!==scope.session_id||meta.version!==4||!Number.isSafeInteger(meta.createdAt)||Number(meta.createdAt)<0||meta.origin==='subagent'||meta.parentSession!==undefined||meta.isSeeded!==false||raw.inheritedEventCount!==0||!Array.isArray(events)||!events.length||events.some((event,i)=>event?.seq!==i||typeof event.type!=='string'))fail();
  const has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const requests=new Set<string>(),turnRequests=new Map<number,Set<string>>();let openTurn:number|undefined;
  for(const event of events as Row[]){
   const data=event.data as Row|undefined;
   if(event.type==='turn/start')openTurn=Number(data?.turn);
   if(event.type==='user/message'){
    const source=data?.source as Row|undefined;
    if(source?.kind==='user'&&typeof source.rpcId==='string'){
     requests.add(source.rpcId);if(openTurn!==undefined){const ids=turnRequests.get(openTurn)??new Set<string>();ids.add(source.rpcId);turnRequests.set(openTurn,ids);}
    }
   }
   if(event.type==='turn/end')openTurn=undefined;
  }
  const messageAttachments:Record<string,ForkAttachment[]>={};
  for(const message of scope.messages){
   const stored=db.prepare('SELECT m.* FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.conversation_id=? AND c.owner_id=?').get(String(message.id),scope.conversation_id,scope.owner_id);
   // Select m.* above is intentional: compare exactly the original source row,
   // without importing joined owner/config fields into the transcript.
   if(!stored||canonical(stored)!==canonical(message))fail();
   const lineage=has('ga_conversation_fork_messages')?db.prepare(`SELECT m.attachment_refs_json,m.source_content_sha256 FROM ga_conversation_fork_messages m JOIN ga_conversation_forks f ON f.fork_id=m.fork_id WHERE m.target_message_id=? AND f.owner_id=? AND f.target_conversation_id=?`).get(String(message.id),scope.owner_id,scope.conversation_id):undefined;
   if(lineage){if(lineage.source_content_sha256!==createHash('sha256').update(String(message.content_json)).digest('hex'))fail();}
   else{
    if(typeof message.run_id!=='string')fail();const native=db.prepare('SELECT session_id,owner_id,conversation_id FROM ga_run_native_sessions WHERE run_id=?').get(String(message.run_id));
    if(!native||native.session_id!==scope.session_id||native.owner_id!==scope.owner_id||native.conversation_id!==scope.conversation_id)fail();
    const run=db.prepare('SELECT input_message_id FROM ga_runs WHERE id=?').get(String(message.run_id));if(!run)fail();
    if(message.role==='user'){
     let requestId=String(message.run_id);
     if(run.input_message_id!==message.id){const command=db.prepare("SELECT id FROM ga_run_commands WHERE id=? AND run_id=? AND kind='steer' AND status='applied'").get(String(message.id).replace(/^message-/,''),String(message.run_id));if(!command)fail();requestId=String(command.id);}
     if(!requests.has(requestId))fail();
    }else{
     const related=new Set([String(message.run_id),...db.prepare("SELECT id FROM ga_run_commands WHERE run_id=? AND kind='steer' AND status='applied'").all(String(message.run_id)).map(row=>String(row.id))]);
     if(!(events as Row[]).some(event=>event.type==='assistant/message'&&[...(turnRequests.get(Number((event.data as Row)?.turn))??[])].some(request=>related.has(request))))fail();
    }
   }
   const ids=decodeStoredContent(String(message.content_json)).attachments;let pins:ForkAttachment[]=[];
   if(ids.length){
    if(lineage)pins=JSON.parse(String(lineage.attachment_refs_json));
    if(!pins.length)pins=messageAttachmentProjection(db,message).attachment_refs??[];
    // Output messages have a producing-run/version witness. Original human
    // inputs cannot borrow output evidence or guess an old input version.
    if(!pins.length&&message.role==='assistant'&&typeof message.run_id==='string'){
     pins=ids.map(artifact=>{
      const rows=db.prepare(`SELECT v.version,v.sha256,v.size_bytes,v.mime_type,v.metadata_json FROM ga_run_artifacts r JOIN ga_artifacts a ON a.id=r.artifact_id JOIN ga_artifact_versions v ON v.artifact_id=r.artifact_id AND v.version=r.version WHERE r.run_id=? AND a.id=? AND a.owner_id=? AND a.conversation_id=?`).all(message.run_id as string,artifact,scope.owner_id,scope.conversation_id);
      if(rows.length!==1)throw Error('fork_attachment_provenance_required');const row=rows[0]!,metadata=JSON.parse(String(row.metadata_json));
      if(metadata?.status!=='ready'||typeof metadata.file_name!=='string')throw Error('fork_attachment_provenance_required');
      return{artifact_id:artifact,version:Number(row.version),sha256:String(row.sha256),size_bytes:Number(row.size_bytes),media_type:String(row.mime_type),file_name:metadata.file_name as string};
     });
    }
    if(!Array.isArray(pins)||JSON.stringify(pins.map(pin=>pin.artifact_id))!==JSON.stringify(ids))throw Error('fork_attachment_provenance_required');
   }
   messageAttachments[String(message.id)]=structuredClone(pins);
  }
  const roleRefs=has('wb_agents')?db.prepare('SELECT agent_id,version,capability_epoch FROM wb_agents WHERE owner_id=? AND conversation_id=? ORDER BY agent_id').all(scope.owner_id,scope.conversation_id).map(row=>({agent_id:String(row.agent_id),version:Number(row.version),capability_epoch:Number(row.capability_epoch)})):[];
  const verifiedMeta=meta as Row,verifiedEvents=events as Row[];
  signal?.throwIfAborted();return{session_id:scope.session_id,session_created_at:Number(verifiedMeta.createdAt),head_seq:Number(verifiedEvents.at(-1)!.seq),head_sha256:createHash('sha256').update(canonical(raw)).digest('hex'),message_attachments:messageAttachments,role_refs:roleRefs};
 };
}
