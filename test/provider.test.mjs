import test from 'node:test';
import assert from 'node:assert/strict';
import {modelProvider} from '../src/provider.mjs';

test('provider decodes split UTF-8 and collects fragmented tool arguments',async()=>{
  const original=globalThis.fetch;
  const frames=[{choices:[{delta:{content:'你好',tool_calls:[{index:0,id:'call-1',function:{name:'file_write',arguments:'{"name":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"test.md","text":"ok"}'}}]},finish_reason:'tool_calls'}]}];
  const bytes=new TextEncoder().encode(frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n');let i=0;
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(c){if(i<bytes.length)c.enqueue(bytes.slice(i,i+=1));else c.close();}}),{status:200});
  try {let text='';const result=await modelProvider({baseUrl:'https://provider.example/v1',model:'test'})([],[],new AbortController().signal,s=>text+=s);assert.equal(text,'你好');assert.equal(result.tool_calls[0].id,'call-1');assert.equal(JSON.parse(result.tool_calls[0].function.arguments).name,'test.md');}
  finally {globalThis.fetch=original;}
});

test('provider refuses incomplete streams instead of reporting success',async()=>{
  const original=globalThis.fetch;globalThis.fetch=async()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  try {await assert.rejects(()=>modelProvider({baseUrl:'https://provider.example/v1',model:'test'})([],[],new AbortController().signal),/incomplete/);}finally{globalThis.fetch=original;}
});

test('provider refuses a truncated or filtered answer even when the stream ends normally',async()=>{
  const original=globalThis.fetch;
  try {
    for(const reason of ['length','content_filter']){
      globalThis.fetch=async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:'unfinished'},finish_reason:reason}]})}\n\ndata: [DONE]\n\n`);
      await assert.rejects(()=>modelProvider({baseUrl:'https://provider.example/v1',model:'test'})([],[],new AbortController().signal),/model_(output_truncated|content_filtered)/);
    }
  }finally{globalThis.fetch=original;}
});

test('provider rejects incomplete tool calls instead of exposing them as executable operations',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file_write","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  try {await assert.rejects(()=>modelProvider({baseUrl:'https://provider.example/v1',model:'test'})([],[],new AbortController().signal),/model_tool_call_invalid/);}finally{globalThis.fetch=original;}
});
