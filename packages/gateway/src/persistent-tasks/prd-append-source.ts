import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {readTaskSubtasks} from './subtask-state.ts';

export type PrdAppendSource={task_count:number;sha256:string;subtasks:ReturnType<typeof readTaskSubtasks>};
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function installPrdAppendSources(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_append_sources(binding_id TEXT PRIMARY KEY REFERENCES wb_task_prd_bindings(binding_id),ledger_sha256 TEXT NOT NULL,ledger_json TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_prd_append_no_update BEFORE UPDATE ON wb_task_prd_append_sources BEGIN SELECT RAISE(ABORT,'prd_append_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_append_no_delete BEFORE DELETE ON wb_task_prd_append_sources BEGIN SELECT RAISE(ABORT,'prd_append_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_append_no_replace BEFORE INSERT ON wb_task_prd_append_sources WHEN EXISTS(SELECT 1 FROM wb_task_prd_append_sources WHERE binding_id=NEW.binding_id)
 BEGIN SELECT RAISE(ABORT,'prd_append_immutable'); END;`);
}
export function prdAppendPreview(db:DatabaseSync,taskId:string):PrdAppendSource{
 const subtasks=readTaskSubtasks(db,taskId);
 if(Buffer.byteLength(canonicalJson(subtasks),'utf8')>4194304)throw Error('invalid_prd_append_source_too_large');
 return {task_count:subtasks.length,sha256:digest(subtasks),subtasks};
}
export function readPrdAppendSource(db:DatabaseSync,bindingId:string):PrdAppendSource|undefined{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_prd_append_sources' AND type='table'").get())return undefined;
 const row=db.prepare('SELECT ledger_json,ledger_sha256 FROM wb_task_prd_append_sources WHERE binding_id=?').get(bindingId) as {ledger_json:string;ledger_sha256:string}|undefined;
 if(!row)return undefined;
 try{
  if(Buffer.byteLength(row.ledger_json,'utf8')>4194304)throw Error();
  const subtasks=JSON.parse(row.ledger_json);
  if(!Array.isArray(subtasks)||canonicalJson(subtasks)!==row.ledger_json||digest(subtasks)!==row.ledger_sha256)throw Error();
  return {task_count:subtasks.length,sha256:row.ledger_sha256,subtasks};
 }catch{throw Error('prd_append_source_integrity_failed');}
}
export function prdAppendInstructions(source:PrdAppendSource|undefined):string{
 return source===undefined?'':`\n用户已确认追加模式。原账本基线 ${source.task_count} 项，SHA-256 ${source.sha256}。先用原 tasks.subtasks 读取原生子任务，保留基线中的原生 ID、标题、验收条件、优先级及依赖，在同一原任务新增 PRD 所需步骤。原状态与证据属于历史来源，新批次继续按原规则核对。tasks.prd.plan 会核对基线保留。期望任务数如有指定，表示新增项数量。\n`;
}
export function assertPrdAppendLedger(source:PrdAppendSource|undefined,subtasks:ReturnType<typeof readTaskSubtasks>){
 if(!source)return;
 const current=new Map(subtasks.map(task=>[task.subtask_id,task]));
 const definition=(task:PrdAppendSource['subtasks'][number])=>({subtask_id:task.subtask_id,task_id:task.task_id,title:task.title,acceptance:task.acceptance,priority:task.priority,dependencies:task.dependencies});
 for(const task of source.subtasks){
  const retained=current.get(task.subtask_id);
  if(!retained||canonicalJson(definition(task))!==canonicalJson(definition(retained)))throw Error('prd_work_plan_append_changed');
 }
}
