import { maxBatchFiles } from './upload-controller.mjs';

export async function collectDroppedFiles(items) {
 const dropped=[];
 const add=(file,relativePath)=>{
  dropped.push({file,relativePath});
  if(dropped.length>maxBatchFiles)throw new Error('upload_batch_limit_exceeded');
 };
 const visit=async(entry,prefix='')=>{
  const path=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.isFile){
   const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));
   add(file,path);return;
  }
  if(!entry.isDirectory)return;
  const reader=entry.createReader();
  for(;;){
   const children=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
   if(!children.length)break;
   for(const child of children)await visit(child,path);
  }
 };
 for(const item of items){
  const entry=typeof item?.webkitGetAsEntry==='function'?item.webkitGetAsEntry():null;
  if(entry){await visit(entry);continue;}
  const file=item instanceof File?item:item?.getAsFile?.();
  if(file)add(file,file.webkitRelativePath||file.name);
 }
 return dropped;
}
