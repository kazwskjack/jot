import {Readable} from 'node:stream';

export function workbenchConfig(input){
 if(!input?.url)return null;
 let url;try{url=new URL(input.url);}catch{throw new Error('invalid_workbench_config');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^[-\w]{1,128}$/.test(input.owner??'')||typeof input.csrf!=='string'||input.csrf.length<16)throw new Error('invalid_workbench_config');
 return {...input,url:url.origin,fetch:input.fetch??fetch};
}

export function registerWorkbenchProxy(app,config,localCsrf){
 app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(req,body,done)=>{
  if(req.method!=='PUT'||!/^\/workbench-api\/v1\/uploads\/[^/?]+\/content(?:\?.*)?$/.test(req.url))return done(Object.assign(new Error('binary_upload_only'),{statusCode:415,code:'FST_ERR_CTP_INVALID_MEDIA_TYPE'}));
  done(null,body);
 });
 const handler=async(req,reply)=>{
  if(!config)return reply.code(503).send({error:{code:'WORKBENCH_NOT_CONFIGURED',message:'Configure the local workbench gateway first.'}});
  const path=new URL(req.url,'http://localhost');
  const suffix=path.pathname.slice('/workbench-api'.length);
  const allowed=/^\/v1\/(capabilities|agents|persistent-tasks|teams|workspaces|runs|conversations|interactions|channel-bindings|projects|artifacts|uploads)(?:\/|$)/;
  if(!allowed.test(suffix)||/%(?:2e|2f|5c)/i.test(suffix)||suffix.includes('\\'))return reply.code(400).send({error:{code:'INVALID_WORKBENCH_PATH'}});
  const headers={'x-user-id':config.owner,'x-csrf-token':config.csrf,'origin':`http://${req.headers.host??'localhost'}`,'accept':req.headers.accept??'application/json'};
  if(req.headers['idempotency-key'])headers['idempotency-key']=req.headers['idempotency-key'];
  if(req.headers['last-event-id'])headers['last-event-id']=req.headers['last-event-id'];
  const binary=req.method==='PUT'&&/^\/v1\/uploads\/[^/]+\/content$/.test(suffix);
  if(binary&&!Buffer.isBuffer(req.body))return reply.code(415).send({error:{code:'BINARY_UPLOAD_REQUIRED'}});
  if(req.body!==undefined)headers['content-type']=binary?'application/octet-stream':'application/json';
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),binary?120000:30000);
  req.raw.once('aborted',()=>controller.abort());reply.raw.once('close',()=>controller.abort());
  try{
   const response=await config.fetch(config.url+suffix+path.search,{method:req.method,headers,body:req.body===undefined?undefined:binary?req.body:JSON.stringify(req.body),signal:controller.signal,redirect:'error'});
   reply.code(response.status);const type=response.headers.get('content-type')??'application/json';reply.type(type);
   if(suffix==='/v1/capabilities'&&response.ok){reply.header('x-csrf-token',localCsrf);const scope=response.headers.get('x-workbench-draft-scope');if(/^[a-f0-9]{64}$/.test(scope??''))reply.header('x-workbench-draft-scope',scope);}
   if(type.startsWith('text/event-stream')&&response.body){clearTimeout(timer);return reply.send(Readable.fromWeb(response.body));}
   if(response.status===204)return reply.send();
   for(const name of ['content-disposition']){const value=response.headers.get(name);if(value)reply.header(name,value);}
   return reply.send(Buffer.from(await response.arrayBuffer()));
  }catch{return reply.code(502).send({error:{code:'WORKBENCH_UNAVAILABLE',message:'The local workbench gateway did not respond.'}});}
  finally{clearTimeout(timer);}
 };
 app.route({method:['GET','POST','PATCH','DELETE'],url:'/workbench-api/v1/*',handler});
 app.route({method:'PUT',url:'/workbench-api/v1/uploads/:uploadId/content',bodyLimit:104857600,handler});
 app.route({method:'PUT',url:'/workbench-api/v1/workspaces/:workspaceId/files',handler});
}
