export function createDesktopLifecycle({app,backendFactory,windowFactory,prepareWindowFactory=null,beforeStart=async()=>true,onError=()=>{}}={}){
 if(!app||typeof app.requestSingleInstanceLock!=='function'||typeof app.quit!=='function'||typeof backendFactory!=='function'||typeof windowFactory!=='function'||
  typeof beforeStart!=='function'||prepareWindowFactory!==null&&typeof prepareWindowFactory!=='function')throw new Error('desktop_lifecycle_configuration_invalid');
 let phase='idle',backend=null,window=null,startPromise=null,stopPromise=null,started=null,preparedWindow=null,retryPromise=null,stopRequested=false;
 const report=error=>{try{onError(error);}catch{}};
 async function start(){
  if(stopRequested)return {started:false,reason:'stopped'};
  if(phase==='retrying'||phase==='stopping'||phase==='failed'&&(backend||window))throw new Error('desktop_lifecycle_not_drained');
  if(phase==='ready')return started;
  if(phase==='starting')return startPromise;
  if(phase==='stopped'||phase==='second-instance')return {started:false,reason:phase==='second-instance'?'second-instance':'stopped'};
  phase='starting';
  startPromise=(async()=>{
   try{
    if(!app.requestSingleInstanceLock()){
     window?.destroy();window=null;preparedWindow=null;phase='second-instance';app.quit();return {started:false,reason:'second-instance'};
    }
    if(await beforeStart()===false){window?.destroy();window=null;preparedWindow=null;phase='stopped';return {started:false,reason:'before-start-aborted'};}
    if(stopRequested)throw Error('desktop_startup_cancelled');
    if(prepareWindowFactory){
     const prepared=await prepareWindowFactory(preparedWindow);
     if(!prepared||typeof prepared.destroy!=='function')throw Error('desktop_window_start_invalid');
     window=preparedWindow=prepared;
    }
    if(stopRequested)throw Error('desktop_startup_cancelled');
    const createdBackend=await backendFactory();
    if(typeof createdBackend?.close==='function')backend=createdBackend;
    if(!createdBackend||typeof createdBackend.close!=='function'||typeof createdBackend.origin!=='string')throw new Error('desktop_backend_start_invalid');
    if(stopRequested)throw Error('desktop_startup_cancelled');
    const createdWindow=await windowFactory(backend.origin,backend,preparedWindow);
    if(!createdWindow||typeof createdWindow.destroy!=='function')throw new Error('desktop_window_start_invalid');
    window=createdWindow;preparedWindow=null;
    if(stopRequested)throw Error('desktop_startup_cancelled');
    phase='ready';started={started:true,origin:backend.origin,window};return started;
   }catch(error){
    phase='failed';report(error);
    if(!backend&&typeof error?.partialBackend?.close==='function')backend=error.partialBackend;
    if(backend){const partial=backend;backend=null;try{await partial.close();}catch(closeError){report(closeError);backend=partial;}}
    throw error;
   }finally{startPromise=null;}
  })();
  return startPromise;
 }
 async function retry(){
  if(retryPromise)return retryPromise;
  if(stopRequested||phase!=='failed'||!preparedWindow||window!==preparedWindow)throw Error('desktop_lifecycle_retry_unavailable');
  phase='retrying';
  retryPromise=(async()=>{
   try{
    if(backend){await backend.close();backend=null;}
    if(stopRequested)return {started:false,reason:'stopped'};
    phase='idle';return await start();
   }catch(error){phase='failed';throw error;}
   finally{retryPromise=null;}
  })();
  return retryPromise;
 }
 async function stop(reason='quit'){
  stopRequested=true;
  if(retryPromise)try{await retryPromise;}catch{}
  if(phase==='starting'&&startPromise){try{await startPromise;}catch{}}
  if(phase==='stopped'||phase==='second-instance'){phase='stopped';return;}
  if(phase==='stopping')return stopPromise;
  if(phase==='idle'||(phase==='failed'&&!backend&&!window)){phase='stopped';return;}
  phase='stopping';
  const activeWindow=window,activeBackend=backend;
  stopPromise=(async()=>{
   try{await activeBackend?.close();backend=null;}catch(error){phase='failed';report(error);throw error;}
   try{activeWindow?.destroy();}catch(error){phase='failed';report(error);throw error;}
   window=null;preparedWindow=null;phase='stopped';started=null;
   return reason;
  })();
  try{return await stopPromise;}finally{if(phase!=='stopped')stopPromise=null;}
 }
 return Object.freeze({start,retry,stop,get canRetry(){return !stopRequested&&phase==='failed'&&!!preparedWindow&&window===preparedWindow;},get phase(){return phase;}});
}
