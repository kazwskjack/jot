import {join} from 'node:path';
import {readGit,type GitProcessLimits} from './process.ts';
import type {GitReadContext} from './inspection.ts';

function gitAttributeRows(bytes:Buffer,paths:ReadonlySet<string>,maxEntries:number){
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(raw&&!raw.endsWith('\0'))throw Error('git_checkout_unavailable');
 const fields=raw?raw.slice(0,-1).split('\0'):[],seen=new Set<string>(),attributes:Array<{path:string;name:string;value:string}>=[];
 if(fields.length%3)throw Error('git_checkout_unavailable');
 if(fields.length/3>Math.min(maxEntries,100000))throw Error('git_metadata_limit');
 for(let at=0;at<fields.length;at+=3){
  const path=fields[at]!,name=fields[at+1]!,value=fields[at+2]!,key=path+'\0'+name;
  if(!paths.has(path)||!name||name.length>1024||/[\x00-\x20\x7f]/.test(name)||seen.has(key))throw Error('git_checkout_unavailable');
  if(value.length>2*1024*1024)throw Error('git_metadata_limit');
  seen.add(key);attributes.push({path,name,value});
 }
 return attributes.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:a.name<b.name?-1:a.name>b.name?1:0);
}

/** Collect bounded metadata through the guarded native allocation path. */
export async function readGitAttributes(options:{executable:string;root:string;context:GitReadContext;objects:string;index:string;paths:ReadonlySet<string>;limits:GitProcessLimits&{maxMetadataEntries:number};cached?:boolean;signal?:AbortSignal}){
 const {executable,root,context,objects,index,paths,limits,cached=false,signal}=options;
 signal?.throwIfAborted();if(!paths.size)return [];
 const chunks:Buffer[]=[];
 const result=await readGit(executable,root,context.directory,['check-attr',...(cached?['--cached']:[]),'--all','-z','--stdin'],limits,signal,
  join(context.directory,'objects'),Buffer.from([...paths].join('\0')+'\0','utf8'),objects,index,chunk=>{chunks.push(chunk);});
 signal?.throwIfAborted();if(result.code!==0)return null;
 return gitAttributeRows(Buffer.concat(chunks),paths,limits.maxMetadataEntries);
}
