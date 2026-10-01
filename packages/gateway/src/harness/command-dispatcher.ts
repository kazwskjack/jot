import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {EventStore} from '../events/event-store.ts';
import {RunRepository} from '../runs/repository.ts';

interface ControlClient {
 prompt(sessionId:string,requestId:string,text:string,mode:'steer',signal?:AbortSignal):Promise<Record<string,unknown>>;
 cancel(sessionId:string):Promise<Record<string,unknown>>;
}
/** Single dispatcher in the owning Worker process; official request IDs make retries idempotent. */
export class SessionCommandDispatcher {
 private db:DatabaseSync;private events:EventStore;private client:ControlClient;private ready:(runId:string)=>boolean;
 constructor(db:DatabaseSync,events:EventStore,client:ControlClient,ready:(runId:string)=>boolean){this.db=db;this.events=events;this.client=client;this.ready=ready;}
 async processNext():Promise<boolean>{
  const rows=this.db.prepare(`SELECT c.*,r.status run_status,r.conversation_id,r.input_message_id,
   r.created_at run_created_at,r.version,b.session_id,l.expires_at
   FROM ga_run_commands c JOIN ga_runs r ON r.id=c.run_id
   LEFT JOIN ga_harness_session_bindings b ON b.conversation_id=r.conversation_id
   LEFT JOIN ga_worker_leases l ON l.resource_id=r.id
   WHERE c.status='pending' AND c.kind IN ('cancel','steer') ORDER BY CASE c.kind WHEN 'cancel' THEN 0 ELSE 1 END,c.created_at`).all() as Array<Record<string,any>>;
  for(const row of rows){
   const terminal=['succeeded','failed','cancelled','interrupted','partial'].includes(row.run_status);
   if(terminal){
    if(row.kind==='steer'){
     const p=JSON.parse(row.payload_json);const owner=this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(row.conversation_id) as {owner_id:string};
     new RunRepository(this.db,this.events).enqueue(row.conversation_id,owner.owner_id,{client_message_id:p.client_message_id,content:[{type:'text',text:p.text}]});
     this.applied(row.id);
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
    await this.client.prompt(row.session_id,row.id,String(payload.text),'steer',AbortSignal.timeout(20_000));
    withImmediateTransaction(this.db,()=>{
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
 private applied(id:string){this.db.prepare("UPDATE ga_run_commands SET status='applied',applied_at=? WHERE id=?").run(new Date().toISOString(),id);}
}
