import {workspaceRelativePath} from '../always-on/workspace-provider.ts';

export function taskmasterPrdPath(name:unknown):string{
 if(typeof name!=='string'||!name||name.length>255||name.startsWith('.')||name.includes('/')||!/\.(md|markdown|txt)$/i.test(name))throw Error('invalid_prd_file_name');
 try{workspaceRelativePath(name);}catch{throw Error('invalid_prd_file_name');}
 return '.taskmaster/docs/'+name;
}
