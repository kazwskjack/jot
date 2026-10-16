import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {decodeStoredContent} from '../messages/content.ts';
type Input=Record<string,unknown>;
type Row=Record<string,string|number|null>;
interface Actor{agent_id:string;workspace_id:string;project_id:string;capability_epoch:number}
interface Ports{agent(owner:string,id:string):Actor;assertRun(owner:string,agentId:string,runId:string):void;save(owner:string,workspace:string,input:Input):Input}
interface Source{source_id:string;message_id:string;block_id:string;block_index:number;role:string;origin:'human'|'agent'|'automation';content_sha256:string;text:string;truncated:boolean}
interface Note{content:string;source_ids:string[]}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const normalize=(value:string)=>value.trim();
function exact(input:Input,allowed:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw new Error('invalid_memory_capture');}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_memory_capture');return (value as string).trim();}
function expected(value:unknown,version:number){if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('invalid_memory_capture');if(value!==version)throw new Error('version_conflict');}
/** Capturing a completed public message is separate from planning, extraction and approval. */
export class MemoryCaptureService{
 private readonly db:DatabaseSync;private readonly ports:Ports;
 constructor(db:DatabaseSync,ports:Ports){this.db=db;this.ports=ports;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_memory_capture_policies(agent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('off','suggest')),include_assistant INTEGER NOT NULL,include_automation INTEGER NOT NULL,version INTEGER NOT NULL,epoch INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_memory_capture_policy_revisions(agent_id TEXT NOT NULL,version INTEGER NOT NULL,owner_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,version));
   CREATE TABLE IF NOT EXISTS wb_memory_captures(sequence INTEGER PRIMARY KEY AUTOINCREMENT,capture_id TEXT UNIQUE NOT NULL,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,agent_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,source_conversation_id TEXT NOT NULL,run_kind TEXT NOT NULL,policy_version INTEGER NOT NULL,epoch INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('watching','ready','proposed','applied','rejected','no_notes','no_source','source_failed','stale')),version INTEGER NOT NULL,
    source_json TEXT,info_json TEXT,proposal_json TEXT,results_json TEXT,processor_run_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_id,agent_id,source_run_id));
   CREATE INDEX IF NOT EXISTS wb_memory_capture_scope ON wb_memory_captures(owner_id,agent_id,sequence DESC);
   CREATE INDEX IF NOT EXISTS wb_memory_capture_watch ON wb_memory_captures(status,sequence);
   CREATE TRIGGER IF NOT EXISTS wb_capture_policy_revision_no_update BEFORE UPDATE ON wb_memory_capture_policy_revisions BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_capture_policy_revision_no_delete BEFORE DELETE ON wb_memory_capture_policy_revisions BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_capture_policy_revision_no_replace BEFORE INSERT ON wb_memory_capture_policy_revisions WHEN EXISTS(SELECT 1 FROM wb_memory_capture_policy_revisions WHERE agent_id=NEW.agent_id AND version=NEW.version) BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_captures_no_delete BEFORE DELETE ON wb_memory_captures BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_capture_sequence_guard BEFORE UPDATE OF sequence ON wb_memory_captures WHEN NEW.sequence IS NOT OLD.sequence BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_captures_no_replace BEFORE INSERT ON wb_memory_captures WHEN EXISTS(SELECT 1 FROM wb_memory_captures WHERE sequence=NEW.sequence OR capture_id=NEW.capture_id OR (owner_id=NEW.owner_id AND agent_id=NEW.agent_id AND source_run_id=NEW.source_run_id)) BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_captures_guard BEFORE UPDATE ON wb_memory_captures
    WHEN NEW.capture_id IS NOT OLD.capture_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.project_id IS NOT OLD.project_id OR NEW.agent_id IS NOT OLD.agent_id
     OR NEW.source_run_id IS NOT OLD.source_run_id OR NEW.source_conversation_id IS NOT OLD.source_conversation_id OR NEW.run_kind IS NOT OLD.run_kind OR NEW.policy_version!=OLD.policy_version OR NEW.epoch!=OLD.epoch OR NEW.created_at IS NOT OLD.created_at OR NEW.version!=OLD.version+1
     OR (OLD.source_json IS NOT NULL AND NEW.source_json IS NOT OLD.source_json) OR (OLD.info_json IS NOT NULL AND NEW.info_json IS NOT OLD.info_json)
     OR (OLD.proposal_json IS NOT NULL AND NEW.proposal_json IS NOT OLD.proposal_json) OR (OLD.results_json IS NOT NULL AND NEW.results_json IS NOT OLD.results_json)
     OR (OLD.processor_run_id IS NOT NULL AND NEW.processor_run_id IS NOT OLD.processor_run_id)
     OR (NEW.source_json IS NOT OLD.source_json AND NOT(OLD.status='watching' AND NEW.status IN ('ready','no_source','source_failed','stale')))
     OR (NEW.info_json IS NOT OLD.info_json AND NOT(OLD.status='watching' AND NEW.status IN ('ready','no_source','source_failed','stale')))
     OR ((NEW.proposal_json IS NOT OLD.proposal_json OR NEW.processor_run_id IS NOT OLD.processor_run_id) AND NOT(OLD.status='ready' AND NEW.status IN ('proposed','no_notes')))
     OR (NEW.results_json IS NOT OLD.results_json AND NOT(OLD.status='proposed' AND NEW.status='applied'))
     OR NOT((OLD.status='watching' AND NEW.status IN ('ready','no_source','source_failed','stale','rejected')) OR (OLD.status='ready' AND NEW.status IN ('proposed','no_notes','rejected')) OR (OLD.status='proposed' AND NEW.status IN ('applied','rejected')))
    BEGIN SELECT RAISE(ABORT,'memory_capture_immutable'); END;`);
 }
 private rawPolicy(owner:string,agentId:string){return this.db.prepare('SELECT * FROM wb_memory_capture_policies WHERE owner_id=? AND agent_id=?').get(owner,agentId) as Row|undefined;}
 policy(owner:string,agentId:string){const actor=this.ports.agent(owner,agentId),row=this.rawPolicy(owner,agentId);return {agent_id:agentId,mode:row?.mode??'off',include_assistant:!!row?.include_assistant,include_automation:!!row?.include_automation,version:Number(row?.version??0),current:!row||row.epoch===actor.capability_epoch,updated_at:row?.updated_at??null};}
 setPolicy(owner:string,agentId:string,input:Input){return withImmediateTransaction(this.db,()=>{
  exact(input,['expected_version','mode','include_assistant','include_automation']);const actor=this.ports.agent(owner,agentId),old=this.rawPolicy(owner,agentId);expected(input.expected_version,Number(old?.version??0));
  if(input.mode!=='off'&&input.mode!=='suggest')throw new Error('invalid_memory_capture');for(const key of ['include_assistant','include_automation'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw new Error('invalid_memory_capture');
  const assistant=input.include_assistant===undefined?Number(old?.include_assistant??0):Number(input.include_assistant),automation=input.include_automation===undefined?Number(old?.include_automation??0):Number(input.include_automation),at=now(),version=Number(old?.version??0)+1;
  this.db.prepare(`INSERT INTO wb_memory_capture_policies VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET mode=excluded.mode,include_assistant=excluded.include_assistant,include_automation=excluded.include_automation,version=excluded.version,epoch=excluded.epoch,updated_at=excluded.updated_at`)
   .run(agentId,owner,String(input.mode),assistant,automation,version,actor.capability_epoch,old?.created_at??at,at);
  const value=this.policy(owner,agentId);this.db.prepare('INSERT INTO wb_memory_capture_policy_revisions VALUES(?,?,?,?,?)').run(agentId,version,owner,JSON.stringify(value),at);return value;
 });}
 register(owner:string,agentId:string,runId:string){
  if(!this.db.isTransaction)throw new Error('memory_capture_transaction_required');const policy=this.rawPolicy(owner,agentId);if(!policy||policy.mode!=='suggest')return;
  const actor=this.ports.agent(owner,agentId);if(policy.epoch!==actor.capability_epoch)return;
  const run=this.db.prepare(`SELECT r.conversation_id,b.kind FROM ga_runs r JOIN wb_run_bindings b ON b.run_id=r.id WHERE r.id=? AND b.owner_id=? AND b.agent_id=?`).get(runId,owner,agentId) as Row|undefined;
  if(!run||!['chat','task','native_team','internal_mailbox'].includes(String(run.kind))||(run.kind!=='chat'&&!policy.include_assistant&&!policy.include_automation))return;
  if(this.db.prepare('SELECT 1 FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND source_run_id=?').get(owner,agentId,runId))return;
  const at=now();this.db.prepare(`INSERT INTO wb_memory_captures(capture_id,owner_id,workspace_id,project_id,agent_id,source_run_id,source_conversation_id,run_kind,policy_version,epoch,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'watching',1,?,?)`)
   .run('capture-'+randomUUID(),owner,actor.workspace_id,actor.project_id,agentId,runId,String(run.conversation_id),String(run.kind),Number(policy.version),actor.capability_epoch,at,at);
 }
 private row(owner:string,agentId:string,id:string){const actor=this.ports.agent(owner,agentId),row=this.db.prepare('SELECT * FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND capture_id=?').get(owner,agentId,id) as Row|undefined;if(!row)throw new Error('memory_capture_not_found');if(row.workspace_id!==actor.workspace_id||row.project_id!==actor.project_id)throw new Error('memory_scope_forbidden');return row;}
 private policyCurrent(row:Row){const p=this.rawPolicy(String(row.owner_id),String(row.agent_id)),actor=this.ports.agent(String(row.owner_id),String(row.agent_id));return !!p&&p.mode==='suggest'&&p.version===row.policy_version&&p.epoch===row.epoch&&row.epoch===actor.capability_epoch;}
 private currentSource(row:Row,source:Source){
  const message=this.db.prepare(`SELECT m.content_json,m.status,m.role,c.archived_at FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.conversation_id=? AND c.owner_id=? AND c.workspace_id=? AND c.project_id=?`).get(source.message_id,String(row.source_conversation_id),String(row.owner_id),String(row.workspace_id),String(row.project_id)) as Row|undefined;
  return !!message&&message.status==='complete'&&message.role===source.role&&message.archived_at===null&&digest(String(message.content_json))===source.content_sha256;
 }
 private sources(row:Row){return (row.source_json?JSON.parse(String(row.source_json)):[]) as Source[];}
 private requireSources(row:Row){const sources=this.sources(row);if(!sources.length||sources.some(source=>!this.currentSource(row,source)))throw new Error('memory_capture_source_conflict');return sources;}
 private processing(row:Row){
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_memory_processing_runs'").get())return null;
  const job=this.db.prepare(`SELECT r.status,r.reason_code FROM wb_memory_processing_runs p LEFT JOIN ga_runs r ON r.id=p.processor_run_id
   WHERE p.capture_id=? AND p.owner_id=? AND p.agent_id=?`).get(String(row.capture_id),String(row.owner_id),String(row.agent_id)) as {status:string|null;reason_code:string|null}|undefined;
  return job?{status:job.status??'missing',reason_code:job.reason_code}:null;
 }
 private header(row:Row){const sources=this.sources(row),proposal=row.proposal_json?JSON.parse(String(row.proposal_json)):null;return {processing:this.processing(row),capture_id:String(row.capture_id),agent_id:String(row.agent_id),workspace_id:String(row.workspace_id),project_id:String(row.project_id),source_run_id:String(row.source_run_id),source_conversation_id:String(row.source_conversation_id),run_kind:String(row.run_kind),policy_version:Number(row.policy_version),policy_current:this.policyCurrent(row),status:String(row.status),version:Number(row.version),source_count:sources.length,notes_count:proposal?.notes.length??0,created_at:String(row.created_at),updated_at:String(row.updated_at)};}
 list(owner:string,agentId:string,beforeId?:string){this.ports.agent(owner,agentId);let before:number|null=null;if(beforeId!==undefined){const cursor=this.db.prepare('SELECT sequence FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND capture_id=?').get(owner,agentId,beforeId) as {sequence:number}|undefined;if(!cursor)throw new Error('memory_capture_not_found');before=cursor.sequence;}
  const rows=this.db.prepare('SELECT * FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT 26').all(owner,agentId,before,before) as Row[],page=rows.slice(0,25);return {items:page.map(row=>this.header(row)),next_before_id:rows.length>25?String(page.at(-1)!.capture_id):null};}
 get(owner:string,agentId:string,id:string){const row=this.row(owner,agentId,id),sources=this.sources(row),available=sources.every(source=>this.currentSource(row,source));return {...this.header(row),info:row.info_json?JSON.parse(String(row.info_json)):null,
  sources:sources.map(source=>{const {text,...metadata}=source;return {...metadata,available:this.currentSource(row,source),...(this.currentSource(row,source)?{text}:{})};}),
  proposal:available&&row.proposal_json?JSON.parse(String(row.proposal_json)):null,proposal_unavailable:!available&&row.proposal_json!==null,results:row.results_json?JSON.parse(String(row.results_json)):null};}
 collect(owner?:string,agentId?:string){if(owner!==undefined||agentId!==undefined){if(!owner||!agentId)throw new Error('invalid_memory_capture');this.ports.agent(owner,agentId);}
  return withImmediateTransaction(this.db,()=>{const rows=this.db.prepare(`SELECT b.*,r.status AS source_status,a.status AS actor_status,a.capability_epoch,p.mode AS policy_mode,p.version AS current_policy,p.include_assistant,p.include_automation
    FROM wb_memory_captures b LEFT JOIN ga_runs r ON r.id=b.source_run_id JOIN wb_agents a ON a.agent_id=b.agent_id JOIN wb_memory_capture_policies p ON p.agent_id=b.agent_id
    WHERE b.status='watching' AND (? IS NULL OR (b.owner_id=? AND b.agent_id=?)) AND (r.id IS NULL OR r.status IN ('succeeded','partial','failed','cancelled','interrupted','outcome_unknown') OR a.status!='active' OR a.capability_epoch!=b.epoch OR p.mode!='suggest' OR p.version!=b.policy_version)
    AND ((SELECT count(*) FROM wb_memory_captures q WHERE q.owner_id=b.owner_id AND q.agent_id=b.agent_id AND q.policy_version=b.policy_version AND q.status IN ('ready','proposed'))<50 OR r.id IS NULL OR r.status NOT IN ('succeeded','partial') OR a.status!='active' OR p.mode!='suggest' OR p.version!=b.policy_version OR a.capability_epoch!=b.epoch) ORDER BY b.sequence LIMIT 50`)
    .all(owner??null,owner??null,agentId??null) as Row[];let ready=0,skipped=0;
   for(const row of rows){let status='ready',sources:Source[]=[],captured=0,truncated=0,omitted=0,excluded=0;
    if(row.actor_status!=='active'||row.capability_epoch!==row.epoch||row.policy_mode!=='suggest'||row.current_policy!==row.policy_version)status='stale';
    else if(!['succeeded','partial'].includes(String(row.source_status)))status='source_failed';
    else{
     const count=this.db.prepare("SELECT count(*) n FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND policy_version=? AND status IN ('ready','proposed')").get(String(row.owner_id),String(row.agent_id),Number(row.policy_version)) as {n:number};if(count.n>=50)continue;
     const run=this.db.prepare('SELECT input_message_id FROM ga_runs WHERE id=?').get(String(row.source_run_id)) as Row;
     const messages=this.db.prepare(`SELECT m.* FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id WHERE c.owner_id=? AND c.workspace_id=? AND c.project_id=? AND c.archived_at IS NULL AND m.conversation_id=? AND (m.id=? OR (m.run_id=? AND m.role='assistant')) ORDER BY CASE m.role WHEN 'user' THEN 0 ELSE 1 END,m.created_at,m.id`)
       .all(String(row.owner_id),String(row.workspace_id),String(row.project_id),String(row.source_conversation_id),String(run.input_message_id),String(row.source_run_id)) as Row[];
     for(const message of messages){for(const [index,block] of decodeStoredContent(String(message.content_json)).blocks.entries()){
      const role=String(message.role),allowed=message.status==='complete'&&(role==='user'?(row.run_kind==='chat'||!!row.include_automation):role==='assistant'&&!!row.include_assistant);
      if(!allowed||block.kind!=='text'||(block.exposure!==undefined&&block.exposure!=='public')||typeof block.text!=='string'||!block.text.trim()){excluded++;continue;}
      if(sources.length>=20||captured>=20000){omitted++;continue;}const value=block.text.slice(0,20000-captured),short=value.length<block.text.length,hash=digest(String(message.content_json));if(short)truncated++;
      sources.push({source_id:'source-'+digest(JSON.stringify([message.id,index,hash])).slice(0,32),message_id:String(message.id),block_id:typeof block.block_id==='string'?block.block_id.slice(0,256):String(message.id)+':'+index,block_index:index,role,origin:role==='assistant'?'agent':row.run_kind==='chat'?'human':'automation',content_sha256:hash,text:value,truncated:short});captured+=value.length;
     }}if(!sources.length)status='no_source';
    }
    this.db.prepare('UPDATE wb_memory_captures SET source_json=?,info_json=?,status=?,version=version+1,updated_at=? WHERE capture_id=? AND version=?').run(JSON.stringify(sources),JSON.stringify({captured_chars:captured,truncated_blocks:truncated,omitted_blocks:omitted,excluded_blocks:excluded,source_status:row.source_status??'missing'}),status,now(),String(row.capture_id),Number(row.version));if(status==='ready')ready++;else skipped++;
   }return {ready,skipped};
  });}
 pending(owner:string,agentId:string){const actor=this.ports.agent(owner,agentId),p=this.rawPolicy(owner,agentId);if(!p||p.mode!=='suggest'||p.epoch!==actor.capability_epoch)return {items:[]};const rows=this.db.prepare("SELECT * FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND policy_version=? AND status='ready' ORDER BY sequence LIMIT 10").all(owner,agentId,Number(p.version)) as Row[];return {items:rows.map(row=>this.header(row))};}
 private assertCurrent(row:Row){if(!this.policyCurrent(row))throw new Error('memory_capture_policy_stale');}
 read(owner:string,agentId:string,id:string,processorRunId:string){this.ports.assertRun(owner,agentId,processorRunId);const row=this.row(owner,agentId,id);this.assertCurrent(row);if(!['ready','proposed','no_notes'].includes(String(row.status)))throw new Error('memory_capture_not_ready');this.requireSources(row);return this.get(owner,agentId,id);}
 propose(owner:string,agentId:string,id:string,input:Input,processorRunId:string){return withImmediateTransaction(this.db,()=>{
  this.ports.assertRun(owner,agentId,processorRunId);exact(input,['expected_version','summary','notes']);const row=this.row(owner,agentId,id);this.assertCurrent(row);expected(input.expected_version,Number(row.version));if(row.status!=='ready')throw new Error('memory_capture_state_conflict');const sources=this.requireSources(row),ids=new Set(sources.map(source=>source.source_id)),summary=text(input.summary,2000);
  if(!Array.isArray(input.notes)||input.notes.length>10)throw new Error('invalid_memory_capture');const notes:Note[]=input.notes.map(value=>{const note=value as Input;exact(note,['content','source_ids']);const content=text(note.content,3000);if(!Array.isArray(note.source_ids)||!note.source_ids.length||note.source_ids.length>20||note.source_ids.some(id=>typeof id!=='string'||!ids.has(id))||new Set(note.source_ids).size!==note.source_ids.length)throw new Error('invalid_memory_capture');return {content,source_ids:note.source_ids as string[]};});
  if(new Set(notes.map(note=>normalize(note.content))).size!==notes.length||notes.reduce((sum,note)=>sum+note.content.length,0)>20000)throw new Error('invalid_memory_capture');
  this.db.prepare('UPDATE wb_memory_captures SET proposal_json=?,processor_run_id=?,status=?,version=version+1,updated_at=? WHERE capture_id=?').run(JSON.stringify({summary,notes}),processorRunId,notes.length?'proposed':'no_notes',now(),id);return this.get(owner,agentId,id);
 });}
 apply(owner:string,agentId:string,id:string,version:number){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,agentId,id);this.assertCurrent(row);expected(version,Number(row.version));if(row.status!=='proposed')throw new Error('memory_capture_state_conflict');const sources=new Map(this.requireSources(row).map(source=>[source.source_id,source])),proposal=JSON.parse(String(row.proposal_json)) as {notes:Note[]};
  const existing=this.db.prepare("SELECT memory_id,content,version FROM wb_memories WHERE owner_id=? AND workspace_id=? AND project_id=? AND agent_id=? AND scope='private' AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at,memory_id").all(owner,String(row.workspace_id),String(row.project_id),agentId,now()) as Row[],results=[];
  for(const note of proposal.notes){const prior=existing.find(value=>normalize(String(value.content))===normalize(note.content));if(prior){results.push({memory_id:String(prior.memory_id),version:Number(prior.version),reused:true});continue;}
   const refs=note.source_ids.map(id=>sources.get(id)!);const saved=this.ports.save(owner,String(row.workspace_id),{scope:'private',agent_id:agentId,project_id:row.project_id,content:note.content,verified:false,provenance:refs.map(source=>({kind:'conversation_block',reference:source.message_id+':block:'+source.block_index})),source_revision:digest(JSON.stringify(refs.map(source=>[source.message_id,source.block_index,source.content_sha256])))});
   results.push({memory_id:String(saved.memory_id),version:Number(saved.version),reused:false});
  }
  this.db.prepare("UPDATE wb_memory_captures SET results_json=?,status='applied',version=version+1,updated_at=? WHERE capture_id=?").run(JSON.stringify(results),now(),id);return this.get(owner,agentId,id);
 });}
 reject(owner:string,agentId:string,id:string,version:number){return withImmediateTransaction(this.db,()=>{const row=this.row(owner,agentId,id);expected(version,Number(row.version));if(!['watching','ready','proposed'].includes(String(row.status)))throw new Error('memory_capture_state_conflict');this.db.prepare("UPDATE wb_memory_captures SET status='rejected',version=version+1,updated_at=? WHERE capture_id=?").run(now(),id);return this.get(owner,agentId,id);});}
}
