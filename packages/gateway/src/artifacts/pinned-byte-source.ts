import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,lstat,open,unlink,rmdir} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import type {FileHandle} from 'node:fs/promises';

export type PinnedByteSource=Readonly<{sha256:string;sizeBytes:number;stream(signal?:AbortSignal):AsyncGenerator<Buffer>}>;
type Writer={source:PinnedByteSource;append(bytes:Buffer):Promise<void>;seal():Promise<void>;dispose():Promise<void>};

/** Operator-private spool only. Files are unlinked while the descriptor is open:
 * no model workspace path, persistent copy, receipt or execution authority. */
export function createPinnedByteStore(root:string){
 if(typeof root!=='string'||!isAbsolute(root))throw Error('attachment_snapshot_root_invalid');
 const writers:Writer[]=[];let disposed=false;
 return{
  async begin(sha256:string,sizeBytes:number,signal?:AbortSignal){
   if(disposed)throw Error('attachment_source_closed');signal?.throwIfAborted();
   await mkdir(root,{recursive:true,mode:0o700});const parent=await lstat(root);if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('attachment_snapshot_root_invalid');
   const directory=await mkdtemp(join(root,'input-')),path=join(directory,'bytes');let file:FileHandle|undefined;
   try{file=await open(path,'wx+',0o600);await unlink(path);await rmdir(directory);}
   catch{await file?.close();await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(directory).catch(error=>{if(error.code!=='ENOENT')throw error;});throw Error('attachment_snapshot_unavailable');}
   const handle=file;let closed=false,sealed=false,reading=false,written=0;const checksum=createHash('sha256');
   const assertOpen=()=>{if(closed||disposed)throw Error('attachment_source_closed');};
   const source:PinnedByteSource=Object.freeze({sha256,sizeBytes,async *stream(signal?:AbortSignal){
    assertOpen();signal?.throwIfAborted();if(!sealed)throw Error('attachment_source_unsealed');if(reading)throw Error('attachment_source_busy');reading=true;
    try{let position=0;const hash=createHash('sha256');while(position<sizeBytes){assertOpen();signal?.throwIfAborted();const bytes=Buffer.allocUnsafe(Math.min(65536,sizeBytes-position)),value=await handle.read(bytes,0,bytes.length,position);assertOpen();signal?.throwIfAborted();if(value.bytesRead<1)throw Error('attachment_source_integrity_failed');position+=value.bytesRead;const chunk=bytes.subarray(0,value.bytesRead);hash.update(chunk);yield chunk;}
     assertOpen();signal?.throwIfAborted();if(hash.digest('hex')!==sha256)throw Error('attachment_source_integrity_failed');
    }finally{reading=false;}
   }});
   const writer:Writer={source,async append(bytes){assertOpen();if(sealed||written+bytes.length>sizeBytes)throw Error('attachment_source_integrity_failed');signal?.throwIfAborted();let offset=0;while(offset<bytes.length){const result=await handle.write(bytes,offset,bytes.length-offset,written+offset);if(result.bytesWritten<1)throw Error('attachment_source_integrity_failed');offset+=result.bytesWritten;}written+=bytes.length;checksum.update(bytes);},async seal(){assertOpen();signal?.throwIfAborted();if(sealed||written!==sizeBytes||checksum.digest('hex')!==sha256)throw Error('attachment_source_integrity_failed');await handle.sync();if((await handle.stat()).size!==sizeBytes)throw Error('attachment_source_integrity_failed');sealed=true;},async dispose(){if(closed)return;closed=true;await handle.close();}};
   writers.push(writer);signal?.throwIfAborted();return writer;
  },
  sources:()=>Object.freeze(writers.map(writer=>writer.source)),
  async dispose(){if(disposed)return;disposed=true;await Promise.all(writers.map(writer=>writer.dispose()));}
 };
}
