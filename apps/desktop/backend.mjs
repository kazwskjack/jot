import {join} from 'node:path';

export async function startLocalBackend({buildServer,userDataPath,publicRoot,probeOnly=false}={}){
 if(typeof buildServer!=='function'||typeof userDataPath!=='string'||!userDataPath||typeof publicRoot!=='string'||!publicRoot)throw new Error('desktop_backend_configuration_invalid');
 const service=await buildServer({database:join(userDataPath,'jot.db'),root:join(userDataPath,'files'),publicRoot,
  ...(probeOnly?{provider:async()=>{throw new Error('desktop_probe_dispatch_forbidden');},chat:{enabled:false},workbench:{}}:{})});
 try{
  if(probeOnly){if(typeof service.beginDrain!=='function')throw new Error('desktop_backend_drain_unavailable');service.beginDrain();}
  await service.app.listen({host:'127.0.0.1',port:0});
  const address=service.app.server.address();
  if(!address||typeof address!=='object'||address.address!=='127.0.0.1'||!Number.isInteger(address.port)||address.port<1||address.port>65535)throw new Error('desktop_backend_address_invalid');
  let closing,closed=false;
  const beginDrain=()=>{if(typeof service.beginDrain!=='function')throw new Error('desktop_backend_drain_unavailable');service.beginDrain();};
  return Object.freeze({origin:'http://127.0.0.1:'+address.port,service,beginDrain,probeOnly,
   get draining(){return service.draining===true;},
   get closed(){return closed;},
   close:()=>{service.beginDrain?.();return closing??=Promise.resolve().then(()=>service.close()).then(()=>{closed=true;}).catch(error=>{closing=null;throw error;});}});
 }catch(error){
  try{await service.close();}catch{}
  throw error;
 }
}
