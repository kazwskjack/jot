import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';
const bytes=Buffer.from('Upload recovery fixture.'),sha=createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const directory=resolve('.test-tmp',`upload-recovery-${randomUUID()}`);mkdirSync(directory,{recursive:true});
 const service=await buildServer({databasePath:join(directory,'product.sqlite'),workspaces:['shared'],uploadRoot:join(directory,'uploads'),templateRoot:resolve('file-engine/templates'),csrfToken:'test-upload-recovery-auth',allowedOrigins:['http://localhost:3058']});
 t.after(async()=>{await service.app.close();service.db.close();});
 const conversation=service.conversations.create('test-owner',{workspace_id:'shared',model:{provider:'fixture',model:'fixture'}});
 const headers=key=>({'x-user-id':'test-owner',origin:'http://localhost:3058','x-csrf-token':'test-upload-recovery-auth','idempotency-key':key});
 const init=()=>service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/uploads`,headers:headers('test-upload-init'),payload:{file_name:'sample.txt',size_bytes:bytes.length,media_type:'text/plain',sha256:sha}});
 const put=id=>service.app.inject({method:'PUT',url:`/v1/uploads/${id}/content`,headers:{...headers('test-upload-content'),'content-type':'application/octet-stream'},payload:bytes});
 const complete=id=>service.app.inject({method:'POST',url:`/v1/uploads/${id}/complete`,headers:headers('test-upload-complete'),payload:{sha256:sha}});
 const fail=(status,key)=>service.db.exec(`CREATE TRIGGER test_receipt_failure BEFORE UPDATE ON ga_idempotency WHEN NEW.response_status=${status} AND OLD.idempotency_key='${key}' BEGIN SELECT RAISE(ABORT,'test_receipt_failure');END;`);
 return {service,directory,init,put,complete,fail};
}
test('init business row rolls back with a failed durable receipt; the original request can recover',async t=>{
 const f=await fixture(t);f.fail(201,'test-upload-init');assert.equal((await f.init()).statusCode,500);
 assert.equal(f.service.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,0);
 f.service.db.exec('DROP TRIGGER test_receipt_failure');const first=await f.init();assert.equal(first.statusCode,201,first.body);assert.equal((await f.init()).body,first.body);assert.equal(f.service.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,1);
});
test('content completion and its receipt commit together; a receipt failure does not strand uploaded state',async t=>{
 const f=await fixture(t),id=(await f.init()).json().upload_id;f.fail(204,'test-upload-content');assert.equal((await f.put(id)).statusCode,500);
 const row=f.service.db.prepare('SELECT status,server_path FROM ga_uploads WHERE id=?').get(id);assert.equal(row.status,'created');assert.equal(existsSync(row.server_path),false);
 f.service.db.exec('DROP TRIGGER test_receipt_failure');assert.equal((await f.put(id)).statusCode,204);assert.equal((await f.put(id)).statusCode,204);assert.equal((await f.complete(id)).statusCode,201);
});
test('complete receipt failure rolls back registration; renamed bytes recover without a new artifact',async t=>{
 const f=await fixture(t),id=(await f.init()).json().upload_id;assert.equal((await f.put(id)).statusCode,204);f.fail(201,'test-upload-complete');assert.equal((await f.complete(id)).statusCode,500);
 assert.equal(f.service.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,0);assert.equal(f.service.db.prepare('SELECT status FROM ga_uploads WHERE id=?').get(id).status,'uploaded');
 f.service.db.exec('DROP TRIGGER test_receipt_failure');const restored=await f.complete(id);assert.equal(restored.statusCode,201,restored.body);assert.equal((await f.complete(id)).body,restored.body);assert.equal(f.service.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,1);assert.equal(readdirSync(join(f.directory,'uploads/ready/uploads')).length,1);
});
test('unregistered final bytes after a failed DB commit must match the declared content',async t=>{
 const f=await fixture(t),id=(await f.init()).json().upload_id;await f.put(id);
 f.service.db.exec("CREATE TRIGGER test_artifact_failure BEFORE INSERT ON ga_artifacts BEGIN SELECT RAISE(ABORT,'test_artifact_failure');END;");
 assert.throws(()=>f.service.artifacts.complete(id,'test-owner',{sha256:sha}),/test_artifact_failure/);f.service.db.exec('DROP TRIGGER test_artifact_failure');
 const directory=join(f.directory,'uploads/ready/uploads'),path=join(directory,readdirSync(directory)[0]);writeFileSync(path,'altered bytes');
 assert.throws(()=>f.service.artifacts.complete(id,'test-owner',{sha256:sha}),/upload_content_mismatch/);assert.equal(f.service.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,0);
});
test('legacy unknown upload commands are not re-executed and a live partial writer is not reset',async t=>{
 const f=await fixture(t),initialized=await f.init(),id=initialized.json().upload_id;
 f.service.db.prepare('UPDATE ga_idempotency SET response_status=NULL,response_json=NULL,receipt_protocol=NULL WHERE idempotency_key=?').run('test-upload-init');
 const legacy=await f.init();assert.equal(legacy.statusCode,409);assert.equal(legacy.json().error.code,'IDEMPOTENCY_IN_PROGRESS');assert.equal(f.service.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,1);
 f.service.db.exec("CREATE TRIGGER test_content_pause BEFORE UPDATE ON ga_idempotency WHEN NEW.response_status=204 BEGIN SELECT RAISE(ABORT,'test_content_pause');END;");await f.put(id);f.service.db.exec('DROP TRIGGER test_content_pause');
 const row=f.service.db.prepare('SELECT server_path FROM ga_uploads WHERE id=?').get(id);writeFileSync(row.server_path,'partial');f.service.db.prepare("UPDATE ga_uploads SET status='uploading' WHERE id=?").run(id);
 const held=await f.put(id);assert.equal(held.statusCode,409);assert.equal(f.service.db.prepare('SELECT status FROM ga_uploads WHERE id=?').get(id).status,'uploading');assert.equal(existsSync(row.server_path),true);
});
test('accepted upload receipts are durable before later response hooks and keep owner and request isolation',async t=>{
 const f=await fixture(t);let receiptInHook;
 f.service.app.addHook('onSend',async(request,reply,payload)=>{if(request.url.endsWith('/uploads'))receiptInHook=f.service.db.prepare('SELECT response_status,response_json FROM ga_idempotency WHERE idempotency_key=?').get('test-upload-init');return payload;});
 const initialized=await f.init();assert.equal(initialized.statusCode,201);assert.equal(receiptInHook.response_status,201);assert.deepEqual(JSON.parse(receiptInHook.response_json),initialized.json());
 const id=initialized.json().upload_id;await f.put(id);const completed=await f.complete(id);assert.equal(completed.statusCode,201);
 assert.deepEqual(f.service.artifacts.complete(id,'test-owner',{sha256:sha}),completed.json());
 assert.throws(()=>f.service.artifacts.complete(id,'other-owner',{sha256:sha}),/upload_not_found/);
 assert.throws(()=>f.service.artifacts.complete(id,'test-owner',{sha256:'0'.repeat(64)}),/upload_sha256_mismatch/);
});
test('only an expired identified writer can be replaced; generations never overwrite each other',async t=>{
 const f=await fixture(t),id=(await f.init()).json().upload_id;
 // Reserve a current-protocol request through a reversible receipt failure.
 f.fail(204,'test-upload-content');await f.put(id);f.service.db.exec('DROP TRIGGER test_receipt_failure');
 const old=f.service.db.prepare('SELECT server_path FROM ga_uploads WHERE id=?').get(id).server_path;writeFileSync(old,'partial old generation');
 f.service.db.prepare("UPDATE ga_uploads SET status='uploading',writer_token='test-expired-writer',writer_lease_until=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),id);
 assert.equal((await f.put(id)).statusCode,204);
 const current=f.service.db.prepare('SELECT status,server_path,writer_token FROM ga_uploads WHERE id=?').get(id);assert.equal(current.status,'uploaded');assert.notEqual(current.server_path,old);assert.equal(current.writer_token,null);assert.equal(existsSync(old),true);assert.equal((await f.complete(id)).statusCode,201);
});
test('a resumed obsolete stream cannot commit or remove a replacement writer file',async t=>{
 const f=await fixture(t),id=(await f.init()).json().upload_id;let release,started;
 const pause=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
 async function* stream(){yield bytes.subarray(0,5);started();await pause;yield bytes.subarray(5);}
 const old=f.service.artifacts.writeContent(id,'test-owner',stream()),rejected=assert.rejects(old,/upload_writer_lost/);await ready;
 f.service.db.prepare('UPDATE ga_uploads SET writer_lease_until=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),id);
 async function* replacement(){yield bytes;}
 await f.service.artifacts.writeContent(id,'test-owner',replacement());const replacementPath=f.service.db.prepare('SELECT server_path FROM ga_uploads WHERE id=?').get(id).server_path;
 release();await rejected;assert.equal(existsSync(replacementPath),true);assert.equal(f.service.db.prepare('SELECT status FROM ga_uploads WHERE id=?').get(id).status,'uploaded');assert.equal((await f.complete(id)).statusCode,201);
});
for(const stage of ['init','content','complete'])test(`a real process exit during ${stage} receipt commit recovers after reopening the DB`,async t=>{
 const directory=resolve('.test-tmp',`upload-exit-${randomUUID()}`);mkdirSync(directory,{recursive:true});
 const script=fileURLToPath(new URL('./fixtures/upload-exit.mjs',import.meta.url));
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[script,directory,stage],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:directory,TMP:directory,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',part=>{if(error.length<2000)error+=part.toString();});child.stdout.resume();
  const timer=setTimeout(()=>{child.kill();reject(new Error('fixture_exit_timeout'));},20000);
  child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,error});});
 });assert.equal(result.code,91,result.error);
 const service=await buildServer({databasePath:join(directory,'product.sqlite'),workspaces:['shared'],uploadRoot:join(directory,'uploads'),templateRoot:resolve('file-engine/templates'),csrfToken:'test-upload-recovery-auth',allowedOrigins:['http://localhost:3058']});t.after(async()=>{await service.app.close();service.db.close();});service.db.exec('DROP TRIGGER test_exit');
 const headers=key=>({'x-user-id':'test-owner',origin:'http://localhost:3058','x-csrf-token':'test-upload-recovery-auth','idempotency-key':key}),conversation=service.db.prepare('SELECT id FROM ga_conversations').get().id;
 let id=service.db.prepare('SELECT id FROM ga_uploads').get()?.id;
 if(stage==='init'){assert.equal(id,undefined);const receipt=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation}/uploads`,headers:headers('test-upload-init'),payload:{file_name:'sample.txt',size_bytes:bytes.length,media_type:'text/plain',sha256:sha}});assert.equal(receipt.statusCode,201,receipt.body);id=receipt.json().upload_id;}
 const put=()=>service.app.inject({method:'PUT',url:`/v1/uploads/${id}/content`,headers:{...headers('test-upload-content'),'content-type':'application/octet-stream'},payload:bytes});
 if(stage==='content'){
  assert.equal((await put()).statusCode,409);assert.equal(service.db.prepare('SELECT status FROM ga_uploads WHERE id=?').get(id).status,'uploading');
  // Simulate elapsed lease time only in this isolated fixture after the writer
  // process exited; production waits for its actual five-minute expiry.
  service.db.prepare('UPDATE ga_uploads SET writer_lease_until=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),id);
 }
 if(stage!=='complete')assert.equal((await put()).statusCode,204);
 const complete=()=>service.app.inject({method:'POST',url:`/v1/uploads/${id}/complete`,headers:headers('test-upload-complete'),payload:{sha256:sha}}),first=await complete();assert.equal(first.statusCode,201,first.body);assert.equal((await complete()).body,first.body);
 assert.equal(service.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,1);
});
