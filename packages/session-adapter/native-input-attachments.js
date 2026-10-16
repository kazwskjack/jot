import {createHash} from 'node:crypto';
const fail=()=>{throw Error('ordinary_input_attachments_unconfirmed');};
/** Verify only the unentered original input's binary references. This is not a
 * vision call, upload, receipt re-admission, historical rescan or authority grant. */
export async function verifyNativeInputAttachments(messages,{attachments,signal}={}){
 signal?.throwIfAborted();let count=0;
 try{
  if(!Array.isArray(messages))fail();
  for(const message of messages){if(!Array.isArray(message?.content))fail();for(const part of message.content){
   signal?.throwIfAborted();if(part?.type==='text')continue;if(!['image','file'].includes(part?.type))fail();
   const ref=part.attachment;if(!ref||!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<0)fail();
   const hash=createHash('sha256');let bytes=0;
   if(part.type==='image'){
    if(typeof attachments?.readImage!=='function')fail();const value=await attachments.readImage(ref,signal);signal?.throwIfAborted();if(!(value?.data instanceof Uint8Array))fail();bytes=value.data.byteLength;hash.update(value.data);
   }else{
    if(typeof attachments?.readFileStream!=='function')fail();for await(const chunk of attachments.readFileStream(ref,signal)){
     signal?.throwIfAborted();if(!(chunk instanceof Uint8Array))fail();bytes+=chunk.byteLength;if(bytes>ref.bytes)fail();hash.update(chunk);
    }
   }
   signal?.throwIfAborted();if(bytes!==ref.bytes||hash.digest('hex')!==ref.attachmentId.slice(7))fail();count++;
  }}
  return Object.freeze({verified:true,attachments:count});
 }catch{signal?.throwIfAborted();fail();}
}
