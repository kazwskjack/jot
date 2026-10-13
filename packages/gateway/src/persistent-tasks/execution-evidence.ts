import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

export type ExecutionEvidence = { kind: string; reference: string; hash?: string };

/** Receipts attest an operation actually executed; they do not judge its business acceptance criteria. */
export class TaskExecutionEvidence {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS wb_task_execution_receipts (
      receipt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_runs(id),call_id TEXT NOT NULL,
      operation TEXT NOT NULL,result_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,call_id));
      CREATE TRIGGER IF NOT EXISTS wb_execution_receipt_no_update BEFORE UPDATE ON wb_task_execution_receipts
        BEGIN SELECT RAISE(ABORT,'execution_receipt_immutable'); END;
      CREATE TABLE IF NOT EXISTS wb_task_file_execution_receipts (
        receipt_id TEXT PRIMARY KEY REFERENCES wb_task_execution_receipts(receipt_id),run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,path TEXT NOT NULL,
        version INTEGER NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,
        FOREIGN KEY(run_id,path,version) REFERENCES wb_file_write_runs(run_id,path,version));
      CREATE TRIGGER IF NOT EXISTS wb_task_file_receipt_no_update BEFORE UPDATE ON wb_task_file_execution_receipts
        BEGIN SELECT RAISE(ABORT,'file_execution_receipt_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_task_file_receipt_no_delete BEFORE DELETE ON wb_task_file_execution_receipts
        BEGIN SELECT RAISE(ABORT,'file_execution_receipt_immutable'); END;`);
    db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_web_evidence(receipt_id TEXT PRIMARY KEY REFERENCES wb_task_execution_receipts(receipt_id),result_json TEXT NOT NULL,byte_length INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS wb_task_reply_web_evidence_no_update BEFORE UPDATE ON wb_task_reply_web_evidence BEGIN SELECT RAISE(ABORT,'reply_evidence_immutable'); END;`);
  }

  record(runId: string, callId: string, operation: string, result: unknown): ExecutionEvidence {
    if(operation==='files.write'&&!this.db.isTransaction)throw new Error('file_execution_receipt_transaction_required');
    return withImmediateTransaction(this.db,()=>this.recordInside(runId,callId,operation,result));
  }

  private recordInside(runId: string, callId: string, operation: string, result: unknown): ExecutionEvidence {
    if (operation.startsWith('tasks.')) throw new Error('invalid_execution_evidence_operation');
    let file:Record<string,string|number>|undefined;
    if(operation==='files.write'){
      if(!this.db.isTransaction)throw new Error('file_execution_receipt_transaction_required');
      if(!result||typeof result!=='object')throw new Error('file_execution_output_unverified');
      const value=result as Record<string,unknown>;
      if(typeof value.path!=='string'||!Number.isSafeInteger(value.version)||typeof value.sha256!=='string'||!Number.isSafeInteger(value.size))throw new Error('file_execution_output_unverified');
      file=this.db.prepare(`SELECT w.* FROM wb_file_write_runs w
        JOIN wb_file_versions v ON v.owner_id=w.owner_id AND v.workspace_id=w.workspace_id AND v.project_id=w.project_id AND v.path=w.path AND v.version=w.version
        JOIN wb_run_bindings b ON b.run_id=w.run_id AND b.owner_id=w.owner_id
        WHERE w.run_id=? AND w.path=? AND w.version=? AND w.sha256=? AND w.size=?
        AND v.sha256=w.sha256 AND v.size=w.size
        AND json_extract(b.context_json,'$.workspace_id')=w.workspace_id AND json_extract(b.context_json,'$.project_id')=w.project_id`)
        .get(runId,value.path,value.version as number,value.sha256,value.size as number) as Record<string,string|number>|undefined;
      if(!file)throw new Error('file_execution_output_unverified');
    }
    const serialized=JSON.stringify(result);
    const hash = createHash('sha256').update(serialized).digest('hex');
    const reference = `proof-${randomUUID()}`;
    this.db.prepare('INSERT INTO wb_task_execution_receipts VALUES(?,?,?,?,?,?)')
      .run(reference, runId, callId, operation, hash, new Date().toISOString());
    if(file)this.db.prepare('INSERT INTO wb_task_file_execution_receipts VALUES(?,?,?,?,?,?,?,?,?)')
      .run(reference,runId,file.owner_id!,file.workspace_id!,file.project_id!,file.path!,file.version!,file.sha256!,file.size!);
    // Store only bounded autonomous web evidence, never every tool result.
    // Oversized results remain attested but cannot be used as full content proof.
    if(operation==='web.read'&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_reply_scopes'").get()){
      const scope=this.db.prepare("SELECT o.occurrence_id FROM wb_task_run_occurrences o JOIN wb_task_reply_scopes s ON s.occurrence_id=o.occurrence_id WHERE o.run_id=? AND json_extract(s.scope_json,'$.policy.mode')='bounded_auto_reply'").get(runId) as {occurrence_id:string}|undefined;
      const bytes=Buffer.byteLength(serialized,'utf8');if(scope&&bytes<=262144){
        const used=this.db.prepare('SELECT COALESCE(sum(w.byte_length),0) bytes FROM wb_task_reply_web_evidence w JOIN wb_task_execution_receipts e ON e.receipt_id=w.receipt_id JOIN wb_task_run_occurrences o ON o.run_id=e.run_id WHERE o.occurrence_id=?').get(scope.occurrence_id) as {bytes:number};
        if(used.bytes+bytes<=1048576)this.db.prepare('INSERT INTO wb_task_reply_web_evidence VALUES(?,?,?)').run(reference,serialized,bytes);
      }
    }
    return { kind: 'tool_receipt', reference, hash };
  }

  /** Owned untrusted source material for the later scope/risk verifier, not an
   * approval. Missing/oversized/legacy content is unavailable, never truncated. */
  replySources(owner:string,taskId:string,occurrenceId:string,refs:ExecutionEvidence[]):{available:boolean;reason?:string;sources:Array<{reference:string;operation:string;result:unknown}>}{
    const read=()=>{
      if(!Array.isArray(refs)||refs.length<1||refs.length>20||new Set(refs.map(ref=>ref?.reference)).size!==refs.length)throw new Error('reply_evidence_unverified');
      const sources:Array<{reference:string;operation:string;result:unknown}>=[];let bytes=0;
      for(const ref of refs){
        if(!ref||typeof ref.hash!=='string'||! /^[a-f0-9]{64}$/.test(ref.hash)||!this.verified(owner,taskId,ref,occurrenceId))throw new Error('reply_evidence_unverified');
        const row=this.db.prepare('SELECT e.operation,e.result_hash,w.result_json,w.byte_length FROM wb_task_execution_receipts e LEFT JOIN wb_task_reply_web_evidence w ON w.receipt_id=e.receipt_id WHERE e.receipt_id=?').get(ref.reference) as {operation:string;result_hash:string;result_json:string|null;byte_length:number|null};
        if(row.operation!=='web.read'||row.result_json===null)return {available:false,reason:'REPLY_EVIDENCE_CONTENT_MISSING',sources:[]};
        const size=Buffer.byteLength(row.result_json,'utf8');if(size!==row.byte_length||size>262144||createHash('sha256').update(row.result_json).digest('hex')!==row.result_hash)throw new Error('reply_evidence_content_corrupt');
        bytes+=size;if(bytes>1048576)return {available:false,reason:'REPLY_EVIDENCE_CONTENT_TOO_LARGE',sources:[]};
        const result=JSON.parse(row.result_json);
        if(result&&typeof result==='object'&&result.truncated===true)return {available:false,reason:'REPLY_EVIDENCE_TRUNCATED',sources:[]};
        sources.push({reference:ref.reference,operation:row.operation,result});
      }
      return {available:true,sources};
    };
    if(this.db.isTransaction)return read();this.db.exec('BEGIN');try{const value=read();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  verified(owner: string, taskId: string, ref: ExecutionEvidence, occurrenceId?: string): boolean {
    if (ref.kind !== 'tool_receipt' || typeof ref.reference !== 'string') return false;
    let row = this.db.prepare(`SELECT e.result_hash,o.occurrence_id FROM wb_task_execution_receipts e
      JOIN wb_task_run_occurrences o ON o.run_id=e.run_id JOIN wb_persistent_tasks t ON t.task_id=o.task_id
      WHERE e.receipt_id=? AND t.owner_id=? AND t.task_id=?`).get(ref.reference, owner, taskId) as
      {result_hash: string; occurrence_id: string} | undefined;
    // Immutable execution lineage attests member material, not parent completion.
    // This read remains valid after the lead changes a step; active authority is
    // checked at execution, and historical receipts must not be rewritten.
    if(!row&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_child_runs'").get()){
      row=this.db.prepare(`SELECT e.result_hash,n.occurrence_id FROM wb_task_execution_receipts e
        JOIN wb_native_execution_runs n ON n.run_id=e.run_id JOIN wb_persistent_tasks t ON t.task_id=n.task_id AND t.owner_id=n.owner_id
        WHERE e.receipt_id=? AND n.owner_id=? AND t.task_id=? AND json_type(n.snapshot_json,'$.task_assignment.subtask_id')='text'`)
        .get(ref.reference,owner,taskId) as {result_hash:string;occurrence_id:string}|undefined;
    }
    return !!row && (occurrenceId === undefined || occurrenceId === row.occurrence_id)
      && (ref.hash === undefined || ref.hash === row.result_hash);
  }

  completionVerified(owner:string,taskId:string,refs:ExecutionEvidence[],occurrenceId?:string):boolean {
    const verified=(ref:ExecutionEvidence)=>this.verified(owner,taskId,ref,occurrenceId);
    return refs.some(verified) && !refs.some(ref=>ref.kind==='tool_receipt'&&!verified(ref));
  }
}
