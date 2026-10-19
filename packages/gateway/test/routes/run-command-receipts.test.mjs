import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';import {canonicalJson} from '../../src/db/canonical-json.ts';
const csrf='command-receipt-csrf-fixture',origin='https://fixture.invalid';
const headers={'x-user-id':'owner','x-jot-actor':'web','x-csrf-token':csrf,origin,'idempotency-key':'original-command-key'};
const options=databasePath=>({databasePath,workspaces:['ws'],templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),csrfToken:csrf,allowedOrigins:[origin]});
function seed(service){const c=service.conversations.create('owner',{workspace_id:'ws',title:'Fixture',model:{provider:'fixture',model:'work'}});return service.runs.enqueue(c.conversation_id,'owner',{client_message_id:'original-message',content:[{type:'text',text:'Fixture task'}]});}

for(const kind of ['steer','cancel'])test(kind+' and its HTTP receipt commit together; exact outcome survives reopen and current state changes',async()=>{
 const scratch=resolve(tmpdir()),root=await mkdtemp(join(scratch,'jot-command-receipt-')),database=join(root,'db.sqlite');let service;
 try{
  service=await buildServer(options(database));const run=seed(service),path='/v1/runs/'+run.run_id+'/'+kind,body=kind==='steer'?{text:'Original supplement',client_message_id:'original-supplement',expected_run_version:1}:{reason:'USER_CANCELLED',expected_run_version:1};
  const before=service.events.replay(run.conversation_id,'0',1000).length;
  service.db.exec(`CREATE TRIGGER reject_command_receipt BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.operation='POST ${path}' AND NEW.response_status=202 BEGIN SELECT RAISE(ABORT,'synthetic_receipt_failure'); END;`);
  const request=()=>service.app.inject({method:'POST',url:path,headers,payload:body});const failed=await request();assert.equal(failed.statusCode,500);
  assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,0);assert.equal(service.runs.get(run.run_id,'owner').version,1);assert.equal(service.runs.get(run.run_id,'owner').status,'queued');assert.equal(service.events.replay(run.conversation_id,'0',1000).length,before);
  const reserved=service.db.prepare('SELECT receipt_protocol,response_status FROM ga_idempotency WHERE operation=?').get('POST '+path);assert.equal(reserved.receipt_protocol,'run-command-atomic-v1');assert.equal(reserved.response_status,null);
  service.db.exec('DROP TRIGGER reject_command_receipt');const accepted=await request();assert.equal(accepted.statusCode,202,accepted.body);const original=accepted.json();assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,1);
  service.db.prepare("UPDATE ga_runs SET status='succeeded',version=version+3 WHERE id=?").run(run.run_id);const savedVersion=service.runs.get(run.run_id,'owner').version;await service.app.close();service.db.close();service=await buildServer(options(database));
  const replay=await request();assert.equal(replay.statusCode,202);assert.deepEqual(replay.json(),original);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,1);assert.equal(service.runs.get(run.run_id,'owner').version,savedVersion);
  const changed=await service.app.inject({method:'POST',url:path,headers,payload:{...body,expected_run_version:9}});assert.equal(changed.statusCode,409);assert.equal(changed.json().error.code,'IDEMPOTENCY_CONFLICT');
  const foreign=await service.app.inject({method:'POST',url:path,headers:{...headers,'x-user-id':'foreign-owner'},payload:body});assert.ok(foreign.statusCode>=400);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,1);
 }finally{if(service){await service.app.close();service.db.close();}assert.ok(root.startsWith(scratch+sep));await rm(root,{recursive:true,force:true});}
});

test('legacy unknown run-command reservations cannot be automatically adopted or replayed',async()=>{
 const service=await buildServer(options(':memory:'));
 try{const run=seed(service),body={expected_run_version:1},path='/v1/runs/'+run.run_id+'/cancel',at=new Date().toISOString();service.db.prepare('INSERT INTO ga_idempotency(owner_id,operation,idempotency_key,request_sha256,response_status,response_json,created_at,expires_at,receipt_protocol) VALUES(?,?,?,?,NULL,NULL,?,?,NULL)').run('owner','POST '+path,headers['idempotency-key'],createHash('sha256').update(canonicalJson(body)).digest('hex'),at,at);
 const response=await service.app.inject({method:'POST',url:path,headers,payload:body});assert.equal(response.statusCode,409);assert.equal(response.json().error.code,'IDEMPOTENCY_IN_PROGRESS');assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,0);assert.equal(service.runs.get(run.run_id,'owner').status,'queued');
 }finally{await service.app.close();service.db.close();}
});
