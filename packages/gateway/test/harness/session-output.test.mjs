import test from 'node:test';
import assert from 'node:assert/strict';
const output=await import('../../src/harness/session-output.ts').catch(()=>({}));

test('shared native output preserves final text and reasoning without accepting stream chunks as settled output',()=>{
 assert.equal(typeof output.assistantText,'function');
 const event={type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'Synthetic reasoning'},{type:'text',text:' First '},{type:'image',url:'fixture'},{type:'text',text:'answer '}]}}};
 assert.equal(output.assistantText(event),'First answer');
 assert.deepEqual(output.assistantBlocks(event),[{kind:'reasoning',text:'Synthetic reasoning'},{kind:'text',text:' First '},{kind:'text',text:'answer '}]);
 assert.equal(output.assistantText({...event,type:'assistant/chunk'}),'');
 assert.deepEqual(output.assistantBlocks({type:'assistant/message',data:{message:{content:null}}}),[]);
});

test('structured completed outputs retain artifact references while prose and unfinished jobs do not',()=>{
 assert.equal(typeof output.collectArtifactRefs,'function');const refs=new Set();
 output.collectArtifactRefs({nested:[JSON.stringify({status:'completed',output_version:2,artifact_ref:'artifact-first'}),{version:1,sha256:'fixture-hash',media_type:'text/plain',size_bytes:0,artifact_ref:'artifact-receipt'},{status:'pending',artifact_ref:'artifact-pending'},{status:'failed',artifact_ref:'artifact-failed'},'artifact-prose']},refs);
 assert.deepEqual([...refs],['artifact-first','artifact-receipt']);
 output.collectArtifactRefs({status:'completed',output_version:1,artifact_ref:'artifact-first'},refs);assert.equal(refs.size,2);
});

test('file presentation keeps exact paths and descriptions for later owner/integrity validation',()=>{
 assert.equal(typeof output.presentedFiles,'function');
 const event={type:'deliverables/presented',data:{files:[{path:'outputs/report.pdf',description:'Summary'},{path:'outputs/chart.png',description:''},{path:''},{path:42},null]}};
 assert.deepEqual(output.presentedFiles(event),[{path:'outputs/report.pdf',description:'Summary'},{path:'outputs/chart.png'}]);
 assert.deepEqual(output.presentedFiles({...event,type:'tool/result'}),[]);
});
