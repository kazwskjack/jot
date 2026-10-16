import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
export type TaskRunLimit=number|null;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=10000;
export function configuredTaskRunLimit(budget:unknown,fallback:TaskRunLimit=100):TaskRunLimit{
 if(budget===undefined)return fallback;
 if(!budget||typeof budget!=='object'||Array.isArray(budget)||Object.keys(budget).join(',')!=='max_runs')throw Error('invalid_budget');
 const value=(budget as Record<string,unknown>).max_runs;
 if(value===null||finite(value))return value;throw Error('invalid_budget');
}
export function storedTaskRunLimit(row:Record<string,unknown>):TaskRunLimit{
 if(row.run_limit_mode==='unlimited'&&row.max_runs===0)return null;
 if(row.run_limit_mode==='finite'&&finite(row.max_runs))return row.max_runs;
 throw Error('task_run_limit_unconfirmed');
}
export function taskRunLimitExhausted(row:Record<string,unknown>):boolean{
 const limit=storedTaskRunLimit(row);
 if(typeof row.runs_used!=='number'||!Number.isSafeInteger(row.runs_used)||row.runs_used<0)throw Error('task_run_limit_unconfirmed');
 return limit!==null&&row.runs_used>=limit;
}
export function encodedTaskRunLimit(limit:TaskRunLimit){return{mode:limit===null?'unlimited':'finite',maximum:limit===null?0:limit};}
/** Zero is a legacy admission fence, never a public unlimited value. */
export function installTaskRunLimits(db:DatabaseSync){withImmediateTransaction(db,()=>{
 if(!db.prepare('PRAGMA table_info(wb_persistent_tasks)').all().some(row=>row.name==='run_limit_mode'))db.exec("ALTER TABLE wb_persistent_tasks ADD COLUMN run_limit_mode TEXT NOT NULL DEFAULT 'finite'");
 const invalid=`NOT ((NEW.run_limit_mode='finite' AND typeof(NEW.max_runs)='integer' AND NEW.max_runs BETWEEN 1 AND 10000) OR (NEW.run_limit_mode='unlimited' AND NEW.max_runs=0))`;
 db.exec(`CREATE TRIGGER IF NOT EXISTS wb_task_run_limit_insert BEFORE INSERT ON wb_persistent_tasks WHEN ${invalid}
  BEGIN SELECT RAISE(ABORT,'task_run_limit_unconfirmed'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_run_limit_update BEFORE UPDATE OF max_runs,run_limit_mode ON wb_persistent_tasks WHEN ${invalid}
  BEGIN SELECT RAISE(ABORT,'task_run_limit_unconfirmed'); END;`);
});}
