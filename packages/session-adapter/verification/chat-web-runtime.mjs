// Actual official Session persistence and real Gateway leases, with a synthetic
// provider body. This is not a cold Controller inference or production test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {buildServer} from '../../gateway/src/server.ts';
import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';
import {createChatContextSelector} from '../chat-context.js';
import {createChatWebSelector} from '../chat-web.js';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
test('official Session reopen and replacement lease cannot redispatch a consumed uncertain Web call',{skip:!runtime,timeout:15000},async()=>{
 const {Session}=await import(pathToFileURL(join(runtime,'dsh-session/lib/index.js'))),{createUserMessage,createSystemMessage,createAssistantMessage}=await import(pathToFileURL(join(runtime,'dsh-llm/lib/index.js')));
 const base=resolve('.test-tmp/chat-web-runtime');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-')),token=randomBytes(32).toString('hex');let f;
 try{
  f=await buildServer({databasePath:join(root,'gateway.db'),workspaces:['ws'],internalChannelToken:token,uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url))});
  const policy={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'},c=f.conversations.create('web-owner',{workspace_id:'ws',mode:'chat',model:{provider:'fixture',model:'work'}},{chatPolicy:policy});
  const run=f.runs.enqueue(c.conversation_id,'web-owner',{client_message_id:'current',content:[{type:'text',text:'Synthetic current input.'}]},{modePolicy:policy}),row=f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(run.run_id),coordinator=new HarnessCoordinator(f.db,f.runs,f.events);
  let lease=coordinator.claimNext('first-web-worker',30000);coordinator.start(lease);
  const session=Session.create(row.native_session_ref,undefined,{...Session.create('header-fixture').header,id:row.native_session_ref,agentPreset:'jot-chat',cwd:root});
  session.append('system/message',{turn:1,step:1,message:createSystemMessage('Synthetic stable system prompt.')},{surfaceOp:'append'});
  const binding=()=>({runId:run.run_id,sessionRef:session.id,executionLease:{owner:lease.owner,generation:lease.generation}}),bridge={request:async(path,scope,payload,signal)=>{signal.throwIfAborted();const response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/'+path,headers:{authorization:'Bearer '+token},payload:{...payload,run_id:scope.runId,session_ref:scope.sessionRef,execution_lease:scope.executionLease}});assert.equal(response.statusCode,200,response.body);return response.json();}},sessions={flush:async current=>{await writeFile(join(root,'session.json'),JSON.stringify({header:current.header,events:current.snapshotEvents(0)}));return true;}};
  const agent={id:session.id,session};await createChatContextSelector({bridge,sessions,createUserMessage,chatPolicy:policy})({agent,binding:binding(),signal:new AbortController().signal,check:async()=>{}});
  session.append('user/message',createUserMessage({source:{kind:'user',rpcId:run.run_id},content:[{type:'text',text:'Synthetic original input.'}]}),{surfaceOp:'append'});
  const args={url:'https://example.com/uncertain'},call={type:'tool-call',id:'fetch-a',name:'web_fetch',arguments:JSON.stringify(args)};
  session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'fixture',model:'fast'},content:[call]}),stream:[]},{surfaceOp:'append'});
  session.append('tool/call',{turn:1,step:1,callId:call.id,name:call.name,arguments:call.arguments});
  let execute,effects=0;agent.ctx={on:(name,fn)=>{assert.equal(name,'tools/execute');execute=fn;return()=>{};}};
  const prepare=async current=>{await createChatWebSelector({bridge,sessions,chatPolicy:policy})({agent:current,binding:binding(),signal:new AbortController().signal,check:async()=>{}});};
  const exec=current=>({agent:current,callId:call.id,name:call.name,arguments:args,signal:new AbortController().signal,token:Symbol()}),next=async()=>{effects++;throw Error('synthetic unknown provider outcome');};
  await prepare(agent);await assert.rejects(execute(exec(agent),next),/unknown provider outcome/);assert.equal(effects,1);
  f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),run.run_id);lease=coordinator.claimNext('replacement-web-worker',30000);coordinator.start(lease);
  const stored=JSON.parse(await readFile(join(root,'session.json'),'utf8')),reopened=Session.create(session.id,stored.events,stored.header),restored={id:session.id,session:reopened,ctx:agent.ctx};await prepare(restored);
  await assert.rejects(execute(exec(restored),next),/CHAT_WEB_ALLOWANCE_CONSUMED/);assert.equal(effects,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_web_calls').get().n,1);
 }finally{if(f){await f.app.close();f.db.close();}const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
