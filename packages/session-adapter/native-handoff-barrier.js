import {captureNativeHandoffQuiescence} from './native-child-closure.js';
/** Trusted host transition only. Never wait for a busy lead from its own tool. */
export async function withNativeHandoffBarrier(input,operation){
 const agent=input?.agent;
 if(typeof operation!=='function'||agent?.status!=='idle'||input.registry?.get(agent.id)!==agent
  ||typeof agent.ctx?.tools?.guard!=='function'||typeof agent.ctx?.on!=='function')throw Error('native_handoff_not_idle');
 if(typeof agent.runMaintenance!=='function')throw Error('native_handoff_maintenance_unavailable');
 let entered=false;
 try{return await agent.runMaintenance(async nativeSignal=>{entered=true;const signal=input.signal?AbortSignal.any([input.signal,nativeSignal]):nativeSignal;return runBarrier({...input,signal},operation);});}
 catch(error){if(!entered)throw Error('native_handoff_not_idle');throw error;}
}
async function runBarrier(input,operation){
 const agent=input.agent,session=agent.session,signal=input.signal;
 const count=session.seq,header=JSON.stringify(session.header);let removeModel;const removeTool=agent.ctx.tools.guard(()=> 'NATIVE_HANDOFF_PENDING');
 try{
  removeModel=agent.ctx.on('llm/stream',(options,next)=>{if(options?.sessionId===agent.id)throw Error('native_handoff_pending');return next();},{prepend:true});
  const check=()=>{
   signal?.throwIfAborted();
   const inbox=input.projections.stateOf(session,'inbox');
   if(agent.status!=='idle'||agent.session!==session||session.seq!==count||JSON.stringify(session.header)!==header||input.registry.get(agent.id)!==agent
    ||!Array.isArray(inbox?.['next-turn'])||!Array.isArray(inbox?.['next-step'])||inbox['next-turn'].length||inbox['next-step'].length)throw Error('native_handoff_changed');
  };
  check();const proof=await captureNativeHandoffQuiescence(input,signal);check();
  const result=await operation(proof,check,signal);check();return result;
 }finally{try{removeModel?.();}finally{removeTool();}}
}
