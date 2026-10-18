import {randomUUID} from 'node:crypto';import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {OrdinaryFinalPublisher} from './ordinary-final-publication.ts';
import {HistoricalFinalDeliveryIntents} from '../channels/historical-final-intents.ts';
type Row=Record<string,any>;
type Claim={run_id:string;owner_id:string;conversation_id:string;session_id:string;phase:'publication'|'delivery';token:string};
type Options={enabled:boolean;workerId:string;now?:()=>number;retryMs?:number;leaseMs?:number};
export function ordinaryFinalRecoveryEnabled(env:Record<string,string|undefined>):boolean{
 if(env.GENERAL_AGENT_ORDINARY_FINAL_RECONCILIATION_ENABLED!=='true')return false;
 if(env.GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED!=='true'||env.GENERAL_AGENT_ORDINARY_STEERING_ENABLED!=='true')throw Error('ordinary_final_requires_original_steering');
 return true;
}
/** One original-run fact consumer. Observation claims only coalesce reads;
 * original publisher/source/native proofs and provider send gates retain all
 * authority. Nothing here calls a prompt, Agent, Goal control or provider. */
export class OrdinaryFinalRecoveryPump{
 private db:DatabaseSync;private publisher:OrdinaryFinalPublisher;private deliveries:HistoricalFinalDeliveryIntents;private options:Options;
 private now:()=>number;private retryMs:number;private leaseMs:number;private busy=false;
 constructor(db:DatabaseSync,publisher:OrdinaryFinalPublisher,deliveries:HistoricalFinalDeliveryIntents,options:Options){
  if(!(publisher instanceof OrdinaryFinalPublisher)||!publisher.usesDatabase(db)||!(deliveries instanceof HistoricalFinalDeliveryIntents)||!deliveries.usesDatabase(db))throw Error('ordinary_final_observer_database_mismatch');
  this.db=db;this.publisher=publisher;this.deliveries=deliveries;this.options=options;this.now=options.now??Date.now;this.retryMs=options.retryMs??5000;this.leaseMs=options.leaseMs??60000;
  if(typeof options.enabled!=='boolean'||!options.workerId||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(options.workerId)||!Number.isSafeInteger(this.retryMs)||this.retryMs<100||!Number.isSafeInteger(this.leaseMs)||this.leaseMs<1000)throw Error('ordinary_final_observer_config_invalid');
 }
 private claim():Claim|null{
  return withImmediateTransaction(this.db,()=>{
   const now=this.now(),table=(name:string)=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
   const ordinary=(table('wb_run_bindings')?' AND NOT EXISTS(SELECT 1 FROM wb_run_bindings wb WHERE wb.run_id=r.id)':'')
    +(table('wb_agents')?' AND NOT EXISTS(SELECT 1 FROM wb_agents a WHERE a.conversation_id=c.id AND a.owner_id=c.owner_id)':'');
   const row=this.db.prepare(`SELECT r.id run_id,r.conversation_id,c.owner_id,b.session_id,
    CASE WHEN p.run_id IS NULL THEN 'publication' ELSE 'delivery' END phase
    FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN ga_run_native_sessions b ON b.run_id=r.id AND b.conversation_id=c.id AND b.owner_id=c.owner_id
    LEFT JOIN ga_ordinary_final_publications p ON p.run_id=r.id
    LEFT JOIN ga_historical_final_delivery_batches h ON h.run_id=r.id
    LEFT JOIN ga_ordinary_final_observers o ON o.run_id=r.id
    WHERE r.status IN ('succeeded','failed','interrupted','partial') AND c.archived_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM ga_run_commands cmd WHERE cmd.run_id=r.id AND cmd.kind<>'steer')
     AND NOT EXISTS(SELECT 1 FROM ga_worker_leases l WHERE l.resource_id=r.id AND CAST(l.expires_at AS INTEGER)>?)
     AND (o.run_id IS NULL OR (o.owner_id=c.owner_id AND o.conversation_id=c.id AND o.session_id=b.session_id AND o.lease_until<=? AND o.next_check_at<=?))
     AND (
      (p.run_id IS NULL AND h.run_id IS NULL AND r.continuation_of IS NULL
       AND EXISTS(SELECT 1 FROM ga_messages i WHERE i.id=r.input_message_id AND i.run_id=r.id AND i.conversation_id=c.id AND i.role='user' AND i.status='complete')
       AND NOT EXISTS(SELECT 1 FROM ga_runs later WHERE later.conversation_id=c.id AND later.rowid>r.rowid)
       AND NOT EXISTS(SELECT 1 FROM ga_conversation_goal_controls g WHERE g.run_id=r.id)
       AND (r.status<>'succeeded' OR NOT EXISTS(SELECT 1 FROM ga_messages m WHERE m.run_id=r.id AND m.role='assistant' AND m.status='complete') OR EXISTS(SELECT 1 FROM ga_run_commands steer WHERE steer.run_id=r.id AND steer.kind='steer'))
       ${ordinary})
      OR (p.run_id IS NOT NULL AND h.owner_id=c.owner_id AND h.conversation_id=c.id AND p.owner_id=c.owner_id AND p.session_id=b.session_id
       AND EXISTS(SELECT 1 FROM ga_historical_final_delivery_intents i JOIN ga_historical_final_delivery_states s ON s.intent_id=i.intent_id
        WHERE i.run_id=r.id AND (s.status IN ('hold','queued','pending_receipt') OR
         (s.status='delivered' AND CASE WHEN json_valid(s.decision_json) THEN json_array_length(json_extract(s.decision_json,'$.unresolved_effect_ids'))>0 ELSE 0 END))))
     ) ORDER BY COALESCE(o.updated_at,0),r.created_at,r.rowid LIMIT 1`).get(now,now,now) as Omit<Claim,'token'>|undefined;
   if(!row)return null;
   const old=this.db.prepare('SELECT * FROM ga_ordinary_final_observers WHERE run_id=?').get(row.run_id) as Row|undefined;
   const token=randomUUID();
   if(old){
    if(!Number.isSafeInteger(old.attempts)||old.attempts<1)throw Error('ordinary_final_observer_state_invalid');
    if(this.db.prepare("UPDATE ga_ordinary_final_observers SET observer_id=?,token=?,lease_until=?,next_check_at=0,attempts=attempts+1,last_phase=?,last_outcome='observing',updated_at=? WHERE run_id=? AND token=?").run(this.options.workerId,token,now+this.leaseMs,row.phase,now,row.run_id,old.token).changes!==1)throw Error('ordinary_final_observer_claim_lost');
   }else this.db.prepare('INSERT INTO ga_ordinary_final_observers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.run_id,row.owner_id,row.conversation_id,row.session_id,this.options.workerId,token,now+this.leaseMs,0,1,row.phase,'observing',now);
   return{...row,token};
  });
 }
 async processNext(signal?:AbortSignal):Promise<{run_id:string;phase:'publication'|'delivery';outcome:'published'|'checked'|'unconfirmed'|'stopped';execution_authorized:false}|null>{
  if(!this.options.enabled||this.busy||signal?.aborted)return null;
  this.busy=true;let claim:Claim|null=null,outcome:'published'|'checked'|'unconfirmed'|'stopped'='unconfirmed';
  try{
   claim=this.claim();if(!claim)return null;
   const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
   const result=claim.phase==='publication'?await this.publisher.reconcile(claim.run_id,claim.session_id,combined,{owner_id:claim.owner_id,conversation_id:claim.conversation_id}):this.deliveries.reconcileHeld(claim.run_id);
   outcome=result?(claim.phase==='publication'?'published':'checked'):signal?.aborted?'stopped':'unconfirmed';
   return{run_id:claim.run_id,phase:claim.phase,outcome,execution_authorized:false};
  }finally{
   if(claim)try{const now=this.now();this.db.prepare('UPDATE ga_ordinary_final_observers SET lease_until=0,next_check_at=?,last_outcome=?,updated_at=? WHERE run_id=? AND observer_id=? AND token=?').run(outcome==='published'?now:now+this.retryMs,outcome,now,claim.run_id,this.options.workerId,claim.token);}catch{/* A lost observation update is not replay or monetary authority. */}
   this.busy=false;
  }
 }
}
