import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

type Row=Record<string,any>;
type Scope={project_id:string;workspace_id:string;agent_id:string};
const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
function exact(value:unknown,keys:string[],code='discovery_policy_invalid'):Row{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error(code);return value as Row;
}
function identity(value:unknown,code='discovery_scope_unavailable'):string{
 if(typeof value!=='string'||!value.trim()||value.length>256||/[\u0000-\u001f\u007f]/.test(value))throw Error(code);return value;
}
function integer(value:unknown,min=0){if(!Number.isSafeInteger(value)||Number(value)<min)throw Error('discovery_policy_invalid');return Number(value);}
function install(db:DatabaseSync){withImmediateTransaction(db,()=>{
 db.exec(`CREATE TABLE IF NOT EXISTS wb_discovery_policies(
  policy_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),role_version INTEGER NOT NULL CHECK(role_version>0),role_epoch INTEGER NOT NULL CHECK(role_epoch>0),
  state TEXT NOT NULL CHECK(state IN ('off','active','paused','stopped')),config_json TEXT NOT NULL,updated_at TEXT NOT NULL,
  UNIQUE(owner_id,project_id,workspace_id,agent_id));
 CREATE TABLE IF NOT EXISTS wb_discovery_policy_revisions(
  policy_id TEXT NOT NULL REFERENCES wb_discovery_policies(policy_id),version INTEGER NOT NULL CHECK(version>0),
  command_key TEXT NOT NULL,command_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(policy_id,version),UNIQUE(policy_id,command_key));
 CREATE TRIGGER IF NOT EXISTS wb_discovery_policy_identity BEFORE UPDATE ON wb_discovery_policies
 WHEN NEW.policy_id IS NOT OLD.policy_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.version<>OLD.version+1
 BEGIN SELECT RAISE(ABORT,'discovery_policy_identity_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_policy_no_delete BEFORE DELETE ON wb_discovery_policies
 BEGIN SELECT RAISE(ABORT,'discovery_policy_identity_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_policy_no_replace BEFORE INSERT ON wb_discovery_policies
 WHEN EXISTS(SELECT 1 FROM wb_discovery_policies WHERE policy_id=NEW.policy_id OR (owner_id=NEW.owner_id AND project_id=NEW.project_id AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id))
 BEGIN SELECT RAISE(ABORT,'discovery_policy_identity_immutable'); END;
 CREATE TABLE IF NOT EXISTS wb_discovery_signals(
  policy_id TEXT NOT NULL REFERENCES wb_discovery_policies(policy_id),revision INTEGER NOT NULL CHECK(revision>0),
  kind TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL CHECK(source_version>0),source_sha256 TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version>0),created_at TEXT NOT NULL,
  PRIMARY KEY(policy_id,revision),UNIQUE(policy_id,kind,source_id,source_version));`);
 for(const table of ['wb_discovery_policy_revisions','wb_discovery_signals']){
  for(const op of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'discovery_revision_immutable'); END;`);
  const match=table==='wb_discovery_policy_revisions'?'(policy_id=NEW.policy_id AND (version=NEW.version OR command_key=NEW.command_key))':'(policy_id=NEW.policy_id AND (revision=NEW.revision OR (kind=NEW.kind AND source_id=NEW.source_id AND source_version=NEW.source_version)))';
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${match}) BEGIN SELECT RAISE(ABORT,'discovery_revision_immutable'); END;`);
 }
});}

/** Owner command and source evidence store only. A saved policy is never a
 * model/tool grant. Signal ingestion is internal and must not be a model tool. */
export class DiscoveryPolicies{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;install(db);}
 private owned(owner:string,value:unknown){
  identity(owner);const scope=exact(value,['project_id','workspace_id','agent_id'],'discovery_scope_unavailable') as Scope;
  for(const key of ['project_id','workspace_id','agent_id'] as const)identity(scope[key]);
  const role=this.db.prepare(`SELECT a.version,a.capability_epoch,a.status FROM wb_agents a JOIN ga_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
   JOIN ga_conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id AND c.project_id=a.project_id AND c.workspace_id=a.workspace_id
   WHERE a.owner_id=? AND a.project_id=? AND a.workspace_id=? AND a.agent_id=?`).get(owner,scope.project_id,scope.workspace_id,scope.agent_id) as Row|undefined;
  if(!role)throw Error('discovery_scope_unavailable');
  return {scope:{...scope},role,id:'discovery-'+digest([owner,scope.project_id,scope.workspace_id,scope.agent_id])};
 }
 private head(id:string){return this.db.prepare('SELECT * FROM wb_discovery_policies WHERE policy_id=?').get(id) as Row|undefined;}
 private effective(row:Row,role:Row){return row.state==='active'&&(role.status!=='active'||role.version!==row.role_version||role.capability_epoch!==row.role_epoch)?'revoked':row.state;}
 private view(row:Row){return {policy_id:row.policy_id,scope:{project_id:row.project_id,workspace_id:row.workspace_id,agent_id:row.agent_id},version:row.version,role_version:row.role_version,role_epoch:row.role_epoch,state:row.state,...JSON.parse(row.config_json),execution_authorized:false as const};}
 get(owner:string,scope:unknown){const owned=this.owned(owner,scope),row=this.head(owned.id);return {policy:row?{...this.view(row),effective_state:this.effective(row,owned.role)}:null,execution_authorized:false as const};}
 private command(owner:string,scope:unknown,input:unknown,key:string,action:'save'|'control'){
  identity(key,'discovery_command_key_invalid');
  return withImmediateTransaction(this.db,()=>{
   const owned=this.owned(owner,scope),commandHash=digest(canonical({action,input})),prior=this.db.prepare('SELECT command_sha256,receipt_json FROM wb_discovery_policy_revisions WHERE policy_id=? AND command_key=?').get(owned.id,key) as Row|undefined;
   if(prior){if(prior.command_sha256!==commandHash)throw Error('idempotency_conflict');return JSON.parse(prior.receipt_json);}
   const row=this.head(owned.id),body=action==='save'?exact(input,['expected_version','expected_role_version','expected_role_epoch','mode','cooldown_ms','recent_input_ms','max_cycles']):exact(input,(input as Row)?.action==='enable'?['action','expected_version','expected_role_version','expected_role_epoch']:['action','expected_version']);
   if(integer(body.expected_version)!==(row?.version??0))throw Error('version_conflict');
   let state=row?.state??'off',roleVersion=row?.role_version??owned.role.version,roleEpoch=row?.role_epoch??owned.role.capability_epoch,config:Row;
   if(action==='save'){
    if(integer(body.expected_role_version,1)!==owned.role.version||integer(body.expected_role_epoch,1)!==owned.role.capability_epoch)throw Error('discovery_role_changed');
    if(!['discover_only','discover_and_work'].includes(body.mode))throw Error('discovery_policy_invalid');
    config={mode:body.mode,cooldown_ms:integer(body.cooldown_ms),recent_input_ms:integer(body.recent_input_ms),max_cycles:body.max_cycles===null?null:integer(body.max_cycles,1)};
    if(state==='active'&&this.effective(row!,owned.role)==='revoked')state='paused';
    roleVersion=owned.role.version;roleEpoch=owned.role.capability_epoch;
   }else{
    if(!row||!['enable','pause','stop'].includes(body.action))throw Error('discovery_policy_invalid');config=JSON.parse(row.config_json);
    if(body.action==='enable'){
     if(owned.role.status!=='active')throw Error('discovery_role_unavailable');
     if(integer(body.expected_role_version,1)!==owned.role.version||integer(body.expected_role_epoch,1)!==owned.role.capability_epoch)throw Error('discovery_role_changed');
     state='active';roleVersion=owned.role.version;roleEpoch=owned.role.capability_epoch;
    }else state=body.action==='pause'?'paused':'stopped';
   }
   const version=integer((row?.version??0)+1,1),now=new Date().toISOString();
   if(row)this.db.prepare('UPDATE wb_discovery_policies SET version=?,role_version=?,role_epoch=?,state=?,config_json=?,updated_at=? WHERE policy_id=? AND version=?').run(version,roleVersion,roleEpoch,state,JSON.stringify(config),now,owned.id,row.version);
   else this.db.prepare('INSERT INTO wb_discovery_policies VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(owned.id,owner,owned.scope.project_id,owned.scope.workspace_id,owned.scope.agent_id,version,roleVersion,roleEpoch,state,JSON.stringify(config),now);
   const receipt=this.view(this.head(owned.id)!);
   this.db.prepare('INSERT INTO wb_discovery_policy_revisions VALUES(?,?,?,?,?,?)').run(owned.id,version,key,commandHash,JSON.stringify(receipt),now);return receipt;
  });
 }
 save(owner:string,scope:unknown,input:unknown,key:string){return this.command(owner,scope,input,key,'save');}
 control(owner:string,scope:unknown,input:unknown,key:string){return this.command(owner,scope,input,key,'control');}
 signals(owner:string,scope:unknown){const owned=this.owned(owner,scope),row=this.db.prepare('SELECT max(revision) AS revision FROM wb_discovery_signals WHERE policy_id=?').get(owned.id) as Row;return {revision:Number(row.revision??0),execution_authorized:false as const};}
 recordSignal(owner:string,scope:unknown,input:unknown){
  const value=exact(input,['kind','source_id','source_version','source_sha256','origin'],'discovery_signal_invalid');
  if(!['project_change','workspace_change','user_input','external_update'].includes(value.kind)||!['external','cycle','generated'].includes(value.origin)||!Number.isSafeInteger(value.source_version)||value.source_version<1||typeof value.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.source_sha256))throw Error('discovery_signal_invalid');identity(value.source_id,'discovery_signal_invalid');
  return withImmediateTransaction(this.db,()=>{
   const owned=this.owned(owner,scope),head=this.head(owned.id),current=this.signals(owner,scope).revision;
   const ignored=(reason:string)=>({recorded:false,reason,signal_revision:current,execution_authorized:false as const});
   if(value.origin!=='external')return ignored('SELF_GENERATED');
   if(!head||['off','stopped'].includes(head.state))return ignored('POLICY_OFF');
   if(owned.role.status!=='active'||owned.role.version!==head.role_version||owned.role.capability_epoch!==head.role_epoch)return ignored('ROLE_REVOKED');
   const prior=this.db.prepare('SELECT revision,source_sha256 FROM wb_discovery_signals WHERE policy_id=? AND kind=? AND source_id=? AND source_version=?').get(owned.id,value.kind,value.source_id,value.source_version) as Row|undefined;
   const receipt=(revision:number)=>({recorded:true,reason:null,signal_revision:revision,execution_authorized:false as const});
   if(prior){if(prior.source_sha256!==value.source_sha256)throw Error('discovery_signal_conflict');return receipt(prior.revision);}
   const latest=this.db.prepare('SELECT max(source_version) AS version FROM wb_discovery_signals WHERE policy_id=? AND kind=? AND source_id=?').get(owned.id,value.kind,value.source_id) as Row;
   if(latest.version!==null&&value.source_version<latest.version)throw Error('discovery_signal_stale');
   const revision=integer(current+1,1);this.db.prepare('INSERT INTO wb_discovery_signals VALUES(?,?,?,?,?,?,?,?)').run(owned.id,revision,value.kind,value.source_id,value.source_version,value.source_sha256,head.version,new Date().toISOString());return receipt(revision);
  });
 }
}
