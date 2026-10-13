import type {DatabaseSync} from 'node:sqlite';

export type ExecutionLease = Readonly<{owner:string;generation:number}>;
const rejected=()=>new Error('workbench_execution_lease_revoked');

/** Trusted Worker metadata only; a fence cannot acquire or renew execution. */
export function normalizeExecutionLease(value:unknown):ExecutionLease {
  if(!value||typeof value!=='object'||Array.isArray(value))throw rejected();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).some(key=>!['owner','generation'].includes(key))
    ||typeof row.owner!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row.owner)
    ||!Number.isSafeInteger(row.generation)||Number(row.generation)<1)throw rejected();
  return Object.freeze({owner:row.owner,generation:Number(row.generation)});
}

export function assertExecutionLease(db:DatabaseSync,runId:string,expected:unknown,now:()=>number=Date.now):ExecutionLease {
  const original=normalizeExecutionLease(expected);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_child_runs'").get()){
    const child=db.prepare('SELECT root_run_id,snapshot_json FROM wb_native_execution_runs WHERE run_id=?').get(runId) as {root_run_id:string;snapshot_json:string}|undefined;
    if(child){
      const saved=normalizeExecutionLease(JSON.parse(child.snapshot_json).execution_lease);
      if(child.root_run_id===runId||saved.owner!==original.owner||saved.generation!==original.generation
        ||db.prepare('SELECT 1 FROM wb_native_execution_runs WHERE run_id=?').get(child.root_run_id))throw rejected();
      return assertExecutionLease(db,child.root_run_id,original,now);
    }
  }
  const current=db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(runId);
  const expiry=Number(current?.expires_at);
  if(!current||current.owner!==original.owner||current.generation!==original.generation
    ||!Number.isSafeInteger(expiry)||expiry<=now())throw rejected();
  return original;
}
