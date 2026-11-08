import {createHash} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HASH=/^[a-f0-9]{64}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fail=()=>{throw Error('mcp_host_stdio_unavailable');};

export function normalizeMcpStdioPolicy(value){
 if(!exact(value,['owner_id','connections'])||typeof value.owner_id!=='string'||value.owner_id.length>128||!ID.test(value.owner_id)
  ||!Array.isArray(value.connections)||value.connections.length>64)fail();
 const keys=new Set();
 const connections=value.connections.map(row=>{
  if(!exact(row,['agent_id','connection_id','server_name','command','command_sha256','args','cwd','files'])
   ||![row.agent_id,row.connection_id].every(id=>typeof id==='string'&&ID.test(id))
   ||typeof row.server_name!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(row.server_name)
   ||typeof row.command!=='string'||row.command.length>1024||!isAbsolute(row.command)||typeof row.command_sha256!=='string'||!HASH.test(row.command_sha256)
   ||typeof row.cwd!=='string'||row.cwd.length>2048||!isAbsolute(row.cwd)||!Array.isArray(row.args)||row.args.length>64
   ||row.args.some(arg=>typeof arg!=='string'||arg.length>4096||arg.includes('\0'))
   ||!object(row.files)||Object.keys(row.files).length>64)fail();
  const key=JSON.stringify([row.agent_id,row.connection_id]);if(keys.has(key))fail();keys.add(key);
  const files=Object.create(null);
  for(const [file,hash] of Object.entries(row.files)){
   if(file.length>4096||!isAbsolute(file)||typeof hash!=='string'||!HASH.test(hash)||Object.hasOwn(files,resolve(file)))fail();
   files[resolve(file)]=hash;
  }
  return Object.freeze({...row,command:resolve(row.command),cwd:resolve(row.cwd),args:Object.freeze([...row.args]),files:Object.freeze(files)});
 });
 return Object.freeze({owner_id:value.owner_id,connections:Object.freeze(connections)});
}

async function matchesFile(path,expected,signal){
 signal.throwIfAborted();
 const prior=await lstat(path);
 if(!prior.isFile()||prior.isSymbolicLink())return false;
 const file=await open(path,'r');
 try{
  const before=await file.stat();if(!before.isFile()||before.size>536870912)return false;
  const hash=createHash('sha256');
  for await(const chunk of file.createReadStream({autoClose:false})){signal.throwIfAborted();hash.update(chunk);}
  const after=await file.stat(),current=await lstat(path);
  return current.isFile()&&!current.isSymbolicLink()&&before.dev===after.dev&&before.ino===after.ino
   &&before.size===after.size&&before.mtimeMs===after.mtimeMs&&current.dev===after.dev&&current.ino===after.ino
   &&current.size===after.size&&current.mtimeMs===after.mtimeMs&&hash.digest('hex')===expected;
 }finally{await file.close();}
}

/** Private Host policy authorizes the native SDK's existing stdio startup. */
export function createMcpHostStdioAuthorization({policy,readIdentity}={}){
 const approved=normalizeMcpStdioPolicy(policy);
 if(typeof readIdentity!=='function')fail();
 return async request=>{
  try{
   const signal=AbortSignal.any([request.signal??new AbortController().signal,AbortSignal.timeout(60000)]);
   signal.throwIfAborted();
   const before=readIdentity();
   const row=approved.connections.find(row=>row.agent_id===request.agentId&&row.connection_id===request.connectionId);
   if(before.ownerId!==approved.owner_id||request.ownerId!==approved.owner_id||!row||request.serverName!==row.server_name
    ||typeof request.command!=='string'||!isAbsolute(request.command)||resolve(request.command)!==row.command
    ||typeof request.cwd!=='string'||!isAbsolute(request.cwd)||resolve(request.cwd)!==row.cwd
    ||!isDeepStrictEqual(request.args,row.args))return false;
   const directory=await lstat(row.cwd);if(!directory.isDirectory()||directory.isSymbolicLink())return false;
   if(!await matchesFile(row.command,row.command_sha256,signal))return false;
   for(const [path,hash] of Object.entries(row.files))if(!await matchesFile(path,hash,signal))return false;
   signal.throwIfAborted();
   const after=readIdentity();
   return after.ownerId===before.ownerId&&after.profileId===before.profileId;
  }catch{return false;}
 };
}
