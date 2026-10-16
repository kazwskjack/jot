import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const verify=(await import('../native-input-attachments.js').catch(()=>({}))).verifyNativeInputAttachments;
function fixture(type='file'){
 const data=Buffer.from('original synthetic attachment'),ref={attachmentId:'sha256:'+createHash('sha256').update(data).digest('hex'),bytes:data.length,mediaType:type==='image'?'image/png':'text/plain'},messages=[{content:[{type,attachment:ref}]}];let reads=0,closed=false;
 const options={attachments:{readImage:async()=>{reads++;return{ref,data};},async *readFileStream(){reads++;try{yield data.subarray(0,3);yield data.subarray(3);}finally{closed=true;}}}};
 return{data,ref,messages,options,reads:()=>reads,closed:()=>closed};
}
test('text-only input never reads attachments and original binary refs verify without vision calls',async()=>{
 assert.equal(typeof verify,'function');assert.deepEqual(await verify([{content:[{type:'text',text:'read when needed'}]}],{}),{verified:true,attachments:0});
 for(const type of ['file','image']){const f=fixture(type);assert.deepEqual(await verify(f.messages,f.options),{verified:true,attachments:1});assert.equal(f.reads(),1);if(type==='file')assert.equal(f.closed(),true);assert.equal(JSON.stringify(await verify(f.messages,f.options)).includes('synthetic'),false);}
});
test('missing, corrupt and changed-size attachments refuse without exposing storage details',async()=>{
 assert.equal(typeof verify,'function');for(const type of ['file','image'])for(const kind of ['missing','corrupt','size','reference']){const f=fixture(type);if(kind==='missing'){f.options.attachments.readImage=async()=>{throw Error('private location');};f.options.attachments.readFileStream=async function*(){throw Error('private location');};}if(kind==='corrupt')f.data[0]^=1;if(kind==='size')f.ref.bytes++;if(kind==='reference')f.ref.attachmentId='unverified-ref';await assert.rejects(verify(f.messages,f.options),e=>e.message==='ordinary_input_attachments_unconfirmed');}
});
test('cancelled or unavailable readers never silently admit attached input',async()=>{
 assert.equal(typeof verify,'function');const f=fixture();await assert.rejects(verify(f.messages,{...f.options,signal:AbortSignal.abort()}));assert.equal(f.reads(),0);await assert.rejects(verify(f.messages,{}),/attachments_unconfirmed/);
});
test('oversized file streams close as soon as the original reference byte bound is exceeded',async()=>{
 assert.equal(typeof verify,'function');const f=fixture();let extra=false,closed=false;f.options.attachments.readFileStream=async function*(){try{yield Buffer.alloc(f.ref.bytes+1);extra=true;yield Buffer.alloc(1000000);}finally{closed=true;}};await assert.rejects(verify(f.messages,f.options),/attachments_unconfirmed/);assert.equal(extra,false);assert.equal(closed,true);
});
