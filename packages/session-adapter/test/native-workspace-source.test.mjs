import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {WorkbenchBridge} from '../workbench.js';
const scope={owner_id:'owner',project_id:'project',execution_id:'execution'};
function source(){
 const members=[{session_ref:'native',scopes:[{conversation_id:'conversation',workspace_id:'workspace'}],source_kinds:['work_binding']}];
 const base={reservation_id:'reservation',owner_id:'owner',project_id:'project',binding_sha256:'b'.repeat(64),members:members.map(({session_ref,scopes})=>({session_ref,scopes}))};
 return{protocol:1,...base,execution_id:'execution',family_sha256:createHash('sha256').update(JSON.stringify(base)).digest('hex'),members,execution_authorized:false};
}
function bridge(fetchImpl){return new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-source-token',fetchImpl});}
test('original bridge requests only original operation scope and returns frozen verified membership',async()=>{
 const requested={...scope};let sent;
 const client=bridge(async(url,init)=>{assert.equal(url,'http://127.0.0.1:7654/internal/v1/workbench/git-workspace-source');assert.equal(init.headers.authorization,'Bearer test-source-token');assert.equal(init.redirect,'error');sent=JSON.parse(init.body);requested.owner_id='changed';return Response.json({source:source()});});
 const result=await client.workspaceFamily(requested);assert.deepEqual(sent,scope);assert.equal(result.owner_id,'owner');assert.equal(result.execution_authorized,false);assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.members[0].scopes[0]),true);
});
test('foreign scope, fabricated grant, extra root and inconsistent digest never become host inventory',async()=>{
 for(const mutate of [s=>{s.owner_id='foreign';},s=>{s.execution_authorized=true;},s=>{s.root='untrusted';},s=>{s.members[0].scopes[0].workspace_id='changed';},s=>{s.members.push(structuredClone(s.members[0]));},s=>{s.members[0].source_kinds=['invented'];}]){
  const value=source();mutate(value);await assert.rejects(bridge(async()=>Response.json({source:value})).workspaceFamily(scope),/native_workspace_source_unconfirmed/);
 }
});
test('request selectors are strict and cancellation or HTTP failure cannot yield a cached family',async()=>{
 let calls=0;const client=bridge(async()=>{calls++;return Response.json({source:source()});});
 for(const extra of [{members:[]},{root:'untrusted'},{run_id:'borrowed'}])await assert.rejects(client.workspaceFamily({...scope,...extra}),/native_workspace_source_invalid/);
 assert.equal(calls,0);const abort=new AbortController();abort.abort();await assert.rejects(client.workspaceFamily(scope,abort.signal),{name:'AbortError'});assert.equal(calls,0);
 for(const status of [401,409,503])await assert.rejects(bridge(async()=>new Response('sensitive details',{status})).workspaceFamily(scope),/native_workspace_source_unavailable/);
 const after=new AbortController();await assert.rejects(bridge(async()=>{after.abort();return Response.json({source:source()});}).workspaceFamily(scope,after.signal),{name:'AbortError'});
});
test('oversized source streams are cancelled without returning a partial member list',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}}));
 await assert.rejects(bridge(async()=>response).workspaceFamily(scope),/native_workspace_source_unconfirmed/);assert.equal(cancelled,true);
});
