import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
const output=new URL('../../.test-tmp/review-output-client/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./review-output-client.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',outfile:new URL('client.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {reviewOutputPath,reviewOutputList,reviewOutputPreview,reviewPreviewKind,reviewOutputBytes}=await import(new URL('client.mjs',output));
const {reviewOutputPage}=await import(new URL('client.mjs',output));
const content='<script>globalThis.reviewExecuted=true</script>',hash=createHash('sha256').update(content).digest('hex');
const item={output_index:0,source:'workspace',file_name:'review.html',version:1,size_bytes:Buffer.byteLength(content),sha256:hash,mime_type:'text/html',download_url:'/v1/interactions/int-1/outputs/0'};

test('review metadata uses only the owned interaction selector and rejects redirect or mutable file paths',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({items:[item]});};
 const signal=new AbortController().signal;assert.deepEqual(await reviewOutputList('int-1',signal),[item]);assert.equal(calls[0].url,'/workbench-api/v1/interactions/int-1/outputs');assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.cache,'no-store');
 for(const changed of [{...item,download_url:'https://foreign.invalid/file'},{...item,download_url:'/v1/artifacts/other/download'},{...item,output_index:2}]){globalThis.fetch=async()=>Response.json({items:[changed]});await assert.rejects(reviewOutputList('int-1',signal),/review_output_list_invalid/);}
 for(const selector of ['../path','int-1?version=2'])assert.throws(()=>reviewOutputPath(selector,0));
});

test('HTML and SVG are verified plain text, never executable embedded previews',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;delete globalThis.reviewExecuted;});
 globalThis.fetch=async()=>new Response(content);const value=await reviewOutputPreview('int-1',item,new AbortController().signal);assert.deepEqual(value,{kind:'text',text:content});assert.equal(globalThis.reviewExecuted,undefined);
 assert.equal(reviewPreviewKind({...item,mime_type:'image/svg+xml'}),'text');assert.equal(reviewPreviewKind({...item,mime_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'download');assert.equal(reviewPreviewKind({...item,size_bytes:300000}),'download');
});

test('changed bytes, failed ownership or expiry cannot become a preview',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const signal=new AbortController().signal;
 globalThis.fetch=async()=>new Response('Different content');await assert.rejects(reviewOutputPreview('int-1',item,signal),/review_output_integrity_failed/);
 for(const status of [403,404,409,410,429]){globalThis.fetch=async()=>new Response('{}',{status});await assert.rejects(reviewOutputPreview('int-1',item,signal),error=>error.status===status);}
});

test('verified downloads return exact bytes and oversized streams are cancelled immediately',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const signal=new AbortController().signal;
 globalThis.fetch=async()=>new Response(content);assert.equal(Buffer.from(await reviewOutputBytes('int-1',item,signal)).toString(),content);
 let cancelled=false;globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(item.size_bytes+1));},cancel(){cancelled=true;}}));
 await assert.rejects(reviewOutputBytes('int-1',item,signal),/review_output_integrity_failed/);assert.equal(cancelled,true);
 globalThis.fetch=async()=>new Response(content.slice(0,-1));await assert.rejects(reviewOutputBytes('int-1',item,signal),/review_output_integrity_failed/);
 const aborted=new AbortController();aborted.abort();globalThis.fetch=async()=>new Response(content);await assert.rejects(reviewOutputBytes('int-1',item,aborted.signal),error=>error.name==='AbortError');
});

test('complete isolated review inventory stays in the original owned list and rejects unsafe or authoritative projections',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const signal=new AbortController().signal;
 const manifest={protocol:1,provider:'snapshot-copy',paths:['report.md'],entries:[{path:'report.md',kind:'file',bytes:4,sha256:hash,executable:false}]};
 const work={protocol:1,source:'isolated',grant_id:'grant',work_occurrence_id:'occ',cycle_id:'cycle',snapshot_id:'snapshot',selected_objective:'Selected original plan',
  ...Object.fromEntries(['source_sha256','source_record_sha256','plans_sha256','paths_sha256','call_set_sha256','inspection_sha256'].map(k=>[k,hash])),base_manifest:manifest,result_manifest:manifest,
  diff:{protocol:1,base_sha256:hash,result_sha256:hash,diff_sha256:hash,changes:[],execution_authorized:false},execution_authorized:false};
 let path;globalThis.fetch=async url=>{path=url;return Response.json({items:[item],work_review:work});};
 assert.deepEqual((await reviewOutputPage('int-1',signal)).work_review,work);assert.equal(path,'/workbench-api/v1/interactions/int-1/outputs');
 for(const mutate of [v=>v.execution_authorized=true,v=>v.diff.execution_authorized=true,v=>v.result_manifest.entries[0].path='../secret',v=>v.base_manifest.entries[0].bytes=-1,v=>v.diff.changes=[{kind:'rename',from:'/private',path:'report.md'}]]){
  const changed=structuredClone(work);mutate(changed);globalThis.fetch=async()=>Response.json({items:[item],work_review:changed});
  await assert.rejects(reviewOutputPage('int-1',signal),/review_work_evidence_invalid/);
 }
});
