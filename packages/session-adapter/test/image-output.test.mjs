import test from 'node:test';
import assert from 'node:assert/strict';
import {commitImageResult,renderNativeResult} from '../image-output.js';
test('model-visible image metadata omits private attachment storage paths',()=>{
 const attachment={path:'/private/runtime/attachments/image.jpg',mediaType:'image/jpeg'};
 const value={ok:true,kind:'page_image_bundle',tile_count:1,images:[{tile_index:0,top:0,bottom:400,attachment}]};
 const blocks=renderNativeResult(value);
 assert.equal(blocks.filter(x=>x.type==='text').some(x=>x.text.includes(attachment.path)),false);
 assert.deepEqual(blocks.find(x=>x.type==='image').attachment,attachment);
});
test('binary image bytes become durable references and are never JSON text',async()=>{
 const calls=[];const input={ok:true,kind:'page_image_bundle',source_url:'https://example.org/item',images:[{media_type:'image/jpeg',data:Buffer.from([255,216,255,0]).toString('base64'),tile_index:0}]};
 const result=await commitImageResult(input,{saveImage:async value=>{calls.push(value);return {attachmentId:'att-one',mediaType:'image/jpeg',bytes:4,width:1,height:1}}});
 assert.equal(calls.length,1);assert.equal(calls[0].data.length,4);
 assert.equal(JSON.stringify(result).includes(input.images[0].data),false);
 const blocks=renderNativeResult(result);const images=blocks.filter(x=>x.type==='image');assert.equal(images.length,1);assert.equal(images[0].attachment.attachmentId,'att-one');
});
test('ordinary reads remain text only and invalid image payloads refuse',async()=>{
 const plain={ok:true,body_text:'正文'};assert.deepEqual(await commitImageResult(plain),plain);assert.equal(renderNativeResult(plain).length,1);
 for(const data of ['!bad',Buffer.from('text').toString('base64')])await assert.rejects(commitImageResult({ok:true,kind:'page_image_bundle',images:[{media_type:'image/jpeg',data}]},{saveImage:()=>{throw Error('must not save')}}),/IMAGE_/);
});
