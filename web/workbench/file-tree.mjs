import {validateWorkspaceFilePath} from './file-editor-state.mjs';

export function buildFileTree(files){
 if(!Array.isArray(files))throw new Error('workspace_file_tree_invalid');
 const root=new Map();
 for(const file of files){
  if(!file||typeof file!=='object')throw new Error('workspace_file_tree_invalid');
  const path=validateWorkspaceFilePath(file.path),parts=path.split('/');let nodes=root,parentPath='';
  for(let index=0;index<parts.length;index++){
   const name=parts[index],nodePath=parentPath?`${parentPath}/${name}`:name,last=index===parts.length-1;
   let node=nodes.get(name);
   if(last){
    if(node)throw new Error('workspace_file_tree_conflict');
    node={name,path:nodePath,kind:'file',file};nodes.set(name,node);
   }else{
    if(node?.kind==='file')throw new Error('workspace_file_tree_conflict');
    if(!node){node={name,path:nodePath,kind:'directory',children:new Map()};nodes.set(name,node);}
    nodes=node.children;
   }
   parentPath=nodePath;
  }
 }
 const ordered=nodes=>[...nodes.values()].sort((left,right)=>{
  return left.name.localeCompare(right.name,'en',{sensitivity:'base'})||left.name.localeCompare(right.name);
 }).map(node=>node.kind==='directory'?{name:node.name,path:node.path,kind:'directory',children:ordered(node.children)}:node);
 return ordered(root);
}
