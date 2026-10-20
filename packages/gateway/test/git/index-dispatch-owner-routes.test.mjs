import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';import {buildServer} from '../../src/server.ts';
async function fixture(t,options={}){
 let api;t.after(async()=>{if(api){await api.app.close();api.db.close()}});const f=await indexResolutionFixture(t),review=await f.review();
 const config={databasePath:f.database,templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],csrfToken:'test-index-dispatch-csrf',allowedOrigins:['http://127.0.0.1:3030'],gitRepositories:[{owner_id:'owner',project_id:'project',root:f.repository}],...(options.client?{nativeGitClient:options.client}:{})};api=await buildServer(config);
 const request=(method,url,payload,key='test-index-command-key',headers={})=>api.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{'x-user-id':'owner',origin:config.allowedOrigins[0],'x-csrf-token':config.csrfToken,'idempotency-key':key,...headers}});
 const admitted=await request('POST','/v1/projects/project/git/intents/'+review.approved.intent_id+'/admissions',review.input,'test-index-acceptance');assert.equal(admitted.statusCode,202,admitted.body);const id=admitted.json().execution_id,path='/v1/projects/project/git/executions/'+id;
 return{...f,...review,id,path,request,get apiDb(){return api.db},async restart(){await api.app.close();api.db.close();api=await buildServer(config)},async confirm(){const command={request_id:'original-resolution',expected_state_sha256:f.current.executions.inspect('owner','project',id).state_sha256,acknowledge_unknown:true},response=await request('POST',path+'/controls',command,'test-index-confirm');assert.equal(response.statusCode,202,response.body);return command}};
}
const noEffects=f=>{for(const table of ['wb_git_index_producers','ga_worker_leases','wb_workspace_reservations'])assert.equal(f.apiDb.prepare('SELECT count(*) n FROM '+table).get().n,0)};

test('Git capability advertises only original reviewed index actions when trusted native dispatch is configured',async t=>{
 const ordinary=await fixture(t),first=await ordinary.request('GET','/v1/capabilities');assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json().git_workbench,{configured_projects:['project'],read_only:true});noEffects(ordinary);
 const calls=[],configured=await fixture(t,{client:{async execute(input){calls.push(input)}}}),response=await configured.request('GET','/v1/capabilities');assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().git_workbench,{configured_projects:['project'],read_only:false,index_actions:['stage','unstage']});assert.deepEqual(calls,[]);noEffects(configured);
 configured.apiDb.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement','project');assert.deepEqual((await configured.request('GET','/v1/capabilities')).json().git_workbench,{configured_projects:[],read_only:true});
});
test('HTTP status distinguishes original producer and workspace drain without granting effects or adopting other owners',async t=>{
 const f=await fixture(t),before=f.apiDb.prepare('SELECT total_changes() n').get().n,response=await f.request('GET',f.path+'/status');assert.equal(response.statusCode,200,response.body);assert.equal(response.json().producer.state,'not_started');assert.equal(response.json().workspace_state,'not_reserved');assert.equal(response.json().control,null);assert.equal(response.json().execution_authorized,false);assert.match(response.headers['cache-control'],/no-store/);assert.equal(f.apiDb.prepare('SELECT total_changes() n').get().n,before);noEffects(f);
 assert.equal((await f.request('GET',f.path+'/status',undefined,undefined,{'x-user-id':'other'})).statusCode,404);assert.equal((await f.request('GET',f.path+'/status?root=caller')).statusCode,400);
});
test('peer JSON cannot manufacture an index result and lost dispatch HTTP acknowledgement never resends',async t=>{
 const calls=[],f=await fixture(t,{client:{async execute(input){calls.push(input);return{state:'applied',workspace_state:'released_settled'}}}}),before=await readFile(join(f.repository,'.git/index'));
 const response=await f.request('POST',f.path+'/dispatch',{});assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error.code,'GIT_INDEX_DISPATCH_UNCONFIRMED');assert.deepEqual(calls,[{owner_id:'owner',project_id:'project',execution_id:f.id,operation_kind:'git_index'}]);noEffects(f);
 await f.restart();assert.deepEqual((await f.request('POST',f.path+'/dispatch',{})).json(),response.json());assert.equal(calls.length,1);
 f.apiDb.prepare('UPDATE ga_idempotency SET response_status=NULL,response_json=NULL WHERE operation=?').run('POST '+f.path+'/dispatch');assert.equal((await f.request('POST',f.path+'/dispatch',{})).statusCode,409);assert.equal(calls.length,1);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);
});
test('explicit dispatch refuses roots, commands, CSRF, foreign owners and an unconfigured native client',async t=>{
 const f=await fixture(t);for(const [n,payload] of [{root:'caller'},{owner_id:'other'},{command:'git add .'}].entries())assert.equal((await f.request('POST',f.path+'/dispatch',payload,'test-dispatch-injection-'+n)).statusCode,400);
 assert.equal((await f.request('POST',f.path+'/dispatch',{},'test-invalid-csrf',{'x-csrf-token':'invalid'})).statusCode,403);assert.equal((await f.request('POST',f.path+'/dispatch',{},'test-other-owner',{'x-user-id':'other'})).statusCode,404);
 const unavailable=await f.request('POST',f.path+'/dispatch',{});assert.equal(unavailable.statusCode,503,unavailable.body);assert.equal(unavailable.json().error.code,'GIT_INDEX_DISPATCH_UNAVAILABLE');noEffects(f);
});
test('confirmed never-started resolution closes the original without a native client and replays its exact durable receipt',async t=>{
 const f=await fixture(t),command=await f.confirm(),before=await readFile(join(f.repository,'.git/index')),response=await f.request('POST',f.path+'/resolve',command);assert.equal(response.statusCode,200,response.body);const result=response.json();assert.equal(result.receipt.result.state,'not_dispatched');assert.equal(result.status.workspace_state,'not_reserved');assert.equal(result.status.producer.state,'not_started');assert.equal(result.status.execution_authorized,false);noEffects(f);
 await f.restart();assert.deepEqual((await f.request('POST',f.path+'/resolve',command)).json(),result);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_dispositions').get().n,1);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);
 assert.equal((await f.request('POST',f.path+'/dispatch',{},'test-closed-dispatch')).statusCode,409);
});
test('resolve cannot create a confirmation, replace its snapshot or mistake peer JSON for original settlement',async t=>{
 const calls=[],f=await fixture(t,{client:{async execute(input){calls.push(input);return{state:'completed'}}}}),before={request_id:'unconfirmed',expected_state_sha256:f.current.executions.inspect('owner','project',f.id).state_sha256,acknowledge_unknown:true};
 assert.equal((await f.request('POST',f.path+'/resolve',before,'test-unconfirmed-resolve')).statusCode,404);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_controls').get().n,0);
 f.current.executions.reserveWorkspace('owner','project',f.id);const command=await f.confirm();assert.equal((await f.request('POST',f.path+'/resolve',{...command,expected_state_sha256:'0'.repeat(64)},'test-changed-resolve')).statusCode,409);
 assert.equal((await f.request('POST',f.path+'/resolve',{...command,acknowledge_unknown:false},'test-unacknowledged-resolve')).statusCode,400);assert.equal(calls.length,0);
 const unresolved=await f.request('POST',f.path+'/resolve',command);assert.equal(unresolved.statusCode,503,unresolved.body);assert.equal(unresolved.json().error.code,'GIT_INDEX_DISPATCH_UNCONFIRMED');assert.deepEqual(calls,[{owner_id:'owner',project_id:'project',execution_id:f.id,operation_kind:'git_index',command}]);assert.equal(f.current.executions.getControl('owner','project',f.id,command.request_id).state,'pending');assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,0);
});
test('a known original producer failure requires reconciliation rather than dispatching a new attempt',async t=>{
 const calls=[],f=await fixture(t,{client:{async execute(input){calls.push(input)}}});f.current.workbench.indexEffects('owner','project').prepareIndex=async()=>{throw Error('synthetic_prepare_failure')};await assert.rejects(f.current.executions.perform('owner','project',f.id),/synthetic_prepare_failure/);
 const response=await f.request('POST',f.path+'/dispatch',{});assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,'GIT_INDEX_RECONCILIATION_REQUIRED');assert.equal(calls.length,0);
});
test('ownership is rechecked after native IO rather than accepting a late peer acknowledgement',async t=>{
 let f,calls=0;f=await fixture(t,{client:{async execute(){calls++;f.apiDb.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('other','project');return{state:'applied'}}}});
 const response=await f.request('POST',f.path+'/dispatch',{});assert.equal(response.statusCode,404,response.body);assert.equal(calls,1);noEffects(f);
});
test('HTTP history restores original UI acceptance after restart without browser metadata or write side effects',async t=>{
 const f=await fixture(t);await f.restart();const changes=f.apiDb.prepare('SELECT total_changes() n').get().n,path='/v1/projects/project/git/history',response=await f.request('GET',path+'?limit=1');assert.equal(response.statusCode,200,response.body);assert.equal(response.json().items.length,1);assert.equal(response.json().items[0].acceptance.execution_id,f.id);assert.equal(response.json().items[0].status.producer.state,'not_started');assert.match(response.headers['cache-control'],/no-store/);assert.equal(f.apiDb.prepare('SELECT total_changes() n').get().n,changes);
 assert.deepEqual((await f.request('GET',path+'?before='+f.id)).json().items,[]);for(const query of ['limit=0','limit=51','limit=1.5','root=caller'])assert.equal((await f.request('GET',path+'?'+query)).statusCode,400);
 assert.equal((await f.request('GET',path+'?before=unknown')).statusCode,404);assert.equal((await f.request('GET',path,undefined,undefined,{'x-user-id':'other'})).statusCode,404);noEffects(f);
});
