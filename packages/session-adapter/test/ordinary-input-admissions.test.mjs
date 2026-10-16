import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';import {resolve,join,relative,isAbsolute} from 'node:path';
const create=(await import('../ordinary-input-admissions.js').catch(()=>({}))).createOrdinaryInputAdmissions;
const stamp={protocol:1,run_id:'run-a',input_message_id:'product-a',conversation_id:'conv-a',owner_id:'owner-a',session_id:'session-a',session_created_at:1234,input_sha256:'a'.repeat(64),native_message_id:'native-a',native_message_sha256:'b'.repeat(64),profile_fingerprint:'c'.repeat(64)};
test('admission storage preserves a write-once original receipt without message or attachment bodies',async()=>{
 assert.equal(typeof create,'function');const base=resolve('.test-tmp');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'ordinary-admissions-'));
 try{const store=create({root}),session={id:'session-a',header:{createdAt:1234}},request={session,runId:'run-a',messageId:'native-a'};await assert.rejects(store.read(request));await store.create(session,stamp);assert.deepEqual(await store.read(request),stamp);await Promise.all([store.create(session,stamp),store.create(session,{...stamp})]);await assert.rejects(store.create(session,{...stamp,native_message_sha256:'d'.repeat(64)}),/conflict/);
  await assert.rejects(store.read({...request,runId:'run-b'}));await assert.rejects(store.read({...request,session:{...session,header:{createdAt:1235}}}));await store.create(session,{...stamp,run_id:'run-b'});assert.equal((await store.read({...request,runId:'run-b'})).run_id,'run-b');assert.deepEqual(await store.read(request),stamp);
  const files=await readdir(root);assert.equal(files.length,2);for(const file of files){assert.match(file,/^[a-f0-9]{64}\.json$/);const value=JSON.parse(await readFile(join(root,file),'utf8'));assert.ok(!('content' in value));assert.ok(!('message' in value));}
  await writeFile(join(root,'.pending-orphan'),'{');await store.create(session,stamp);assert.deepEqual(await store.read(request),stamp);
 }finally{const rel=relative(base,root);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(root,{recursive:true,force:true});}
});
test('admission storage rejects extra content, scope mismatch, malformed identifiers and cancellation',async()=>{
 assert.equal(typeof create,'function');const root=resolve('.test-tmp/unused-admission-invalid'),store=create({root}),session={id:'session-a',header:{createdAt:1234}};
 for(const value of [{...stamp,text:'never persist user text'},{...stamp,session_id:'other'},{...stamp,session_created_at:1235},{...stamp,run_id:'../escape'},{...stamp,input_sha256:'bad'}])await assert.rejects(store.create(session,value));
 await assert.rejects(store.create(session,stamp,{signal:AbortSignal.abort()}));assert.throws(()=>create({root:'relative'}));
});
