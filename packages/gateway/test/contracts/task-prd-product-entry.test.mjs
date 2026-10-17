import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';

test('PRD is registered on the actual product server with CSRF, read-only preview and original task binding',async t=>{
 const base=join(tmpdir(),'prd-product-entry');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));
 const csrf='test-prd-product-csrf',origin='https://fixture.invalid',server=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),csrfToken:csrf,allowedOrigins:[origin]});
 t.after(async()=>{await server.app.close();server.db.close();await rm(root,{recursive:true,force:true});});
 const role=server.workbench.createAgent('owner',{name:'PRD role'}),created=server.persistentTasks.create('owner',{agent_id:role.agent_id,title:'Original task',objective:'Deliver documented results',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 server.persistentTasks.pause('owner',created.task_id,created.version);
 const file=server.workbench.writeFile('owner','ws',{project_id:role.project_id,path:'requirements.md',content:'# Goal\nProduce a cited report.',expected_version:0});
 const source={kind:'logical_file',path:file.path,version:file.version,sha256:file.sha256},url=`/v1/persistent-tasks/${created.task_id}/prd`,headers={'x-user-id':'owner','x-csrf-token':csrf,origin};
 const listed=await server.app.inject({url:url+'/sources',headers});assert.equal(listed.statusCode,200,listed.body);
 const before=server.db.prepare('SELECT total_changes() n').get().n;
 const preview=await server.app.inject({method:'POST',url:url+'/preview',headers,payload:{source}});assert.equal(preview.statusCode,200,preview.body);
 assert.equal(server.db.prepare('SELECT total_changes() n').get().n,before,'preview never reserves generic or business writes');
 assert.equal((await server.app.inject({method:'POST',url:url+'/preview',headers:{...headers,'x-csrf-token':'wrong'},payload:{source}})).statusCode,403);
 const payload={source,preview_sha256:preview.json().preview_sha256},command={method:'POST',url:url+'/bind',headers:{...headers,'idempotency-key':'prd-product-command'},payload};
 for(const key of ['x','x'.repeat(129),'has a space']){
  const rejected=await server.app.inject({...command,headers:{...headers,'idempotency-key':key}});
  assert.equal(rejected.statusCode,422,rejected.body);
  assert.equal(server.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,0);
 }
 const receipt=await server.app.inject(command);assert.equal(receipt.statusCode,200,receipt.body);assert.equal(receipt.json().execution_authorized,false);
 assert.deepEqual((await server.app.inject(command)).json(),receipt.json());
 const task=server.persistentTasks.get('owner',created.task_id);assert.equal(task.status,'paused');assert.equal(task.runs_used,0);assert.ok(task.objective.includes('Produce a cited report.'));
 assert.equal(server.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
 assert.equal(server.db.prepare("SELECT count(*) n FROM ga_idempotency WHERE operation LIKE '%/prd/%'").get().n,0);
 const caps=(await server.app.inject({url:'/v1/capabilities',headers})).json();assert.equal(caps.workbench.task_prd,true);
});
