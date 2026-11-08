import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';

export type BrainSourceFile={path:string;content:string};
export type BrainRenderInput={root:string;page_id:string;title:string;summary:string;source:string;content:string;files:BrainSourceFile[]};
const require=createRequire(import.meta.url);

/** Only the pinned CLI authors Brain data. Staging carries no live workspace,
 * user configuration, agent hooks, model services or filesystem authority. */
export async function renderBrainPublication(parent:string,input:BrainRenderInput):Promise<BrainSourceFile[]>{
 if(isAbsolute(input.root)||input.root.split('/').some(part=>!part||part==='.'||part==='..')||input.root.includes('\\')||input.root.includes(':'))throw Error('invalid_brain_publication');
 let cli:string;
 try{
  const manifest=require.resolve('@mindmux/brain-md/package.json');
  const metadata=JSON.parse(await readFile(manifest,'utf8'));
  if(metadata.name!=='@mindmux/brain-md'||metadata.version!=='0.3.0')throw Error('unsupported_brain_runtime');
  cli=join(dirname(manifest),'bin','brain.mjs');
 }catch{throw Error('brain_runtime_unavailable');}
 const staging=await mkdtemp(join(parent,'.brain-preview-'));
 try{
  for(const file of input.files){
   const target=resolve(staging,file.path);
   const boundary=relative(staging,target);
   if(isAbsolute(boundary)||boundary==='..'||boundary.startsWith('../')||boundary.startsWith('..\\'))throw Error('invalid_brain_publication');
   await mkdir(dirname(target),{recursive:true});await writeFile(target,file.content,{flag:'wx'});
  }
  // Only a validated project-relative root reaches the CLI. Other original
  // preferences are unnecessary for rendering and confer no staging authority.
  await mkdir(join(staging,'.mindmux'),{recursive:true});
  await writeFile(join(staging,'.mindmux','preferences.json'),JSON.stringify({brainRoot:input.root}));
  const run=(args:string[],stdin?:string)=>new Promise<void>((resolveRun,reject)=>{
   const child=execFile(process.execPath,[cli,...args],{cwd:staging,windowsHide:true,timeout:10000,maxBuffer:65536},error=>error?reject(Error('brain_render_failed')):resolveRun());
   child.stdin?.on('error',()=>{});child.stdin?.end(stdin??'');
  });
  await run(['init','--no-wire']);
  await mkdir(join(staging,input.root,'pages'),{recursive:true});
  const page=join(input.root,'pages',input.page_id+'.md').replaceAll('\\','/');
  if(!input.files.some(file=>file.path===page))await run(['create-page','--id',input.page_id,'--category','decision','--title',input.title,'--source',input.source]);
  await run(['update-truth','--id',input.page_id,'--summary',input.summary,'--source',input.source],input.content);
  const files:BrainSourceFile[]=[];let size=0;
  const collect=async(directory:string)=>{
   for(const entry of await readdir(join(staging,directory),{withFileTypes:true})){
    const path=directory+'/'+entry.name;
    if(entry.isSymbolicLink())throw Error('brain_render_failed');
    if(entry.isDirectory()){if(entry.name==='pages')await collect(path);continue;}
    if(!entry.isFile()||!entry.name.endsWith('.md'))continue;
    const content=await readFile(join(staging,path),'utf8');size+=Buffer.byteLength(content);
    if(Buffer.byteLength(content)>1048576||size>8388608||files.length>=200)throw Error('brain_publication_too_large');
    files.push({path,content});
   }
  };
  await collect(input.root);
  const protocol=await readFile(join(staging,'BRAIN.md'),'utf8');
  if(files.length>=200||Buffer.byteLength(protocol)>1048576||size+Buffer.byteLength(protocol)>8388608)throw Error('brain_publication_too_large');
  files.push({path:'BRAIN.md',content:protocol});
  return files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
 }finally{
  if(dirname(staging)!==resolve(parent))throw Error('brain_staging_scope_invalid');
  await rm(staging,{recursive:true,force:true});
 }
}
