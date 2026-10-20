import {createServer,request} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {lstat,realpath,chmod} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const keys='execution_id,owner_id,project_id';
const rejected=()=>Error('native_git_transport_rejected');
function scopeOf(input){
 const invalid=()=>{throw Error('native_git_transport_input_invalid');};
 if(!input||typeof input!=='object'||Array.isArray(input))invalid();
 const value={...input},typed=Object.hasOwn(value,'operation_kind'),recovery=Object.hasOwn(value,'command');
 const expected=typed?(recovery?'command,execution_id,operation_kind,owner_id,project_id':'execution_id,operation_kind,owner_id,project_id'):keys;
 if(Object.keys(value).sort().join(',')!==expected||!['owner_id','project_id','execution_id'].every(key=>typeof value[key]==='string'&&ID.test(value[key]))
  ||typed&&!['git_index','work_publication'].includes(value.operation_kind)||recovery&&value.operation_kind!=='work_publication')invalid();
 if(recovery){
  if(!value.command||typeof value.command!=='object'||Array.isArray(value.command))invalid();const command={...value.command};
  if(Object.keys(command).sort().join(',')!=='acknowledge_unknown,action,expected_journal_sha256,request_id'||typeof command.request_id!=='string'||!ID.test(command.request_id)
   ||!['confirm_recorded','abandon_unknown'].includes(command.action)||command.acknowledge_unknown!==true||typeof command.expected_journal_sha256!=='string'||!/^[a-f0-9]{64}$/.test(command.expected_journal_sha256))invalid();
  value.command=Object.freeze(command);
 }
 return Object.freeze(value);
}
function configuration(options){
 if(!options||typeof options.socket!=='string'||typeof options.token!=='string'||options.token.length<32||options.token.length>256||/[\r\n]/.test(options.token))throw Error('native_git_transport_config_invalid');
 const bs=String.fromCharCode(92),prefix=[bs,bs,'.',bs,'pipe',bs].join('');
 if(process.platform==='win32'){
  if(!options.socket.startsWith(prefix)||!/^jot-git-[A-Za-z0-9._-]{1,120}$/.test(options.socket.slice(prefix.length)))throw Error('native_git_transport_config_invalid');
 }else if(!isAbsolute(options.socket)||resolve(options.socket)!==options.socket||Buffer.byteLength(options.socket)>100)throw Error('native_git_transport_config_invalid');
 return{socket:options.socket,token:options.token};
}
const digest=value=>createHash('sha256').update(value).digest();
const publicCodes=new Set(['git_execution_revoked','git_execution_not_found','git_native_workspace_host_unavailable','native_git_database_changed','native_git_transport_busy']);

/** Local transport only. The original perform function retains all authority.
 * Preserve legacy three-ID index requests; typed publication requests carry
 * only original IDs and, for recovery, an exact original-owner command. No
 * root, source bytes, planner or approval can be supplied through this layer.
 * Requests are never automatically retried, replayed or treated as approvals. */
export async function createNativeGitTransport(options){
 const {socket,token}=configuration(options),perform=options.perform;
 if(typeof perform!=='function')throw Error('native_git_transport_config_invalid');
 if(process.platform!=='win32'){
  const parent=dirname(socket),stat=await lstat(parent);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(parent)!==parent||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw Error('native_git_transport_directory_invalid');
 }
 let stopped=false,disposal;const active=new Set(),controllers=new Set(),expected=digest('Bearer '+token);
 const server=createServer((req,res)=>{
  const send=(status,value)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
  const operation=(async()=>{
   if(stopped){send(503,{error:'native_git_transport_unavailable'});return;}
   const supplied=typeof req.headers.authorization==='string'?req.headers.authorization:'';
   if(!timingSafeEqual(digest(supplied),expected)){send(403,{error:'native_git_transport_rejected'});return;}
   if(req.method!=='POST'||req.url!=='/execute'||req.headers['content-type']!=='application/json'){send(400,{error:'native_git_transport_input_invalid'});return;}
   if(controllers.size){send(409,{error:'native_git_transport_busy'});return;}
   const abort=new AbortController();controllers.add(abort);
   const disconnected=()=>{if(!res.writableFinished)abort.abort(Error('native_git_transport_disconnected'));};res.once('close',disconnected);
   const stopBody=()=>{if(!req.complete)req.destroy();};abort.signal.addEventListener('abort',stopBody,{once:true});
   try{
    const chunks=[];let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>2048)throw Error('native_git_transport_input_invalid');chunks.push(chunk);}
    const input=scopeOf(JSON.parse(Buffer.concat(chunks).toString('utf8')));abort.signal.throwIfAborted();
    const result=await perform(input,abort.signal);abort.signal.throwIfAborted();
    const json=JSON.stringify(result);if(typeof json!=='string'||Buffer.byteLength(json)>256*1024)throw Error('native_git_transport_result_invalid');
    send(200,result);
   }catch(error){send(409,{error:publicCodes.has(error?.message)?error.message:'native_git_transport_rejected'});}
   finally{controllers.delete(abort);res.removeListener('close',disconnected);abort.signal.removeEventListener('abort',stopBody);}
  })().catch(()=>send(500,{error:'native_git_transport_rejected'})).finally(()=>active.delete(operation));active.add(operation);
 });
 server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=1000;server.maxConnections=8;
 try{await new Promise((done,reject)=>{server.once('error',reject);server.listen({path:socket,readableAll:false,writableAll:false},done);});if(process.platform!=='win32')await chmod(socket,0o600);}
 catch(error){server.close();throw Error('native_git_transport_unavailable');}
 return Object.freeze({dispose(){
  if(disposal)return disposal;stopped=true;
  const closed=new Promise(done=>server.close(done));for(const abort of controllers)abort.abort(Error('native_git_transport_shutdown'));
  server.closeIdleConnections();
  disposal=(async()=>{await Promise.allSettled([...active]);server.closeAllConnections();await closed;})();return disposal;
 }});
}

export async function callNativeGitTransport(options,input,signal){
 const config=configuration(options),scope=scopeOf(input);signal?.throwIfAborted();
 const combined=AbortSignal.any([AbortSignal.timeout(120000),...(signal?[signal]:[])]);
 return new Promise((done,reject)=>{
  const req=request({socketPath:config.socket,path:'/execute',method:'POST',agent:false,signal:combined,headers:{authorization:'Bearer '+config.token,'content-type':'application/json','connection':'close'}},res=>{
   const chunks=[];let bytes=0;
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>256*1024)res.destroy(rejected());else chunks.push(chunk);});res.on('error',()=>reject(rejected()));
   res.on('end',()=>{if(res.statusCode!==200){reject(rejected());return;}try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(rejected());}});
  });
  req.on('error',()=>reject(combined.aborted?combined.reason:rejected()));req.end(JSON.stringify(scope));
 });
}
