import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
import {CHAT_PRESET_REVISION} from '../chat-preset.mjs';
import {buildServer} from '../../gateway/src/server.ts';
import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';
import {HarnessWorker} from '../../gateway/src/harness/worker.ts';
import {SessionControllerClient} from '../../gateway/src/harness/session-controller-client.ts';
import {OfficialSessionRunner} from '../../gateway/src/harness/official-session-runner.ts';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
const listen=async server=>{await new Promise(done=>server.listen(0,'127.0.0.1',done));return'http://127.0.0.1:'+server.address().port;};
test('actual official Chat preset sends thinking disabled, exposes only web tools and publishes one original answer',{skip:!runtime,timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jot-chat-native-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace);
 const token=randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),modelKey='sk-'+randomBytes(32).toString('hex'),requests=[];
 let service,host,exit,done,output='',succeeded=false,modelFailure;
 const policy={protocol:1,mode:'chat',model:{provider:'deepseek-official',model:'deepseek-flash'},thinking:'disabled',preset_id:'jot-chat',preset_revision:CHAT_PRESET_REVISION,context_revision:'fixture-context-v1'};
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.headers['x-api-key'],modelKey);assert.match(req.url,/\/messages$/);assert.equal(input.thinking.type,'disabled');assert.equal(input.output_config,undefined);
  assert.deepEqual(input.tools.map(tool=>tool.name).sort(),['web_fetch','web_search']);assert.match(input.system,/useful solutions/);requests.push(input);
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const event of [
   {type:'message_start',message:{id:'synthetic-chat',type:'message',role:'assistant',content:[],model:'deepseek-flash',usage:{input_tokens:10,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'CHAT-NATIVE-OK'}},
   {type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
   {type:'message_stop'},
  ])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch(error){modelFailure=error;res.writeHead(500);res.end('synthetic_request_rejected');}});
 const modelUrl=await listen(model);
 try{
  service=await buildServer({databasePath:join(root,'gateway.db'),workspaces:['ws'],internalChannelToken:token,uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),chatModeEnabled:true,
   // Explicit fixture readiness; no production readiness claim is made.
   conversationModeClient:{conversationModeReadiness:async()=>({protocol:1,ready:true,policy})}});
  await service.app.listen({host:'127.0.0.1',port:0});const gateway='http://127.0.0.1:'+service.app.server.address().port;
  const prepared=await createHostProfile({home,adapter:fileURLToPath(new URL('./chat-input-adapter.mjs',import.meta.url))});
  const probe=createServer();await listen(probe);const port=probe.address().port;await new Promise(done=>probe.close(done));
  const patchPath=join(prepared.directory,'cordis.patch.yml');let patch=await readFile(patchPath,'utf8');
  const parsed=JSON.parse(patch.replace('!!js process.cwd()','null')),adapter=parsed.find(row=>row.insert).insert.find(row=>row.id==='jot-session-adapter');
  adapter.config={...adapter.config,port,workbenchOrigin:gateway,ordinaryExecutionPolicy:policy,chatFixture:{admissions:join(root,'admissions'),receipt:join(root,'composition.json')}};
  adapter.inject.push('jotChatPresetReady');
  parsed.find(row=>row.insert).insert.unshift({id:'preset-jot-chat',name:pathToFileURL(fileURLToPath(new URL('../chat-preset.mjs',import.meta.url))).href});
  parsed.push({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}});
  patch=JSON.stringify(parsed,null,2).replace('"workspaceRoot": null','"workspaceRoot": !!js process.cwd()');await writeFile(patchPath,patch);
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  host=spawn(process.execPath,[join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env:{...env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:token,DEEPSEEK_API_KEY:modelKey},stdio:['ignore','pipe','pipe'],windowsHide:true});
  done=new Promise(resolve=>host.once('exit',(code,signal)=>{exit={code,signal};resolve();}));for(const stream of [host.stdout,host.stderr])stream.on('data',data=>{output+=data;});
  const adapterUrl='http://127.0.0.1:'+port,deadline=Date.now()+30000;let ready=false;
  while(Date.now()<deadline&&!exit){try{const response=await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)});if(response.status===401){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,100));}
  assert.equal(ready,true,'official Chat Host readiness deadline');
  const created=await service.app.inject({method:'POST',url:'/v1/conversations',headers:{'x-user-id':'chat-owner'},payload:{workspace_id:'ws',mode:'chat',model:{provider:'deepseek-official',model:'deepseek-flash',reasoning_effort:'high'}}});assert.equal(created.statusCode,201,created.body);
  const conversation=created.json(),accepted=await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:{'x-user-id':'chat-owner'},payload:{client_message_id:'chat-input',content:[{type:'text',text:'Give the synthetic fixture answer.'}]}});assert.equal(accepted.statusCode,202,accepted.body);
  const failures=[];const client=new SessionControllerClient(adapterUrl,adapterToken,async(url,options)=>{const response=await fetch(url,options);if(!response.ok)failures.push({path:new URL(url).pathname,status:response.status,body:await response.clone().json()});return response;}),runner=new OfficialSessionRunner(client,{cwd:workspace,agentPreset:'jot-general',chatAgentPreset:'jot-chat'}),coordinator=new HarnessCoordinator(service.db,service.runs,service.events);
  const execute=runner.run.bind(runner);let runnerFailure;runner.run=async input=>{try{return await execute(input);}catch(error){runnerFailure={message:error.message,reason:error.reasonCode};throw error;}};
  const worker=new HarnessWorker(service.db,coordinator,runner,{workerId:'chat-fixture',leaseMs:60000,ordinaryInputRecoveryEnabled:true,ordinarySteeringEnabled:true});
  await worker.processNext();if(modelFailure)throw modelFailure;
  const run=service.runs.get(accepted.json().run_id,'chat-owner');assert.equal(run.status,'succeeded',JSON.stringify({status:run.status,error:run.error_code,requests:requests.length,failures,runnerFailure}));
  assert.equal(requests.length,1);assert.equal(await worker.processNext(),null);
  const answers=service.db.prepare("SELECT content_json FROM ga_messages WHERE role='assistant' AND run_id=?").all(run.run_id);assert.equal(answers.length,1);assert.match(answers[0].content_json,/CHAT-NATIVE-OK/);
  assert.deepEqual(JSON.parse(await readFile(join(root,'composition.json'),'utf8')),{preset:'jot-chat',tools:['web_fetch','web_search'],mounted:true});
  t.diagnostic(JSON.stringify({officialLauncher:true,chatPresetMounted:true,thinking:'disabled',tools:['web_fetch','web_search'],modelRequests:1,replyCount:1,production:false,readiness:'scripted-fixture'}));succeeded=true;
 }catch(error){await writeFile(join(root,'startup-private.log'),output);throw Error('chat_native_host_failed; private diagnostics: '+root,{cause:error});}
 finally{if(host&&!exit)host.kill('SIGTERM');if(done)await done;if(service){await service.app.close();service.db.close();}model.closeAllConnections();await new Promise(done=>model.close(done));if(succeeded)await rm(root,{recursive:true,force:true});}
});
