export function createDesktopLifecycle({app,backendFactory,windowFactory,beforeStart=async()=>true,onError=()=>{}}={}){
 if(!app||typeof app.requestSingleInstanceLock!=='function'||typeof app.quit!=='function'||typeof backendFactory!=='function'||typeof windowFactory!=='function'||
  typeof beforeStart!=='function')throw new Error('desktop_lifecycle_configuration_invalid');
 let phase='idle',backend=null,window=null,startPromise=null,stopPromise=null,started=null;
 const report=error=>{try{onError(error);}catch{}};
 async function start(){
  if(phase==='stopping'||phase==='failed'&&(backend||window))throw new Error('desktop_lifecycle_not_drained');
  if(phase==='ready')return started;
  if(phase==='starting')return startPromise;
  if(phase==='stopped'||phase==='second-instance')return {started:false,reason:phase==='second-instance'?'second-instance':'stopped'};
  phase='starting';
  startPromise=(async()=>{
   try{
    if(!app.requestSingleInstanceLock()){
     phase='second-instance';app.quit();return {started:false,reason:'second-instance'};
    }
    if(await beforeStart()===false){phase='stopped';return {started:false,reason:'before-start-aborted'};}
    const createdBackend=await backendFactory();
    if(!createdBackend||typeof createdBackend.close!=='function'||typeof createdBackend.origin!=='string')throw new Error('desktop_backend_start_invalid');
    backend=createdBackend;
    const createdWindow=await windowFactory(backend.origin,backend);
    if(!createdWindow||typeof createdWindow.destroy!=='function')throw new Error('desktop_window_start_invalid');
    window=createdWindow;phase='ready';started={started:true,origin:backend.origin,window};return started;
   }catch(error){
    phase='failed';report(error);
    if(backend){const partial=backend;backend=null;try{await partial.close();}catch(closeError){report(closeError);backend=partial;}}
    throw error;
   }finally{startPromise=null;}
  })();
  return startPromise;
 }
 async function stop(reason='quit'){
  if(phase==='starting'&&startPromise){try{await startPromise;}catch{}}
  if(phase==='stopped'||phase==='second-instance'){phase='stopped';return;}
  if(phase==='stopping')return stopPromise;
  if(phase==='idle'||(phase==='failed'&&!backend&&!window)){phase='stopped';return;}
  phase='stopping';
  const activeWindow=window,activeBackend=backend;
  stopPromise=(async()=>{
   try{await activeBackend?.close();backend=null;}catch(error){phase='failed';report(error);throw error;}
   try{activeWindow?.destroy();}catch(error){phase='failed';report(error);throw error;}
   window=null;phase='stopped';started=null;
   return reason;
  })();
  try{return await stopPromise;}finally{if(phase!=='stopped')stopPromise=null;}
 }
 return Object.freeze({start,stop,get phase(){return phase;}});
}
