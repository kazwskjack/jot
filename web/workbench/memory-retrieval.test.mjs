import test from 'node:test';
import assert from 'node:assert/strict';
import {retrievalMatches,retrievalSourceView,retrievalMethodLabel} from './memory-retrieval.mjs';
test('a stale role or project trace is not displayed under a new selection',()=>{
 const trace={agent_id:'a',project_id:'p'};assert.equal(retrievalMatches(trace,{agent_id:'a',project_id:'p'}),true);assert.equal(retrievalMatches(trace,{agent_id:'b',project_id:'p'}),false);assert.equal(retrievalMatches(trace,{agent_id:'a',project_id:'other'}),false);
});
test('invalidated references suppress any previously cached preview and provenance',()=>{
 const old={available:false,content_preview:'Deleted original',provenance:[{kind:'note',reference:'deleted.md'}],keyword_score:3};const view=retrievalSourceView(old,'keyword');assert.equal(view.preview,'');assert.deepEqual(view.provenance,[]);assert.equal(view.available,false);
});
test('keyword counts are never presented as adapter confidence',()=>{
 const reference={available:true,content_preview:'Current source',provenance:[],keyword_score:2};assert.equal(retrievalSourceView(reference,'keyword').keyword_count,2);assert.equal(retrievalSourceView(reference,'adapter').keyword_count,null);assert.equal(retrievalSourceView(reference,'scope_order').keyword_count,null);assert.equal(retrievalMethodLabel('keyword'),'关键词匹配');assert.equal(retrievalMethodLabel('scope_order'),'范围顺序');
});
