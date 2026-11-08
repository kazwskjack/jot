// Store the original batch identity and apply command, leaving document bytes in the server preview.
export class MemoryImportStore {
 constructor(storage,owner,workspace,target){
  if(!/^[a-f0-9]{64}$/.test(owner)||!storage||!workspace)throw new Error('记忆导入恢复存储不可用');
  this.storage=storage;this.workspace=workspace;this.target=structuredClone(target);
  this.key='jot-memory-import/v1/'+JSON.stringify([owner,workspace,target]);
 }
 read(){
  const text=this.storage.getItem(this.key);if(!text)return null;
  if(text.length>4096)throw new Error('记忆导入恢复记录无效');
  const value=JSON.parse(text),batch=value?.batch,command=value?.command;
  if(!value||Object.keys(value).sort().join(',')!=='batch,command,version'||value.version!==1
   ||!batch||!['import_id,target','import_id,mode,target','import_id,source_file,target','import_id,mode,source_file,target'].includes(Object.keys(batch).sort().join(','))
   ||batch.mode!==undefined&&batch.mode!=='replace_scope'
   ||typeof batch.import_id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(batch.import_id)
   ||JSON.stringify(batch.target)!==JSON.stringify(this.target))throw new Error('记忆导入恢复记录无效');
  if(batch.source_file!==undefined){
   const source=batch.source_file;
   if(!source||Object.keys(source).sort().join(',')!=='kind,path,sha256,size,version'||source.kind!=='workspace_file'
    ||typeof source.path!=='string'||!source.path||source.path.length>400||!Number.isSafeInteger(source.version)||source.version<1
    ||typeof source.sha256!=='string'||! /^[a-f0-9]{64}$/.test(source.sha256)||!Number.isSafeInteger(source.size)||source.size<0||source.size>104857600)throw new Error('记忆源文件恢复记录无效');
  }
  if(command!==null){
   const body=command?.body;
   if(!command||Object.keys(command).sort().join(',')!=='body,key,method,path'
    ||![this.path(batch.import_id),this.path(batch.import_id,true)].includes(command.path)||command.method!=='POST'
    ||typeof command.key!=='string'||command.key.length<8||command.key.length>200
    ||!body||Object.keys(body).join(',')!=='expected_version'||!Number.isSafeInteger(body.expected_version)||body.expected_version<1)
    throw new Error('记忆导入原请求无效');
  }
  return value;
 }
 path(id,paged=false){return `/workspaces/${encodeURIComponent(this.workspace)}/memory/import/${encodeURIComponent(id)}/apply${paged?'?offset=0&limit=25':''}`;}
 /** @param {string} id @param {'append'|'replace_scope'} [mode] @param {import('../../packages/gateway/contracts/types').WorkbenchMemoryImportFileSelection} [sourceFile] */
 saveBatch(id,mode='append',sourceFile=undefined){
  if(this.read())throw new Error('请先核对已有导入记录');
  if(!['append','replace_scope'].includes(mode))throw new Error('记忆导入模式无效');
  this.storage.setItem(this.key,JSON.stringify({version:1,batch:{import_id:id,target:this.target,...(mode==='replace_scope'?{mode}:{}),...(sourceFile?{source_file:sourceFile}:{})},command:null}));
  this.read();
 }
 saveCommand(command,expected){
  if(command===null){this.complete(expected);return;}
  const value=this.read();if(!value)throw new Error('记忆导入批次不存在');
  if(value.command&&value.command.key!==command.key)throw new Error('已有待确认的记忆导入请求');
  const text=JSON.stringify({...value,command});
  // Validate before persistence without ever replacing the original pending command.
  if(![this.path(value.batch.import_id),this.path(value.batch.import_id,true)].includes(command.path)||command.method!=='POST'
   ||!Number.isSafeInteger(command.body?.expected_version)||command.body.expected_version<1)throw new Error('记忆导入原请求无效');
  this.storage.setItem(this.key,text);
 }
 complete(expected){
  const value=this.read();if(!value)return;
  if(expected&&value.command?.key!==expected.key)throw new Error('记忆导入原请求已改变');
  this.storage.setItem(this.key,JSON.stringify({...value,command:null}));
 }
 clear(){
  if(this.read()?.command)throw new Error('请先确认原记忆导入请求的结果');
  this.storage.removeItem(this.key);
 }
}
