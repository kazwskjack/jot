import {captureNativeHandoffQuiescence} from './native-child-closure.js';
/** Trusted host transition only. Never wait for a busy lead from its own tool. */
export async function withNativeHandoffBarrier(input,operation){
 const agent=input?.agent,session=agent?.session,signal=input?.signal;
 if(typeof operation!=='function'||agent?.status!=='idle'||input.registry?.get(agent.id)!==agent
  ||typeof agent.ctx?.tools?.guard!=='function'||typeof agent.ctx?.on!=='function')throw Error('native_handoff_not_idle');
 const count=session.seq;let removeModel;const removeTool=agent.ctx.tools.guard(()=> 'NATIVE_HANDOFF_PENDING');
 try{
  removeModel=agent.ctx.on('llm/stream',(options,next)=>{if(options?.sessionId===agent.id)throw Error('native_handoff_pending');return next();},{prepend:true});
  const check=()=>{
   signal?.throwIfAborted();
   const inbox=input.projections.stateOf(session,'inbox');
   if(agent.status!=='idle'||agent.session!==session||session.seq!==count||input.registry.get(agent.id)!==agent
    ||!Array.isArray(inbox?.['next-turn'])||!Array.isArray(inbox?.['next-step'])||inbox['next-turn'].length||inbox['next-step'].length)throw Error('native_handoff_changed');
  };
  check();const proof=await captureNativeHandoffQuiescence(input);check();
  const result=await operation(proof,check);check();return result;
 }finally{try{removeModel?.();}finally{removeTool();}}
}
