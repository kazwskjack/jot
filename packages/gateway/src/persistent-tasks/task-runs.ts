import type {DatabaseSync} from 'node:sqlite';
import {savedSessionCheckpoint} from '../harness/session-checkpoints.ts';

/** Immutable recovery lineage. The existing occurrence and run queue remain authoritative. */
export function installTaskRunLineage(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_continuations (
   run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),
   parent_run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),created_at TEXT NOT NULL,CHECK(run_id!=parent_run_id));
   CREATE INDEX IF NOT EXISTS wb_task_continuations_occurrence ON wb_task_continuations(occurrence_id);
   CREATE TRIGGER IF NOT EXISTS wb_task_continuation_no_update BEFORE UPDATE ON wb_task_continuations
     BEGIN SELECT RAISE(ABORT,'task_continuation_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_continuation_no_delete BEFORE DELETE ON wb_task_continuations
     BEGIN SELECT RAISE(ABORT,'task_continuation_immutable'); END;
   CREATE VIEW IF NOT EXISTS wb_task_run_occurrences AS
     SELECT o.*,o.run_id AS root_run_id,NULL AS parent_run_id FROM wb_task_occurrences o
     UNION ALL
     SELECT o.occurrence_id,o.task_id,o.trigger_key,o.scheduled_for,o.generation,o.conversation_id,c.run_id,
       o.status,o.business_state,o.evidence_json,o.created_at,o.updated_at,o.run_id AS root_run_id,c.parent_run_id
       FROM wb_task_continuations c JOIN wb_task_occurrences o ON o.occurrence_id=c.occurrence_id;
   CREATE VIEW IF NOT EXISTS wb_task_current_occurrences AS
     SELECT o.* FROM wb_task_run_occurrences o WHERE NOT EXISTS (
       SELECT 1 FROM wb_task_continuations c WHERE c.parent_run_id=o.run_id);`);
}

/** Called inside the existing resume transaction, after authoritative RunCommand checks. */
export function bindTaskContinuation(db:DatabaseSync,owner:string,parentId:string,runId:string){
 const row=db.prepare(`SELECT o.*,t.owner_id,t.status AS task_status,t.generation AS current_generation,
   p.status AS parent_status,p.checkpoint_id AS parent_checkpoint,p.reason_code,
   n.status AS next_status,n.continuation_of,n.conversation_id AS next_conversation,n.checkpoint_id AS next_checkpoint
   FROM wb_task_current_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id
   JOIN ga_runs p ON p.id=o.run_id JOIN ga_runs n ON n.id=?
   JOIN ga_conversations conversation ON conversation.id=n.conversation_id
   WHERE o.run_id=? AND t.owner_id=? AND conversation.owner_id=?`).get(runId,parentId,owner,owner) as Record<string,string|number|null>|undefined;
 if(!row)throw new Error('task_continuation_conflict');
 if(row.generation!==row.current_generation || !['active','budget_exhausted'].includes(String(row.task_status)))throw new Error('task_generation_revoked');
 if(!['failed','interrupted'].includes(String(row.parent_status)) || row.next_status!=='queued'
   || row.continuation_of!==parentId || row.next_conversation!==row.conversation_id
   || !row.parent_checkpoint || row.next_checkpoint!==row.parent_checkpoint)throw new Error('task_continuation_conflict');
 if(row.reason_code==='OUTCOME_UNKNOWN'||row.status==='outcome_unknown')throw new Error('reconciliation_required');
 const native=db.prepare(`SELECT 1 FROM wb_native_goal_bindings g JOIN ga_harness_session_bindings s ON s.conversation_id=?
   WHERE g.run_id=? AND g.occurrence_id=? AND s.owner_id=?`).get(row.conversation_id!,row.root_run_id!,row.occurrence_id!,owner);
 if(!native)throw new Error('task_checkpoint_unavailable');
 if(!savedSessionCheckpoint(db,parentId))throw new Error('task_checkpoint_unavailable');
 if(Number(db.prepare('SELECT count(*) n FROM wb_task_continuations WHERE occurrence_id=?').get(row.occurrence_id!)!.n)>=50)throw new Error('task_continuation_limit');
 if(db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN wb_task_run_occurrences o ON o.run_id=a.run_id
   WHERE o.occurrence_id=? AND a.state IN ('unknown','in_flight') LIMIT 1`).get(row.occurrence_id!))throw new Error('budget_usage_unknown');
 db.prepare('INSERT INTO wb_task_continuations VALUES(?,?,?,?)').run(runId,row.occurrence_id!,parentId,new Date().toISOString());
 return row;
}
