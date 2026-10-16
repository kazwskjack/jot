import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';import {resolve,join,relative,isAbsolute} from 'node:path';
const create=(await import('../ordinary-input-admissions.js').catch(()=>({}))).createOrdinaryInputAdmissions;
const stamp={protocol:2,run_id:'run-a',input_message_id:'product-a',conversation_id:'conv-a',owner_id:'owner-a',session_id:'session-a',session_created_at:1234,input_sha256:'a'.repeat(64),native_message_id:'native-a',native_message_sha256:'b'.repeat(64),profile_fingerprint:'c'.repeat(64)};
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


test('one immutable entry reservation fences competing original attempts without certifying model execution',async()=>{
 const base=resolve('.test-tmp');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'ordinary-entry-'));try{
 const store=create({root}),session={id:'session-a',header:{createdAt:1234}},request={session,runId:'run-a',messageId:'native-a'},one={execution_lease:{owner:'worker-a',generation:1},observer_id:'attempt-a'},two={execution_lease:{owner:'worker-b',generation:2},observer_id:'attempt-b'};
 assert.equal(store.entryReservationProtocol,1);await store.create(session,stamp);assert.deepEqual(await store.readReplayCandidate(request),stamp);const outcomes=await Promise.allSettled([store.reserveEntry(session,stamp,one),store.reserveEntry(session,stamp,two)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);const winner=outcomes[0].status==='fulfilled'?one:two;await store.reserveEntry(session,stamp,winner);await assert.rejects(store.readReplayCandidate(request),/entry_reserved/);assert.deepEqual(await store.read(request),stamp);const files=await readdir(root);assert.equal(files.filter(f=>f.endsWith('.entry.json')).length,1);const entry=JSON.parse(await readFile(join(root,files.find(f=>f.endsWith('.entry.json'))),'utf8'));assert.deepEqual(entry.execution_lease,winner.execution_lease);assert.equal(entry.observer_id,winner.observer_id);assert.equal(entry.protocol,1);assert.ok(!('model_called' in entry));assert.ok(!('usage' in entry));
 }finally{const rel=relative(base,root);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(root,{recursive:true,force:true});}
});
test('entry reservation requires the exact admitted message and cancelled reservations do not block replay',async()=>{
 const base=resolve('.test-tmp');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'ordinary-entry-denial-'));try{const store=create({root}),session={id:'session-a',header:{createdAt:1234}},attempt={execution_lease:{owner:'worker-a',generation:1},observer_id:'attempt-a'},request={session,runId:'run-a',messageId:'native-a'};await assert.rejects(store.reserveEntry(session,stamp,attempt));await store.create(session,stamp);await assert.rejects(store.reserveEntry(session,{...stamp,input_sha256:'d'.repeat(64)},attempt));await assert.rejects(store.reserveEntry(session,stamp,attempt,{signal:AbortSignal.abort()}));await assert.rejects(store.reserveEntry(session,stamp,{...attempt,owner_id:'override'}));assert.deepEqual(await store.readReplayCandidate(request),stamp);assert.equal((await readdir(root)).length,1);}finally{const rel=relative(base,root);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(root,{recursive:true,force:true});}
});


test('legacy admission receipts cannot acquire replay safety from a missing newer entry marker',async()=>{
 const base=resolve('.test-tmp');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'ordinary-entry-legacy-'));try{const store=create({root}),session={id:'session-a',header:{createdAt:1234}};await assert.rejects(store.create(session,{...stamp,protocol:1}));}finally{const rel=relative(base,root);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(root,{recursive:true,force:true});}
});
