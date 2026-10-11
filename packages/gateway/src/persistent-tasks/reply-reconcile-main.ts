import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {ModelBudgetLedger} from '../workbench/model-budget.ts';
import {TaskReplySemanticChecks} from './reply-semantic.ts';

const [operation,database,owner,id,...extra]=process.argv.slice(2);
if(!['inspect','recover'].includes(operation??'')||!database||!owner||!id||extra.length||process.argv.slice(2).some(value=>value.startsWith('--'))){
 console.error('usage: reply-reconcile-main inspect DATABASE OWNER DRAFT_ID | recover DATABASE OWNER DRAFT_ID');process.exitCode=2;
}else{
 let db:DatabaseSync|undefined;
 try{
  const source=lstatSync(database);if(!source.isFile()||source.isSymbolicLink())throw new Error('reply_database_denied');
  db=new DatabaseSync(database,{readOnly:operation==='inspect'});db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
  const row=db.prepare('SELECT draft_json,payload_sha256,run_id FROM wb_task_reply_drafts WHERE draft_id=? AND owner_id=?').get(id,owner) as Record<string,any>|undefined;
  if(!row||createHash('sha256').update(canonicalJson(JSON.parse(row.draft_json))).digest('hex')!==row.payload_sha256)throw new Error('reply_draft_denied');
  if(operation==='inspect'){
   db.exec('BEGIN');
   const exists=(table:string)=>!!db!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
   const attempt=exists('wb_task_reply_semantic_attempts')?db.prepare('SELECT attempt_id FROM wb_task_reply_semantic_attempts WHERE draft_id=? AND owner_id=?').get(id,owner) as {attempt_id:string}|undefined:undefined;
   const saved=exists('wb_task_reply_semantic_responses')&&!!db.prepare('SELECT 1 FROM wb_task_reply_semantic_responses WHERE draft_id=? AND owner_id=?').get(id,owner);
   const check=exists('wb_task_reply_semantic_checks')?db.prepare('SELECT verdict FROM wb_task_reply_semantic_checks WHERE draft_id=? AND owner_id=?').get(id,owner) as {verdict:string}|undefined:undefined;
   const billing=attempt&&exists('wb_model_budget_attempts')?db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(row.run_id,attempt.attempt_id) as {state:string}|undefined:undefined;
   db.exec('COMMIT');
   console.log(JSON.stringify({draft_id:id,check_status:check?.verdict??'not_recorded',provider_response_saved:saved,budget_state:billing?.state??'not_started',sending_performed:false}));
  }else{
   // No network or dispatch. The original frozen route/rates are in the ledger;
   // this host operation cannot replace them with caller-supplied accounting.
   const result=new TaskReplySemanticChecks(db).recover(owner,id,{ledger:new ModelBudgetLedger(db,{routes:[]}),guard:()=>{}});
   console.log(JSON.stringify({draft_id:id,verdict:result.verdict,reason_code:result.reason_code??null,sending_performed:false}));
  }
 }catch{console.error('reply_reconciliation_failed');process.exitCode=1;}finally{db?.close();}
}
