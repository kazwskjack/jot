import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile,stat,readdir,writeFile,unlink} from 'node:fs/promises';import {join,relative} from 'node:path';
import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';
test('preparing a repeated stage must not freshen an existing source blob or invalidate its own approved snapshot',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),e=f.current.executions;assert.equal((await e.perform('owner','project',accepted.execution_id)).state,'applied');
 const snapshot=await f.current.workbench.inspect('owner','project'),review=await f.current.intents.prepare('owner','project',{request_id:'unstage-review',action:'unstage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),approved=await f.current.intents.control('owner','project',review.intent_id,{request_id:'unstage-approve',expected_version:1,review_sha256:review.review_sha256,action:'approve'});
 assert.equal((await e.execute('owner','project',review.intent_id,{request_id:'unstage-execute',expected_version:approved.version,review_sha256:approved.review_sha256})).state,'applied');
 const third=await f.review(),source=f.current.intents.executionSource('owner','project',third.approved.intent_id,third.approved.version,third.approved.review_sha256),bytes=await readFile(join(f.repository,'note.txt')),oid=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),object=join(f.repository,'.git','objects',oid.slice(0,2),oid.slice(2)),index=await readFile(join(f.repository,'.git/index'));
 const stamp=async()=>{const s=await stat(object,{bigint:true});return[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].map(String)},before=await stamp();let failure;
 try{await f.current.workbench.indexEffects('owner','project').prepareIndex(source.witness,'stage')}catch(error){failure=error}
 assert.deepEqual(await stamp(),before,'preparation must not touch the existing source object');assert.deepEqual(await readFile(join(f.repository,'.git/index')),index);if(failure)throw failure;
});

async function objectStamps(root){const result={},queue=[join(root,'.git','objects')];while(queue.length){const dir=queue.pop();for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())queue.push(path);else{const s=await stat(path,{bigint:true});result[relative(root,path)]=[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].map(String)}}}return result}
for(const [objectFormat,packed] of [['sha1',true],['sha256',false],['sha256',true]])test('planning source objects remain unchanged for '+objectFormat+' '+(packed?'packed':'loose')+' repeated stages',async t=>{
 const f=await indexResolutionFixture(t,{objectFormat}),{accepted}=await f.admit(),e=f.current.executions;assert.equal((await e.perform('owner','project',accepted.execution_id)).state,'applied');
 const snapshot=await f.current.workbench.inspect('owner','project'),review=await f.current.intents.prepare('owner','project',{request_id:'undo-review',action:'unstage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),approved=await f.current.intents.control('owner','project',review.intent_id,{request_id:'undo-approve',expected_version:1,review_sha256:review.review_sha256,action:'approve'});
 assert.equal((await e.execute('owner','project',review.intent_id,{request_id:'undo-execute',expected_version:approved.version,review_sha256:approved.review_sha256})).state,'applied');
 const bytes=await readFile(join(f.repository,'note.txt')),oid=createHash(objectFormat).update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 if(packed){f.git('update-ref','refs/test/keep',oid);f.git('gc','--prune=now');assert.ok((await readdir(join(f.repository,'.git','objects','pack'))).some(name=>name.endsWith('.pack')))}
 const third=await f.review(),source=f.current.intents.executionSource('owner','project',third.approved.intent_id,third.approved.version,third.approved.review_sha256),before=await objectStamps(f.repository),index=await readFile(join(f.repository,'.git/index'));
 await f.current.workbench.indexEffects('owner','project').prepareIndex(source.witness,'stage');assert.deepEqual(await objectStamps(f.repository),before);assert.deepEqual(await readFile(join(f.repository,'.git/index')),index);
});

test('isolated planning preserves original hash-object behavior when working attributes are absent',async t=>{
 const f=await indexResolutionFixture(t);await writeFile(join(f.repository,'.gitattributes'),'*.txt text eol=lf\n');f.git('add','.gitattributes');f.git('commit','-m','Synthetic indexed attributes');await unlink(join(f.repository,'.gitattributes'));await writeFile(join(f.repository,'note.txt'),'after\r\n');
 const {accepted,approved}=await f.admit(),source=f.current.intents.executionSource('owner','project',approved.intent_id,approved.version,approved.review_sha256),before=await objectStamps(f.repository),index=await readFile(join(f.repository,'.git/index'));
 await f.current.workbench.indexEffects('owner','project').prepareIndex(source.witness,'stage');assert.deepEqual(await objectStamps(f.repository),before);assert.deepEqual(await readFile(join(f.repository,'.git/index')),index);
 // The original controlled hash-object path does not promise git-add's
 // index-attribute fallback. This byte expectation was independently checked
 // against the published implementation before changing this test.
 assert.equal((await f.current.executions.perform('owner','project',accepted.execution_id)).state,'applied');assert.equal(f.git('show',':note.txt'),'after\r\n');assert.equal((await readFile(join(f.repository,'note.txt'))).toString(),'after\r\n');
});

test('isolated planning preserves original hash-object autocrlf behavior for CRLF index blobs',async t=>{
 const f=await indexResolutionFixture(t);await writeFile(join(f.repository,'note.txt'),'old\r\n');f.git('add','note.txt');f.git('commit','-m','Synthetic original CRLF index');f.git('config','core.autocrlf','true');await writeFile(join(f.repository,'note.txt'),'next\r\n');
 const {accepted,approved}=await f.admit(),source=f.current.intents.executionSource('owner','project',approved.intent_id,approved.version,approved.review_sha256),before=await objectStamps(f.repository);
 await f.current.workbench.indexEffects('owner','project').prepareIndex(source.witness,'stage');assert.deepEqual(await objectStamps(f.repository),before);
 assert.equal((await f.current.executions.perform('owner','project',accepted.execution_id)).state,'applied');assert.equal(f.git('show',':note.txt'),'next\n');
});
