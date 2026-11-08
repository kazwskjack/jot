import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryReasoningClient,loadMemoryReasoningClient} from '../../src/workbench/memory-reasoning-client.ts';

const route={provider:'fixture',model:'memory-reasoner',revision:'fixture-v1',context_window:16000,max_output_tokens:2000,rates:{input:1,output:2,cache_read:1,cache_write:1}};
const config={provider:'fixture',model:'memory-reasoner',base_url:'https://reasoning.example.test/v1',api_key_file:'test-secret-file',max_input_bytes:12000,timeout_ms:5000};
const request={query:'Which hour should callers leave?',limit:1,candidates:[{memory_id:'private-memory-1',version:3,content:'The ferry stops at 18:00.'}]};
const usage={prompt_tokens:9,completion_tokens:2,total_tokens:11,prompt_tokens_details:{cached_tokens:0,cache_write_tokens:0},completion_tokens_details:{reasoning_tokens:0}};

test('configured client sends the supplied candidate set to the configured route and returns only selection IDs',async()=>{
 let call;
 const client=createMemoryReasoningClient(config,[route],{readSecret:path=>{assert.equal(path,'test-secret-file');return'test-provider-key';},fetch:async(url,init)=>{
  call={url,init};return Response.json({model:'memory-reasoner',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({selected_ids:['private-memory-1']})}}],usage});
 }});
 client.preflight(request);const result=await client.invoke(request);
 assert.deepEqual(client.route,{provider:'fixture',model:'memory-reasoner'});
 assert.equal(call.url,'https://reasoning.example.test/v1/chat/completions');assert.equal(call.init.headers.authorization,'Bearer test-provider-key');assert.equal(call.init.redirect,'error');
 const body=JSON.parse(call.init.body),payload=JSON.parse(body.messages[1].content);
 assert.equal(body.tools,undefined);assert.equal(body.stream,false);assert.equal(payload.text,request.query);assert.deepEqual(payload.direction,{selection_limit:1});
 assert.deepEqual(payload.sources,[{reference:'private-memory-1',result:{version:3,content:'The ferry stops at 18:00.'}}]);
 assert.deepEqual(result,{value:{selected_ids:['private-memory-1']},usage:{inputTokens:9,outputTokens:2,totalTokens:11,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0}});
});

test('client configuration is opt-in and configuration or secret failures expose no contents',()=>{
 let reads=0;
 assert.equal(loadMemoryReasoningClient({},[route],{readConfig:()=>{reads++;throw new Error('must not read');}}),undefined);assert.equal(reads,0);
 const enabled=loadMemoryReasoningClient({GENERAL_AGENT_MEMORY_REASONING_FILE:'reasoning-config'},[route],{
  readConfig:path=>{assert.equal(path,'reasoning-config');return JSON.stringify(config);},readSecret:()=> 'test-provider-key',fetch:async()=>Response.json({}),
 });assert.deepEqual(enabled.route,{provider:'fixture',model:'memory-reasoner'});
 assert.throws(()=>loadMemoryReasoningClient({GENERAL_AGENT_MEMORY_REASONING_FILE:'bad-config'},[route],{readConfig:()=>'{private config contents'}),/^Error: memory_reasoning_config_unavailable$/);
 assert.throws(()=>createMemoryReasoningClient(config,[route],{readSecret:()=>{throw new Error('secret path detail');}}),/^Error: memory_reasoning_secret_unavailable$/);
});

test('client rejects oversized requests before fetch and rejects non-local plain HTTP endpoints',()=>{
 let calls=0;const client=createMemoryReasoningClient({...config,max_input_bytes:256},[route],{readSecret:()=> 'test-provider-key',fetch:async()=>{calls++;throw new Error();}});
 assert.throws(()=>client.preflight({...request,candidates:[{memory_id:'large-memory',version:1,content:'x'.repeat(2000)}]}),/memory_reasoning_input_too_large/);assert.equal(calls,0);
 assert.throws(()=>createMemoryReasoningClient({...config,base_url:'http://reasoning.example.test/v1'},[route],{readSecret:()=> 'test-key'}),/memory_reasoning_config_invalid/);
});
