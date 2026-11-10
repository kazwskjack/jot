import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createTerminalAttachments} from './terminal-attachments.js';
import {sessionHeaderIdentity} from './session-header-identity.js';
import {projectTerminalInventory} from '../gateway/src/terminal/inventory.js';
import {validateTerminalCommand,validateTerminalOptions,validateTerminalReceipt} from '../gateway/src/terminal/control.js';

/** Explicit user-terminal operations borrow the exact existing native Agent. */
export function createTerminalControl({readIdentity,terminalController,sessionController,sessionNotFoundError,agents,sessions,createPeer,gateway}) {
  const instances=new WeakMap();
  const receipts=new Map();
  const recoveries=new Map(),lifetime=new AbortController();
  const receiptKey=(ownerId,sessionId,command)=>JSON.stringify([ownerId,sessionId,command.request_id]);
  function trim() {
    let settled=[...receipts.values()].filter(record=>record.state!=='pending').length;
    for(const [key,record] of receipts) {
      if(settled<=256)break;
      if(record.state!=='pending'){receipts.delete(key);settled--;}
    }
  }
  function source(ownerId,sessionId,signal,expectedInstance) {
    signal.throwIfAborted();
    if(readIdentity().ownerId!==ownerId)throw Error('terminal_profile_forbidden');
    const controller=terminalController();
    const agent=agents.get(sessionId),session=sessions.get(sessionId);
    const check=(cancellable=true)=>{
      if(cancellable)signal.throwIfAborted();
      if(!agent||agent.id!==sessionId||agent.session!==session||session?.id!==sessionId
        ||agents.get(sessionId)!==agent||sessions.get(sessionId)!==session||terminalController()!==controller)
        throw Error('terminal_session_changed');
    };
    check();
    let generation=instances.get(agent);
    if(!generation||generation.controller!==controller){generation={controller,instance:randomUUID()};instances.set(agent,generation);}
    const hostInstance=generation.instance;
    if(expectedInstance!==undefined&&expectedInstance!==hostInstance)throw Error('terminal_host_changed');
    return {controller,agent,check,hostInstance};
  }
  const attachments=createTerminalAttachments({createPeer,gateway,authorize:(owner,session,instance,signal)=>source(owner,session,signal,instance)});
  async function options(ownerId,sessionId,signal) {
    const {controller,agent,check,hostInstance}=source(ownerId,sessionId,signal);
    if(typeof controller?.environment!=='function'||typeof controller.shells!=='function'||typeof controller.list!=='function')throw Error('terminal_control_unavailable');
    const environment=controller.environment(agent,signal),shells=await controller.shells(agent,signal);
    check();
    const inventory=projectTerminalInventory(sessionId,controller.list(sessionId));
    return validateTerminalOptions({protocol:1,session_id:sessionId,host_instance:hostInstance,inventory,environment,shells,execution_authorized:false},sessionId);
  }
  return Object.freeze({
    attach:attachments.attach,
    input:attachments.input,
    async dispose(){lifetime.abort();await attachments.close();},
    options,
    async recover(ownerId,sessionId,signal) {
      const active=AbortSignal.any([signal,lifetime.signal]);active.throwIfAborted();
      const identity=readIdentity();
      if(identity.ownerId!==ownerId)throw Error('terminal_profile_forbidden');
      if(agents.get(sessionId))return options(ownerId,sessionId,active);
      const controller=sessionController?.();
      if(typeof controller?.inspect!=='function'||typeof controller.resolveAgent!=='function')throw Error('terminal_control_unavailable');
      const key=JSON.stringify([ownerId,sessionId]);
      let record=recoveries.get(key);
      if(record&&(!isDeepStrictEqual(record.identity,identity)||record.controller!==controller))throw Error('terminal_session_changed');
      if(!record){
        if(recoveries.size>=32)throw Error('terminal_recovery_capacity');
        record={identity,controller,waiters:new Set()};recoveries.set(key,record);
        const check=()=>{
          lifetime.signal.throwIfAborted();
          if(!record.waiters.size)throw Error('terminal_recovery_cancelled');
          if(sessionController()!==controller||!isDeepStrictEqual(readIdentity(),identity))throw Error('terminal_session_changed');
        };
        const pending=Promise.resolve().then(async()=>{
          check();
          let saved;
          try{saved=await controller.inspect(sessionId,lifetime.signal);}
          catch(error){if(error?.code==='session/not-found'||typeof sessionNotFoundError==='function'&&error instanceof sessionNotFoundError)throw Error('terminal_session_not_found');throw error;}
          check();
          if(saved?.meta?.id!==sessionId||typeof saved.meta.cwd!=='string'||!saved.meta.cwd)throw Error('terminal_session_changed');
          const expected=sessionHeaderIdentity(saved.meta);
          const result=await controller.resolveAgent(sessionId);check();
          if(result?.error){
            if(result.error.code==='session/not-found')throw Error('terminal_session_not_found');
            if(['session/writer-held','session/agent-busy'].includes(result.error.code))throw Error('terminal_session_busy');
            throw Error('terminal_recovery_unavailable');
          }
          const agent=result?.agent;
          if(agent?.id!==sessionId||agent.session?.id!==sessionId||agents.get(sessionId)!==agent
            ||sessions.get(sessionId)!==agent.session||sessionHeaderIdentity(agent.session.header)!==expected)throw Error('terminal_session_changed');
        });
        const finish=(failed,error)=>{
          if(recoveries.get(key)===record)recoveries.delete(key);
          for(const waiter of record.waiters)failed?waiter.reject(error):waiter.resolve();
          record.waiters.clear();
        };
        void pending.then(()=>finish(false),error=>finish(true,error));
      }
      if(record.waiters.size>=32)throw Error('terminal_recovery_capacity');
      // Native resolution is shared and has no caller AbortSignal parameter.
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{record.waiters.delete(waiter);active.removeEventListener('abort',abort);};
        const waiter={resolve:()=>{cleanup();resolve();},reject:error=>{cleanup();reject(error);}};
        const abort=()=>waiter.reject(active.reason);
        record.waiters.add(waiter);
        active.addEventListener('abort',abort,{once:true});
        if(active.aborted)abort();
      });
      active.throwIfAborted();
      if(sessionController()!==controller||!isDeepStrictEqual(readIdentity(),identity))throw Error('terminal_session_changed');
      const result=await options(ownerId,sessionId,active);
      active.throwIfAborted();
      if(sessionController()!==controller||!isDeepStrictEqual(readIdentity(),identity))throw Error('terminal_session_changed');
      return result;
    },
    async command(ownerId,sessionId,input,signal) {
      const command=validateTerminalCommand(input);
      if(readIdentity().ownerId!==ownerId)throw Error('terminal_profile_forbidden');
      const key=receiptKey(ownerId,sessionId,command),previous=receipts.get(key);
      if(previous) {
        if(!isDeepStrictEqual(previous.command,command))throw Error('terminal_command_conflict');
        if(previous.state==='completed')return previous.inventory;
        if(previous.state==='unknown')throw Error('terminal_outcome_unknown');
        return previous.promise;
      }
      const {controller,agent,check}=source(ownerId,sessionId,signal,command.host_instance);
      if(typeof controller?.create!=='function'||typeof controller.close!=='function'||typeof controller.list!=='function')throw Error('terminal_control_unavailable');
      if([...receipts.values()].filter(record=>record.state==='pending').length>=32)throw Error('terminal_receipt_capacity');
      const record={command,state:'pending',inventory:null,promise:null};
      receipts.set(key,record);
      record.promise=Promise.resolve().then(async()=>{
        try {
          check();
          if(command.action==='create') {
            await controller.create(agent,{id:command.terminal_id,cols:command.cols,rows:command.rows,
              ...(command.shell_path!==null?{shellPath:command.shell_path}:{})},signal);
          } else {
            await controller.close(agent,command.terminal_id);
          }
          check(false);
          record.inventory=projectTerminalInventory(sessionId,controller.list(sessionId));
          record.state='completed';
          return record.inventory;
        }catch(error){record.state='unknown';throw error;}
        finally{record.promise=null;trim();}
      });
      return record.promise;
    },
    receipt(ownerId,sessionId,input,signal) {
      signal.throwIfAborted();
      const command=validateTerminalCommand(input);
      if(readIdentity().ownerId!==ownerId)throw Error('terminal_profile_forbidden');
      const record=receipts.get(receiptKey(ownerId,sessionId,command));
      if(record&&!isDeepStrictEqual(record.command,command))throw Error('terminal_command_conflict');
      return validateTerminalReceipt({protocol:1,session_id:sessionId,host_instance:command.host_instance,
        request_id:command.request_id,state:record?.state??'unknown',inventory:record?.inventory??null,
        rejection:null,execution_authorized:false},command,sessionId);
    },
  });
}
