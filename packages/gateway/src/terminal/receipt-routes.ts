import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {readOwnedTerminalSession} from './inventory-routes.ts';
import type {TerminalControlClient} from './control-routes.ts';
import {validateTerminalInventory} from './inventory.js';
import {validateTerminalCommand,validateTerminalReceipt,type TerminalCommand,type TerminalReceipt} from './control.js';
import {installTerminalWaitReceipts,readTerminalWaitReceipt,saveTerminalWaitReceipt,terminalCommandHash} from './wait-receipts.ts';

type OriginalReceipt={operation:string;request_sha256:string;response_status:number|null;response_json:string|null;receipt_protocol:string|null};

/** Old callers may have used a different equivalent URL encoding. */
function originalReceipts(db:DatabaseSync,owner:string,conversationId:string,runId:string,key:string,operation?:string) {
  const rows=db.prepare(`SELECT operation,request_sha256,response_status,response_json,receipt_protocol
    FROM ga_idempotency WHERE owner_id=? AND idempotency_key=?${operation===undefined?'':' AND operation=?'}`)
    .all(...(operation===undefined?[owner,key]:[owner,key,operation])) as OriginalReceipt[];
  const matches=rows.filter(row=>{
    const path=/^POST \/v1\/conversations\/([^/]+)\/runs\/([^/]+)\/terminals\/commands$/.exec(row.operation);
    try{return path&&decodeURIComponent(path[1]!)===conversationId&&decodeURIComponent(path[2]!)===runId;}
    catch{return false;}
  });
  return matches;
}

function project(command:TerminalCommand,sessionId:string,state:TerminalReceipt['state'],inventory:unknown=null,rejection:unknown=null) {
  return validateTerminalReceipt({protocol:1,session_id:sessionId,host_instance:command.host_instance,
    request_id:command.request_id,state,inventory,rejection,execution_authorized:false},command,sessionId);
}

function stored(row:OriginalReceipt,command:TerminalCommand,sessionId:string) {
  if(row.response_status===200)return project(command,sessionId,'completed',validateTerminalInventory(JSON.parse(row.response_json!),sessionId));
  if(row.response_status!==null&&row.response_status>=400&&row.response_status<500&&row.response_status!==408) {
    const value=JSON.parse(row.response_json!),code=value?.error?.code;
    if(code==='TERMINAL_WAIT_ENDED_UNKNOWN')return project(command,sessionId,'wait_ended_unknown');
    if(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(code)&&code!=='IDEMPOTENCY_IN_PROGRESS')
      return project(command,sessionId,'rejected',null,{status:row.response_status,error_code:code});
  }
  return project(command,sessionId,'unknown');
}

export function registerTerminalReceiptRoutes(app:FastifyInstance,options:{
  db:DatabaseSync;actor(request:{headers:Record<string,unknown>}):string;client?:TerminalControlClient|undefined;
}) {
  const {db,actor,client}=options;
  installTerminalWaitReceipts(db);
  async function handle(request:FastifyRequest,reply:FastifyReply,endWait:boolean) {
    reply.header('cache-control','private, no-store');
    const abort=new AbortController(),disconnected=()=>abort.abort();
    request.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    if(request.raw.aborted||reply.raw.destroyed)disconnected();
    try {
      const owner=actor(request),{conversationId,runId,requestId}=request.params as {conversationId:string;runId:string;requestId:string};
      const command=validateTerminalCommand(request.body),id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
      if(!id.test(conversationId)||!id.test(runId)||requestId!==command.request_id
        ||request.headers['idempotency-key']!==requestId||Object.keys(request.query as object).length)throw Error('terminal_command_invalid');
      const expectedHash=terminalCommandHash(command);
      const inspect=()=>{
        const binding=readOwnedTerminalSession(db,owner,conversationId,runId);
        if(!binding)throw Error('terminal_receipt_scope_missing');
        const ended=readTerminalWaitReceipt(db,owner,conversationId,runId,command);
        const rows=originalReceipts(db,owner,conversationId,runId,requestId,ended?.operation);
        if(rows.some(row=>row.request_sha256!==expectedHash||row.receipt_protocol!==null)
          ||rows.length>1&&!endWait)throw Error('terminal_receipt_conflict');
        return {binding,ended,row:rows.length===1?rows[0]:undefined};
      };
      const before=withReadTransaction(db,inspect),sessionId=before.ended?.receipt.session_id??before.binding.session_id;
      if(endWait)return withImmediateTransaction(db,()=>{
        const current=inspect();
        if(current.ended)return current.ended.receipt;
        let resolution=project(command,current.binding.session_id,'wait_ended_unknown');
        if(current.row&&current.row.response_status!==null) {
          // Unverifiable historical responses retain an unknown closure snapshot.
          try{const known=stored(current.row,command,current.binding.session_id);
            if(known.state==='completed'||known.state==='rejected')resolution=known;
          }catch{}
        }
        const operation=current.row?.operation??`POST /v1/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/terminals/commands`;
        return saveTerminalWaitReceipt(db,owner,conversationId,runId,command,operation,resolution);
      });
      if(before.row&&before.row.response_status!==null) {
        try{return stored(before.row,command,sessionId);}
        catch(error){if(before.ended)return before.ended.receipt;throw error;}
      }
      if(!before.row)return before.ended?.receipt??project(command,sessionId,'not_admitted');
      if(before.ended&&before.ended.receipt.state!=='wait_ended_unknown')return before.ended.receipt;
      if(typeof client?.terminalReceipt!=='function')return before.ended?.receipt??project(command,sessionId,'unknown');
      const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]);
      let observation:TerminalReceipt;
      try{observation=validateTerminalReceipt(await client.terminalReceipt(owner,sessionId,command,signal),command,sessionId);}
      catch{return before.ended?.receipt??project(command,sessionId,'unknown');}
      signal.throwIfAborted();
      if(!['pending','completed','unknown'].includes(observation.state))throw Error('terminal_receipt_invalid');
      return withImmediateTransaction(db,()=>{
        const current=inspect();
        if(current.binding.session_id!==sessionId||!current.row)return current.ended?.receipt??project(command,sessionId,'unknown');
        if(current.row.response_status!==null)return stored(current.row,command,sessionId);
        if(observation.state==='completed') {
          const updated=db.prepare(`UPDATE ga_idempotency SET response_status=200,response_json=?
            WHERE owner_id=? AND operation=? AND idempotency_key=? AND request_sha256=?
            AND response_status IS NULL AND receipt_protocol IS NULL`).run(JSON.stringify(observation.inventory),
              owner,current.row.operation,requestId,expectedHash);
          if(updated.changes!==1)throw Error('terminal_receipt_conflict');
        }
        return observation.state==='completed'?observation:current.ended?.receipt??observation;
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
  }
  const path='/v1/conversations/:conversationId/runs/:runId/terminals/commands/:requestId';
  const routeOptions={config:{terminalReceiptReconciliation:true},bodyLimit:1048576};
  app.post(path+'/reconcile',routeOptions,(request,reply)=>handle(request,reply,false));
  app.post(path+'/end-wait',routeOptions,(request,reply)=>handle(request,reply,true));
}
