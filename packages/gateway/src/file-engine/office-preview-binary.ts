// Shared bounded Office version probe.
// AGPL-3.0 notice retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
import {execFile} from 'node:child_process';
import type {OfficePreviewBinaryStatus} from '../../contracts/types.ts';

export function probeOfficePreviewBinary(binaryPath:string,environment:Record<string,string>,signal:AbortSignal):Promise<OfficePreviewBinaryStatus>{
 return new Promise(resolve=>{
  execFile(binaryPath,['--version'],{env:environment,windowsHide:true,encoding:'utf8',
   timeout:2000,maxBuffer:4096,killSignal:'SIGKILL',signal},(error,stdout)=>{
   const version=typeof stdout==='string'?stdout.trim().replace(/\s+/g,' '):'';
   resolve(error?{binaryPath,available:false,reason:'probe_failed'}
    :/^LibreOffice [^\r\n]{1,180}$/.test(version)?{binaryPath,available:true,version}
    :{binaryPath,available:false,reason:'version_unconfirmed'});
  });
 });
}
