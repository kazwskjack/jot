import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {verifiedTaskExecutionEvidence,type ExecutionEvidence} from './execution-evidence.ts';

export function installPrdResearch(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_research_bindings(binding_id TEXT PRIMARY KEY REFERENCES wb_task_prd_bindings(binding_id));
 CREATE TRIGGER IF NOT EXISTS wb_prd_research_no_update BEFORE UPDATE ON wb_task_prd_research_bindings BEGIN SELECT RAISE(ABORT,'prd_research_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_research_no_delete BEFORE DELETE ON wb_task_prd_research_bindings BEGIN SELECT RAISE(ABORT,'prd_research_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_research_no_replace BEFORE INSERT ON wb_task_prd_research_bindings WHEN EXISTS(SELECT 1 FROM wb_task_prd_research_bindings WHERE binding_id=NEW.binding_id)
 BEGIN SELECT RAISE(ABORT,'prd_research_immutable'); END;`);
}
export function readPrdResearch(db:DatabaseSync,bindingId:string):boolean{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_prd_research_bindings' AND type='table'").get())return false;
 return !!db.prepare('SELECT 1 FROM wb_task_prd_research_bindings WHERE binding_id=?').get(bindingId);
}
export function prdResearchInstructions(enabled:boolean|undefined):string{
 return enabled?'\n用户已确认研究模式。沿原工具权限及累计预算，使用 web.read 或 files.read 读取本批研究资料，并在 tasks.prd.plan 的 evidence 中引用实际资料读取回执。原 PRD 仍需完整分段读取。研究资料会按原 owner、任务、执行批次和结果哈希核对，计划保留 research_evidence 供审阅。资料不足或原权限/预算不足时说明阻塞并请求补充。\n':'';
}
/** Actual same-occurrence source IO, including originally assigned members.
 * The attestation proves reading, while owner review evaluates the findings. */
export function isPrdResearchEvidence(db:DatabaseSync,owner:string,taskId:string,occurrenceId:string,source:Record<string,unknown>,ref:ExecutionEvidence):boolean{
 if(!verifiedTaskExecutionEvidence(db,owner,taskId,ref,occurrenceId))return false;
 const row=db.prepare(`SELECT e.operation,e.result_hash,w.response_json FROM wb_task_execution_receipts e
  JOIN wb_tool_receipts w ON w.run_id=e.run_id AND w.call_id=e.call_id WHERE e.receipt_id=?`).get(ref.reference) as {operation:string;result_hash:string;response_json:string}|undefined;
 if(!row||!['web.read','files.read'].includes(row.operation))return false;
 const {execution_receipt,...result}=JSON.parse(row.response_json);
 if(canonicalJson(execution_receipt)!==canonicalJson(ref)||row.result_hash!==ref.hash
  ||createHash('sha256').update(JSON.stringify(result)).digest('hex')!==row.result_hash)throw Error('prd_work_plan_research_unverified');
 if(row.operation==='web.read')return result.mode==='public_http'&&result.trusted===false&&typeof result.text==='string'&&!!result.text.trim();
 return typeof result.content==='string'&&!!result.content.trim()&&typeof result.path==='string'&&Number.isSafeInteger(result.version)&&result.version>0
  &&!(source.kind==='logical_file'&&source.path===result.path&&source.version===result.version)
  &&createHash('sha256').update(result.content,'utf8').digest('hex')!==source.sha256;
}
