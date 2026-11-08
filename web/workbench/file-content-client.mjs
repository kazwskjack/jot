import {validateWorkspaceFilePath,verifyWorkspaceFileContent} from './file-editor-state.mjs';

/**
 * @param {{request:typeof import('../jot/client').request,workspace_id:string,project_id:string,path:string,version?:number,sha256?:string}} options
 * @param {AbortSignal} [signal]
 */
export async function readWorkspaceFile({request,workspace_id,project_id,path,version,sha256},signal){
 if(typeof request!=='function')throw new Error('workspace_file_request_unavailable');
 validateWorkspaceFilePath(path);
 if(typeof workspace_id!=='string'||!workspace_id||typeof project_id!=='string'||!project_id)throw new Error('workspace_file_source_mismatch');
 if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw new Error('workspace_file_source_mismatch');
 if(sha256!==undefined&&(typeof sha256!=='string'||! /^[a-f0-9]{64}$/.test(sha256)))throw new Error('workspace_file_source_mismatch');
 const query=new URLSearchParams({project_id,path});
 if(version!==undefined)query.set('version',String(version));
 const encodedWorkspace=encodeURIComponent(workspace_id);
 const response=await request(`/workspaces/${encodedWorkspace}/files/content?${query.toString()}`,'GET',undefined,undefined,signal);
 return verifyWorkspaceFileContent({workspace_id,project_id,path,version,sha256},response);
}
