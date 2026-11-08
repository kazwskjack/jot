const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,keys)=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function challengeValue(value){
 if(!exactKeys(value,['state','actor_id','dsh_origin','bootstrap_path','namespaces'])||!token(value.state)
  ||typeof value.actor_id!=='string'||!/^[-\w]{1,128}$/.test(value.actor_id)||value.bootstrap_path!=='/api/jot-host-policy/bootstrap'
  ||!Array.isArray(value.namespaces)||value.namespaces.length===0||value.namespaces.some(name=>typeof name!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(name)||name==='jot-host-policy')
  ||new Set(value.namespaces).size!==value.namespaces.length)throw new Error('HOST_BOOTSTRAP_INVALID');
 let origin;
 try{origin=new URL(value.dsh_origin);}catch{throw new Error('HOST_BOOTSTRAP_INVALID');}
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.origin!==value.dsh_origin)throw new Error('HOST_BOOTSTRAP_INVALID');
 return {state:value.state,dshOrigin:origin.origin,path:value.bootstrap_path,namespaces:[...value.namespaces]};
}

function approveSettingsRead(bootstrapRequest,{signal,timeoutMs=120000}={}){
 if(typeof window==='undefined'||typeof window.open!=='function')return Promise.reject(new Error('HOST_POPUP_UNAVAILABLE'));
 // Open synchronously inside the user gesture before awaiting the local BFF.
 const popup=window.open('about:blank','_blank','popup,width=760,height=800');
 if(!popup)return Promise.reject(new Error('HOST_POPUP_BLOCKED'));
 return new Promise((resolve,reject)=>{
  let challenge,done=false,initialized=false,busy=false,timeout;
  const cleanup=()=>{clearTimeout(timeout);window.removeEventListener('message',onMessage);signal?.removeEventListener('abort',onAbort);try{if(!popup.closed)popup.close();}catch{}};
  const finish=(error,value)=>{if(done)return;done=true;cleanup();if(error)reject(error);else resolve(value);};
  const onAbort=()=>finish(new Error('HOST_BOOTSTRAP_CANCELLED'));
  const onMessage=async event=>{
   if(done||!challenge||event.source!==popup||event.origin!==challenge.dshOrigin||!record(event.data))return;
   if(event.data.type==='jot-host-bootstrap-ready'&&exactKeys(event.data,['type'])&&!initialized){
    initialized=true;popup.postMessage({type:'jot-host-bootstrap-init',state:challenge.state},challenge.dshOrigin);return;
   }
   if(event.data.type!=='jot-host-bootstrap-approved'||!exactKeys(event.data,['type','state','code','namespaces'])||busy
    ||event.data.state!==challenge.state||!token(event.data.code)||!Array.isArray(event.data.namespaces)
    ||event.data.namespaces.length===0||event.data.namespaces.some(name=>typeof name!=='string'||!challenge.namespaces.includes(name))
    ||new Set(event.data.namespaces).size!==event.data.namespaces.length)return;
   busy=true;let code=event.data.code;
   try{
    const result=await bootstrapRequest('redeem',{state:challenge.state,code},signal);
    if(!exactKeys(result,['approved'])||result.approved!==true)throw new Error('HOST_BOOTSTRAP_INVALID');
    finish(undefined,{approved:true,namespaces:[...event.data.namespaces]});
   }catch{finish(new Error('HOST_BOOTSTRAP_REDEEM_FAILED'));}
   finally{code='';challenge.state='';}
  };
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted){onAbort();return;}
  window.addEventListener('message',onMessage);
  timeout=setTimeout(()=>finish(new Error('HOST_BOOTSTRAP_TIMEOUT')),timeoutMs);
  Promise.resolve().then(()=>bootstrapRequest('challenge',undefined,signal)).then(value=>{
   if(done)return;
   challenge=challengeValue(value);
   popup.location.href=challenge.dshOrigin+challenge.path;
  }).catch(()=>finish(new Error('HOST_BOOTSTRAP_CHALLENGE_FAILED')));
 });
}

function approveSettingsWrite(request,namespace,command,key,{signal,timeoutMs=120000}={}){
 const failure=()=>Object.assign(new Error('host_settings_owner_approval_invalid'),{status:422,code:'host_settings_owner_approval_invalid'});
 if(typeof window==='undefined'||typeof window.open!=='function')return Promise.reject(failure());
 const popup=window.open('about:blank','_blank','popup,width=760,height=800');
 if(!popup)return Promise.reject(failure());
 return new Promise((resolve,reject)=>{
  let challenge,done=false,timeout,poll;
  const cleanup=()=>{clearTimeout(timeout);clearInterval(poll);window.removeEventListener('message',onMessage);signal?.removeEventListener('abort',onAbort);try{if(!popup.closed)popup.close();}catch{}};
  const finish=(error)=>{if(done)return;done=true;cleanup();if(error)reject(error);else resolve();};
  const onAbort=()=>finish(failure());
  const onMessage=event=>{
   if(done||!challenge||event.source!==popup||event.origin!==challenge.owner_origin||!record(event.data)
    ||!exactKeys(event.data,['type','challenge_id','review_sha256'])||event.data.type!=='jot-host-settings-write-approved'
    ||event.data.challenge_id!==challenge.challenge_id||event.data.review_sha256!==challenge.review_sha256)return;
   finish();
  };
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted){onAbort();return;}
  window.addEventListener('message',onMessage);
  timeout=setTimeout(()=>finish(failure()),timeoutMs);
  poll=setInterval(()=>{try{if(popup.closed)finish(failure());}catch{finish(failure());}},500);
  Promise.resolve().then(()=>request(`/host/settings/approval-requests?namespace=${encodeURIComponent(namespace)}`,'POST',{purpose:'settings.update',command:{idempotency_key:key,...command}},undefined,signal)).then(value=>{
   const raw=value?.approval;
   if(!exactKeys(value,['approval'])||!exactKeys(raw,['challenge_id','expires_at','owner_approval_url','purpose','review_sha256'])
    ||raw.purpose!=='settings.update'||!token(raw.challenge_id)||typeof raw.review_sha256!=='string'||!/^[a-f0-9]{64}$/.test(raw.review_sha256)
    ||!Number.isSafeInteger(raw.expires_at)||raw.expires_at<=Date.now()||typeof raw.owner_approval_url!=='string')throw new Error('HOST_SETTINGS_APPROVAL_INVALID');
   let url;try{url=new URL(raw.owner_approval_url);}catch{throw new Error('HOST_SETTINGS_APPROVAL_INVALID');}
   if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.hash
    ||url.pathname!=='/api/jot-host-settings/approval'||url.searchParams.size!==1||url.searchParams.get('challenge_id')!==raw.challenge_id)
    throw new Error('HOST_SETTINGS_APPROVAL_INVALID');
   challenge={challenge_id:raw.challenge_id,review_sha256:raw.review_sha256,owner_origin:url.origin};
   popup.location.href=url.origin+url.pathname+url.search;
  }).catch(()=>finish(failure()));
 });
}

/** Build the UI-owned client for Host read-only routes. */
export function createHostAdminClient(request,bootstrapRequest=async()=>{throw new Error('HOST_BOOTSTRAP_UNAVAILABLE');}){
 const editorPath=namespace=>{if(typeof namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(namespace)||namespace==='jot-host-policy')throw Error('HOST_SETTINGS_NAMESPACE_INVALID');return`?namespace=${encodeURIComponent(namespace)}`;};
 return Object.freeze({
  credentials:async signal=>{
   const result=await bootstrapRequest('credentials',{},signal);
   if(exactKeys(result,['enabled'])&&result.enabled===false)return{enabled:false};
   if(!exactKeys(result,['enabled','owner_url'])||result.enabled!==true||typeof result.owner_url!=='string')throw Error('HOST_CREDENTIALS_UNAVAILABLE');
   const url=new URL(result.owner_url);
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/api/jot-host-credentials')throw Error('HOST_CREDENTIALS_UNAVAILABLE');
   return{enabled:true,owner_url:url.href};
  },
  approveSettingsRead:signal=>approveSettingsRead(bootstrapRequest,{signal}),
  namespaceSettings:(namespace,signal)=>{
   if(typeof namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(namespace)||namespace==='jot-host-policy')return Promise.reject(new Error('HOST_SETTINGS_NAMESPACE_INVALID'));
   return request(`/host/settings?namespace=${encodeURIComponent(namespace)}`,'GET',undefined,undefined,signal);
  },
  readiness:(namespace,signal)=>{
   if(typeof namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(namespace)||namespace==='jot-host-policy')return Promise.reject(new Error('HOST_READINESS_NAMESPACE_INVALID'));
   return request(`/host/readiness?namespace=${encodeURIComponent(namespace)}`,'GET',undefined,undefined,signal);
  },
  settings:(namespace,signal)=>request('/host/settings/editor'+editorPath(namespace),'GET',undefined,undefined,signal),
  saveSettings:(namespace,input,key,signal)=>{
   if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))return Promise.reject(new Error('HOST_SETTINGS_ATTEMPT_INVALID'));
   editorPath(namespace);
   return approveSettingsWrite(request,namespace,input,key,{signal}).then(()=>request('/host/settings'+editorPath(namespace),'PATCH',input,key,signal));
  },
  settingsAttempt:(namespace,key,signal)=>{if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw Error('HOST_SETTINGS_ATTEMPT_INVALID');return request(`/host/settings/attempts/${encodeURIComponent(key)}`+editorPath(namespace),'GET',undefined,undefined,signal);},
  onboarding:signal=>request('/host/onboarding','GET',undefined,undefined,signal),
  saveOnboarding:(input,key)=>request('/host/onboarding','PATCH',input,key),
 });
}
