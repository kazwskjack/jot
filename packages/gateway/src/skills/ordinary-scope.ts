import type {DatabaseSync} from 'node:sqlite';
import {withReadTransaction} from '../db/database.ts';

export type OrdinarySkillScope=Readonly<{kind:'ordinary';owner_id:string;project_id:string|null;workspace_id:string;
 conversation_id:string;conversation_version:number;run_id:string;run_version:number;session_ref:string;mode:'work'|'chat'}>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Existing original run/Session lineage grants this read-only observation. */
export function readOrdinarySkillScope(db:DatabaseSync,owner:string,runId:string):OrdinarySkillScope{
 if(!ID.test(owner)||!ID.test(runId))throw Error('skill_catalog_scope_forbidden');
 return withReadTransaction(db,()=>{
  const row=db.prepare(`SELECT c.id AS conversation_id,c.owner_id,c.workspace_id,c.project_id,c.version AS conversation_version,c.mode,
   r.id AS run_id,r.version AS run_version,n.session_id AS session_ref
   FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
   JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=c.id AND n.owner_id=c.owner_id
   WHERE r.id=? AND c.owner_id=? AND r.status IN ('queued','starting','running','waiting_user','waiting_approval') AND c.archived_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM wb_run_bindings w WHERE w.run_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM wb_agents a WHERE a.conversation_id=c.id AND a.owner_id=c.owner_id)
   AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM ga_projects p WHERE p.id=c.project_id AND p.owner_id=c.owner_id AND p.deleted_at IS NULL))`)
   .get(runId,owner) as Record<string,unknown>|undefined;
  if(!row||!['conversation_id','workspace_id','session_ref'].every(key=>typeof row[key]==='string'&&ID.test(row[key] as string))
   ||row.project_id!==null&&(typeof row.project_id!=='string'||!ID.test(row.project_id))
   ||!['work','chat'].includes(String(row.mode))||!['run_version','conversation_version'].every(key=>Number.isSafeInteger(row[key])&&Number(row[key])>=1))throw Error('skill_catalog_scope_forbidden');
  return {kind:'ordinary',owner_id:owner,project_id:row.project_id as string|null,workspace_id:row.workspace_id as string,
   conversation_id:row.conversation_id as string,conversation_version:Number(row.conversation_version),run_id:runId,
   run_version:Number(row.run_version),session_ref:row.session_ref as string,mode:row.mode as 'work'|'chat'};
 });
}
