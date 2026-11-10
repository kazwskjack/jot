import {randomUUID} from 'node:crypto';
import {projectTerminalInventory} from '../gateway/src/terminal/inventory.js';
import {validateTerminalCommand,validateTerminalOptions} from '../gateway/src/terminal/control.js';

/** Explicit user-terminal operations borrow the exact existing native Agent. */
export function createTerminalControl({readIdentity,terminalController,agents,sessions}) {
  let selectedController,instance=randomUUID();
  function source(ownerId,sessionId,signal,expectedInstance) {
    signal.throwIfAborted();
    if(readIdentity().ownerId!==ownerId)throw Error('terminal_profile_forbidden');
    const controller=terminalController();
    if(controller!==selectedController){selectedController=controller;instance=randomUUID();}
    if(expectedInstance!==undefined&&expectedInstance!==instance)throw Error('terminal_host_changed');
    const hostInstance=instance,agent=agents.get(sessionId),session=sessions.get(sessionId);
    const check=()=>{
      signal.throwIfAborted();
      if(!agent||agent.id!==sessionId||agent.session!==session||session?.id!==sessionId
        ||agents.get(sessionId)!==agent||sessions.get(sessionId)!==session||terminalController()!==controller)
        throw Error('terminal_session_changed');
    };
    check();
    return {controller,agent,check,hostInstance};
  }
  return Object.freeze({
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
      const {controller,agent,check}=source(ownerId,sessionId,signal,command.host_instance);
      if(typeof controller?.create!=='function'||typeof controller.close!=='function'||typeof controller.list!=='function')throw Error('terminal_control_unavailable');
      if(command.action==='create') {
        await controller.create(agent,{id:command.terminal_id,cols:command.cols,rows:command.rows,
          ...(command.shell_path!==null?{shellPath:command.shell_path}:{})},signal);
      } else {
        await controller.close(agent,command.terminal_id);
      }
      check();
      return projectTerminalInventory(sessionId,controller.list(sessionId));
    },
  });
}
