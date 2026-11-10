import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {validateTerminalCommand,validateTerminalReceipt,type TerminalCommand,type TerminalReceipt} from './control.js';
import {validateTerminalInventory} from './inventory.js';

type TerminalWaitReceipt={operation:string;receipt:TerminalReceipt};

export function installTerminalWaitReceipts(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS ga_terminal_wait_receipts(
    owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,command_json TEXT NOT NULL,
    session_id TEXT NOT NULL,original_operation TEXT NOT NULL,receipt_json TEXT NOT NULL,ended_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,run_id,request_id));
    CREATE TRIGGER IF NOT EXISTS ga_terminal_wait_receipt_immutable BEFORE UPDATE ON ga_terminal_wait_receipts
      BEGIN SELECT RAISE(ABORT,'terminal_wait_receipt_immutable'); END;`);
}

export function terminalCommandHash(command:TerminalCommand) {
  return createHash('sha256').update(canonicalJson(validateTerminalCommand(command))).digest('hex');
}

export function readTerminalWaitReceipt(db:DatabaseSync,owner:string,conversationId:string,runId:string,command:TerminalCommand):TerminalWaitReceipt|undefined {
  const row=db.prepare(`SELECT conversation_id,request_sha256,command_json,session_id,original_operation,receipt_json
    FROM ga_terminal_wait_receipts WHERE owner_id=? AND run_id=? AND request_id=?`)
    .get(owner,runId,command.request_id) as {
      conversation_id:string;request_sha256:string;command_json:string;session_id:string;original_operation:string;receipt_json:string;
    }|undefined;
  if(!row)return;
  if(row.conversation_id!==conversationId||row.request_sha256!==terminalCommandHash(command)
    ||row.command_json!==canonicalJson(command))throw Error('terminal_receipt_conflict');
  const operation=/^POST \/v1\/conversations\/([^/]+)\/runs\/([^/]+)\/terminals\/commands$/.exec(row.original_operation);
  if(!operation||decodeURIComponent(operation[1]!)!==conversationId||decodeURIComponent(operation[2]!)!==runId)
    throw Error('terminal_receipt_conflict');
  const receipt=validateTerminalReceipt(JSON.parse(row.receipt_json),command,row.session_id);
  if(!['completed','rejected','wait_ended_unknown'].includes(receipt.state))throw Error('terminal_receipt_invalid');
  return {operation:row.original_operation,receipt};
}

/** Replaying an observed result cannot dispatch the original operation again. */
export function replayTerminalWaitReceipt(db:DatabaseSync,owner:string,command:TerminalCommand,ended:TerminalWaitReceipt) {
  const row=db.prepare(`SELECT request_sha256,response_status,response_json,receipt_protocol FROM ga_idempotency
    WHERE owner_id=? AND operation=? AND idempotency_key=?`).get(owner,ended.operation,command.request_id) as {
      request_sha256:string;response_status:number|null;response_json:string|null;receipt_protocol:string|null;
    }|undefined;
  if(row&&(row.request_sha256!==terminalCommandHash(command)||row.receipt_protocol!==null))throw Error('terminal_receipt_conflict');
  if(row&&row.response_status!==null) {
    try {
      const body=JSON.parse(row.response_json!);
      if(row.response_status===200)return {status:200,body:validateTerminalInventory(body,ended.receipt.session_id)};
      if(row.response_status>=400&&row.response_status<500&&row.response_status!==408
        &&typeof body?.error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(body.error.code)
        &&body.error.code!=='IDEMPOTENCY_IN_PROGRESS')return {status:row.response_status,body};
    }catch{ /* The immutable closure still blocks dispatch if the old response is unverifiable. */ }
  }
  if(ended.receipt.state==='completed')return {status:200,body:ended.receipt.inventory};
  if(ended.receipt.state==='rejected')return {status:ended.receipt.rejection!.status,body:{error:{code:ended.receipt.rejection!.error_code}}};
  return {status:409,body:{error:{code:'TERMINAL_WAIT_ENDED_UNKNOWN'}}};
}

/** Called inside the original immediate transaction after ownership is rechecked. */
export function saveTerminalWaitReceipt(db:DatabaseSync,owner:string,conversationId:string,runId:string,
  command:TerminalCommand,operation:string,receipt:TerminalReceipt) {
  const value=validateTerminalReceipt(receipt,command,receipt.session_id);
  if(!['completed','rejected','wait_ended_unknown'].includes(value.state))throw Error('terminal_receipt_invalid');
  db.prepare(`INSERT INTO ga_terminal_wait_receipts
    (owner_id,conversation_id,run_id,request_id,request_sha256,command_json,session_id,original_operation,receipt_json,ended_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(owner,conversationId,runId,command.request_id,terminalCommandHash(command),
      canonicalJson(command),value.session_id,operation,JSON.stringify(value),new Date().toISOString());
  return value;
}
