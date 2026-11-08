import type {DatabaseSync} from 'node:sqlite';

export const SESSION_BINDING_SCHEMA:Record<string,readonly string[]>={
  ga_conversations:['id','owner_id','workspace_id','next_seq','archived_at'],
  ga_harness_session_bindings:['conversation_id','owner_id','session_id','created_at','updated_at'],
  ga_conversation_mode_sessions:['conversation_id','owner_id','mode','session_id','created_at'],
  ga_runs:['id','conversation_id','status','version','created_at','updated_at',
    'native_session_ref','native_owner_id','native_conversation_id'],
  ga_run_native_sessions:['run_id','conversation_id','owner_id','session_id','created_at','updated_at'],
};

export const REQUIRED_SCHEMA:Record<string,readonly string[]>={
  ...SESSION_BINDING_SCHEMA,
  ga_events:['event_id','conversation_id','seq','run_id','type','payload_json','created_at'],
  ga_worker_leases:['resource_id','owner','generation','expires_at','updated_at'],
};

export function hasRequiredColumns(db:DatabaseSync,schema:Record<string,readonly string[]>):boolean{
  try{
    if(!db.isOpen||db.isTransaction)return false;
    for(const [name,requiredColumns] of Object.entries(schema)){
      const exists=db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name) as {present?:unknown}|undefined;
      if(exists?.present!==1)return false;
      const columns=new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{name?:unknown}>)
        .map(column=>column.name).filter((column):column is string=>typeof column==='string'));
      if(requiredColumns.some(column=>!columns.has(column)))return false;
    }
    return true;
  }catch{return false;}
}
