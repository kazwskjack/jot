import Fastify from 'fastify';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {Store} from './store.mjs';
import {Agent} from './agent.mjs';
import {createTools,safeName,readArtifact} from './tools.mjs';
import {modelProvider} from './provider.mjs';
const publicRoot=fileURLToPath(new URL('../dist/',import.meta.url));
const string={type:'string',minLength:1,maxLength:8000};
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const sameToken=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

export async function buildServer(options={}){
  const demo=options.demo??false,csrf=randomBytes(24).toString('hex');
  const root=resolve(options.root??'.data/files'),store=new Store(options.database??'.data/jot.db');store.recover();
  const origins=new Set((process.env.JOT_WEB_ORIGINS??'').split(',').map(x=>x.trim()).filter(Boolean));
  const tools=createTools({store,root,origins,searchUrl:process.env.JOT_SEARCH_URL??'',browserEnabled:process.env.JOT_BROWSER==='true'&&!demo});
  const demoProvider=async (messages,definitions,signal,onText)=>{
    const text='This is a local demonstration, not a model response. Jot can show task progress, preserve conversations, request approval and deliver files. Configure a model endpoint to perform real tasks.';
    for(const word of text.split(' ')){await new Promise((resolve,reject)=>{if(signal.aborted)return reject(new Error('cancelled'));const done=()=>{signal.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,35);const abort=()=>{clearTimeout(timer);reject(new Error('cancelled'));};signal.addEventListener('abort',abort,{once:true});});onText(word+' ');}return {role:'assistant',content:text};
  };
  const agent=new Agent(store,{provider:options.provider??(demo?demoProvider:modelProvider({baseUrl:process.env.JOT_MODEL_URL,key:process.env.JOT_MODEL_KEY,model:process.env.JOT_MODEL})),tools,maxWorkers:options.maxWorkers??process.env.JOT_WORKERS,maxSteps:options.maxSteps??process.env.JOT_MAX_STEPS,approvalTimeoutMs:options.approvalTimeoutMs??process.env.JOT_APPROVAL_TIMEOUT_MS});
  const app=Fastify({logger:false,bodyLimit:1500000}),streams=new Set();
  app.addHook('onRequest',async(req,reply)=>{
    const host=req.headers.host??'localhost';
    if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))return reply.code(403).send({error:'invalid_host'});
    if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==`http://${host}`))return reply.code(403).send({error:'origin_denied'});
    if(req.url.startsWith('/api/')&&req.url.split('?')[0]!=='/api/capabilities'&&!sameToken(req.headers['x-jot-token'],csrf))return reply.code(403).send({error:'token_required'});
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
  });
  app.setErrorHandler((error,req,reply)=>{const status=error.validation?400:reply.statusCode>=400?reply.statusCode:500;reply.code(status).send({error:error.validation?'invalid_input':status===500?'request_failed':error.message});});
  app.get('/api/capabilities',async()=>({mode:demo?'demo':'agent',csrf,model_configured:Boolean(process.env.JOT_MODEL_URL&&process.env.JOT_MODEL)||Boolean(options.provider),tools:tools.definitions.map(t=>t.function.name),limits:{max_message_chars:8000,max_file_bytes:1000000,workers:agent.maxWorkers,per_conversation:1,max_steps:agent.maxSteps,approval_timeout_ms:agent.approvalTimeoutMs}}));
  app.get('/api/conversations',async()=>store.conversations());
  app.post('/api/conversations',{schema:{body:object({title:{type:'string',maxLength:100}},[])}},async req=>store.createConversation(req.body.title||'New chat'));
  app.get('/api/conversations/:id/snapshot',async(req,reply)=>{if(!store.conversation(req.params.id))return reply.code(404).send({error:'not_found'});return store.snapshot(req.params.id);});
  app.post('/api/conversations/:id/messages',{schema:{body:object({text:string,request_id:{type:'string',minLength:1,maxLength:100}},['text','request_id'])}},async(req,reply)=>{
    try {const accepted=store.accept(req.params.id,req.body.text,req.body.request_id);if(!accepted.duplicate)void agent.execute(accepted.run);return reply.code(202).send(accepted);}
    catch(e){return reply.code(e.message==='conversation_not_found'?404:409).send({error:e.message});}
  });
  app.post('/api/runs/:id/cancel',async(req,reply)=>{if(!store.run(req.params.id))return reply.code(404).send({error:'not_found'});agent.cancel(req.params.id);return {accepted:true};});
  app.post('/api/runs/:id/approval',{schema:{body:object({allowed:{type:'boolean'},approval_id:{type:'string',minLength:1,maxLength:100}},['allowed','approval_id'])}},async(req,reply)=>agent.approve(req.params.id,req.body.allowed,req.body.approval_id)?{accepted:true}:reply.code(409).send({error:'approval_expired'}));
  app.get('/api/conversations/:id/events',async(req,reply)=>{
    if(!store.conversation(req.params.id))return reply.code(404).send({error:'not_found'});
    let cursor=Number(req.query.after??0);if(!Number.isSafeInteger(cursor)||cursor<0)return reply.code(400).send({error:'invalid_cursor'});
    reply.hijack();streams.add(reply.raw);reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});reply.raw.flushHeaders();
    const send=()=>{if(reply.raw.destroyed)return;for(const e of store.events(req.params.id,cursor)){if(reply.raw.writableLength>1000000){reply.raw.destroy();return;}reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);cursor=e.seq;}};
    send();const polling=setInterval(send,150),heartbeat=setInterval(()=>reply.raw.write(': keepalive\n\n'),15000);reply.raw.on('close',()=>{streams.delete(reply.raw);clearInterval(polling);clearInterval(heartbeat);});
  });
  app.post('/api/conversations/:id/files',{schema:{body:object({name:{type:'string',maxLength:100},text:{type:'string',maxLength:1000000}},['name','text'])}},async(req,reply)=>{
    if(!store.conversation(req.params.id))return reply.code(404).send({error:'not_found'});
    let name;try{name=safeName(req.body.name);}catch{return reply.code(400).send({error:'invalid_file_name'});}
    if(Buffer.byteLength(req.body.text)>1000000)return reply.code(413).send({error:'file_too_large'});
    const id=randomUUID(),folder=join(root,req.params.id);await mkdir(folder,{recursive:true});const path=join(folder,id);await writeFile(path,req.body.text,{flag:'wx'});store.artifact({id,conversation_id:req.params.id,name,path,size:Buffer.byteLength(req.body.text)});return {id,name};
  });
  app.get('/api/artifacts/:id/download',async(req,reply)=>{
    const a=store.getArtifact(req.params.id);if(!a)return reply.code(404).send({error:'artifact_not_found'});
    try {const bytes=await readArtifact(a.path,root);return reply.header('Content-Type','application/octet-stream').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`).send(bytes);}catch{return reply.code(410).send({error:'artifact_expired'});}
  });
  app.get('/*',async(req,reply)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;const path=resolve(publicRoot,pathname==='/'?'index.html':'.'+pathname);
    if(!path.startsWith(publicRoot+sep))return reply.code(404).send('Not found');
    try {const data=await readFile(path);const ext=path.split('.').pop();const types={html:'text/html',js:'application/javascript',css:'text/css',svg:'image/svg+xml'};return reply.header('Content-Type',types[ext]??'application/octet-stream').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'").send(data);}catch{return reply.code(404).send('Run npm run build before opening the interface.');}
  });
  let closing;
  return {app,agent,store,close:()=>closing??=(async()=>{for(const stream of streams)stream.destroy();await agent.close();await app.close();store.close();})()};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const service=await buildServer({demo:process.argv.includes('--demo')});const port=Number(process.env.JOT_PORT??3030);await service.app.listen({host:'127.0.0.1',port});
  console.log(`Jot is ready at http://127.0.0.1:${port} (${process.argv.includes('--demo')?'demo':'agent'})`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await service.close();process.exit(0);});
}
