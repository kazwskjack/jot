import {randomBytes} from 'node:crypto';
import {HOST_POLICY_NAMESPACE,HOST_POLICY_READ_OPERATION} from './host-policy-constants.js';

const OWNER_PATH='/api/jot-host-policy/bootstrap';
const BODY_KEYS=['expected_revision','expires_at','namespaces','owner_page_nonce','state'];
const BINDING_KEYS=['actor_id','epoch','expires_at','gateway_id','host_instance_id','namespace','operation'];
const deny=(status,code)=>Response.json({ok:false,error:code},{status,headers:privateHeaders()});
const privateHeaders=()=>({'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
const randomToken=()=>randomBytes(32).toString('base64url');

function parseOrigin(value){
  try{
    const parsed=new URL(value);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)return undefined;
    return parsed;
  }catch{return undefined;}
}

function validateConfig(config){
  const dsh=parseOrigin(config?.dshOrigin),jot=parseOrigin(config?.jotOrigin);
  if(!dsh||!jot||dsh.origin===jot.origin||dsh.protocol!==jot.protocol||dsh.hostname!==jot.hostname)throw new TypeError('host_bootstrap_origin_invalid');
  if(!['gatewayId','actorId','hostInstanceId'].every(key=>typeof config?.[key]==='string'&&config[key].length>0))throw new TypeError('host_bootstrap_identity_invalid');
  if(!Array.isArray(config.namespaces)||config.namespaces.length===0||config.namespaces.length>64
    ||config.namespaces.some(value=>typeof value!=='string'||!value||value===HOST_POLICY_NAMESPACE)
    ||new Set(config.namespaces).size!==config.namespaces.length)throw new TypeError('host_bootstrap_namespaces_invalid');
  const maxBindingLifetimeMs=config.maxBindingLifetimeMs??1_800_000;
  if(!Number.isSafeInteger(maxBindingLifetimeMs)||maxBindingLifetimeMs<60_000||maxBindingLifetimeMs>1_800_000)throw new TypeError('host_bootstrap_binding_lifetime_invalid');
  return {...config,dshOrigin:dsh.origin,jotOrigin:jot.origin,maxBindingLifetimeMs};
}

function exactRow(row){
  if(!row||typeof row!=='object'||Array.isArray(row))return false;
  const keys=Object.keys(row).sort();
  return keys.length===BINDING_KEYS.length&&keys.every((key,index)=>key===BINDING_KEYS[index])
    &&['gateway_id','actor_id','host_instance_id','operation','namespace'].every(key=>typeof row[key]==='string'&&row[key].length>0)
    &&Number.isSafeInteger(row.epoch)&&row.epoch>0&&Number.isSafeInteger(row.expires_at)&&row.expires_at>0;
}

async function readPolicy(settingsController){
  try{
    const described=await settingsController.describe();
    const row=described?.namespaces?.find(item=>item?.ns===HOST_POLICY_NAMESPACE);
    if(!row||!Number.isSafeInteger(row.revision)||row.revision<0||!Array.isArray(row.value?.bindings)||row.value.bindings.some(item=>!exactRow(item)))return undefined;
    return {revision:row.revision,bindings:row.value.bindings.map(item=>({...item}))};
  }catch{return undefined;}
}

function connectionRequest(request){
  const url=new URL(request.url);
  const headers=Object.fromEntries(request.headers.entries());
  if(!headers.host)headers.host=url.host;
  return {method:request.method,url:url.pathname+url.search,headers};
}

function originAllowed(request,config){
  let url;
  try{url=new URL(request.url);}catch{return false;}
  if(url.origin!==config.dshOrigin||url.pathname!==OWNER_PATH||url.search)return false;
  const origin=request.headers.get('origin');
  if(origin!==null&&origin!==config.dshOrigin)return false;
  const site=request.headers.get('sec-fetch-site');
  if(site==='cross-site')return false;
  if(request.method==='POST'&&(origin!==config.dshOrigin||site!=='same-origin'))return false;
  return true;
}

function escapeJson(value){
  return JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026')
    .replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}

function nextEpoch(snapshot,config,namespace){
  const rows=snapshot.bindings.filter(row=>row.gateway_id===config.gatewayId&&row.actor_id===config.actorId
    &&row.host_instance_id===config.hostInstanceId&&row.operation===HOST_POLICY_READ_OPERATION&&row.namespace===namespace);
  const current=rows.reduce((max,row)=>Math.max(max,row.epoch),0);
  return Number.isSafeInteger(current+1)?current+1:undefined;
}

function approvalPage(data,config){
  const cspNonce=randomToken();
  const responseConfig={
    ownerPageNonce:data.ownerPageNonce,
    policyRevision:data.snapshot.revision,
    serverNow:data.now,
    actorId:config.actorId,
    gatewayId:config.gatewayId,
    hostInstanceId:config.hostInstanceId,
    operation:HOST_POLICY_READ_OPERATION,
    jotOrigin:config.jotOrigin,
    endpoint:OWNER_PATH,
    namespaces:data.namespaces.map(namespace=>({namespace,epoch:nextEpoch(data.snapshot,config,namespace)}))
  };
  if(responseConfig.namespaces.some(item=>!Number.isSafeInteger(item.epoch)))return deny(503,'policy_unavailable');
  const html=`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Jot Host 唯讀授權</title><main><h1>批准 Jot Host 唯讀設定</h1><p id="status">等待 Jot 工作台驗證這個視窗…</p><dl><dt>Jot actor</dt><dd id="actor"></dd><dt>Gateway component</dt><dd id="gateway"></dd><dt>Host instance</dt><dd id="host"></dd><dt>操作</dt><dd id="operation"></dd><dt>policy revision</dt><dd id="revision"></dd></dl><fieldset id="namespaces" disabled><legend>允許讀取的設定 namespace</legend></fieldset><label>授權有效期 <select id="lifetime"><option value="300000">5 分鐘</option><option value="900000" selected>15 分鐘</option><option value="1800000">30 分鐘</option></select></label><p><button id="approve" type="button" disabled>批准唯讀存取</button></p></main><script id="bootstrap-config" type="application/json">${escapeJson(responseConfig)}</script><script nonce="${cspNonce}">(()=>{const c=JSON.parse(document.getElementById('bootstrap-config').textContent),status=document.getElementById('status'),fieldset=document.getElementById('namespaces'),button=document.getElementById('approve');for(const [id,value] of [['actor',c.actorId],['gateway',c.gatewayId],['host',c.hostInstanceId],['operation',c.operation],['revision',String(c.policyRevision)]])document.getElementById(id).textContent=value;for(const item of c.namespaces){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=item.namespace;label.append(input,document.createTextNode(' '+item.namespace+' (epoch '+item.epoch+')'));fieldset.append(label,document.createElement('br'));}let state='';let busy=false;const validState=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(value);if(!window.opener){status.textContent='請從 Jot 工作台重新開啟此確認頁。';}else{window.opener.postMessage({type:'jot-host-bootstrap-ready'},c.jotOrigin);window.addEventListener('message',event=>{if(event.source!==window.opener||event.origin!==c.jotOrigin||state||!event.data||Object.keys(event.data).sort().join(',')!=='state,type'||event.data.type!=='jot-host-bootstrap-init'||!validState(event.data.state))return;state=event.data.state;fieldset.disabled=false;button.disabled=false;status.textContent='請確認上方身份、namespace 與有效期，再明確批准。';});}button.addEventListener('click',async()=>{if(!state||busy)return;const namespaces=[...fieldset.querySelectorAll('input:checked')].map(input=>input.value);if(!namespaces.length){status.textContent='請至少選擇一個 namespace。';return;}busy=true;button.disabled=true;const expires_at=c.serverNow+Number(document.getElementById('lifetime').value);status.textContent='正在透過 DSH owner Remote 保存批准…';try{const response=await fetch(c.endpoint,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({owner_page_nonce:c.ownerPageNonce,state,namespaces,expires_at,expected_revision:c.policyRevision})});const result=await response.json();if(!response.ok||result.ok!==true||result.state!==state||typeof result.code!=='string')throw new Error('approval_failed');window.opener.postMessage({type:'jot-host-bootstrap-approved',state,code:result.code,namespaces},c.jotOrigin);state='';result.code='';c.ownerPageNonce='';status.textContent='批准完成。請返回 Jot 工作台。';}catch{state='';c.ownerPageNonce='';status.textContent='批准失敗或結果不確定。請關閉此視窗，回到 Jot 後重新發起並批准。';}finally{busy=false;button.disabled=true;}});})();</script></html>`;
  return new Response(html,{status:200,headers:{...privateHeaders(),
    'content-type':'text/html; charset=utf-8',
    'content-security-policy':`default-src 'none'; script-src 'nonce-${cspNonce}'; connect-src 'self'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'cross-origin-opener-policy':'unsafe-none'
  }});
}

export function createHostPolicyBootstrapOwnerRoute({connection,typertGateway,settingsController,authority,config:input,now=()=>Date.now()}={}){
  const config=validateConfig(input);
  if(!connection||typeof connection.admit!=='function'||typeof connection.fetch?.register!=='function'
    ||!typertGateway||typeof typertGateway.invoke!=='function'||!settingsController||typeof settingsController.describe!=='function'
    ||!authority||typeof authority.createOwnerPageNonce!=='function'||typeof authority.beginOwnerApproval!=='function'||typeof authority.createOwnerCode!=='function')throw new TypeError('host_bootstrap_owner_dependency_invalid');

  async function ownerPeer(request){
    if(!originAllowed(request,config)||request.headers.has('x-user-id'))return undefined;
    const admission=connection.admit(connectionRequest(request));
    return !('rejection' in admission)&&admission.peer?.principal?.kind==='owner'?admission.peer:undefined;
  }

  async function fetchOwner(request){
    if(request.method==='GET'){
      const peer=await ownerPeer(request);
      if(!peer)return deny(403,'owner_required');
      const nonce=authority.createOwnerPageNonce(peer);
      if(!nonce.ok)return deny(503,'owner_page_unavailable');
      const snapshot=await readPolicy(settingsController);
      const serverNow=now();
      if(!snapshot||!Number.isSafeInteger(serverNow))return deny(503,'policy_unavailable');
      return approvalPage({ownerPageNonce:nonce.nonce,snapshot,now:serverNow,namespaces:config.namespaces},config);
    }
    if(request.method!=='POST')return deny(405,'method_not_allowed');
    const peer=await ownerPeer(request);
    if(!peer)return deny(403,'owner_required');
    if((request.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()!=='application/json')return deny(415,'content_type_invalid');
    let body;
    try{
      const contentLength=request.headers.get('content-length');
      if(contentLength!==null&&(!/^\d+$/.test(contentLength)||Number(contentLength)>4096))return deny(413,'body_too_large');
      const reader=request.body?.getReader();
      if(!reader)return deny(400,'body_invalid');
      const chunks=[];let size=0;
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        size+=value.byteLength;
        if(size>4096){await reader.cancel().catch(()=>{});return deny(413,'body_too_large');}
        chunks.push(value);
      }
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }catch{return deny(400,'body_invalid');}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==BODY_KEYS.join(','))return deny(400,'body_invalid');
    if(!Number.isSafeInteger(body.expected_revision)||body.expected_revision<0||!Number.isSafeInteger(body.expires_at))return deny(400,'body_invalid');
    const namespaces=body.namespaces;
    if(!Array.isArray(namespaces)||namespaces.length===0||namespaces.some(value=>typeof value!=='string'||!config.namespaces.includes(value))
      ||new Set(namespaces).size!==namespaces.length)return deny(400,'namespace_invalid');
    const currentTime=now();
    if(!Number.isSafeInteger(currentTime)||body.expires_at<=currentTime||body.expires_at>currentTime+config.maxBindingLifetimeMs)return deny(400,'expiry_invalid');
    const snapshot=await readPolicy(settingsController);
    if(!snapshot)return deny(503,'policy_unavailable');
    if(snapshot.revision!==body.expected_revision)return deny(409,'policy_changed');

    const selectedBindings=[];
    for(const namespace of namespaces){
      const epoch=nextEpoch(snapshot,config,namespace);
      if(!Number.isSafeInteger(epoch))return deny(409,'policy_changed');
      selectedBindings.push({gateway_id:config.gatewayId,actor_id:config.actorId,host_instance_id:config.hostInstanceId,
        operation:HOST_POLICY_READ_OPERATION,namespace,epoch,expires_at:body.expires_at});
    }
    const approval=authority.beginOwnerApproval({peer,ownerPageNonce:body.owner_page_nonce,state:body.state,namespaces});
    if(!approval.ok)return deny(409,'approval_invalid');
    const replaced=new Set(namespaces);
    const bindings=snapshot.bindings.filter(binding=>!(binding.gateway_id===config.gatewayId&&binding.actor_id===config.actorId
      &&binding.host_instance_id===config.hostInstanceId&&binding.operation===HOST_POLICY_READ_OPERATION&&replaced.has(binding.namespace)));
    bindings.push(...selectedBindings);
    let remoteMutation;
    try{
      remoteMutation=await typertGateway.invoke({
        namespace:'settings',method:'mutate',peer,
        args:{ns:HOST_POLICY_NAMESPACE,ops:[{op:'set',path:['bindings'],value:bindings}],expectedRevision:snapshot.revision}
      });
    }catch{return deny(409,'policy_conflict');}
    if(remoteMutation&&typeof remoteMutation==='object'&&remoteMutation.ok===false)return deny(409,'policy_conflict');
    const issued=await authority.createOwnerCode({peer,approvalId:approval.approvalId});
    if(!issued.ok)return deny(409,'approval_not_current');
    return Response.json({ok:true,state:body.state,code:issued.code,expires_at:issued.expires_at},{status:200,headers:privateHeaders()});
  }

  return Object.freeze({
    path:OWNER_PATH,
    methods:['GET','POST'],
    requestBody:'buffered',
    fetch:fetchOwner
  });
}

export function registerHostPolicyBootstrapOwnerRoute(context,deps){
  const connection=deps?.connection;
  if(!context||typeof context.effect!=='function'||!connection?.fetch?.register)throw new TypeError('host_bootstrap_owner_registration_invalid');
  const dispose=connection.fetch.register(createHostPolicyBootstrapOwnerRoute(deps));
  context.effect(()=>()=>dispose());
  return dispose;
}
