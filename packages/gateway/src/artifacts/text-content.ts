import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {open,lstat} from 'node:fs/promises';

type Source={path:string;size:number;sha256:string};
type Match={offset_chars:number;match_offset_chars:number;match_text:string;excerpt:string};
const PAGE_SIZE=16384;
const identity=(stat:BigIntStats)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const boundary=(text:string,offset:number)=>offset>0&&/[\uD800-\uDBFF]/.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/.test(text[offset]!)?offset-1:offset;

/** Consumers must drain the iterator before publishing any selected text. */
async function* verifiedText(source:Source,signal?:AbortSignal){
 signal?.throwIfAborted();
 const handle=await open(source.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=await handle.stat({bigint:true});
  if(!before.isFile()||before.size!==BigInt(source.size))throw Error('artifact_content_mismatch');
  const hash=createHash('sha256'),decoder=new TextDecoder(),buffer=Buffer.alloc(65536);
  let size=0;
  for(;;){
   signal?.throwIfAborted();
   const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,source.size-size+1),null);
   if(!bytesRead)break;
   size+=bytesRead;
   if(size>source.size)throw Error('artifact_content_mismatch');
   const bytes=buffer.subarray(0,bytesRead);hash.update(bytes);
   yield decoder.decode(bytes,{stream:true});
  }
  const tail=decoder.decode();
  if(tail)yield tail;
  signal?.throwIfAborted();
  const after=await handle.stat({bigint:true}),named=await lstat(source.path,{bigint:true});
  if(size!==source.size||hash.digest('hex')!==source.sha256||!named.isFile()||named.isSymbolicLink()
   ||identity(before)!==identity(after)||identity(named)!==identity(after))throw Error('artifact_content_mismatch');
 }finally{await handle.close();}
}

export async function searchVerifiedArtifactText(source:Source,q:string,signal?:AbortSignal){
 const pattern=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
 let carry='',total=0,match:Match|undefined;
 const find=(window:string,start:number,final:boolean)=>{
  const found=pattern.exec(window);
  if(!found||!final&&found.index+found[0].length+60>window.length)return;
  const left=boundary(window,Math.max(0,found.index-60)),right=boundary(window,Math.min(window.length,found.index+found[0].length+60));
  match={offset_chars:start+left,match_offset_chars:start+found.index,match_text:found[0],excerpt:window.slice(left,right)};
 };
 for await(const text of verifiedText(source,signal)){
  if(!match){
   const window=carry+text;find(window,total-carry.length,false);
   carry=match?'':window.slice(boundary(window,Math.max(0,window.length-2*q.length-122)));
  }
  total+=text.length;
 }
 if(!match)find(carry,total-carry.length,true);
 return {total_chars:total,match};
}

export async function readVerifiedArtifactTextPage(source:Source,offset:number,signal?:AbortSignal){
 const start=Math.max(0,offset-1),stop=offset+PAGE_SIZE+1;
 let total=0,window='';
 for await(const text of verifiedText(source,signal)){
  const left=Math.max(0,start-total),right=Math.min(text.length,stop-total);
  if(right>left)window+=text.slice(left,right);
  total+=text.length;
 }
 if(offset>total||boundary(window,offset-start)!==offset-start)throw Error('artifact_text_query_invalid');
 const end=start+boundary(window,Math.min(offset+PAGE_SIZE,total)-start);
 return {offset_chars:offset,total_chars:total,text:window.slice(offset-start,end-start),
  ...(end<total?{next_offset_chars:end}:{})};
}
