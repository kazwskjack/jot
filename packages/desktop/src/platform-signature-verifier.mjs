import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat as nodeLstat,readFile as nodeReadFile,realpath as nodeRealpath} from 'node:fs/promises';
import {promisify} from 'node:util';
import {isAbsolute,relative,resolve,sep} from 'node:path';

const execFileAsync=promisify(execFile);
const sha256Pattern=/^[a-f0-9]{64}$/;
const defaultFilesystem=Object.freeze({lstat:nodeLstat,readFile:nodeReadFile,realpath:nodeRealpath});
const psScript=[
 "$ErrorActionPreference = 'Stop'",
 "$ProgressPreference = 'SilentlyContinue'",
 "$env:PSModulePath = Join-Path $PSHOME 'Modules'",
 "Import-Module -Name 'Microsoft.PowerShell.Security' -ErrorAction Stop",
 "Import-Module -Name 'Microsoft.PowerShell.Utility' -ErrorAction Stop",
 "$signature = Get-AuthenticodeSignature -LiteralPath $env:JOT_DESKTOP_UPDATE_VERIFY_PATH",
 "if ($null -eq $signature.SignerCertificate) { [Console]::Out.WriteLine('{\"status\":\"NotSigned\",\"certificateDerBase64\":\"\"}'); exit 0 }",
 "$result = @{ status = $signature.Status.ToString(); certificateDerBase64 = [Convert]::ToBase64String($signature.SignerCertificate.RawData) }",
 '[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))'
].join('; ');

function fail(code){throw new Error(code);}
function safeRelative(value){
 if(typeof value!=='string'||!value||value.length>4096||value.includes('\\')||value.startsWith('/')||/^[A-Za-z]:/.test(value)||/[\x00-\x1f\x7f]/.test(value))return false;
 return !value.split('/').some(part=>!part||part==='.'||part==='..');
}
function isInside(root,path){
 const rel=relative(root,path);
 if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))return true;
 if(process.platform==='win32'){
  const folded=relative(root.toLocaleLowerCase('en-US'),path.toLocaleLowerCase('en-US'));
  return folded===''||(!folded.startsWith('..'+sep)&&folded!=='..'&&!isAbsolute(folded));
 }
 return false;
}
async function inspectRegularFile(root,path,filesystem){
 if(!safeRelative(path))fail('desktop_platform_signature_path_invalid');
 let cursor=root;
 for(const part of path.split('/')){
  cursor=resolve(cursor,part);
  if(!isInside(root,cursor))fail('desktop_platform_signature_path_invalid');
  let info;try{info=await filesystem.lstat(cursor);}catch{fail('desktop_platform_signature_artifact_missing');}
  if(info.isSymbolicLink())fail('desktop_platform_signature_path_unsafe');
  if(cursor!==resolve(root,path.split('/').join(sep))&&!info.isDirectory())fail('desktop_platform_signature_path_unsafe');
 }
 const info=await filesystem.lstat(cursor);if(!info.isFile()||info.isSymbolicLink())fail('desktop_platform_signature_artifact_invalid');
 return cursor;
}
async function runAuthenticode({filePath}){
 let result;
 try{
  result=await execFileAsync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',psScript],{
   encoding:'utf8',timeout:15000,maxBuffer:64*1024,windowsHide:true,
   env:{...process.env,JOT_DESKTOP_UPDATE_VERIFY_PATH:filePath}
  });
 }catch{fail('desktop_platform_signature_verifier_failed');}
 try{return JSON.parse(result.stdout.trim());}catch{fail('desktop_platform_signature_verifier_output_invalid');}
}

export async function verifyPlatformArtifacts({platform=process.platform,artifactRoot,artifacts,allowedSignerSha256,runPowerShell=runAuthenticode,filesystem=defaultFilesystem}={}){
 if(platform!=='win32')fail('desktop_platform_signature_verifier_unavailable');
 if(typeof artifactRoot!=='string'||!isAbsolute(artifactRoot)||!Array.isArray(artifacts)||!artifacts.length||typeof runPowerShell!=='function'||
  !Array.isArray(allowedSignerSha256)||!allowedSignerSha256.length||allowedSignerSha256.some(value=>typeof value!=='string'||!sha256Pattern.test(value)))
  fail('desktop_platform_signature_configuration_invalid');
 let root;
 try{root=await filesystem.realpath(artifactRoot);const info=await filesystem.lstat(root);if(!info.isDirectory()||info.isSymbolicLink())fail('desktop_platform_signature_root_invalid');}
 catch(error){if(error?.message?.startsWith('desktop_platform_'))throw error;fail('desktop_platform_signature_root_invalid');}
 const allowed=new Set(allowedSignerSha256),seen=new Set(),verified=[];
 for(const artifact of artifacts){
  if(!artifact||typeof artifact!=='object'||Array.isArray(artifact)||Object.keys(artifact).sort().join(',')!=='path,sha256'||!sha256Pattern.test(artifact.sha256)||seen.has(artifact.path?.toLocaleLowerCase('en-US')))
   fail('desktop_platform_signature_artifact_invalid');
  seen.add(artifact.path.toLocaleLowerCase('en-US'));
  const filePath=await inspectRegularFile(root,artifact.path,filesystem);
  const bytes=await filesystem.readFile(filePath);
  if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)fail('desktop_platform_signature_artifact_hash_mismatch');
  let output;try{output=await runPowerShell({filePath});}catch{fail('desktop_platform_signature_verifier_failed');}
  if(!output||typeof output!=='object'||Array.isArray(output)||Object.keys(output).sort().join(',')!=='certificateDerBase64,status'||output.status!=='Valid')fail('desktop_platform_authenticode_invalid');
  const encoded=output.certificateDerBase64;
  if(typeof encoded!=='string'||!encoded||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))fail('desktop_platform_certificate_invalid');
  const certificate=Buffer.from(encoded,'base64');if(!certificate.length||certificate.toString('base64')!==encoded)fail('desktop_platform_certificate_invalid');
  const signerSha256=createHash('sha256').update(certificate).digest('hex');
  if(!allowed.has(signerSha256))fail('desktop_platform_signer_untrusted');
  verified.push(Object.freeze({path:artifact.path,sha256:artifact.sha256,signerSha256}));
 }
 return Object.freeze({verified:true,platform:'win32',verifier:'windows-authenticode',artifacts:Object.freeze(verified)});
}

export const windowsAuthenticodeVerifier=Object.freeze({identity:'windows-authenticode-v1',verify:verifyPlatformArtifacts});
