import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createTerminalAttachments} from './terminal-attachments.js';
import {projectTerminalInventory} from '../gateway/src/terminal/inventory.js';
import {validateTerminalCommand,validateTerminalOptions,validateTerminalReceipt} from '../gateway/src/terminal/control.js';

/** Explicit user-terminal operations borrow the exact existing native Agent. */
export function createTerminalControl({readIdentity,terminalController,agents,sessions,createPeer,gateway}) {
  const instances=new WeakMap();
  const receipts=new Map();
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
  return Object.freeze({
    attach:attachments.attach,
    input:attachments.input,
    dispose:attachments.close,
    async options(ownerId,sessionId,signal) {
      const {controller,agent,check,hostInstance}=source(ownerId,sessionId,signal);
      if(typeof controller?.environment!=='function'||typeof controller.shells!=='function'||typeof controller.list!=='function')throw Error('terminal_control_unavailable');
      const environment=controller.environment(agent,signal),shells=await controller.shells(agent,signal);
      check();
      const inventory=projectTerminalInventory(sessionId,controller.list(sessionId));
      return validateTerminalOptions({protocol:1,session_id:sessionId,host_instance:hostInstance,inventory,environment,shells,execution_authorized:false},sessionId);
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
