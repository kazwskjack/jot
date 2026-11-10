import { execFile, spawn } from 'node:child_process';
import {join} from 'node:path';

export function fileEngineChildEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: environment.PATH ?? '',
    PYTHONPATH: environment.PYTHONPATH ?? '',
    GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT: environment.GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT ?? '',
    GENERAL_AGENT_LIBREOFFICE: environment.GENERAL_AGENT_LIBREOFFICE?.trim() || '/usr/bin/libreoffice',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

export interface FileEngineInput {
  operation: string;
  input_path: string;
  output_path?: string;
  media_type: string;
  job_dir: string;
  request: Record<string, unknown>;
}

export interface FileEngineResult {
  ok: boolean;
  engine: { name: string; version: string };
  content?: any;
  output_path?: string;
  checks?: Record<string, unknown>;
  warnings?: string[];
  error_code?: string;
}

export class FileEngineAdapter {
  private readonly python: string;
  private readonly workerPath: string;
  private readonly timeoutMs: number;
  constructor(options: { python: string; workerPath: string; timeoutMs?: number }) {
    this.python = options.python; this.workerPath = options.workerPath;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  run(input: FileEngineInput,options:{signal?:AbortSignal;maxOutputBytes?:number}={}): Promise<FileEngineResult> {
    return new Promise((resolve, reject) => {
      const {signal,maxOutputBytes}=options;
      signal?.throwIfAborted();
      if(maxOutputBytes!==undefined&&(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1)){
        throw new Error('ENGINE_OUTPUT_LIMIT_INVALID');
      }
      const child = spawn(this.python, [this.workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform!=='win32',
        env: fileEngineChildEnvironment(),
      });
      const stdout: Buffer[] = [];let outputBytes=0,failure:Error|undefined;
      let termination:Promise<void>|undefined;
      const terminateTree=():Promise<void>=>{
        if(termination)return termination;
        if(child.pid===undefined)return Promise.resolve();
        const pid=child.pid;
        // Same owned-process-group/taskkill pattern as archive-executor and Taskmaster probing.
        if(process.platform==='win32'){
          termination=new Promise<void>(done=>{
            const complete=(error:unknown)=>{
              if(error){
                failure=new Error('ENGINE_PROCESS_TREE_STOP_FAILED',{cause:failure??error});
                child.kill('SIGKILL');
              }
              done();
            };
            try{
              const executable=join(process.env.SystemRoot||'C:\Windows','System32','taskkill.exe');
              execFile(executable,['/PID',String(pid),'/T','/F'],
                {windowsHide:true,timeout:5000,maxBuffer:4096,killSignal:'SIGKILL'},complete);
            }catch(error){complete(error);}
          });
        }else{
          try{process.kill(-pid,'SIGKILL');}
          catch(error){
            if((error as NodeJS.ErrnoException).code!=='ESRCH'){
              failure=new Error('ENGINE_PROCESS_TREE_STOP_FAILED',{cause:failure??error});
              child.kill('SIGKILL');
            }
          }
          termination=Promise.resolve();
        }
        return termination;
      };
      const stop=(error:Error)=>{failure??=error;void terminateTree();};
      const abort=()=>stop(signal?.reason instanceof Error?signal.reason:new Error('ENGINE_CANCELLED'));
      const timer=setTimeout(()=>stop(new Error('ENGINE_TIMEOUT')),this.timeoutMs);
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
      child.stdout.on('data',value=>{
        if(failure)return;
        const bytes=Buffer.from(value);outputBytes+=bytes.length;
        if(maxOutputBytes!==undefined&&outputBytes>maxOutputBytes){stop(new Error('ENGINE_OUTPUT_TOO_LARGE'));return;}
        stdout.push(bytes);
      });
      child.stderr.resume();
      child.stdin.on('error',()=>stop(new Error('ENGINE_CRASH')));
      child.on('error',()=>{
        failure??=new Error('ENGINE_CRASH');
        if(child.pid===undefined){cleanup();reject(failure);}
      });
      child.once('close', async code => {
        cleanup();
        if(process.platform!=='win32')await terminateTree();
        else if(termination)await termination;
        if(failure){reject(failure);return;}
        let value: FileEngineResult;
        try { value = JSON.parse(Buffer.concat(stdout).toString('utf8')) as FileEngineResult; }
        catch { reject(new Error(code === 0 ? 'ENGINE_RESULT_INVALID' : 'ENGINE_CRASH')); return; }
        if (!value.ok) reject(new Error(value.error_code || 'ENGINE_CRASH'));
        else resolve(value);
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}
