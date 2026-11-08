import test from 'node:test';
import assert from 'node:assert/strict';
import {registerConversationForkContextRoute} from '../../src/harness/conversation-fork-routes.ts';

test('fork-context handler mounts without fork capability and authenticates before validating its body',async()=>{
 const routes=new Map(),app={post:(path,handler)=>routes.set(path,handler)},token='fork-context-unit-token-0123456789';
 registerConversationForkContextRoute(app,{db:{},token});
 const handler=routes.get('/internal/v1/workbench/ordinary-fork-context');assert.equal(typeof handler,'function');
 const reply={statusCode:200,body:undefined,code(status){this.statusCode=status;return this;},send(body){this.body=body;return body;}};
 const invoke=(authorization,body)=>handler({headers:{authorization},body},reply);
 await invoke('Bearer wrong',{});assert.equal(reply.statusCode,401);assert.deepEqual(reply.body,{error:{code:'UNAUTHORIZED'}});
 reply.statusCode=200;reply.body=undefined;
 await invoke('Bearer '+token,{});assert.equal(reply.statusCode,422);assert.deepEqual(reply.body,{error:{code:'FORK_CONTEXT_INPUT_INVALID'}});
});
