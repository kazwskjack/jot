/** Load the official package-owned session invariant in an isolated read-only
 * context. The composition has no Agent, driver, model, tools or persistence. */
export function createNativeInvariantReplay({Context,Service,InvariantRegistry,sessionInvariant}){
 if(typeof Context!=='function'||typeof Service!=='function'||typeof InvariantRegistry!=='function'||typeof sessionInvariant?.apply!=='function')throw Error('native_invariant_replay_unavailable');
 return async function validateLog(view,{signal}={}){
  signal?.throwIfAborted();if(typeof view?.snapshotEvents!=='function')throw Error('native_invariant_log_invalid');
  const ctx=new Context();
  class ReadOnlySessionLog extends Service{constructor(scope){super(scope,'sessions');}list(){return [view];}}
  try{
   await ctx.plugin(ReadOnlySessionLog);signal?.throwIfAborted();
   await ctx.plugin(InvariantRegistry,{enabled:true,package_allowlist:['^@deepseek-ai/dsh-session$'],package_blocklist:[]});
   if(ctx.invariants.selected('@deepseek-ai/dsh-session')!==true)throw Error('native_invariant_replay_unavailable');
   await ctx.plugin(sessionInvariant);signal?.throwIfAborted();return {validated:true};
  }finally{await ctx.fiber.dispose();}
 };
}
