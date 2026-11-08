import {isDeepStrictEqual} from 'node:util';
import {inspectOrdinarySteeringBinding} from '../conversations/ordinary-steering-binding.ts';
import {hasOrdinarySteeringCustody,reserveOrdinarySteeringCustody} from './ordinary-steering-custody.ts';
import type {OrdinarySteeringExecution,OrdinarySteeringAdmission,NativeMemberWakeReceipt,SessionPromptPart} from './session-controller-client.ts';
import type {PinnedByteSource} from '../artifacts/pinned-byte-source.ts';
import type {AttachmentResolver} from '../artifacts/resolver.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {ExecutionLease} from '../workbench/execution-lease.ts';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {EventStore} from '../events/event-store.ts';
import {RunRepository} from '../runs/repository.ts';
import type {LeaseTakeoverObservation,LeaseTakeoverScope} from './session-controller-client.ts';

type ReadyExecution=Readonly<{sessionRef:string;ordinary:boolean;executionLease:ExecutionLease}>;
function takeoverScope(value:unknown,sessionId:string):LeaseTakeoverScope{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('lease_takeover_scope_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='kind,lease_generation,lease_owner,owner_id,protocol,run_id,session_id,workspace_id'||row.protocol!==1||row.kind!=='lease_takeover'
  ||['run_id','owner_id','workspace_id','session_id','lease_owner'].some(key=>typeof row[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row[key] as string))
  ||!Number.isSafeInteger(row.lease_generation)||Number(row.lease_generation)<1||row.session_id!==sessionId)throw Error('lease_takeover_scope_invalid');
 return Object.freeze({...row}) as LeaseTakeoverScope;
}
const TAKEOVER_TOOLS=new Set(['universe_capabilities','universe_search','browser_action']);
interface OrdinarySteering {currentExecutionFor(runId:string):ReadyExecution|undefined;reconcileHistorical?(runId:string,sessionId:string,commandId:string):Promise<boolean>;attachments?:Readonly<{protocol:1;resolver:Pick<AttachmentResolver,'snapshotPinnedForMessage'>;snapshotRoot:string}>;}
interface ControlClient {
 steerOriginal?(sessionId:string,commandId:string,text:string,proof:OrdinarySteeringExecution,signal?:AbortSignal):Promise<Record<string,unknown>>;
 steerOriginalContent?(sessionId:string,commandId:string,content:SessionPromptPart[],proof:OrdinarySteeringExecution,signal?:AbortSignal):Promise<Record<string,unknown>>;
 observeOriginalSteeringAdmission?(sessionId:string,proof:OrdinarySteeringExecution,sourceHash:string,signal?:AbortSignal):Promise<OrdinarySteeringAdmission>;
 stageVerifiedFile?(sessionId:string,source:PinnedByteSource,name:string,signal?:AbortSignal):Promise<{receipt_id:string}>;
 prompt(sessionId:string,requestId:string,text:string,mode:'steer',signal?:AbortSignal):Promise<Record<string,unknown>>;
 cancel(sessionId:string):Promise<Record<string,unknown>>;
 wakeNativeMember?(sessionId:string,childSessionId:string,requestId:string,text:string,signal?:AbortSignal):Promise<NativeMemberWakeReceipt>;
 leaseTakeover?(sessionId:string,scope:LeaseTakeoverScope):Promise<LeaseTakeoverObservation>;
}
interface ExecutionGuard {
 assertRunActive(runId:string):void;
 contextForRun(runId:string):unknown;
 inheritChatRun(owner:string,originalRunId:string,newRunId:string):void;
}
/** Single dispatcher in the owning Worker process; official request IDs make retries idempotent. */
export class SessionCommandDispatcher {
 private db:DatabaseSync;private events:EventStore;private client:ControlClient;private ready:(runId:string)=>boolean;
 private executionGuard:ExecutionGuard|undefined;private ordinarySteering:OrdinarySteering|undefined;
  private readonly takeoverRetries=new Map<string,{attempt:number;retryAt:number}>();
 constructor(db:DatabaseSync,events:EventStore,client:ControlClient,ready:(runId:string)=>boolean,executionGuard?:ExecutionGuard,ordinarySteering?:OrdinarySteering){if(ordinarySteering&&(typeof ordinarySteering.currentExecutionFor!=='function'||ordinarySteering.reconcileHistorical!==undefined&&typeof ordinarySteering.reconcileHistorical!=='function'))throw Error('ordinary_steering_dispatch_config_invalid');const attachments=ordinarySteering?.attachments;if(attachments!==undefined&&(!attachments||attachments.protocol!==1||typeof attachments.snapshotRoot!=='string'||!isAbsolute(attachments.snapshotRoot)||typeof attachments.resolver?.snapshotPinnedForMessage!=='function'||typeof client.observeOriginalSteeringAdmission!=='function'||typeof client.stageVerifiedFile!=='function'||typeof client.steerOriginalContent!=='function'))throw Error('ordinary_attachment_dispatch_config_invalid');this.ordinarySteering=ordinarySteering;this.db=db;this.events=events;this.client=client;this.ready=ready;this.executionGuard=executionGuard;}
 async processNext():Promise<boolean>{
  const hasWorkbenchBindings=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_run_bindings'").get());
  const bindingJoin=hasWorkbenchBindings?'LEFT JOIN wb_run_bindings wb ON wb.run_id=r.id':'';
  const bindingSelect=hasWorkbenchBindings?'wb.owner_id binding_owner,wb.context_json':'NULL binding_owner,NULL context_json';
  const rows=this.db.prepare(`SELECT c.*,r.status run_status,r.conversation_id,r.input_message_id,
   r.created_at run_created_at,r.version,b.session_id,l.expires_at,l.owner lease_owner,l.generation lease_generation,
    runtime.harness_session_ref,runtime.runtime_owner,CAST(runtime.fence_epoch AS TEXT) fence_epoch,conversation.owner_id conversation_owner,conversation.workspace_id conversation_workspace,${bindingSelect}
   FROM ga_run_commands c JOIN ga_runs r ON r.id=c.run_id
   JOIN ga_conversations conversation ON conversation.id=r.conversation_id
   LEFT JOIN ga_run_native_sessions b ON b.run_id=r.id AND b.conversation_id=r.conversation_id
   LEFT JOIN ga_worker_leases l ON l.resource_id=r.id
   LEFT JOIN ga_runtime_bindings runtime ON runtime.run_id=r.id
   ${bindingJoin}
   WHERE c.status='pending' AND c.kind IN ('cancel','lease_takeover','native_member_control','steer') ORDER BY CASE c.kind WHEN 'cancel' THEN 0 WHEN 'lease_takeover' THEN 1 WHEN 'native_member_control' THEN 2 ELSE 3 END,c.created_at`).all() as Array<Record<string,any>>;
   if(this.takeoverRetries.size){const pending=new Set(rows.filter(row=>row.kind==='lease_takeover').map(row=>String(row.id)));for(const id of this.takeoverRetries.keys())if(!pending.has(id))this.takeoverRetries.delete(id);}
  for(const row of rows){
   const terminal=['succeeded','failed','cancelled','interrupted','partial'].includes(row.run_status);
   if(terminal){
    if(row.kind==='steer'){
     if(hasOrdinarySteeringCustody(this.db,row.id)||this.ordinarySteering&&this.isOrdinaryParent(row.run_id)){
      if(row.run_status!=='cancelled'&&typeof row.session_id==='string'&&await this.ordinarySteering?.reconcileHistorical?.(row.run_id,row.session_id,row.id))return true;
      continue; // Never convert absent/unknown acceptance into a fallback run.
     }
     const p=JSON.parse(row.payload_json);const owner=this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(row.conversation_id) as {owner_id:string};
     try {
      withImmediateTransaction(this.db,()=>{
       this.executionGuard?.contextForRun(row.run_id);
       const next=new RunRepository(this.db,this.events).enqueue(row.conversation_id,owner.owner_id,{client_message_id:p.client_message_id,content:[{type:'text',text:p.text}]});
       this.executionGuard?.inheritChatRun(owner.owner_id,row.run_id,String(next.run_id));
       this.applied(row.id);
      });
     } catch(error) {
      const code=error instanceof Error?error.message:'';
      if(code.endsWith('_revoked')||code==='task_continuation_unsupported') this.superseded(row.id);
      else throw error;
     }
    }else this.db.prepare("UPDATE ga_run_commands SET status='superseded',applied_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(),row.id);
    continue;
   }
   if(!this.ready(row.run_id)&&Number(row.expires_at??0)>Date.now())continue;
   if(row.kind==='steer'&&!this.ready(row.run_id))continue;
   if(row.kind==='steer'&&row.run_status==='cancelling')continue;
   const payload=JSON.parse(row.payload_json);
   if(row.kind==='native_member_control'){
    if(!row.session_id||!this.ready(row.run_id)||!['starting','running'].includes(row.run_status))continue;
    try{this.executionGuard?.assertRunActive(row.run_id);}catch{this.superseded(row.id);continue;}
    if(!this.client.wakeNativeMember||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join(',')!=='child_run_id,child_session_ref,operation,request_id,role_ref,text'
      ||payload.operation!=='wake'||![payload.request_id,payload.child_session_ref,payload.child_run_id,payload.role_ref].every(value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value))
      ||typeof payload.text!=='string'||!payload.text.trim()||Buffer.byteLength(payload.text,'utf8')>32768)throw Error('native_member_control_invalid');
    const receipt=await this.client.wakeNativeMember(row.session_id,payload.child_session_ref,payload.request_id,payload.text,AbortSignal.timeout(30_000));
    if(!receipt||Object.keys(receipt).sort().join(',')!=='execution_authorized,request_id,status'||receipt.execution_authorized!==false
      ||receipt.request_id!==payload.request_id||!['accepted','unknown'].includes(receipt.status))throw Error('native_member_control_receipt_invalid');
    this.applied(row.id);return true;
   }
   if(row.kind==='lease_takeover'){
     if((this.takeoverRetries.get(String(row.id))?.retryAt??0)>Date.now())continue;
     if(await this.processLeaseTakeover(row,payload)){this.takeoverRetries.delete(String(row.id));return true;}
    continue;
   }else if(row.kind==='cancel'){
    // A run without a Session binding has never entered this Session adapter.
    const receipt=row.session_id?await this.client.cancel(row.session_id):{settled:true};
    if(receipt.settled!==true)throw new Error('session_cancel_unconfirmed');
    withImmediateTransaction(this.db,()=>{
     const run=this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(row.run_id) as Record<string,any>;
     if(run.status==='cancelling'){
      const now=new Date().toISOString();
      this.db.prepare("UPDATE ga_runs SET status='cancelled',version=version+1,updated_at=?,reason_code='USER_CANCELLED' WHERE id=?").run(now,row.run_id);
      this.events.append(row.conversation_id,row.run_id,'run.state',{run_id:row.run_id,conversation_id:row.conversation_id,input_message_id:run.input_message_id,status:'cancelled',version:run.version+1,created_at:run.created_at,updated_at:now});
     }
     this.applied(row.id);
    });
   }else{
    if(!row.session_id)continue;
    try { this.executionGuard?.assertRunActive(row.run_id); }
    catch { this.superseded(row.id); continue; }
    const currentReady=this.ordinarySteering?.currentExecutionFor(row.run_id),ready=currentReady?structuredClone(currentReady):undefined;if(this.ordinarySteering&&!ready)throw Error('ordinary_steering_execution_unavailable');
    const ordinary=ready?.ordinary===true;
    if(hasOrdinarySteeringCustody(this.db,row.id)&&!ordinary)continue;
    let proof:ReturnType<typeof inspectOrdinarySteeringBinding>|undefined;
    if(ordinary){if(!this.client.steerOriginal||ready.sessionRef!==row.session_id)throw Error('ordinary_steering_execution_unavailable');proof=reserveOrdinarySteeringCustody(this.db,row.run_id,row.session_id,row.id,ready.executionLease);if(proof.protocol===2)await this.sendAttachments(proof,ready,String(payload.text));else{const receipt=await this.client.steerOriginal(row.session_id,row.id,String(payload.text),{run_id:row.run_id,command_id:row.id,execution_lease:ready.executionLease},AbortSignal.timeout(20_000));if(receipt.accepted!==true)throw Error('ordinary_steering_admission_unconfirmed');}}
    else await this.client.prompt(row.session_id,row.id,String(payload.text),'steer',AbortSignal.timeout(20_000));
    withImmediateTransaction(this.db,()=>{
     if(ordinary){if(!isDeepStrictEqual(this.ordinarySteering!.currentExecutionFor(row.run_id),ready)||!isDeepStrictEqual(inspectOrdinarySteeringBinding(this.db,row.run_id,row.session_id,row.id,ready!.executionLease),proof))throw Error('ordinary_steering_admission_unconfirmed');}

     const now=new Date().toISOString();const messageId=`message-${row.id}`;
     const blocks=proof?.protocol===2&&!String(payload.text).trim()?[]:[{block_id:`${messageId}:text`,kind:'text',text:String(payload.text)}],attachments=proof?.protocol===2?proof.attachment_manifest.attachments.map(pin=>pin.artifact_id):[];
     const inserted=this.db.prepare("INSERT OR IGNORE INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,'user','complete',?,?,?,?)")
      .run(messageId,row.conversation_id,row.run_id,JSON.stringify({blocks,attachments}),String(payload.client_message_id),now,now).changes;
     if(inserted)this.events.append(row.conversation_id,row.run_id,'message.created',{message_id:messageId,run_id:row.run_id,role:'user',status:'complete',blocks,...(attachments.length?{attachments}:{}),...(proof?.protocol===2?{attachment_refs:pinnedAttachmentRefs(proof.attachment_manifest)}:{}),created_at:now});
     this.applied(row.id);
    });
   }
   return true;
  }
  return false;
 }
 private async processLeaseTakeover(row:Record<string,any>,value:unknown):Promise<boolean>{
  if(!this.client.leaseTakeover||!row.session_id||row.run_status==='cancelling'
    ||this.db.prepare("SELECT 1 FROM ga_run_commands WHERE run_id=? AND kind='cancel' AND status='pending'").get(row.run_id))return false;
  let scope:LeaseTakeoverScope;try{scope=takeoverScope(value,row.session_id);}catch{return false;}
  if(scope.run_id!==row.run_id||scope.owner_id!==row.binding_owner||scope.workspace_id!==row.conversation_workspace
    ||scope.lease_owner!==row.lease_owner||scope.lease_generation!==Number(row.lease_generation)
    ||row.harness_session_ref!==scope.session_id||row.runtime_owner!==scope.lease_owner||Number(row.fence_epoch)!==scope.lease_generation
    ||!Number.isSafeInteger(Number(row.expires_at))||Number(row.expires_at)>Date.now()||!this.takeoverContextMatches(row,scope))return false;
  let receipt:LeaseTakeoverObservation;
   try{receipt=await this.client.leaseTakeover(scope.session_id,scope);}catch{this.deferTakeover(row.id);return false;}
  if(!receipt||receipt.protocol!==1||receipt.kind!=='lease_takeover'||receipt.execution_authorized!==false
     ||!['quiescent','outcome_unknown','unknown'].includes(receipt.status)||typeof receipt.settled!=='boolean'
     ||!isDeepStrictEqual(receipt.scope,scope)||receipt.status==='unknown'&&receipt.settled||receipt.status!=='unknown'&&!receipt.settled){this.deferTakeover(row.id);return false;}
   if(receipt.status==='unknown'){this.deferTakeover(row.id);return false;}
  return withImmediateTransaction(this.db,()=>{
   const current=this.readTakeoverIdentity(scope.run_id);
   const command=this.db.prepare("SELECT payload_json,status FROM ga_run_commands WHERE id=? AND run_id=? AND kind='lease_takeover'").get(row.id,scope.run_id) as {payload_json:string;status:string}|undefined;
   if(!command||command.status!=='pending'||!isDeepStrictEqual(JSON.parse(command.payload_json),scope)
    ||!current||!this.takeoverContextMatches(current,scope)||current.lease_owner!==scope.lease_owner
    ||Number(current.lease_generation)!==scope.lease_generation||!Number.isSafeInteger(Number(current.expires_at))||Number(current.expires_at)>Date.now()
    ||current.harness_session_ref!==scope.session_id||current.runtime_owner!==scope.lease_owner||Number(current.fence_epoch)!==scope.lease_generation)return false;
   if(current.run_status==='cancelling'||this.db.prepare("SELECT 1 FROM ga_run_commands WHERE run_id=? AND kind='cancel' AND status='pending'").get(scope.run_id)){
    this.superseded(row.id);return false;
   }
   if(!['starting','running'].includes(current.run_status))return false;
   const now=new Date().toISOString(),next=receipt.status==='quiescent'?'queued':'interrupted',reason=receipt.status==='outcome_unknown'?'OUTCOME_UNKNOWN':null;
   const changed=this.db.prepare('UPDATE ga_runs SET status=?,reason_code=?,version=version+1,updated_at=? WHERE id=? AND status IN (\'starting\',\'running\')').run(next,reason,now,scope.run_id).changes;
   if(!changed)return false;
   const run=this.db.prepare('SELECT version,created_at FROM ga_runs WHERE id=?').get(scope.run_id) as {version:number;created_at:string};
   this.events.append(String(current.conversation_id),scope.run_id,'run.state',{run_id:scope.run_id,conversation_id:String(current.conversation_id),input_message_id:current.input_message_id??null,status:next,version:run.version,created_at:run.created_at,updated_at:now,...(reason?{reason_code:reason}:{})});
   if(receipt.status==='outcome_unknown')this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(scope.run_id,scope.lease_owner,scope.lease_generation);
   this.applied(row.id);return true;
  });
 }
  private deferTakeover(commandId:string):void{
   const attempt=(this.takeoverRetries.get(commandId)?.attempt??0)+1;
   // shortcut: retry cooldown is process-local; persist it only if Gateway restarts make unknown receipts noisy.
   const delay=Math.min(60_000,1_000*2**Math.min(attempt-1,6));
   this.takeoverRetries.set(commandId,{attempt,retryAt:Date.now()+delay});
  }
 private readTakeoverIdentity(runId:string):Record<string,any>|undefined{
  const bindings=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_run_bindings'").get());
  if(!bindings)return undefined;
  return this.db.prepare(`SELECT r.id run_id,r.status run_status,r.conversation_id,r.input_message_id,conversation.owner_id conversation_owner,conversation.workspace_id conversation_workspace,
     n.session_id,l.owner lease_owner,l.generation lease_generation,l.expires_at,runtime.harness_session_ref,runtime.runtime_owner,CAST(runtime.fence_epoch AS TEXT) fence_epoch,
    wb.owner_id binding_owner,wb.context_json
    FROM ga_runs r JOIN ga_conversations conversation ON conversation.id=r.conversation_id
    JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=r.conversation_id AND n.owner_id=conversation.owner_id
    JOIN ga_worker_leases l ON l.resource_id=r.id LEFT JOIN ga_runtime_bindings runtime ON runtime.run_id=r.id
    JOIN wb_run_bindings wb ON wb.run_id=r.id WHERE r.id=?`).get(runId) as Record<string,any>|undefined;
 }
 private takeoverContextMatches(row:Record<string,any>,scope:LeaseTakeoverScope):boolean{
  try{const context=JSON.parse(row.context_json);return !!context&&typeof context==='object'&&!Array.isArray(context)
   &&context.run_id===scope.run_id&&context.owner_id===scope.owner_id&&context.workspace_id===scope.workspace_id
   &&Array.isArray(context.allowed_tools)&&context.allowed_tools.includes('browser_action')&&context.allowed_tools.every((name:unknown)=>typeof name==='string'&&TAKEOVER_TOOLS.has(name))
   &&new Set(context.allowed_tools).size===context.allowed_tools.length&&row.binding_owner===scope.owner_id
   &&row.conversation_workspace===scope.workspace_id&&row.session_id===scope.session_id;}catch{return false;}
 }
 private async sendAttachments(proof:Extract<ReturnType<typeof inspectOrdinarySteeringBinding>,{protocol:2}>,ready:ReadyExecution,text:string){
  const options=this.ordinarySteering?.attachments;if(!options||!this.client.observeOriginalSteeringAdmission||!this.client.steerOriginalContent||!this.client.stageVerifiedFile)throw Error('ordinary_attachment_steering_unavailable');
  const signal=AbortSignal.timeout(120_000),scope={run_id:proof.run_id,command_id:proof.command_id,execution_lease:ready.executionLease},sourceHash=createHash('sha256').update(canonicalJson(proof)).digest('hex');
  const check=()=>{signal.throwIfAborted();this.executionGuard?.assertRunActive(proof.run_id);if(!this.ready(proof.run_id)||!isDeepStrictEqual(this.ordinarySteering!.currentExecutionFor(proof.run_id),ready)||!isDeepStrictEqual(inspectOrdinarySteeringBinding(this.db,proof.run_id,proof.session_id,proof.command_id,ready.executionLease),proof))throw Error('ordinary_steering_admission_unconfirmed');};check();
  const observed=await this.client.observeOriginalSteeringAdmission(proof.session_id,scope,sourceHash,signal);check();
  if(!observed||Object.keys(observed).sort().join(',')!=='command_id,execution_authorized,kind,protocol,run_id,session_id,source_sha256,state'||observed.protocol!==1||observed.kind!=='ordinary_steering_admission'||observed.execution_authorized!==false||observed.run_id!==proof.run_id||observed.command_id!==proof.command_id||observed.session_id!==proof.session_id||observed.source_sha256!==sourceHash||!['accepted','unproven'].includes(observed.state))throw Error('ordinary_steering_admission_unconfirmed');
  if(observed.state==='accepted')return;
  const snapshot=await options.resolver.snapshotPinnedForMessage(proof.owner_id,proof.conversation_id,proof.attachment_manifest,proof.command_id,options.snapshotRoot,signal);
  try{check();const content:SessionPromptPart[]=text.trim()?[{type:'text',text:text.trim()}]:[];
   for(const [index,pin] of proof.attachment_manifest.attachments.entries()){check();const source=snapshot.sources[index];if(!source||source.sha256!==pin.sha256||source.sizeBytes!==pin.size_bytes)throw Error('ordinary_attachment_source_unconfirmed');
    if(pin.kind==='image'){if(pin.size_bytes>20*1024*1024)throw Error('ordinary_attachment_image_too_large');const chunks:Buffer[]=[];for await(const chunk of source.stream(signal)){check();chunks.push(chunk);}content.push({type:'image',media_type:pin.media_type,name:pin.file_name,data:Buffer.concat(chunks).toString('base64')});}
    else{const file=await this.client.stageVerifiedFile(proof.session_id,source,pin.file_name,signal);check();if(typeof file?.receipt_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(file.receipt_id))throw Error('ordinary_attachment_file_unconfirmed');content.push({type:'file',receipt_id:file.receipt_id});}
   }
   check();const receipt=await this.client.steerOriginalContent(proof.session_id,proof.command_id,content,scope,signal);if(receipt.accepted!==true)throw Error('ordinary_steering_admission_unconfirmed');check();
  }finally{await snapshot.dispose();}
 }
 /** Classification for conservative terminal handling only, never authority. */
 private isOrdinaryParent(runId:string){
  const row=this.db.prepare(`SELECT r.conversation_id,c.owner_id,m.role,m.run_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id JOIN ga_messages m ON m.id=r.input_message_id WHERE r.id=?`).get(runId);if(!row||row.role!=='user'||row.run_id!==runId)return false;
  const table=(name:string)=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !(table('wb_agents')&&this.db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=? AND owner_id=?').get(row.conversation_id!,row.owner_id!))&&!(table('wb_run_bindings')&&this.db.prepare('SELECT 1 FROM wb_run_bindings WHERE run_id=?').get(runId))&&!this.db.prepare('SELECT 1 FROM ga_conversation_goal_controls WHERE run_id=?').get(runId);
 }
 private applied(id:string){this.db.prepare("UPDATE ga_run_commands SET status='applied',applied_at=? WHERE id=?").run(new Date().toISOString(),id);}
 private superseded(id:string){this.db.prepare("UPDATE ga_run_commands SET status='superseded',applied_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(),id);}
}
import {pinnedAttachmentRefs} from '../messages/pinned-attachments.ts';
