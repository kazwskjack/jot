import {createHash} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import https from 'node:https';
import {isAbsolute,relative,resolve,sep,dirname,join} from 'node:path';
import {verifyUpdateManifest} from './update-envelope.mjs';

const digestPattern=/^[a-f0-9]{64}$/;
const strongEtagPattern=/^"[\x21\x23-\x7e]*"$/;
const decimalPattern=/^(0|[1-9][0-9]*)$/;
const maxManifestBytes=16*1024*1024;
function fail(code){throw new Error(code);}
const sha=value=>createHash('sha256').update(value).digest('hex');

function safeRelativePath(value){
 return typeof value==='string'&&value.length>0&&value.length<=4096&&!value.startsWith('/')&&!/^[A-Za-z]:/.test(value)&&
  !value.includes('\\')&&!value.includes('%')&&!value.includes(':')&&!/[\u0000-\u001f\u007f]/.test(value)&&
  value.split('/').every(part=>part&&part!=='.'&&part!=='..');
}
function inDirectory(parent,child){
 const rel=relative(parent,child);
 return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));
}
function policyBase(policy){
 if(!policy?.enabled||typeof policy.origin!=='string'||typeof policy.pathPrefix!=='string'||
  !['standalone','desktop-electron'].includes(policy.profile??'standalone'))fail(policy?.reason??'desktop_update_policy_unavailable');
 let origin;
 try{origin=new URL(policy.origin);}catch{fail('desktop_update_policy_invalid');}
 if(origin.protocol!=='https:'||origin.origin!==policy.origin||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||
  !policy.pathPrefix.startsWith('/')||policy.pathPrefix==='/'||policy.pathPrefix.endsWith('/')||policy.pathPrefix.includes('..')||/[?#%\\\u0000-\u001f\u007f]/.test(policy.pathPrefix))
  fail('desktop_update_policy_invalid');
 return policy.origin+policy.pathPrefix+'/';
}
function trustedUrl(relativePath,policy){
 if(!safeRelativePath(relativePath))fail('desktop_update_path_invalid');
 const base=policyBase(policy),encoded=relativePath.split('/').map(segment=>encodeURIComponent(segment)).join('/'),url=new URL(encoded,base),origin=new URL(policy.origin);
 if(url.origin!==origin.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(policy.pathPrefix+'/'))fail('desktop_update_url_origin_invalid');
 return url.href;
}
function discardResponse(response){try{response?.body?.destroy?.();}catch{}}
function readHeader(headers,name){
 if(!headers||typeof headers!=='object'||Array.isArray(headers))return undefined;
 const key=Object.keys(headers).find(item=>item.toLowerCase()===name.toLowerCase());
 if(!key)return undefined;
 const value=headers[key];
 if(typeof value==='string')return value;
 if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);
 return undefined;
}
function requireStatus(response,status){
 if(!response||response.statusCode!==status&&response.status!==status)fail('desktop_update_http_status_invalid');
}
function requireContentLength(headers,expected){
 const value=readHeader(headers,'content-length');
 if(value===undefined||!decimalPattern.test(value)||BigInt(value)!==BigInt(expected))fail('desktop_update_content_length_invalid');
}
function requireIdentity(headers){
 const value=readHeader(headers,'content-encoding');
 if(value!==undefined&&value.toLowerCase()!=='identity')fail('desktop_update_content_encoding_invalid');
 if(readHeader(headers,'transfer-encoding')!==undefined)fail('desktop_update_transfer_encoding_invalid');
}
function requireStrongEtag(headers){
 const value=readHeader(headers,'etag');
 if(value===undefined||!strongEtagPattern.test(value))fail('desktop_update_etag_invalid');
 return value;
}
function requireContentRange(headers,offset,last,total){
 const value=readHeader(headers,'content-range');
 const match=typeof value==='string'?/^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(value):null;
 if(!match||BigInt(match[1])!==BigInt(offset)||BigInt(match[2])!==BigInt(last)||BigInt(match[3])!==BigInt(total))
  fail('desktop_update_content_range_invalid');
}
function responseBody(response){
 if(!response||!('body'in response))fail('desktop_update_http_response_invalid');
 const body=response.body;
 if(Buffer.isBuffer(body)||body instanceof Uint8Array||typeof body==='string')return (async function*(){yield Buffer.from(body);})();
 if(body&&typeof body[Symbol.asyncIterator]==='function')return body;
 fail('desktop_update_http_response_invalid');
}
async function requestHttps(url,{headers,signal}={}){
 const parsed=new URL(url);
 if(parsed.protocol!=='https:')fail('desktop_update_url_origin_invalid');
 return new Promise((resolveResponse,reject)=>{
  const request=https.request(parsed,{method:'GET',headers,signal},response=>{
   resolveResponse({statusCode:response.statusCode,headers:response.headers,body:response});
  });
  request.once('error',reject);request.end();
 });
}
function responseLengthHeaders(response,expected){
 requireIdentity(response.headers);requireContentLength(response.headers,expected);
}
async function collectManifest(response,expected,signal){
 try{
  requireStatus(response,200);responseLengthHeaders(response,expected);
  const chunks=[];let total=0;
  for await(const raw of responseBody(response)){
   if(signal?.aborted)fail('desktop_update_cancelled');
   const chunk=Buffer.from(raw);total+=chunk.length;
   if(total>expected||total>maxManifestBytes)fail('desktop_update_manifest_length_mismatch');
   chunks.push(chunk);
  }
  if(total!==expected)fail('desktop_update_manifest_length_mismatch');
  return Buffer.concat(chunks,total);
 }catch(error){discardResponse(response);throw error;}
}
async function lstatIfExists(fs,path){
 try{return await fs.lstat(path);}catch(error){if(error?.code==='ENOENT')return null;throw error;}
}
async function ensureDirectory(fs,path){
 await fs.mkdir(path,{recursive:true});
 const info=await fs.lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink())fail('desktop_update_path_unsafe');
}
async function ensureOperationRoot(fs,root,operationId){
 if(typeof root!=='string'||!isAbsolute(root))fail('desktop_update_root_invalid');
 await ensureDirectory(fs,root);
 const canonicalRoot=await fs.realpath(root),operationRoot=resolve(canonicalRoot,operationId);
 if(!inDirectory(canonicalRoot,operationRoot)||operationRoot===canonicalRoot)fail('desktop_update_root_invalid');
 const existing=await lstatIfExists(fs,operationRoot);
 if(existing){if(existing.isSymbolicLink()||!existing.isDirectory())fail('desktop_update_path_unsafe');}
 else await fs.mkdir(operationRoot,{recursive:false});
 const verified=await fs.lstat(operationRoot);
 if(verified.isSymbolicLink()||!verified.isDirectory())fail('desktop_update_path_unsafe');
 return operationRoot;
}
async function ensureFileParents(fs,root,filePath){
 const parts=filePath.split('/'),directories=parts.slice(0,-1);let cursor=root;
 for(const part of directories){
  cursor=join(cursor,part);
  const existing=await lstatIfExists(fs,cursor);
  if(!existing)await fs.mkdir(cursor,{recursive:false});
  const info=await fs.lstat(cursor);
  if(info.isSymbolicLink()||!info.isDirectory())fail('desktop_update_path_unsafe');
 }
 const target=join(root,...parts);
 if(!inDirectory(root,target))fail('desktop_update_path_invalid');
 return target;
}
async function hashFile(fs,path){
 const handle=await fs.open(path,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let position=0;
 try{
  while(true){
   const {bytesRead}=await handle.read(buffer,0,buffer.length,position);
   if(bytesRead===0)break;
   hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;
  }
 }finally{await handle.close();}
 return {bytes:position,sha256:hash.digest('hex')};
}
async function syncDirectory(fs,path){
 let handle;
 try{handle=await fs.open(path,'r');await handle.sync();}
 catch(error){if(!['EBADF','EISDIR','EINVAL','ENOTSUP','EPERM'].includes(error?.code))throw error;}
 finally{if(handle)await handle.close().catch(()=>{});}
}
async function writeChunk(handle,chunk){
 let offset=0;
 while(offset<chunk.length){const result=await handle.write(chunk,offset,chunk.length-offset);if(!result.bytesWritten)fail('desktop_update_file_write_failed');offset+=result.bytesWritten;}
}
function verifyOperationBinding(operation,operationId,envelope,policy){
 const profile=policy.profile??'standalone';
 if(!operation||operation.id!==operationId||!envelope||envelope.envelopeDigest!==operation.envelopeDigest||
  envelope.manifestSha256!==operation.manifestSha256||envelope.profile!==profile||(operation.profile??'standalone')!==profile||typeof envelope.manifestPath!=='string'||
  typeof envelope.manifestUrl!=='string'||!digestPattern.test(envelope.manifestSha256)||!digestPattern.test(envelope.envelopeDigest))
  fail('desktop_update_operation_mismatch');
 const target=[envelope.product,envelope.channel,envelope.platform,envelope.arch];if(profile==='desktop-electron')target.push(profile);
 const key=JSON.stringify(target);
 if(key!==operation.targetKey||envelope.product!==policy.product||envelope.channel!==policy.channel||envelope.platform!==policy.platform||envelope.arch!==policy.arch)
  fail('desktop_update_target_mismatch');
 const expectedManifestUrl=trustedUrl(envelope.manifestPath,policy);
 if(envelope.manifestUrl!==expectedManifestUrl||!Number.isSafeInteger(envelope.manifestBytes)||envelope.manifestBytes<1||envelope.manifestBytes>maxManifestBytes)
  fail('desktop_update_manifest_binding_invalid');
}
function validateManifestPaths(manifest,profile='standalone'){
 const pathTypes=new Map(),files=[];
 for(const manifestFile of manifest.files){
  const file=profile==='desktop-electron'?{path:manifestFile.path?.startsWith('Jot-Desktop/')?manifestFile.path.slice('Jot-Desktop/'.length):'',
   transportPath:manifestFile.path,bytes:manifestFile.size,sha256:manifestFile.sha256}:manifestFile;
  if(!safeRelativePath(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!digestPattern.test(file.sha256))fail('desktop_update_manifest_invalid');
  if(['releases','.jot-state','release-manifest.json','portable-package-manifest.json','portable-package-manifest.sha256'].includes(file.path.split('/')[0].toLocaleLowerCase('en-US')))
   fail('desktop_update_path_invalid');
  const parts=file.path.split('/');
  for(let index=1;index<=parts.length;index++){
   const prefix=parts.slice(0,index).join('/'),folded=prefix.toLocaleLowerCase('en-US'),isFile=index===parts.length;
   const prior=pathTypes.get(folded);
   if(prior&&(prior.path!==prefix||prior.kind!==(isFile?'file':'directory')))fail('desktop_update_path_collision');
   if(!prior)pathTypes.set(folded,{path:prefix,kind:isFile?'file':'directory'});
  }
  files.push(file);
 }
 const paths=new Set(files.map(file=>file.path.toLocaleLowerCase('en-US')));
 if(files.some(file=>paths.has((file.path+'.part').toLocaleLowerCase('en-US'))))fail('desktop_update_path_collision');
 return files;
}
async function verifyPackageInventory(fs,root,files,profile='standalone'){
 const metadata=profile==='desktop-electron'?['portable-package-manifest.json','portable-package-manifest.sha256']:['release-manifest.json'];
 const expectedFiles=new Set([...files.map(file=>file.path),...metadata].map(value=>value.toLocaleLowerCase('en-US')));
 const expectedDirectories=new Set();
 for(const file of files){
  const parts=file.path.split('/');
  for(let index=1;index<parts.length;index++)expectedDirectories.add(parts.slice(0,index).join('/').toLocaleLowerCase('en-US'));
 }
 const actualFiles=new Set(),actualDirectories=new Set();
 async function walk(directory,prefix=''){
  for(const entry of await fs.readdir(directory)){
   const name=typeof entry==='string'?entry:entry.name,relativePath=prefix?prefix+'/'+name:name,fullPath=join(directory,name),info=await fs.lstat(fullPath),folded=relativePath.toLocaleLowerCase('en-US');
   if(info.isSymbolicLink())fail('desktop_update_path_unsafe');
   if(info.isDirectory()){
    if(!expectedDirectories.has(folded))fail('desktop_update_package_inventory_invalid');
    actualDirectories.add(folded);await walk(fullPath,relativePath);
   }else if(info.isFile()){
    if(!expectedFiles.has(folded)||actualFiles.has(folded))fail('desktop_update_package_inventory_invalid');
    actualFiles.add(folded);
   }else fail('desktop_update_path_unsafe');
  }
 }
 await walk(root);
 if(actualFiles.size!==expectedFiles.size||actualDirectories.size!==expectedDirectories.size)fail('desktop_update_package_inventory_invalid');
}
async function inspectExistingFile(fs,root,filePath){
 let cursor=root;const parts=filePath.split('/');
 for(let index=0;index<parts.length;index++){
  cursor=join(cursor,parts[index]);
  const info=await lstatIfExists(fs,cursor);
  if(!info||info.isSymbolicLink()||(index<parts.length-1?!info.isDirectory():!info.isFile()))fail('desktop_update_existing_file_missing');
 }
 return cursor;
}
async function loadExistingPackage({fs,root,operationId,envelope,signal}){
 if(signal?.aborted)fail('desktop_update_cancelled');
 const profile=envelope.profile??'standalone',manifestName=profile==='desktop-electron'?'portable-package-manifest.json':'release-manifest.json';
 const operationRoot=await ensureOperationRoot(fs,root,operationId),manifestPath=join(operationRoot,manifestName),manifestInfo=await lstatIfExists(fs,manifestPath);
 if(!manifestInfo||manifestInfo.isSymbolicLink()||!manifestInfo.isFile())fail('desktop_update_manifest_file_mismatch');
 const manifestRaw=Buffer.from(await fs.readFile(manifestPath));
 if(manifestRaw.length!==envelope.manifestBytes)fail('desktop_update_manifest_file_mismatch');
 const manifest=verifyUpdateManifest({rawBytes:manifestRaw,envelope}),files=validateManifestPaths(manifest,profile),verifiedFiles=[];
 if(profile==='desktop-electron'){
  const sidecar=await lstatIfExists(fs,join(operationRoot,'portable-package-manifest.sha256'));
  if(!sidecar||sidecar.isSymbolicLink()||!sidecar.isFile()||await fs.readFile(join(operationRoot,'portable-package-manifest.sha256'),'utf8')!==envelope.manifestSha256+'  '+manifestName+'\n')
   fail('desktop_update_manifest_file_mismatch');
 }
 for(const file of files){
  if(signal?.aborted)fail('desktop_update_cancelled');
  const path=await inspectExistingFile(fs,operationRoot,file.path),actual=await hashFile(fs,path);
  if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('desktop_update_file_digest_mismatch');
  verifiedFiles.push(Object.freeze({path:file.path,bytes:file.bytes,sha256:file.sha256}));
 }
 await verifyPackageInventory(fs,operationRoot,files,profile);
 return Object.freeze({packageRoot:operationRoot,manifestSha256:envelope.manifestSha256,envelopeDigest:envelope.envelopeDigest,manifest,
  verifiedFiles:Object.freeze(verifiedFiles)});
}
async function readStore(stateStore){
 if(!stateStore||typeof stateStore.read!=='function')fail('desktop_update_state_unavailable');
 const result=await stateStore.read();
 if(!result?.enabled||!result.state)fail(result?.reason??'desktop_update_state_unavailable');
 return result.state;
}

export function createUpdateDownloader({policy,transport={request:requestHttps},stateStore,fs=defaultFs,root,loadVerifiedEnvelope}={}){
 policyBase(policy);
 if(!transport||typeof transport.request!=='function'||!fs||typeof fs.open!=='function'||typeof fs.lstat!=='function'||!isAbsolute(root??''))
  fail('desktop_update_downloader_invalid');

 async function execute({operationId,verifiedEnvelope,signal,allowStart}){
  if(typeof operationId!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(operationId))fail('desktop_update_operation_invalid');
  let state=await readStore(stateStore),operation=state.operation;
  if(!operation||operation.id!==operationId)fail('desktop_update_operation_mismatch');
  if(!verifiedEnvelope&&typeof loadVerifiedEnvelope==='function')verifiedEnvelope=await loadVerifiedEnvelope({operationId,operation});
  verifyOperationBinding(operation,operationId,verifiedEnvelope,policy);
  if(operation.phase==='available'&&allowStart){await stateStore.setPhase(operationId,'downloading');state=await readStore(stateStore);operation=state.operation;}
  if(operation.phase==='downloaded'&&!allowStart)return loadExistingPackage({fs,root,operationId,envelope:verifiedEnvelope,signal});
  if(operation.phase!=='downloading')fail('desktop_update_phase_invalid');
  if(signal?.aborted)fail('desktop_update_cancelled');

  let manifestResponse;
  try{manifestResponse=await transport.request(verifiedEnvelope.manifestUrl,{headers:{'accept-encoding':'identity','accept':'application/json'},signal});}
  catch(error){if(signal?.aborted)fail('desktop_update_cancelled');throw error;}
  const manifestRaw=await collectManifest(manifestResponse,verifiedEnvelope.manifestBytes,signal);
  const manifest=verifyUpdateManifest({rawBytes:manifestRaw,envelope:verifiedEnvelope});
  const profile=verifiedEnvelope.profile??'standalone',manifestName=profile==='desktop-electron'?'portable-package-manifest.json':'release-manifest.json';
  const files=validateManifestPaths(manifest,profile),operationRoot=await ensureOperationRoot(fs,root,operationId);

  for(const file of files){
   if(signal?.aborted)fail('desktop_update_cancelled');
   const finalPath=await ensureFileParents(fs,operationRoot,file.path),partPath=finalPath+'.part';
   let finalInfo=await lstatIfExists(fs,finalPath);
   if(finalInfo){
    if(finalInfo.isSymbolicLink()||!finalInfo.isFile())fail('desktop_update_path_unsafe');
    const stalePart=await lstatIfExists(fs,finalPath+'.part');
    if(stalePart)fail('desktop_update_path_unsafe');
    const actual=await hashFile(fs,finalPath);
    if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('desktop_update_existing_file_mismatch');
    continue;
   }
   const checkpoint=operation.downloads[file.path],partInfo=await lstatIfExists(fs,partPath);
   if(partInfo&&(partInfo.isSymbolicLink()||!partInfo.isFile()))fail('desktop_update_path_unsafe');
   let offset=checkpoint?.offset??0;
   if(partInfo){
    if(partInfo.size!==offset)fail('desktop_update_resume_state_mismatch');
   }else if(offset!==0)fail('desktop_update_resume_state_mismatch');
   if(offset>file.bytes)fail('desktop_update_resume_state_mismatch');
   if(offset===file.bytes&&partInfo){
    const actual=await hashFile(fs,partPath);
    if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('desktop_update_file_digest_mismatch');
    await fs.rename(partPath,finalPath);await syncDirectory(fs,dirname(finalPath));continue;
   }

   const url=trustedUrl(file.transportPath??file.path,policy),headers={'accept-encoding':'identity'};
   if(offset>0){headers.range=`bytes=${offset}-`;headers['if-range']=checkpoint.etag;}
   let response;
   try{response=await transport.request(url,{headers,signal});}
   catch(error){if(signal?.aborted)fail('desktop_update_cancelled');throw error;}
   let etag;
   try{
    requireIdentity(response?.headers);
    if(offset===0)requireStatus(response,200);
    else{
     if(response?.statusCode!==206&&response?.status!==206)fail('desktop_update_range_invalid');
     requireStatus(response,206);
     requireContentRange(response.headers,offset,file.bytes-1,file.bytes);
    }
    requireContentLength(response.headers,file.bytes-offset);
    etag=requireStrongEtag(response.headers);
    if(offset>0&&etag!==checkpoint.etag)fail('desktop_update_etag_changed');
   }catch(error){discardResponse(response);throw error;}
   await stateStore.recordDownloadProgress(operationId,file.path,offset,etag);

   let handle;
   try{
    if(partInfo){
     const flags=fsConstants.O_WRONLY|fsConstants.O_APPEND|(fsConstants.O_NOFOLLOW??0);
     handle=await fs.open(partPath,flags);
    }else handle=await fs.open(partPath,'wx',0o600);
    let received=0;
    for await(const raw of responseBody(response)){
     if(signal?.aborted)fail('desktop_update_cancelled');
     const chunk=Buffer.from(raw);
     if(received+chunk.length>file.bytes-offset)fail('desktop_update_body_too_long');
     if(chunk.length){
      await writeChunk(handle,chunk);received+=chunk.length;offset+=chunk.length;
      await handle.sync();
      await stateStore.recordDownloadProgress(operationId,file.path,offset,etag);
     }
    }
    if(received!==file.bytes-(checkpoint?.offset??0))fail('desktop_update_body_length_mismatch');
   }finally{if(handle)await handle.close();}
   const actual=await hashFile(fs,partPath);
   if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('desktop_update_file_digest_mismatch');
   await fs.rename(partPath,finalPath);await syncDirectory(fs,dirname(finalPath));
  }

  const manifestPath=join(operationRoot,manifestName),manifestInfo=await lstatIfExists(fs,manifestPath);
  if(manifestInfo){
   if(manifestInfo.isSymbolicLink()||!manifestInfo.isFile()||!Buffer.from(await fs.readFile(manifestPath)).equals(manifestRaw))fail('desktop_update_manifest_file_mismatch');
  }else{
   const handle=await fs.open(manifestPath,'wx',0o600);
   try{await handle.writeFile(manifestRaw);await handle.sync();}finally{await handle.close();}
   await syncDirectory(fs,operationRoot);
  }
  if(profile==='desktop-electron'){
   const sidecarPath=join(operationRoot,'portable-package-manifest.sha256'),sidecarInfo=await lstatIfExists(fs,sidecarPath);
   const sidecarBytes=Buffer.from(verifiedEnvelope.manifestSha256+'  '+manifestName+'\n','utf8');
   if(sidecarInfo){
    if(sidecarInfo.isSymbolicLink()||!sidecarInfo.isFile()||!Buffer.from(await fs.readFile(sidecarPath)).equals(sidecarBytes))fail('desktop_update_manifest_file_mismatch');
   }else{
    const handle=await fs.open(sidecarPath,'wx',0o600);
    try{await handle.writeFile(sidecarBytes);await handle.sync();}finally{await handle.close();}
    await syncDirectory(fs,operationRoot);
   }
  }
  await verifyPackageInventory(fs,operationRoot,files,profile);
  await stateStore.setPhase(operationId,'downloaded');
  return Object.freeze({packageRoot:operationRoot,manifestSha256:verifiedEnvelope.manifestSha256,envelopeDigest:verifiedEnvelope.envelopeDigest,
   manifest,verifiedFiles:Object.freeze(files.map(file=>Object.freeze({path:file.path,bytes:file.bytes,sha256:file.sha256})))});
 }

 async function withFailureState(operationId,signal,callback){
  try{return await callback();}
  catch(error){
   try{
    const current=await readStore(stateStore),operation=current.operation;
    if(operation?.id===operationId&&['downloading','downloaded'].includes(operation.phase)){
     await stateStore.setPhase(operationId,signal?.aborted||error?.message==='desktop_update_cancelled'?'cancelled':'failed');
    }
   }catch{}
   throw error;
  }
 }
 async function download({operationId,verifiedEnvelope,signal}={}){
  return withFailureState(operationId,signal,()=>execute({operationId,verifiedEnvelope,signal,allowStart:true}));
 }
 async function resume({operationId,verifiedEnvelope,signal}={}){
  return withFailureState(operationId,signal,()=>execute({operationId,verifiedEnvelope,signal,allowStart:false}));
 }
 return Object.freeze({download,resume});
}
