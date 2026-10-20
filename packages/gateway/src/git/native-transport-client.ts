import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {WorkPublicationExecutions} from '../persistent-tasks/work-publication-executions.ts';

export type NativeGitRequest=Readonly<{owner_id:string;project_id:string;execution_id:string;operation_kind:'work_publication';command?:Parameters<WorkPublicationExecutions['settlePublication']>[3]}>;
export type NativeGitClient=Readonly<{execute:(input:NativeGitRequest,signal?:AbortSignal)=>Promise<unknown>}>;

/** Fixed sibling package, for source and compiled Gateway layouts. No module
 * path, executable, root or URL can be supplied by a browser or environment. */
async function transport(){
 const path=import.meta.url.endsWith('/dist/src/git/native-transport-client.js')?'../../../../session-adapter/native-git-transport.js'
  :import.meta.url.endsWith('/src/git/native-transport-client.ts')?'../../../session-adapter/native-git-transport.js':undefined;
 if(!path)throw Error('native_git_client_unavailable');
 try{const module=await import(new URL(path,import.meta.url).href);if(typeof module.normalizeNativeGitTransportConfiguration!=='function'||typeof module.callNativeGitTransport!=='function')throw Error();return module}
 catch{throw Error('native_git_client_unavailable')}
}

/** Secret settings stay in this closure, never in a serializable capability. */
export async function createNativeGitClient(options:unknown):Promise<NativeGitClient>{
 const module=await transport(),settings=module.normalizeNativeGitTransportConfiguration(options);
 return Object.freeze({execute:(input:NativeGitRequest,signal?:AbortSignal)=>module.callNativeGitTransport(settings,input,signal) as Promise<unknown>});
}

export async function loadNativeGitClient(env:NodeJS.ProcessEnv):Promise<NativeGitClient|undefined>{
 const socket=env.GENERAL_AGENT_NATIVE_GIT_SOCKET?.trim(),file=env.GENERAL_AGENT_NATIVE_GIT_TOKEN_FILE?.trim();
 if(!socket&&!file)return undefined;
 if(!socket||!file||!isAbsolute(file))throw Error('native_git_client_configuration_invalid');
 let token:string;try{token=(await readFile(file,'utf8')).trim()}catch{throw Error('native_git_client_configuration_invalid')}
 return createNativeGitClient({socket,token});
}
