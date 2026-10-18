/** Trusted Host-local ownership slot. It does not schedule, resolve an Agent,
 * grant inference or persist another task. The original engine owns execution. */
export function createChatCompactionRuntime(){
 const entries=new WeakMap();
 return Object.freeze({protocol:1,get:agent=>entries.get(agent),async withOperation(agent,entry,run){
  if(!agent||agent.id!==agent.session?.id||agent.session.header?.agentPreset!=='jot-chat'||entry?.attempt?.scope?.session_ref!==agent.id||entry.model?.reasoning_effort!=='off'||!(entry.signal instanceof AbortSignal)||typeof entry.check!=='function'||typeof entry.request!=='function'||typeof run!=='function'||entries.has(agent))throw Error('chat_compaction_operation_unconfirmed');
  entry.signal.throwIfAborted();entries.set(agent,entry);try{return await run();}finally{if(entries.get(agent)===entry)entries.delete(agent);}
 }});
}
