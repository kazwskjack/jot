import {spawn} from 'node:child_process';
import {stat,realpath} from 'node:fs/promises';
import {isAbsolute,join,delimiter} from 'node:path';

export async function gitExecutable(configured?:string):Promise<string>{
 const choices=configured?[configured]:(process.env.PATH??'').split(delimiter).filter(isAbsolute).map(path=>join(path.replace(/^"|"$/g,''),process.platform==='win32'?'git.exe':'git'));
 for(const path of choices){if(!isAbsolute(path))continue;try{const canonical=await realpath(path),value=await stat(canonical);if(value.isFile())return canonical;}catch{}}
 throw Error('git_executable_unavailable');
}

export type GitProcessLimits={maxOutputBytes:number;timeoutMs:number};
/** Internal fixed-command transport. Never expose its argument array as an API. */
export async function readGit(executable:string,root:string,gitDirectory:string,args:readonly string[],limits:GitProcessLimits,signal?:AbortSignal,objectDirectory?:string,input?:Buffer,alternateObjectDirectory?:string):Promise<{code:number;bytes:Buffer}>{
 signal?.throwIfAborted();
 const env:NodeJS.ProcessEnv={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{LC_ALL:'C',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',GIT_NO_LAZY_FETCH:'1',GIT_ATTR_NOSYSTEM:'1'});
 if(objectDirectory)env.GIT_OBJECT_DIRECTORY=objectDirectory;
 if(alternateObjectDirectory)env.GIT_ALTERNATE_OBJECT_DIRECTORIES=alternateObjectDirectory;
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,['--no-pager','--no-optional-locks','--literal-pathspecs','--git-dir='+gitDirectory,'--work-tree='+root,
   '-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never',...args],{cwd:root,env,windowsHide:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
  let size=0,settled=false,failure:string|undefined;const chunks:Buffer[]=[];
  const kill=(code:string)=>{failure??=code;child.kill('SIGKILL');};
  const aborted=()=>kill('git_cancelled');signal?.addEventListener('abort',aborted,{once:true});
  const timer=setTimeout(()=>kill('git_read_timeout'),limits.timeoutMs);timer.unref();
  const finish=(error?:Error,code=0)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);if(error)reject(error);else resolve({code,bytes:Buffer.concat(chunks)});};
  child.stdout!.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>limits.maxOutputBytes){kill('git_output_limit');return;}chunks.push(chunk);});
  child.stderr!.resume();
  if(input!==undefined){child.stdin!.on('error',()=>{});child.stdin!.end(input);}
  child.once('error',()=>finish(Error('git_read_unavailable')));
  child.once('close',code=>finish(failure?Error(failure):code===null?Error('git_read_unavailable'):undefined,code??-1));
  if(signal?.aborted)aborted();
 });
}
