/** Test infrastructure only. Never stop a live Host or retry an observation
 * timeout. A fresh port is allowed only after a proven pre-ready bind failure. */
export async function startFixtureWithBindRetry({start,inspectFailure,rebind,signal}){
 if([start,inspectFailure,rebind].some(fn=>typeof fn!=='function'))throw Error('fixture_startup_config_invalid');
 for(let attempt=0;attempt<3;attempt++){
  signal?.throwIfAborted();
  try{return await start();}
  catch(error){
   signal?.throwIfAborted();let state;try{state=await inspectFailure();}catch{throw error;}
   signal?.throwIfAborted();
   if(attempt===2||state?.exited!==true||state.exitCode!==1||state.exitSignal!==null||state.ready!==false||state.inputSubmitted!==false
    ||!Number.isInteger(state.port)||state.port<1||state.port>65535||typeof state.output!=='string'
    ||!new RegExp('Error: listen EADDRINUSE: address already in use 127\\.0\\.0\\.1:'+state.port+'(?:\\s|$)').test(state.output))throw error;
   await rebind({attempt:attempt+1,port:state.port,reason:'EADDRINUSE'});
  }
 }
}
