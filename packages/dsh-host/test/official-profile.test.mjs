import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHostProfile} from '../create-profile.mjs';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
test('official launcher mounts real host services and reads effective preset policy without inference',{skip:!runtime,timeout:45000},async t=>{
 const measured=[];for(const name of ['dsh','dsh-base','dsh-web-app']){const bytes=await readFile(join(runtime,name,'package.json')),manifest=JSON.parse(bytes);assert.equal(manifest.version,'0.2.1-rc.2');measured.push({name,version:manifest.version,manifest_sha256:createHash('sha256').update(bytes).digest('hex')});}
 t.diagnostic(JSON.stringify({kind:'measured-test-installation-not-release-approval',packages:measured}));
 const root=await mkdtemp(join(tmpdir(),'jot-official-host-')),home=join(root,'home'),workspace=join(root,'workspace');await mkdir(workspace);
 const prepared=await createHostProfile({home,name:'jot',adapter:resolve('../session-adapter/index.js')});
 const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
 const receipt=join(root,'composition.json'),patchPath=join(prepared.directory,'cordis.patch.yml'),source=await readFile(patchPath,'utf8');
 const inspection={id:'jot-host-inspection',name:pathToFileURL(fileURLToPath(new URL('./inspect-host-plugin.mjs',import.meta.url))).href,config:{receipt}};
 await writeFile(patchPath,source.replace('"port": 18841','"port": '+port).replace('"jotHostReady"','"jotHostReady", "jotHostInspectionReady"').trim().replace(/\]$/,', '+JSON.stringify({insert:[inspection]})+']'));
 const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',JOT_SESSION_ADAPTER_TOKEN:randomBytes(32).toString('hex')});
 const child=spawn(process.execPath,[join(runtime,'dsh/lib/bin.js'),'--profile','jot','--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',exit,succeeded=false;const done=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};resolve();}));for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output+=data.toString();});
 try{
  const url='http://127.0.0.1:'+port;
  const deadline=Date.now()+30000;let ready=false;
  while(Date.now()<deadline&&!exit){try{const response=await fetch(url+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)});if(response.status===401){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,100));}
  // Preserve only synthetic diagnostics locally on failure; never print startup
  // URLs containing the official Web operator token in a test report.
  if(!ready){await writeFile(join(root,'startup-private.log'),output);throw Error('official_host_not_ready; isolated diagnostics retained in '+root);}
  const response=await fetch(url+'/v1/sessions',{method:'POST',headers:{authorization:'Bearer '+env.JOT_SESSION_ADAPTER_TOKEN,'content-type':'application/json'},body:JSON.stringify({session_id:'host-canary',cwd:workspace,agent_preset:'jot-general'})});
  const body=await response.json();assert.equal(response.status,201,JSON.stringify(body));assert.equal(body.sessionId,'host-canary');assert.equal(body.agentPreset,'jot-general');
  const composition=JSON.parse(await readFile(receipt,'utf8'));
  assert.equal(composition.preset,'jot-general');assert.equal(composition.mounted,true);
  assert.equal(composition.permission,'workspace-write');assert.equal(composition.sandbox.mode,'workspace-write');assert.equal(composition.approval,'ask');
  assert.equal(composition.model.provider,'deepseek-official');assert.equal(composition.model.model,'deepseek-flash');
  for(const name of ['read','write','edit'])assert.ok(composition.tools.includes(name));
  t.diagnostic(JSON.stringify({preset:composition.preset,mounted:composition.mounted,permission:composition.permission,approval:composition.approval,model:composition.model,visibleTools:composition.tools}));
  const upload=await fetch(url+'/v1/sessions/host-canary/files',{method:'POST',headers:{authorization:'Bearer '+env.JOT_SESSION_ADAPTER_TOKEN,'content-type':'application/octet-stream','x-file-name-b64':Buffer.from('canary.txt').toString('base64url')},body:Buffer.from('Synthetic host upload.')});
  const uploaded=await upload.json();assert.equal(upload.status,201,JSON.stringify(uploaded));assert.equal(typeof uploaded.receipt_id,'string');assert.ok(uploaded.file);
  assert.equal(output.includes('entry did not activate'),false,'all configured required services must activate');
  const unauthenticated=await fetch(url+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauthenticated.status,401);
  succeeded=true;
 }catch(error){await writeFile(join(root,'startup-private.log'),output);error.message+='; isolated diagnostics retained in '+root;throw error;}
 finally{if(!exit)child.kill('SIGTERM');await done;if(succeeded)await rm(root,{recursive:true,force:true});}
});
