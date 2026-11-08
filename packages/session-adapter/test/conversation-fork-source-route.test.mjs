import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdapterHandler} from '../index.js';

const token='fork-source-adapter-token-0123456789';
const sessionId='jot-source-session';
const url=path=>new URL('http://127.0.0.1'+path);
const invoke=(handler,path='/v1/sessions/'+sessionId+'/fork-source',body={},authorization='Bearer '+token,method='POST')=>handler({method,url:url(path),headers:{authorization},body});

test('fork-source route returns a cold read-only Session snapshot and always closes its reader',async()=>{
 let opened=0,read=0,closed=0;
 const meta={id:sessionId,version:4,createdAt:1234,origin:null,parentSession:undefined,isSeeded:false};
 const events=[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'turn/end',data:{turn:1}}];
 const handler=createAdapterHandler({token,persistence:{open:async(id,mode,options)=>{
  opened++;assert.equal(id,sessionId);assert.equal(mode,'read');assert.ok(options.signal instanceof AbortSignal);
  return{header:meta,inheritedEventCount:0,read:async(start,end)=>{read++;assert.equal(start,0);assert.equal(end,undefined);return{events};},close:async()=>{closed++;}};
 }}});
 assert.equal((await invoke(handler,'/v1/sessions/'+sessionId+'/fork-source',{},'Bearer wrong')).status,401);
 assert.equal((await invoke(handler,'/v1/sessions/'+sessionId+'/fork-source',{extra:true})).status,422);
 assert.equal((await invoke(handler,'/v1/sessions/foreign%2Fsession/fork-source')).status,422);
 assert.equal((await invoke(handler,'/v1/sessions/'+sessionId+'/fork-source',{},'Bearer '+token,'GET')).status,405);
 assert.equal(opened,0);
 const result=await invoke(handler);
 assert.equal(result.status,200);
 assert.deepEqual(result.value,{execution_authorized:false,inspection:{meta,inheritedEventCount:0,events}});
 assert.equal(opened,1);assert.equal(read,1);assert.equal(closed,1);
});

test('fork-source route exposes only a sanitized error and closes after an unsuccessful read',async()=>{
 let closed=0;
 const handler=createAdapterHandler({token,persistence:{open:async()=>({header:{id:sessionId},inheritedEventCount:0,read:async()=>{throw Error('private disk path');},close:async()=>{closed++;}})}});
 const result=await invoke(handler);
 assert.equal(result.status,409);assert.deepEqual(result.value,{error:'fork_source_unconfirmed'});assert.equal(closed,1);
});
