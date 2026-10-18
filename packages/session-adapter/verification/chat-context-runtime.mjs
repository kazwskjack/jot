// Actual Gateway authority plus official Session surface persistence/reopen.
// This is not a cold Controller inference or a production acceptance test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {buildServer} from '../../gateway/src/server.ts';
import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';
import {createChatContextSelector} from '../chat-context.js';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
test('official Session reopen reuses the exact frozen context under a replacement Gateway lease without another surface append',{skip:!runtime,timeout:15000},async()=>{
 const {Session}=await import(pathToFileURL(join(runtime,'dsh-session/lib/index.js'))),{createUserMessage,createSystemMessage}=await import(pathToFileURL(join(runtime,'dsh-llm/lib/index.js')));
 const base=resolve('.test-tmp/chat-context-runtime');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-')),token=randomBytes(32).toString('hex');let f;
 try{
  f=await buildServer({databasePath:join(root,'gateway.db'),workspaces:['ws'],internalChannelToken:token,uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url))});
  const policy={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'},c=f.conversations.create('surface-owner',{workspace_id:'ws',mode:'chat',model:{provider:'fixture',model:'work'}},{chatPolicy:policy});
  f.db.prepare('INSERT INTO ga_messages(id,conversation_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('prior-context',c.conversation_id,'user','complete',JSON.stringify({blocks:[{kind:'text',text:'Synthetic retained source.'}],attachments:[]}), 'before','before');
  const run=f.runs.enqueue(c.conversation_id,'surface-owner',{client_message_id:'current',content:[{type:'text',text:'Current original input.'}]},{modePolicy:policy}),row=f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(run.run_id),coordinator=new HarnessCoordinator(f.db,f.runs,f.events);
  let lease=coordinator.claimNext('first-surface-worker',30000);coordinator.start(lease);
  const session=Session.create(row.native_session_ref,undefined,{...Session.create('header-fixture').header,id:row.native_session_ref,agentPreset:'jot-chat',cwd:root});
  session.append('system/message',{turn:1,step:1,message:createSystemMessage('Stable synthetic system prompt.')},{surfaceOp:'append'});
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Original old native transcript.'}]}),{surfaceOp:'append'});
  const original=session.snapshotEvents(0),agent={id:session.id,session},binding=()=>({runId:run.run_id,sessionRef:session.id,executionLease:{owner:lease.owner,generation:lease.generation}});
  const bridge={request:async(path,scope,payload,signal)=>{signal.throwIfAborted();const response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/'+path,headers:{authorization:'Bearer '+token},payload:{...payload,run_id:scope.runId,session_ref:scope.sessionRef,execution_lease:scope.executionLease}});assert.equal(response.statusCode,200,response.body);return response.json();}};
  let flushes=0;const sessions={flush:async current=>{flushes++;await writeFile(join(root,'session.json'),JSON.stringify({header:current.header,events:current.snapshotEvents(0)}));return true;}};
  const prepare=current=>createChatContextSelector({bridge,sessions,createUserMessage,chatPolicy:policy})({agent:current,binding:binding(),signal:new AbortController().signal,check:async()=>{assert.equal(current.id,current.session.id);}});
  assert.deepEqual(await prepare(agent),{startsRequestSeries:true});assert.equal(session.snapshotEvents(0).length,3);assert.deepEqual(session.snapshotEvents(0).slice(0,2),original);assert.deepEqual([...session.surface.nodes],[0,2]);const marker=session.eventAt(2);
  // Current conversation/history changes cannot reselect an accepted seed.
  f.db.prepare("UPDATE ga_messages SET content_json='[]',updated_at='changed' WHERE id='prior-context'").run();
  f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),run.run_id);lease=coordinator.claimNext('replacement-surface-worker',30000);coordinator.start(lease);
  const stored=JSON.parse(await readFile(join(root,'session.json'),'utf8')),reopened=Session.create(session.id,stored.events,stored.header),prefix=reopened.snapshotEvents(0);
  assert.deepEqual(await prepare({id:reopened.id,session:reopened}),{startsRequestSeries:true});assert.deepEqual(reopened.snapshotEvents(0),prefix);assert.deepEqual(reopened.eventAt(2),marker);assert.equal(flushes,2);
  assert.equal(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(run.run_id).chat_context_json,row.chat_context_json);assert.equal(reopened.snapshotEvents(0).filter(event=>event.type==='user/message'&&event.data.source.kind==='jot-chat-context').length,1);
 }finally{if(f){await f.app.close();f.db.close();}const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
