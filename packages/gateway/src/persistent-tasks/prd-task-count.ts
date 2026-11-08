import type {DatabaseSync} from 'node:sqlite';

export function installPrdTaskCounts(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_task_counts(
  binding_id TEXT PRIMARY KEY REFERENCES wb_task_prd_bindings(binding_id),num_tasks INTEGER NOT NULL CHECK(num_tasks>0 AND num_tasks<=9007199254740991));
 CREATE TRIGGER IF NOT EXISTS wb_prd_task_count_no_update BEFORE UPDATE ON wb_task_prd_task_counts BEGIN SELECT RAISE(ABORT,'prd_task_count_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_task_count_no_delete BEFORE DELETE ON wb_task_prd_task_counts BEGIN SELECT RAISE(ABORT,'prd_task_count_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_task_count_no_replace BEFORE INSERT ON wb_task_prd_task_counts WHEN EXISTS(SELECT 1 FROM wb_task_prd_task_counts WHERE binding_id=NEW.binding_id)
 BEGIN SELECT RAISE(ABORT,'prd_task_count_immutable'); END;`);
}
export function prdTaskCountInput(value:unknown):number|undefined{
 if(value===undefined)return undefined;
 if(!Number.isSafeInteger(value)||Number(value)<1)throw Error('invalid_prd_task_count');
 return value as number;
}
export function readPrdTaskCount(db:DatabaseSync,bindingId:string):number|undefined{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_prd_task_counts' AND type='table'").get())return undefined;
 const row=db.prepare('SELECT num_tasks FROM wb_task_prd_task_counts WHERE binding_id=?').get(bindingId) as {num_tasks:number}|undefined;
 return prdTaskCountInput(row?.num_tasks);
}
export function prdTaskCountInstructions(numTasks:number|undefined):string{
 return numTasks===undefined?'':`\n用户已确认期望原生子任务数 ${numTasks}。完整读取固定 PRD，使用原 tasks.upsert 建立该数量的真实原生子任务及依赖。tasks.prd.plan 会核对本批原生子任务账本数量。资料不足或原预算不足时说明阻塞，不能省略原文要求、伪造子任务或新增额度。\n`;
}
