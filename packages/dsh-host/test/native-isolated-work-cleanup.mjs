import {rm} from 'node:fs/promises';

export function createNativeIsolatedWorkCleanup(state){
 let stopWorkersCalls=0;
 const handles=()=>state.workerProcesses??[];
 const cleanupTrace=state.cleanupTrace??(value=>process.stderr.write(JSON.stringify(value)+'\n'));
 const cleanupSnapshot=()=>({worker_handles:handles().map(handle=>({pid:handle.child.pid,terminal:handle.terminal()})),host:state.host?{pid:state.host.child.pid,terminal:state.host.terminal()}:null,gateway_listening:!!state.service?.app?.server?.listening,model_listening:!!state.model?.listening});
 const cleanupAwait=async(step,promise,details=()=>({}))=>{
  const started=Date.now(),ownerPid=process.pid;let settled=false;
  const snapshot=()=>({...cleanupSnapshot(),...details()});
  const timer=setTimeout(()=>{if(!settled){let current={};try{current=snapshot();}catch{}cleanupTrace({m08_08_cleanup_pending:{step,owner_pid:ownerPid,elapsed_ms:Date.now()-started,...current}});}},5000);
  try{const value=await promise;settled=true;cleanupTrace({m08_08_cleanup_resolved:{step,owner_pid:ownerPid,elapsed_ms:Date.now()-started,...snapshot()}});return value;}
  catch(error){settled=true;cleanupTrace({m08_08_cleanup_rejected:{step,owner_pid:ownerPid,error_name:error?.name??'Error',error_code:typeof error?.code==='string'?error.code:'unknown',...snapshot()}});throw error;}
  finally{clearTimeout(timer);}
 };
 const stopWorkers=async()=>{
  const invocation=++stopWorkersCalls,current=handles();
  cleanupTrace({m08_08_stop_workers_enter:{invocation,owner_pid:process.pid,handle_count:current.length}});
  const active=current.filter(handle=>!handle.terminal());
  cleanupTrace({m08_08_stop_workers:{invocation,owner_pid:process.pid,handle_count:current.length,handles:current.map(handle=>({pid:handle.child.pid,terminal:handle.terminal()})),active_pids:active.map(handle=>handle.child.pid)}});
  if(!active.length)return;
  await Promise.all(active.map(handle=>cleanupAwait('stopWorkers.'+invocation+'.worker.'+handle.child.pid,handle.stop(),()=>({worker_pid:handle.child.pid,worker_terminal:handle.terminal()}))));
  cleanupTrace({m08_08_stop_workers_returned:invocation,owner_pid:process.pid,active_pids:handles().filter(handle=>!handle.terminal()).map(handle=>handle.child.pid)});
 };
 const finishWorkers=async()=>{
  await cleanupAwait('finishWorkers.stopWorkers',stopWorkers(),()=>({worker_handles:handles().map(handle=>({pid:handle.child.pid,terminal:handle.terminal()}))}));
  const evidence=handles().map(handle=>handle.exit());
  cleanupTrace({m08_08_worker_processes:evidence,process_count:evidence.length,terminal_count:evidence.filter(process=>process.terminal).length});
  return evidence;
 };
 const run=async()=>{
  state.releaseBusyProbe?.resolve?.();state.releaseAcceptedModel?.resolve?.();
  cleanupTrace({m08_08_cleanup_step:'released_fixture_gates',owner_pid:process.pid});
  cleanupTrace({m08_08_cleanup_step:'before_stopWorkers',owner_pid:process.pid});
  await cleanupAwait('finally.stopWorkers',stopWorkers());
  cleanupTrace({m08_08_cleanup_step:'workers_stopped',owner_pid:process.pid});
  if(state.cleanupOnlyResult){
   const evidence=handles().map(handle=>handle.exit());
   Object.assign(state.cleanupOnlyResult,{process_count:evidence.length,process_exit_count:evidence.filter(process=>process.terminal).length,sqlite_busy_count:evidence.reduce((n,process)=>n+process.sqlite_busy_count,0),sqlite_locked_count:evidence.reduce((n,process)=>n+process.sqlite_locked_count,0)});
   cleanupTrace({m08_08_cleanup_only_result:state.cleanupOnlyResult,worker_processes:evidence});
  }
  if(state.host)await cleanupAwait('host.stop',state.host.stop(),()=>({host_pid:state.host.child.pid,host_terminal:state.host.terminal()}));
  cleanupTrace({m08_08_cleanup_step:'official_host_stopped',owner_pid:process.pid});
  if(state.service){
   await cleanupAwait('gateway.app.close',state.service.app.close(),()=>({gateway_listening:!!state.service.app.server?.listening}));
   state.service.db.close();
   cleanupTrace({m08_08_cleanup_step:'gateway_closed',owner_pid:process.pid});
  }
  if(state.model){
   state.model.closeAllConnections();
   cleanupTrace({m08_08_cleanup_step:'model_close_all_connections',owner_pid:process.pid});
   await cleanupAwait('model.close',new Promise(done=>state.model.close(done)),()=>({model_listening:state.model.listening}));
  }
  if(state.succeeded&&state.root)await cleanupAwait('fixture.rm',rm(state.root,{recursive:true,force:true,maxRetries:5,retryDelay:50}),()=>({fixture_root_removed:true}));
 };
 return{cleanupAwait,cleanupSnapshot,cleanupTrace,stopWorkers,finishWorkers,run};
}
