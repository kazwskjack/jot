import {Readable} from 'node:stream';
import {createHostBootstrapStateStore} from './host-bootstrap-state.mjs';

const BOOTSTRAP_PATH='/api/jot-host-policy/bootstrap';
const OPAQUE=/^[A-Za-z0-9_-]{43}$/;
const SETTINGS_KEY=/^[A-Za-z0-9_-]{8,128}$/;
const SETTINGS_HASH=/^[a-f0-9]{64}$/;
const SETTINGS_NAMESPACE=/^[a-z][a-z0-9._-]{0,127}$/;
const SETTINGS_WRITE_ROUTES=[
 {method:'GET',path:'/v1/host/settings/editor',gatewayPath:'/v1/host/settings/editor',kind:'read'},
 {method:'POST',path:'/v1/host/settings/approval-requests',gatewayPath:'/v1/host/settings/approval-requests',kind:'approval'},
 {method:'PATCH',path:'/v1/host/settings',gatewayPath:'/v1/host/settings',kind:'write'},
];
const canonicalOrigin=(value,local=false)=>{
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash
  &&url.origin===value&&(!local||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname));}catch{return false;}
};
const exactObject=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function cookieValue(request,name){
 const raw=request.headers.cookie;if(typeof raw!=='string')return undefined;
 const matches=raw.split(';').map(row=>row.trim()).filter(row=>row.slice(0,row.indexOf('='))===name);
 if(matches.length!==1)return undefined;
 const value=matches[0].slice(name.length+1);return OPAQUE.test(value)?value:undefined;
}
function sameWorkbenchOrigin(request,origin,{allowMissingOrigin=false}={}){
 const requestOrigin=request.headers.origin;
 return (requestOrigin===origin||(allowMissingOrigin&&request.method==='GET'&&requestOrigin===undefined))&&request.headers['sec-fetch-site']==='same-origin'
  &&String(request.headers.host??'').toLowerCase()===new URL(origin).host.toLowerCase();
}
function pendingCookie(handle,maxAge){return `jot_host_pending=${handle}; HttpOnly; SameSite=Strict; Path=/api/host/bootstrap; Max-Age=${maxAge}`;}
function contextCookie(handle,maxAge){return `jot_host_context=${handle}; HttpOnly; SameSite=Strict; Path=/workbench-api/v1/host; Max-Age=${maxAge}`;}
const clearPending=()=>pendingCookie('',0);
const clearContext=()=>contextCookie('',0);
function publicBootstrapError(reply,status,code){return reply.code(status).send({error:{code}});}
function gatewayHeaders(config,jotOrigin){return {'x-user-id':config.owner,'x-csrf-token':config.csrf,'origin':jotOrigin,'accept':'application/json','content-type':'application/json'};}

export function workbenchConfig(input){
 if(!input?.url)return null;
 let url;try{url=new URL(input.url);}catch{throw new Error('invalid_workbench_config');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^[-\w]{1,128}$/.test(input.owner??'')||typeof input.csrf!=='string'||input.csrf.length<16)throw new Error('invalid_workbench_config');
 let hostBootstrap;
 if(input.hostBootstrap!==undefined){
  const value=input.hostBootstrap;
  const {credentialManagementEnabled,...settings}=value??{};
  if(credentialManagementEnabled!==undefined&&typeof credentialManagementEnabled!=='boolean')throw Error('invalid_workbench_host_credentials_config');
  const basic=exactObject(settings,['enabled','dshOrigin','jotOrigin','namespaces']);
  const writable=exactObject(settings,['enabled','dshOrigin','jotOrigin','namespaces','writeEnabled','writeNamespace'])&&value.writeEnabled===true
   &&value.writeNamespace==='jot-session-adapter'&&SETTINGS_NAMESPACE.test(value.writeNamespace)
   &&Array.isArray(value.namespaces)&&value.namespaces.includes(value.writeNamespace);
  if(!value||typeof value!=='object'||Array.isArray(value)||(!basic&&!writable)||value.enabled!==true
   ||!canonicalOrigin(value.dshOrigin)||!canonicalOrigin(value.jotOrigin,true)||value.dshOrigin===value.jotOrigin
   ||!Array.isArray(value.namespaces)||value.namespaces.length===0||value.namespaces.length>64||value.namespaces.some(name=>typeof name!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(name)||name==='jot-host-policy')
   ||new Set(value.namespaces).size!==value.namespaces.length)throw new Error('invalid_workbench_host_bootstrap_config');
  hostBootstrap={enabled:true,...(credentialManagementEnabled?{credentialManagementEnabled:true}:{}),dshOrigin:value.dshOrigin,jotOrigin:value.jotOrigin,namespaces:[...value.namespaces],...(writable?{writeEnabled:true,writeNamespace:value.writeNamespace}:{})};
 }
 return {...input,...(hostBootstrap?{hostBootstrap}:{}),url:url.origin,fetch:input.fetch??fetch};
}

export function registerWorkbenchProxy(app,config,localCsrf){
 const hostBootstrap=config?.hostBootstrap?.enabled===true?config.hostBootstrap:undefined;
 const hostBootstrapStore=hostBootstrap?createHostBootstrapStateStore():undefined;
 const emptyBody={type:'object',properties:{},required:[],additionalProperties:false};
 const bootstrapBody={type:'object',properties:{state:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},code:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}},required:['state','code'],additionalProperties:false};
 if(hostBootstrap){
  app.post('/api/host/bootstrap/credentials',{schema:{body:emptyBody}},async(request,reply)=>{
   if(!exactObject(request.body,[]))return publicBootstrapError(reply,422,'HOST_CREDENTIALS_INVALID');
   if(!sameWorkbenchOrigin(request,hostBootstrap.jotOrigin))return publicBootstrapError(reply,403,'HOST_CREDENTIALS_ORIGIN_DENIED');
   reply.header('cache-control','no-store');
   return hostBootstrap.credentialManagementEnabled===true?{enabled:true,owner_url:hostBootstrap.dshOrigin+'/api/jot-host-credentials'}:{enabled:false};
  });
  app.post('/api/host/bootstrap/challenge',{
   preValidation:async(request,reply)=>{if(!exactObject(request.body,[]))return publicBootstrapError(reply,422,'HOST_BOOTSTRAP_INVALID');},
   schema:{body:emptyBody}
  },async(request,reply)=>{
   if(!sameWorkbenchOrigin(request,hostBootstrap.jotOrigin))return publicBootstrapError(reply,403,'HOST_BOOTSTRAP_ORIGIN_DENIED');
   const challenge=hostBootstrapStore.createChallenge();
   if(!challenge.ok)return publicBootstrapError(reply,503,'HOST_BOOTSTRAP_UNAVAILABLE');
   reply.header('cache-control','no-store').header('set-cookie',pendingCookie(challenge.pendingHandle,90));
   return reply.code(200).send({state:challenge.state,actor_id:config.owner,dsh_origin:hostBootstrap.dshOrigin,
    bootstrap_path:BOOTSTRAP_PATH,namespaces:[...hostBootstrap.namespaces]});
  });
  app.post('/api/host/bootstrap/redeem',{
   preValidation:async(request,reply)=>{if(!exactObject(request.body,['code','state']))return publicBootstrapError(reply,422,'HOST_BOOTSTRAP_INVALID');},
   schema:{body:bootstrapBody}
  },async(request,reply)=>{
   if(!sameWorkbenchOrigin(request,hostBootstrap.jotOrigin))return publicBootstrapError(reply,403,'HOST_BOOTSTRAP_ORIGIN_DENIED');
   const pending=cookieValue(request,'jot_host_pending'),body=request.body;
   if(!pending)return publicBootstrapError(reply,401,'HOST_BOOTSTRAP_REQUIRED');
   const consumed=hostBootstrapStore.consumeChallenge({pendingHandle:pending,state:body.state});
   if(!consumed.ok)return publicBootstrapError(reply,409,'HOST_BOOTSTRAP_INVALID');
   try{
    const response=await config.fetch(`${config.url}/v1/host/bootstrap/redeem`,{method:'POST',headers:gatewayHeaders(config,hostBootstrap.jotOrigin),
     body:JSON.stringify({state:body.state,code:body.code}),signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!response.ok){reply.header('set-cookie',clearPending());return publicBootstrapError(reply,response.status===401||response.status===403?409:503,'HOST_BOOTSTRAP_DENIED');}
    const result=await response.json();
    if(!exactObject(result,['expires_at','ticket'])||!OPAQUE.test(result.ticket)||!Number.isSafeInteger(result.expires_at)){
     reply.header('set-cookie',clearPending());return publicBootstrapError(reply,503,'HOST_BOOTSTRAP_UNAVAILABLE');
    }
    const context=hostBootstrapStore.storeContext({ticket:result.ticket,expiresAt:result.expires_at});
    if(!context.ok){reply.header('set-cookie',clearPending());return publicBootstrapError(reply,409,'HOST_BOOTSTRAP_UNAVAILABLE');}
    const maxAge=Math.max(1,Math.min(300,Math.ceil((context.expiresAt-Date.now())/1000)));
    reply.header('cache-control','no-store').header('set-cookie',[clearPending(),contextCookie(context.handle,maxAge)]);
    return reply.code(200).send({approved:true});
   }catch{
    reply.header('set-cookie',clearPending());return publicBootstrapError(reply,503,'HOST_BOOTSTRAP_UNAVAILABLE');
   }
  });
 }
 app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(req,body,done)=>{
  if(req.method!=='PUT'||!(/^\/workbench-api\/v1\/uploads\/[^/?]+\/content(?:\?.*)?$/.test(req.url)||/^\/workbench-api\/v1\/workspaces\/[^/?]+\/files\/binary(?:\?.*)?$/.test(req.url)))return done(Object.assign(new Error('binary_upload_only'),{statusCode:415,code:'FST_ERR_CTP_INVALID_MEDIA_TYPE'}));
  done(null,body);
 });
 const handler=async(req,reply)=>{
  if(!config)return reply.code(503).send({error:{code:'WORKBENCH_NOT_CONFIGURED',message:'Configure the local workbench gateway first.'}});
  const path=new URL(req.url,'http://localhost');
  const suffix=path.pathname.slice('/workbench-api'.length);
  const isHostReadiness=suffix==='/v1/host/readiness',isHostSettings=suffix==='/v1/host/settings';
  const settingsAttempt=/^\/v1\/host\/settings\/attempts\/([A-Za-z0-9_-]{8,128})$/.exec(suffix);
  const settingsRoute=SETTINGS_WRITE_ROUTES.find(row=>row.method===req.method&&row.path===suffix)
   ??(req.method==='GET'&&settingsAttempt?{method:'GET',path:suffix,gatewayPath:`/v1/host/settings/attempts/${settingsAttempt[1]}`,kind:'read'}:undefined);
  const isHostSettingsWritePath=SETTINGS_WRITE_ROUTES.some(row=>row.path===suffix&&!(suffix==='/v1/host/settings'&&req.method==='GET'))||settingsAttempt!==null;
  if(isHostSettingsWritePath){
   reply.header('cache-control','private, no-store');
   if(!hostBootstrap?.writeEnabled||!settingsRoute)return reply.code(404).send({error:{code:'HOST_SETTINGS_WRITE_UNAVAILABLE'}});
   if(!sameWorkbenchOrigin(req,hostBootstrap.jotOrigin,{allowMissingOrigin:settingsRoute.method==='GET'}))return reply.code(403).send({error:{code:'HOST_SETTINGS_ORIGIN_DENIED'}});
   if(path.searchParams.size!==1||!path.searchParams.has('namespace'))return reply.code(400).send({error:{code:'HOST_SETTINGS_INVALID'}});
   const namespace=path.searchParams.get('namespace');
   if(namespace!==hostBootstrap.writeNamespace||!hostBootstrap.namespaces.includes(namespace)||namespace==='jot-host-policy')return reply.code(403).send({error:{code:'HOST_SETTINGS_DENIED'}});
   const key=req.headers['idempotency-key'];
   if(settingsRoute.kind==='write'&&(!SETTINGS_KEY.test(key??'')||!req.body||typeof req.body!=='object'||Array.isArray(req.body)
    ||Object.keys(req.body).sort().join(',')!=='expected_schema_fingerprint,expected_version,settings'
    ||!Number.isSafeInteger(req.body.expected_version)||req.body.expected_version<1||!SETTINGS_HASH.test(req.body.expected_schema_fingerprint??'')
    ||!req.body.settings||typeof req.body.settings!=='object'||Array.isArray(req.body.settings)))return reply.code(422).send({error:{code:'HOST_SETTINGS_INVALID'}});
   if(settingsRoute.kind==='approval'&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)
    ||Object.keys(req.body).sort().join(',')!=='command,purpose'||req.body.purpose!=='settings.update'
    ||!req.body.command||typeof req.body.command!=='object'||Array.isArray(req.body.command)
    ||Object.keys(req.body.command).sort().join(',')!=='expected_schema_fingerprint,expected_version,idempotency_key,settings'
    ||!SETTINGS_KEY.test(req.body.command.idempotency_key??'')||!Number.isSafeInteger(req.body.command.expected_version)||req.body.command.expected_version<1
    ||!SETTINGS_HASH.test(req.body.command.expected_schema_fingerprint??'')||!req.body.command.settings||typeof req.body.command.settings!=='object'||Array.isArray(req.body.command.settings)))
    return reply.code(422).send({error:{code:'HOST_SETTINGS_INVALID'}});
   if(settingsRoute.kind==='read'&&req.body!==undefined)return reply.code(422).send({error:{code:'HOST_SETTINGS_INVALID'}});
   const contextHandle=cookieValue(req,'jot_host_context'),context=contextHandle&&hostBootstrapStore.getContext(contextHandle);
   if(!context?.ok){if(contextHandle)reply.header('set-cookie',clearContext());return reply.code(401).send({error:{code:'HOST_BOOTSTRAP_REQUIRED'}});}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
   req.raw.once('aborted',()=>controller.abort());reply.raw.once('close',()=>controller.abort());
   const headers={...gatewayHeaders(config,hostBootstrap.jotOrigin),'x-jot-host-context-ticket':context.ticket};
   if(settingsRoute.kind==='write')headers['idempotency-key']=String(key);
   if(settingsRoute.kind==='write'||settingsRoute.kind==='approval')headers['content-type']='application/json';
   try{
    const query=new URLSearchParams({namespace});
    const response=await config.fetch(`${config.url}${settingsRoute.gatewayPath}?${query}`,{method:settingsRoute.method,headers,
     ...(req.body!==undefined?{body:JSON.stringify(req.body)}:{}),signal:controller.signal,redirect:'error'});
    if(!response.ok){
     const value=await response.json().catch(()=>null);
     if(value&&typeof value==='object'&&!Array.isArray(value)
      &&(response.status===409&&['conflict','stale_scope'].includes(value.status)||response.status===422&&value.status==='rejected'))
      return reply.code(response.status).type('application/json').send(value);
     if([401,403,409].includes(response.status)){hostBootstrapStore.deleteContext(contextHandle);reply.header('set-cookie',clearContext());}
     let code=response.status===401?'HOST_BOOTSTRAP_REQUIRED':response.status===422?'HOST_SETTINGS_INVALID':response.status===403?'HOST_SETTINGS_DENIED':'HOST_SETTINGS_UNAVAILABLE';
     if(typeof value?.error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value.error.code))code=value.error.code;
     return reply.code(response.status).send({error:{code}});
    }
    const value=await response.json();
    return reply.code(response.status).type('application/json').send(value);
   }catch{return reply.code(502).send({error:{code:'HOST_SETTINGS_UNAVAILABLE'}});}
   finally{clearTimeout(timer);}
  }
  if(hostBootstrap&&req.method==='GET'&&(isHostSettings||isHostReadiness)){
   const prefix=isHostReadiness?'HOST_READINESS':'HOST_SETTINGS';
   reply.header('cache-control','private, no-store');
   if(!sameWorkbenchOrigin(req,hostBootstrap.jotOrigin,{allowMissingOrigin:true}))return reply.code(403).send({error:{code:`${prefix}_ORIGIN_DENIED`}});
   if(path.searchParams.size!==1||!path.searchParams.has('namespace'))return reply.code(400).send({error:{code:`${prefix}_INVALID`}});
   const namespace=path.searchParams.get('namespace');
   if(typeof namespace!=='string'||!hostBootstrap.namespaces.includes(namespace)||namespace==='jot-host-policy')return reply.code(403).send({error:{code:`${prefix}_DENIED`}});
   const contextHandle=cookieValue(req,'jot_host_context'),context=contextHandle&&hostBootstrapStore.getContext(contextHandle);
   if(!context?.ok){if(contextHandle)reply.header('set-cookie',clearContext());return reply.code(401).send({error:{code:'HOST_BOOTSTRAP_REQUIRED'}});}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
   req.raw.once('aborted',()=>controller.abort());reply.raw.once('close',()=>controller.abort());
   try{
    const query=new URLSearchParams({namespace});
    const gatewayPath=isHostReadiness?'/v1/host/readiness':'/v1/host/settings';
    const response=await config.fetch(`${config.url}${gatewayPath}?${query}`,{method:'GET',headers:{'x-user-id':config.owner,'x-csrf-token':config.csrf,'origin':hostBootstrap.jotOrigin,
      'accept':req.headers.accept??'application/json','x-jot-host-context-ticket':context.ticket},signal:controller.signal,redirect:'error'});
    if(!response.ok){
     if([401,403,409].includes(response.status)){hostBootstrapStore.deleteContext(contextHandle);reply.header('set-cookie',clearContext());}
     return reply.code(response.status).send({error:{code:response.status===401?'HOST_BOOTSTRAP_REQUIRED':`${prefix}_DENIED`}});
    }
    const value=await response.json();
    return reply.code(200).type('application/json').send(value);
   }catch{return reply.code(502).send({error:{code:`${prefix}_UNAVAILABLE`}});}
   finally{clearTimeout(timer);}
  }
  const allowed=/^\/v1\/(capabilities|agents|persistent-tasks|teams|workspaces|runs|conversations|interactions|channel-bindings|push|projects|artifacts|uploads)(?:\/|$)/;
  const pushAllowed=(req.method==='GET'&&suffix==='/v1/push/vapid-public-key')
   ||(req.method==='POST'&&suffix==='/v1/push/subscriptions')
   ||(req.method==='POST'&&/^\/v1\/push\/subscriptions\/[^/]+\/revoke$/.test(suffix));
  if(!allowed.test(suffix)||((suffix==='/v1/push'||suffix.startsWith('/v1/push/'))&&!pushAllowed)||/%(?:2e|2f|5c)/i.test(suffix)||suffix.includes('\\'))return reply.code(400).send({error:{code:'INVALID_WORKBENCH_PATH'}});
  const headers={'x-user-id':config.owner,'x-csrf-token':config.csrf,'origin':`http://${req.headers.host??'localhost'}`,'accept':req.headers.accept??'application/json'};
  if(req.headers['idempotency-key'])headers['idempotency-key']=req.headers['idempotency-key'];
  if(req.headers['last-event-id'])headers['last-event-id']=req.headers['last-event-id'];
   const binary=req.method==='PUT'&&(/^\/v1\/uploads\/[^/]+\/content$/.test(suffix)||/^\/v1\/workspaces\/[^/]+\/files\/binary$/.test(suffix));
   const binaryDownload=req.method==='GET'&&/^\/v1\/workspaces\/[^/]+\/files\/binary$/.test(suffix);
  if(binary&&!Buffer.isBuffer(req.body))return reply.code(415).send({error:{code:'BINARY_UPLOAD_REQUIRED'}});
  if(req.body!==undefined)headers['content-type']=binary?'application/octet-stream':'application/json';
   if(binary||binaryDownload)reply.header('cache-control','private, no-store');
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),binary||binaryDownload?120000:30000);
  req.raw.once('aborted',()=>controller.abort());reply.raw.once('close',()=>controller.abort());
  try{
   const response=await config.fetch(config.url+suffix+path.search,{method:req.method,headers,body:req.body===undefined?undefined:binary?req.body:JSON.stringify(req.body),signal:controller.signal,redirect:'error'});
   reply.code(response.status);const type=response.headers.get('content-type')??'application/json';reply.type(type);
   if(suffix==='/v1/capabilities'&&response.ok){reply.header('x-csrf-token',localCsrf);const scope=response.headers.get('x-workbench-draft-scope');if(/^[a-f0-9]{64}$/.test(scope??''))reply.header('x-workbench-draft-scope',scope);}
    for(const name of ['content-disposition','etag','x-workspace-file-sha256','x-workspace-file-size']){const value=response.headers.get(name);if(value)reply.header(name,value);}
   const reviewDownload=req.method==='GET'&&/^\/v1\/interactions\/[^/]+\/outputs\/(?:0|[1-9][0-9]{0,3})$/.test(suffix)&&type.startsWith('application/octet-stream');
    if((type.startsWith('text/event-stream')||reviewDownload||binaryDownload&&type.startsWith('application/octet-stream'))&&response.body){clearTimeout(timer);return reply.send(Readable.fromWeb(response.body));}
   if(response.status===204)return reply.send();
   return reply.send(Buffer.from(await response.arrayBuffer()));
  }catch{return reply.code(502).send({error:{code:'WORKBENCH_UNAVAILABLE',message:'The local workbench gateway did not respond.'}});}
  finally{clearTimeout(timer);}
 };
 app.route({method:['GET','POST','PATCH','DELETE'],url:'/workbench-api/v1/*',handler});
 app.route({method:'PUT',url:'/workbench-api/v1/uploads/:uploadId/content',bodyLimit:104857600,handler});
 app.route({method:'PUT',url:'/workbench-api/v1/workspaces/:workspaceId/files',handler});
  app.route({method:'PUT',url:'/workbench-api/v1/workspaces/:workspaceId/files/binary',bodyLimit:104857600,handler});
}
