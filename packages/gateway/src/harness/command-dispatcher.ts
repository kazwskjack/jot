import {isDeepStrictEqual} from 'node:util';
import {inspectOrdinarySteeringBinding} from '../conversations/ordinary-steering-binding.ts';
import {hasOrdinarySteeringCustody,reserveOrdinarySteeringCustody} from './ordinary-steering-custody.ts';
import type {OrdinarySteeringExecution} from './session-controller-client.ts';
import type {ExecutionLease} from '../workbench/execution-lease.ts';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {EventStore} from '../events/event-store.ts';
import {RunRepository} from '../runs/repository.ts';

interface OrdinarySteering {currentExecutionFor(runId:string):Readonly<{sessionRef:string;ordinary:boolean;executionLease:ExecutionLease}>|undefined;reconcileHistorical?(runId:string,sessionId:string,commandId:string):Promise<boolean>;}
interface ControlClient {
 steerOriginal?(sessionId:string,commandId:string,text:string,proof:OrdinarySteeringExecution,signal?:AbortSignal):Promise<Record<string,unknown>>;
 prompt(sessionId:string,requestId:string,text:string,mode:'steer',signal?:AbortSignal):Promise<Record<string,unknown>>;
 cancel(sessionId:string):Promise<Record<string,unknown>>;
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
 constructor(db:DatabaseSync,events:EventStore,client:ControlClient,ready:(runId:string)=>boolean,executionGuard?:ExecutionGuard,ordinarySteering?:OrdinarySteering){if(ordinarySteering&&(typeof ordinarySteering.currentExecutionFor!=='function'||ordinarySteering.reconcileHistorical!==undefined&&typeof ordinarySteering.reconcileHistorical!=='function'))throw Error('ordinary_steering_dispatch_config_invalid');this.ordinarySteering=ordinarySteering;this.db=db;this.events=events;this.client=client;this.ready=ready;this.executionGuard=executionGuard;}
 async processNext():Promise<boolean>{
  const rows=this.db.prepare(`SELECT c.*,r.status run_status,r.conversation_id,r.input_message_id,
   r.created_at run_created_at,r.version,b.session_id,l.expires_at
   FROM ga_run_commands c JOIN ga_runs r ON r.id=c.run_id
   LEFT JOIN ga_run_native_sessions b ON b.run_id=r.id AND b.conversation_id=r.conversation_id
   LEFT JOIN ga_worker_leases l ON l.resource_id=r.id
   WHERE c.status='pending' AND c.kind IN ('cancel','steer') ORDER BY CASE c.kind WHEN 'cancel' THEN 0 ELSE 1 END,c.created_at`).all() as Array<Record<string,any>>;
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
   if(row.kind==='cancel'){
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
    const ready=this.ordinarySteering?.currentExecutionFor(row.run_id);if(this.ordinarySteering&&!ready)throw Error('ordinary_steering_execution_unavailable');
    const ordinary=ready?.ordinary===true;
    if(hasOrdinarySteeringCustody(this.db,row.id)&&!ordinary)continue;
    let proof:ReturnType<typeof inspectOrdinarySteeringBinding>|undefined;
    if(ordinary){if(!this.client.steerOriginal||ready.sessionRef!==row.session_id)throw Error('ordinary_steering_execution_unavailable');proof=reserveOrdinarySteeringCustody(this.db,row.run_id,row.session_id,row.id,ready.executionLease);const receipt=await this.client.steerOriginal(row.session_id,row.id,String(payload.text),{run_id:row.run_id,command_id:row.id,execution_lease:ready.executionLease},AbortSignal.timeout(20_000));if(receipt.accepted!==true)throw Error('ordinary_steering_admission_unconfirmed');}
    else await this.client.prompt(row.session_id,row.id,String(payload.text),'steer',AbortSignal.timeout(20_000));
    withImmediateTransaction(this.db,()=>{
     if(ordinary){if(!isDeepStrictEqual(this.ordinarySteering!.currentExecutionFor(row.run_id),ready)||!isDeepStrictEqual(inspectOrdinarySteeringBinding(this.db,row.run_id,row.session_id,row.id,ready!.executionLease),proof))throw Error('ordinary_steering_admission_unconfirmed');}

     const now=new Date().toISOString();const messageId=`message-${row.id}`;
     const blocks=[{block_id:`${messageId}:text`,kind:'text',text:String(payload.text)}];
     const inserted=this.db.prepare("INSERT OR IGNORE INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,'user','complete',?,?,?,?)")
      .run(messageId,row.conversation_id,row.run_id,JSON.stringify({blocks,attachments:[]}),String(payload.client_message_id),now,now).changes;
     if(inserted)this.events.append(row.conversation_id,row.run_id,'message.created',{message_id:messageId,run_id:row.run_id,role:'user',status:'complete',blocks,created_at:now});
     this.applied(row.id);
    });
   }
   return true;
  }
  return false;
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
