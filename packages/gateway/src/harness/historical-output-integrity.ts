import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import type {ResolvedAttachment} from '../artifacts/resolver.ts';
function invalid():never{throw Error('historical_output_integrity_unconfirmed');}
function safePath(root:string,path:string){
 const local=resolve(path),base=resolve(root);if(local===base||!local.startsWith(base+sep))invalid();
 for(let p=local;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())invalid();if(dirname(p)===p)break;}
 const actual=realpathSync(local),actualRoot=realpathSync(base);if(actual===actualRoot||!actual.startsWith(actualRoot+sep))invalid();return local;
}
/** Verify actual bounded bytes, not only the artifact catalog's saved hash.
 * Caller separately checks owner/conversation/version in its publication CAS. */
export function verifyHistoricalOutputBytes(root:string,items:readonly ResolvedAttachment[]){
 for(const item of items){
  if(!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<0||!Number.isSafeInteger(item.version)||Number(item.version)<1||!/^[a-f0-9]{64}$/.test(item.sha256))invalid();
  const path=safePath(root,item.localPath),fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const before=fstatSync(fd);if(!before.isFile()||before.size!==item.sizeBytes)invalid();const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;
   for(;;){const n=readSync(fd,buffer,0,Math.min(buffer.length,item.sizeBytes-total+1),total);if(!n)break;total+=n;if(total>item.sizeBytes)invalid();hash.update(buffer.subarray(0,n));}
   const after=fstatSync(fd),current=lstatSync(safePath(root,path));
   if(total!==item.sizeBytes||hash.digest('hex')!==item.sha256||!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||current.size!==after.size||current.mtimeMs!==after.mtimeMs||current.ctimeMs!==after.ctimeMs)invalid();
  }finally{closeSync(fd);}
 }
}
