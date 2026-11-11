// Adapts PilotDeck 783499ff updateDownload stream backpressure; AGPL-3.0.
// One serial downloader owns one waiter; pause retains its current response.
export function createUpdateTransferControl({signal}={}){
 let paused=false,waiting=false,disposed=false,settle=null;
 const cancelled=()=>new Error('desktop_update_cancelled');
 function pause(){if(disposed||signal?.aborted)throw cancelled();paused=true;}
 function resume(){if(disposed||signal?.aborted)throw cancelled();paused=false;settle?.();}
 async function wait(){
  if(disposed||signal?.aborted)throw cancelled();
  if(!paused)return;
  if(waiting)throw new Error('desktop_update_transfer_wait_pending');
  waiting=true;
  try{
   await new Promise((resolve,reject)=>{
    const abort=()=>finish(cancelled());
    const finish=error=>{
     signal?.removeEventListener('abort',abort);settle=null;waiting=false;
     if(error)reject(error);else resolve();
    };
    settle=finish;signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted||disposed)finish(cancelled());
   });
  }finally{waiting=false;}
  if(disposed||signal?.aborted)throw cancelled();
 }
 function dispose(){if(disposed)return;disposed=true;paused=false;settle?.(cancelled());}
 return Object.freeze({pause,resume,wait,dispose,snapshot:()=>Object.freeze({paused,waiting})});
}
