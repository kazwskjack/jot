import {createHash} from 'node:crypto'
import {openSync,closeSync,readSync,fstatSync,lstatSync,type Stats} from 'node:fs'

export const signature=(value:Stats)=>({dev:value.dev,ino:value.ino,size:value.size,mtimeMs:value.mtimeMs,ctimeMs:value.ctimeMs})
export function currentFileHashes(path:string){
 const fd=openSync(path,'r');try{
  const before=fstatSync(fd);if(!before.isFile())return null
  const sha=createHash('sha256'),legacy=createHash('md5'),buffer=Buffer.alloc(64*1024)
  for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;sha.update(buffer.subarray(0,count));legacy.update(buffer.subarray(0,count))}
  const after=fstatSync(fd),named=lstatSync(path)
  if(!named.isFile()||named.isSymbolicLink()||JSON.stringify(signature(before))!==JSON.stringify(signature(after))
   ||JSON.stringify(signature(named))!==JSON.stringify(signature(after)))return null
  return {size:after.size,sha256:sha.digest('hex'),md5:legacy.digest('hex'),signature:signature(after)}
 }finally{closeSync(fd)}
}
