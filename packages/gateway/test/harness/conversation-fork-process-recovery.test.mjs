import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AttachmentResolver} from '../../src/artifacts/resolver.ts';
import {messageAttachmentProjection} from '../../src/messages/pinned-attachments.ts';

const childFile=fileURLToPath(new URL('./conversation-fork-process-child.mjs',import.meta.url));
function launch(mode,root,source={}){
 const runtimeFlags=process.execArgv.filter((arg,index,all)=>arg.startsWith('--experimental-loader=')||arg.startsWith('--import=')||(['--experimental-loader','--import'].includes(arg)&&Boolean(all[index+1])));
 const child=spawn(process.execPath,[...runtimeFlags,childFile,mode,root,JSON.stringify(source)],{cwd:resolve('.'),stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='',buffer='';
 const queue=[],waiters=[];
 const nextMessage=()=>new Promise((resolveMessage,rejectMessage)=>{
  if(queue.length)return resolveMessage(queue.shift());
  const waiter={resolve:resolveMessage,reject:rejectMessage,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);rejectMessage(new Error('child message timeout: '+stdout+stderr));},20000)};
  waiters.push(waiter);
 });
 const deliver=line=>{let value;try{value=JSON.parse(line);}catch(error){for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(new Error('invalid child message: '+line+'; '+String(error)));}return;}const waiter=waiters.shift();if(waiter){clearTimeout(waiter.timer);waiter.resolve(value);}else queue.push(value);};
 const ready=nextMessage();
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>{stdout+=chunk;buffer+=chunk;for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);deliver(line);}});
 child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.once('error',error=>{for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(error);}});
 child.once('close',(code,signal)=>{for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(new Error('child closed ('+code+'/'+signal+'): '+stdout+stderr));}});
 return{child,ready,next:nextMessage,closed:once(child,'close').then(([code,signal])=>({code,signal})),output:()=>stdout+stderr};
}

test('fork receipt recovers after a real process exit between fork commit and generic onSend', {timeout:60000}, async t=>{
 const root=await mkdtemp(join(resolve('.test-tmp'),'conversation-fork-process-'));
 const children=[];
 t.after(async()=>{for(const child of children){if(child.exitCode===null){child.kill();await once(child,'close').catch(()=>{});}}await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const first=launch('crash-after-fork-commit',root);children.push(first.child);
 const setup=await first.ready;
 const body={expected_version:1,through_message_id:setup.messageId};
 const headers={'x-user-id':setup.owner,origin:'https://fixture.invalid','x-csrf-token':setup.csrf,'idempotency-key':'process-fork-recovery-key','content-type':'application/json'};
 first.child.stdin.write(JSON.stringify({type:'request',url:'/v1/conversations/'+setup.conversationId+'/fork',headers,payload:body})+'\n');
 const firstExit=await first.closed;
 assert.equal(firstExit.code,73,first.output());
 const boundary=JSON.parse(await readFile(join(root,'fork-commit-boundary.json'),'utf8'));
 const db=new DatabaseSync(join(root,'gateway.sqlite'));
 try{
  assert.equal(db.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n,1);
  const pending=db.prepare('SELECT response_status,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get(setup.owner,'POST /v1/conversations/'+setup.conversationId+'/fork',headers['idempotency-key']);
  assert.ok(pending);
  assert.equal(pending.response_status,null);
  assert.equal(pending.receipt_protocol,'conversation-fork-atomic-v1');
 }finally{db.close();}
 const restarted=launch('recover',root,setup);children.push(restarted.child);
 const restartedSetup=await restarted.ready;
 assert.equal(restartedSetup.conversationId,setup.conversationId);
 try{
  restarted.child.stdin.write(JSON.stringify({type:'request',url:'/v1/conversations/'+setup.conversationId+'/fork',headers,payload:body})+'\n');
  const response=await restarted.next();
  assert.equal(response.statusCode,201,response.body+'\n'+restarted.output());
  const receipt=JSON.parse(response.body);
  assert.equal(receipt.conversation_id,boundary.conversation_id);
  assert.equal(receipt.fork_id,boundary.fork_id);
  assert.equal(receipt.source.through_message_id,setup.messageId);
  assert.equal(response.unexpectedSourceReads,0);
  const check=new DatabaseSync(join(root,'gateway.sqlite'));
  try{
   assert.equal(check.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n,1);
   const durable=check.prepare('SELECT response_status,response_json FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get(setup.owner,'POST /v1/conversations/'+setup.conversationId+'/fork',headers['idempotency-key']);
   assert.equal(durable.response_status,201);
   assert.deepEqual(JSON.parse(durable.response_json),receipt);
  }finally{check.close();}
 }finally{
  if(restarted.child.exitCode===null){restarted.child.stdin.write(JSON.stringify({type:'stop'})+'\n');const stopped=await restarted.next();assert.equal(stopped.type,'stopped');const exit=await restarted.closed;assert.equal(exit.code,0,restarted.output());}
 }
});

async function stopChild(processRef){
 if(processRef.child.exitCode!==null)return;
 processRef.child.stdin.write(JSON.stringify({type:'stop'})+'\n');
 const stopped=await processRef.next();assert.equal(stopped.type,'stopped');
 const exit=await processRef.closed;assert.equal(exit.code,0,processRef.output());
}

test('fork verifies fixed source attachment bytes and projects their immutable refs into the target history', {timeout:60000}, async t=>{
 const root=await mkdtemp(join(resolve('.test-tmp'),'conversation-fork-attachment-'));
 const child=launch('attachment-verification',root);t.after(async()=>{if(child.child.exitCode===null){child.child.kill();await once(child.child,'close').catch(()=>{});}await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const setup=await child.ready,key='verified-attachment-fork-key',url='/v1/conversations/'+setup.conversationId+'/fork';
 const headers={'x-user-id':setup.owner,origin:'https://fixture.invalid','x-csrf-token':setup.csrf,'idempotency-key':key,'content-type':'application/json'},payload={expected_version:1,through_message_id:setup.messageId};
 child.child.stdin.write(JSON.stringify({type:'request',url,headers,payload})+'\n');
 const response=await child.next();assert.equal(response.statusCode,201,response.body+child.output());
 const db=new DatabaseSync(join(root,'gateway.sqlite'));
 try{
  const receipt=JSON.parse(response.body),target=db.prepare('SELECT * FROM ga_messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(receipt.conversation_id);
  const pin={artifact_id:'fork-source-artifact',version:1,sha256:createHash('sha256').update('verified source attachment').digest('hex'),size_bytes:Buffer.byteLength('verified source attachment'),media_type:'text/plain',file_name:'source.txt'};
  const refs=messageAttachmentProjection(db,target).attachment_refs;assert.equal(refs.length,1);assert.notEqual(refs[0].artifact_id,pin.artifact_id);assert.deepEqual({...refs[0],artifact_id:pin.artifact_id},pin);
  assert.equal(db.prepare('SELECT count(*) n FROM ga_artifacts WHERE conversation_id=?').get(receipt.conversation_id).n,1);
  await unlink(join(root,'uploads','source.txt'));const resolver=new AttachmentResolver(db,join(root,'uploads')),files=await resolver.resolvePinnedForMessage(setup.owner,receipt.conversation_id,{protocol:1,attachments:refs.map(p=>({...p,kind:'text'}))},'fork-target-test');
  assert.equal((await readFile(files[0].localPath)).toString(),'verified source attachment');resolver.releaseLease('fork-target-test');
  await assert.rejects(resolver.resolvePinnedForMessage('foreign',receipt.conversation_id,{protocol:1,attachments:refs.map(p=>({...p,kind:'text'}))},'foreign-test'));
  await assert.rejects(resolver.resolvePinnedForMessage(setup.owner,setup.conversationId,{protocol:1,attachments:refs.map(p=>({...p,kind:'text'}))},'source-test'));
  const manifest=JSON.parse(db.prepare('SELECT manifest_json FROM ga_conversation_forks WHERE fork_id=?').get(receipt.fork_id).manifest_json);assert.equal(manifest.messages.at(-1).source_attachments[0].artifact_id,pin.artifact_id);assert.equal(manifest.messages.at(-1).attachments[0].artifact_id,refs[0].artifact_id);
  assert.equal(db.prepare("SELECT count(*) n FROM ga_artifact_leases WHERE lease_id LIKE 'fork-verify-%'").get().n,0);
 }finally{db.close();}
 await stopChild(child);
});

test('fork rejects changed bytes for a fixed source attachment pin', {timeout:60000}, async t=>{
 const root=await mkdtemp(join(resolve('.test-tmp'),'conversation-fork-attachment-corrupt-'));
 const child=launch('attachment-corrupt',root);t.after(async()=>{if(child.child.exitCode===null){child.child.kill();await once(child.child,'close').catch(()=>{});}await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const setup=await child.ready,key='corrupt-attachment-fork-key',url='/v1/conversations/'+setup.conversationId+'/fork';
 const headers={'x-user-id':setup.owner,origin:'https://fixture.invalid','x-csrf-token':setup.csrf,'idempotency-key':key,'content-type':'application/json'},payload={expected_version:1,through_message_id:setup.messageId};
 child.child.stdin.write(JSON.stringify({type:'request',url,headers,payload})+'\n');
 const response=await child.next();assert.equal(response.statusCode,503,response.body+child.output());assert.equal(JSON.parse(response.body).error.code,'FORK_SOURCE_UNAVAILABLE');
 const db=new DatabaseSync(join(root,'gateway.sqlite'));
 try{
  assert.equal(db.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n,0);
  const pending=db.prepare('SELECT response_status,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get(setup.owner,'POST '+url,key);
  assert.equal(pending.response_status,null);assert.equal(pending.receipt_protocol,'conversation-fork-atomic-v1');
 }finally{db.close();}
 await stopChild(child);
});

async function legacyScenario(mode,firstStatus,replayStatus,expectedForks){
 const root=await mkdtemp(join(resolve('.test-tmp'),'conversation-fork-'+mode+'-'));
 const children=[];
 try{
  const seeded=launch(mode,root);children.push(seeded.child);const setup=await seeded.ready;
  const key='legacy-'+mode+'-recovery-key';
  const headers={'x-user-id':setup.owner,origin:'https://fixture.invalid','x-csrf-token':setup.csrf,'idempotency-key':key,'content-type':'application/json'};
  const payload={expected_version:1,through_message_id:setup.messageId},url='/v1/conversations/'+setup.conversationId+'/fork';
  seeded.child.stdin.write(JSON.stringify({type:'request',url,headers,payload})+'\n');
  const first=await seeded.next();assert.equal(first.statusCode,firstStatus,first.body+seeded.output());
  assert.equal(first.legacyPending,true);
  await stopChild(seeded);
  const restarted=launch('recover',root,setup);children.push(restarted.child);await restarted.ready;
  restarted.child.stdin.write(JSON.stringify({type:'request',url,headers,payload})+'\n');
  const replay=await restarted.next();assert.equal(replay.statusCode,replayStatus,replay.body+restarted.output());assert.equal(replay.unexpectedSourceReads,0);
  if(replayStatus===201){const receipt=JSON.parse(replay.body);assert.equal(receipt.source.through_message_id,setup.messageId);}
  else assert.equal(JSON.parse(replay.body).error.code,'IDEMPOTENCY_IN_PROGRESS');
  const db=new DatabaseSync(join(root,'gateway.sqlite'));
  try{
   assert.equal(db.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n,expectedForks);
   const row=db.prepare('SELECT response_status,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get(setup.owner,'POST '+url,key);
   assert.ok(row);
   if(replayStatus===201)assert.equal(row.response_status,201);
   else assert.equal(row.response_status,null);
  }finally{db.close();}
  await stopChild(restarted);
 }finally{
  for(const child of children)if(child.exitCode===null){child.kill();await once(child,'close').catch(()=>{});}
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
}

test('legacy NULL/pending fork row recovers only from a matching fork-owned receipt', {timeout:60000}, async()=>{
 await legacyScenario('seed-legacy',201,201,1);
 await legacyScenario('seed-empty-legacy',503,409,0);
});

 test('attachment target bytes and deduplicated records survive process exit after commit', {timeout:60000},async t=>{
 const root=await mkdtemp(join(resolve('.test-tmp'),'conversation-fork-clone-crash-')),first=launch('crash-after-attachment-fork-commit',root),setup=await first.ready;
 const url='/v1/conversations/'+setup.conversationId+'/fork',headers={'x-user-id':setup.owner,origin:'https://fixture.invalid','x-csrf-token':setup.csrf,'idempotency-key':'clone-crash-key','content-type':'application/json'},payload={expected_version:1,through_message_id:setup.messageId};
 first.child.stdin.write(JSON.stringify({type:'request',url,headers,payload})+'\n');assert.equal((await first.closed).code,73,first.output());
 const next=launch('recover',root,setup);t.after(async()=>{if(next.child.exitCode===null){next.child.kill();await next.closed;}});await next.ready;
 next.child.stdin.write(JSON.stringify({type:'request',url,headers,payload})+'\n');const response=await next.next();assert.equal(response.statusCode,201,response.body);assert.equal(response.unexpectedSourceReads,0);
 const receipt=JSON.parse(response.body),db=new DatabaseSync(join(root,'gateway.sqlite'));
 try{const artifacts=db.prepare('SELECT * FROM ga_artifacts WHERE conversation_id=?').all(receipt.conversation_id);assert.equal(artifacts.length,1);assert.equal(artifacts[0].owner_id,setup.owner);assert.equal(db.prepare('SELECT workspace_id FROM ga_conversations WHERE id=?').get(receipt.conversation_id).workspace_id,'ws');const version=db.prepare('SELECT metadata_json FROM ga_artifact_versions WHERE artifact_id=?').get(artifacts[0].id);assert.equal(JSON.parse(version.metadata_json).workspace_id,'ws');
 const rows=db.prepare('SELECT * FROM ga_messages WHERE conversation_id=? AND role=\'assistant\'').all(receipt.conversation_id);assert.equal(rows.length,2);const refs=rows.map(r=>messageAttachmentProjection(db,r).attachment_refs);assert.deepEqual(refs[0],refs[1]);
 const resolver=new AttachmentResolver(db,join(root,'uploads')),files=await resolver.resolvePinnedForMessage(setup.owner,receipt.conversation_id,{protocol:1,attachments:refs[0].map(p=>({...p,kind:'text'}))},'restart-reader');assert.equal((await readFile(files[0].localPath)).toString(),'verified source attachment');resolver.releaseLease('restart-reader');
 }finally{db.close();}await stopChild(next);
 });
