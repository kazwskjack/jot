// The model HTTP endpoint is synthetic; Gateway/Worker/DSH services are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
async function listen(server){await new Promise(done=>server.listen(0,'127.0.0.1',done));return 'http://127.0.0.1:'+server.address().port;}
async function freePort(){const server=createServer();await listen(server);const port=server.address().port;await new Promise(done=>server.close(done));return port;}
async function until(check){const end=Date.now()+30000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(done=>setTimeout(done,100));}throw Error('gateway_host_acceptance_timeout');}
function cleanEnv(){const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'])if(process.env[key])env[key]=process.env[key];return env;}
function launch(args,cwd,env){const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',terminal=false;const ended=new Promise(done=>child.once('exit',()=>{terminal=true;done();}));for(const stream of [child.stdout,child.stderr])stream.on('data',value=>{output+=value;});return {child,output:()=>output,terminal:()=>terminal,async stop(){if(!terminal)child.kill('SIGTERM');await ended;}};}

test('real Gateway and worker commit one reply from an official DSH host through the Messages HTTP transport',{skip:!runtime,timeout:60000},async t=>{
 const {buildServer}=await import('../../gateway/src/server.ts');
 const root=await mkdtemp(join(tmpdir(),'jot-gateway-host-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace);
 let host,worker,service,succeeded=false;const requests=[];
 const modelKey='sk-'+randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex'),internalToken=randomBytes(32).toString('hex');
 const model=createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.method,'POST');assert.match(req.url,/\/messages$/);assert.equal(req.headers['x-api-key'],modelKey);
  requests.push(input);res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  for(const event of [
   {type:'message_start',message:{id:'synthetic-message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:5,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ACCEPTANCE-OK'}},
   {type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
   {type:'message_stop'},
  ])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
 }catch{res.writeHead(500);res.end('synthetic_protocol_request_rejected');}});
 const modelUrl=await listen(model);
 try{
  service=await buildServer({databasePath:join(root,'gateway.db'),uploadRoot:join(root,'files'),workbenchRoot:join(root,'workspaces'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates',import.meta.url)),workspaces:['jot'],internalChannelToken:internalToken});
  await service.app.listen({host:'127.0.0.1',port:0});const gatewayUrl='http://127.0.0.1:'+service.app.server.address().port;
  const prepared=await createHostProfile({home}),port=await freePort(),patchPath=join(prepared.directory,'cordis.patch.yml');
  let patch=await readFile(patchPath,'utf8');patch=patch.replace('"port": 18841','"port": '+port).replace('http://127.0.0.1:18831',gatewayUrl).replace('"jotHostReady"','"jotHostReady", "jotHostInspectionReady"');
  const inspection={insert:[{id:'jot-host-inspection',name:pathToFileURL(fileURLToPath(new URL('./inspect-host-plugin.mjs',import.meta.url))).href,config:{receipt:join(root,'composition.json'),sessionPrefix:'jot-host-acceptance-'}}]};
  patch=patch.trim().replace(/\]$/,', '+JSON.stringify({id:'llm-deepseek',config:{baseURL:modelUrl,apiKeyEnv:'DEEPSEEK_API_KEY',reasoningEffort:'high'}})+', '+JSON.stringify(inspection)+']');await writeFile(patchPath,patch);
  host=launch([join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],workspace,{...cleanEnv(),DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:adapterToken,GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,DEEPSEEK_API_KEY:modelKey});
  const adapterUrl='http://127.0.0.1:'+port;
  await until(async()=>{assert.equal(host.terminal(),false,'official host exited');try{return (await fetch(adapterUrl+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)})).status===401;}catch{return false;}});
  const tokenFile=join(root,'adapter.token');await writeFile(tokenFile,adapterToken,{mode:0o600});
  const headers={'x-user-id':'acceptance-owner','content-type':'application/json'};
  const conversation=await fetch(gatewayUrl+'/v1/conversations',{method:'POST',headers,body:JSON.stringify({title:'Synthetic local model acceptance',workspace_id:'jot',model:{provider:'deepseek-official',model:'deepseek-flash'}})});assert.equal(conversation.status,201);const {conversation_id}=await conversation.json();
  const posted=await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/messages',{method:'POST',headers:{...headers,'idempotency-key':'acceptance-one'},body:JSON.stringify({client_message_id:'acceptance-one',content:[{type:'text',text:'Reply with the single word ACCEPTANCE-OK.'}]})});assert.equal(posted.status,202);const {run_id}=await posted.json();
  worker=launch(['--experimental-strip-types',fileURLToPath(new URL('../../gateway/src/harness/main.ts',import.meta.url))],workspace,{...cleanEnv(),GENERAL_AGENT_DB:join(root,'gateway.db'),GENERAL_AGENT_FILE_ROOT:join(root,'files'),GENERAL_AGENT_WORKBENCH_ROOT:join(root,'workspaces'),GENERAL_AGENT_WORKSPACES:'jot',GENERAL_AGENT_SESSION_ADAPTER_URL:adapterUrl,GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE:tokenFile,GENERAL_AGENT_HARNESS_CWD:workspace,GENERAL_AGENT_DSH_AGENT_PRESET:'jot-general',GENERAL_AGENT_DSH_SESSION_PREFIX:'jot-host-acceptance',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:internalToken,GENERAL_AGENT_WORKER_POLL_MS:'250'});
  const run=await until(async()=>{assert.equal(worker.terminal(),false,'official gateway worker exited');const current=await (await fetch(gatewayUrl+'/v1/runs/'+run_id,{headers})).json();if(['succeeded','failed','interrupted'].includes(current.status))return current;return false;});
  assert.equal(run.status,'succeeded',JSON.stringify(run));assert.equal(requests.length,1);assert.equal(requests[0].model,'deepseek-flash');
  assert.ok(requests[0].dsh_plugin_packages.packages.some(item=>item.name==='jot-dsh-host-preparation'&&item.version==='0.1.0'));
  const composition=JSON.parse(await readFile(join(root,'composition.json'),'utf8'));
  assert.equal(composition.preset,'jot-general');assert.equal(composition.mounted,true);assert.equal(composition.approval,'ask');assert.equal(composition.permission,'workspace-write');assert.equal(composition.sandbox.workspaceRoot,workspace);
  assert.deepEqual(composition.model,{provider:'deepseek-official',model:'deepseek-flash'});
  assert.equal(composition.events.filter(event=>event.sourceRpcId===run_id).length,1);
  assert.equal(composition.events.findLast(event=>event.type==='turn/end')?.reason.kind,'completed');
  assert.ok(JSON.stringify(requests[0].messages).includes('ACCEPTANCE-OK'));
  const snapshot=await (await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/snapshot',{headers})).json();
  const replies=snapshot.messages.filter(message=>message.role==='assistant');assert.equal(replies.length,1);assert.ok(JSON.stringify(replies[0]).includes('ACCEPTANCE-OK'));
  const retry=await fetch(gatewayUrl+'/v1/conversations/'+conversation_id+'/messages',{method:'POST',headers:{...headers,'idempotency-key':'acceptance-one'},body:JSON.stringify({client_message_id:'acceptance-one',content:[{type:'text',text:'Reply with the single word ACCEPTANCE-OK.'}]})});
  assert.equal(retry.status,202);assert.equal((await retry.json()).run_id,run_id);assert.equal(requests.length,1);
  assert.equal(host.output().includes('entry did not activate'),false);
  t.diagnostic(JSON.stringify({officialLauncher:true,realGateway:true,realWorker:true,modelTransport:'synthetic local Messages HTTP',modelRequests:requests.length,replyCount:replies.length,status:run.status,production:false}));succeeded=true;
 }catch(error){await writeFile(join(root,'startup-private.log'),JSON.stringify({host:host?.output(),worker:worker?.output(),modelRequests:requests.length},null,2));throw Error('gateway_host_acceptance_failed; private diagnostics: '+root,{cause:error});}
 finally{await worker?.stop();await host?.stop();if(service){await service.app.close();service.db.close();}model.closeAllConnections();await new Promise(done=>model.close(done));if(succeeded)await rm(root,{recursive:true,force:true});}
});
