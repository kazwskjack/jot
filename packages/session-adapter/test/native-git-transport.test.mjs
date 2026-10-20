import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {createNativeGitTransport,callNativeGitTransport} from '../native-git-transport.js';
const token='test-local-git-transport-token-00000001';
const scope={owner_id:'owner',project_id:'project',execution_id:'execution'};
async function fixture(perform){
 const root=await mkdtemp(join(tmpdir(),'jot-git-transport-'));await chmod(root,0o700);
 const bs=String.fromCharCode(92),socket=process.platform==='win32'?[bs,bs,'.',bs,'pipe',bs,'jot-git-test-',randomUUID()].join(''):join(root,'native.sock');
 const host=await createNativeGitTransport({socket,token,perform});
 return{host,socket,close:async()=>{await host.dispose();await rm(root,{recursive:true,force:true});}};
}
test('local transport sends only original IDs and returns the original receipt',async()=>{
 let calls=0;const f=await fixture(async(input,signal)=>{calls++;assert.deepEqual(input,scope);assert.ok(signal instanceof AbortSignal);return{state:'pending',execution_id:input.execution_id};});
 try{assert.deepEqual(await callNativeGitTransport({socket:f.socket,token},scope),{state:'pending',execution_id:'execution'});assert.equal(calls,1);}
 finally{await f.close();}
});
test('wrong authentication and injected selectors never reach native execution',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return{};});
 try{
  await assert.rejects(callNativeGitTransport({socket:f.socket,token:token+'wrong'},scope),/native_git_transport_rejected/);
  await assert.rejects(callNativeGitTransport({socket:f.socket,token},{...scope,root:'/untrusted'}),/native_git_transport_input_invalid/);
  const raw=body=>new Promise((done,reject)=>{const req=request({socketPath:f.socket,path:'/execute',method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'}},res=>{let text='';res.on('data',c=>{text+=c;});res.on('end',()=>done({status:res.statusCode,text}));});req.on('error',reject);req.end(body);});
  assert.equal((await raw(JSON.stringify({...scope,root:'/untrusted'}))).status,409);
  assert.equal((await raw('{')).status,409);
  assert.equal((await raw('x'.repeat(3000))).status,409);
  assert.equal(calls,0);
 }finally{await f.close();}
});
test('native errors are redacted and malformed endpoint settings never bind TCP',async()=>{
 await assert.rejects(createNativeGitTransport({socket:'http://127.0.0.1:7777',token,perform:async()=>({})}),/config_invalid/);
 const f=await fixture(async()=>{throw Error('private credentials or path');});
 try{await assert.rejects(callNativeGitTransport({socket:f.socket,token},scope),error=>error.message==='native_git_transport_rejected');}
 finally{await f.close();}
});
test('client cancellation propagates into the original native operation; no automatic retry',async()=>{
 let entered,observed,calls=0;const ready=new Promise(r=>{entered=r;}),cancelled=new Promise(r=>{observed=r;});
 const f=await fixture(async(_input,signal)=>{calls++;entered();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{observed();reject(signal.reason);},{once:true});});});
 try{const abort=new AbortController(),pending=callNativeGitTransport({socket:f.socket,token},scope,abort.signal);pending.catch(()=>{});await ready;abort.abort();await assert.rejects(pending);await cancelled;assert.equal(calls,1);}
 finally{await f.close();}
});
test('disposal cancels and drains in-flight execution before returning',async()=>{
 let entered,release;const ready=new Promise(r=>{entered=r;}),drain=new Promise(r=>{release=r;});
 const f=await fixture(async(_input,signal)=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await drain;throw Error('private detail');});
 try{const pending=callNativeGitTransport({socket:f.socket,token},scope);pending.catch(()=>{});await ready;let disposed=false;const disposal=f.host.dispose().then(()=>{disposed=true;});await new Promise(r=>setImmediate(r));assert.equal(disposed,false);release();await disposal;await assert.rejects(pending);}
 finally{await f.close();}
});
test('shutdown drains an authenticated incomplete request body without waiting for its client',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return{};});let req;
 try{
  req=request({socketPath:f.socket,path:'/execute',method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':'200'}},res=>res.resume());req.on('error',()=>{});req.flushHeaders();req.write('{');
  await new Promise(done=>setTimeout(done,20));await f.host.dispose();assert.equal(calls,0);
 }finally{req?.destroy();await f.close();}
});
