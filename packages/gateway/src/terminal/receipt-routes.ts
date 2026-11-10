import type {FastifyInstance} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {readOwnedTerminalSession} from './inventory-routes.ts';
import type {TerminalControlClient} from './control-routes.ts';
import {validateTerminalInventory} from './inventory.js';
import {validateTerminalCommand,validateTerminalReceipt,type TerminalCommand,type TerminalReceipt} from './control.js';

type OriginalReceipt={operation:string;request_sha256:string;response_status:number|null;response_json:string|null;receipt_protocol:string|null};

/** Old callers may have used a different equivalent URL encoding. */
function originalReceipt(db:DatabaseSync,owner:string,conversationId:string,runId:string,key:string) {
  const rows=db.prepare(`SELECT operation,request_sha256,response_status,response_json,receipt_protocol
    FROM ga_idempotency WHERE owner_id=? AND idempotency_key=?`).all(owner,key) as OriginalReceipt[];
  const matches=rows.filter(row=>{
    const path=/^POST \/v1\/conversations\/([^/]+)\/runs\/([^/]+)\/terminals\/commands$/.exec(row.operation);
    try{return path&&decodeURIComponent(path[1]!)===conversationId&&decodeURIComponent(path[2]!)===runId;}
    catch{return false;}
  });
  if(matches.length>1)throw Error('terminal_receipt_conflict');
  return matches[0];
}

function project(command:TerminalCommand,sessionId:string,state:TerminalReceipt['state'],inventory:unknown=null,rejection:unknown=null) {
  return validateTerminalReceipt({protocol:1,session_id:sessionId,host_instance:command.host_instance,
    request_id:command.request_id,state,inventory,rejection,execution_authorized:false},command,sessionId);
}

function stored(row:OriginalReceipt,command:TerminalCommand,sessionId:string) {
  if(row.response_status===200)return project(command,sessionId,'completed',validateTerminalInventory(JSON.parse(row.response_json!),sessionId));
  if(row.response_status!==null&&row.response_status>=400&&row.response_status<500&&row.response_status!==408) {
    const value=JSON.parse(row.response_json!),code=value?.error?.code;
    if(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(code)&&code!=='IDEMPOTENCY_IN_PROGRESS')
      return project(command,sessionId,'rejected',null,{status:row.response_status,error_code:code});
  }
  return project(command,sessionId,'unknown');
}

export function registerTerminalReceiptRoutes(app:FastifyInstance,options:{
  db:DatabaseSync;actor(request:{headers:Record<string,unknown>}):string;client?:TerminalControlClient|undefined;
}) {
  const {db,actor,client}=options;
  app.post('/v1/conversations/:conversationId/runs/:runId/terminals/commands/:requestId/reconcile',
    {config:{terminalReceiptReconciliation:true},bodyLimit:1048576},async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const abort=new AbortController(),disconnected=()=>abort.abort();
    request.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    if(request.raw.aborted||reply.raw.destroyed)disconnected();
    try {
      const owner=actor(request),{conversationId,runId,requestId}=request.params as {conversationId:string;runId:string;requestId:string};
      const command=validateTerminalCommand(request.body),id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
      if(!id.test(conversationId)||!id.test(runId)||requestId!==command.request_id
        ||request.headers['idempotency-key']!==requestId||Object.keys(request.query as object).length)throw Error('terminal_command_invalid');
      const expectedHash=createHash('sha256').update(canonicalJson(command)).digest('hex');
      const inspect=()=>{
        const binding=readOwnedTerminalSession(db,owner,conversationId,runId);
        if(!binding)throw Error('terminal_receipt_scope_missing');
        const row=originalReceipt(db,owner,conversationId,runId,requestId);
        if(row&&(row.request_sha256!==expectedHash||row.receipt_protocol!==null))throw Error('terminal_receipt_conflict');
        return {binding,row};
      };
      const before=withReadTransaction(db,inspect),sessionId=before.binding.session_id;
      if(!before.row)return project(command,sessionId,'not_admitted');
      if(before.row.response_status!==null)return stored(before.row,command,sessionId);
      if(typeof client?.terminalReceipt!=='function')return project(command,sessionId,'unknown');
      const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]);
      let observation:TerminalReceipt;
      try{observation=validateTerminalReceipt(await client.terminalReceipt(owner,sessionId,command,signal),command,sessionId);}
      catch{return project(command,sessionId,'unknown');}
      signal.throwIfAborted();
      if(!['pending','completed','unknown'].includes(observation.state))throw Error('terminal_receipt_invalid');
      return withImmediateTransaction(db,()=>{
        const current=inspect();
        if(current.binding.session_id!==sessionId||!current.row)return project(command,sessionId,'unknown');
        if(current.row.response_status!==null)return stored(current.row,command,sessionId);
        if(observation.state==='completed') {
          const updated=db.prepare(`UPDATE ga_idempotency SET response_status=200,response_json=?
            WHERE owner_id=? AND operation=? AND idempotency_key=? AND request_sha256=?
            AND response_status IS NULL AND receipt_protocol IS NULL`).run(JSON.stringify(observation.inventory),
              owner,current.row.operation,requestId,expectedHash);
          if(updated.changes!==1)throw Error('terminal_receipt_conflict');
        }
        return observation;
      });
    } catch(error) {
      const code=(error as Error)?.message;
      if(code==='unauthorized')return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
      if(code==='terminal_command_invalid')return reply.code(422).send({error:{code:'TERMINAL_INPUT_INVALID'}});
      if(code==='terminal_receipt_conflict')return reply.code(409).send({error:{code:'TERMINAL_RECEIPT_CONFLICT'}});
      return reply.code(503).send({error:{code:'TERMINAL_RECEIPT_UNAVAILABLE'}});
    } finally {
      request.raw.off('aborted',disconnected);reply.raw.off('close',disconnected);
    }
  });
}
