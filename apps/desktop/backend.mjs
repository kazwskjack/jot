import {join} from 'node:path';

export async function startLocalBackend({buildServer,userDataPath,publicRoot,probeOnly=false,diagnostics=null}={}){
 if(typeof buildServer!=='function'||typeof userDataPath!=='string'||!userDataPath||typeof publicRoot!=='string'||!publicRoot)throw new Error('desktop_backend_configuration_invalid');
 const note=(kind,detail)=>{if(!probeOnly)try{diagnostics?.record(kind,detail);}catch{}};
 note('backend-start');
 let service;
 try{
  service=await buildServer({database:join(userDataPath,'jot.db'),root:join(userDataPath,'files'),publicRoot,
  ...(!probeOnly&&diagnostics?{onDiagnosticError:error=>note('backend-error',{error}),onDiagnosticResponse:status=>note('http-server-error',{status})}:{}),
  ...(probeOnly?{provider:async()=>{throw new Error('desktop_probe_dispatch_forbidden');},chat:{enabled:false},workbench:{}}:{})});
  if(probeOnly){if(typeof service.beginDrain!=='function')throw new Error('desktop_backend_drain_unavailable');service.beginDrain();}
  await service.app.listen({host:'127.0.0.1',port:0});
  const address=service.app.server.address();
  if(!address||typeof address!=='object'||address.address!=='127.0.0.1'||!Number.isInteger(address.port)||address.port<1||address.port>65535)throw new Error('desktop_backend_address_invalid');
  note('backend-ready');
  let closing,closed=false;
  const beginDrain=()=>{if(typeof service.beginDrain!=='function')throw new Error('desktop_backend_drain_unavailable');service.beginDrain();note('backend-draining');};
  return Object.freeze({origin:'http://127.0.0.1:'+address.port,service,beginDrain,probeOnly,
   get draining(){return service.draining===true;},
   get closed(){return closed;},
   close:()=>{service.beginDrain?.();if(!closing)note('backend-draining');return closing??=Promise.resolve().then(()=>service.close()).then(async()=>{closed=true;note('backend-closed');if(!probeOnly)try{await diagnostics?.flush();}catch{}}).catch(error=>{closing=null;throw error;});}});
 }catch(error){
  note('backend-error',{error});
  try{await service?.close();}catch{}
  throw error;
 }
}
