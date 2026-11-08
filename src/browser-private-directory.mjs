import {execFileSync} from 'node:child_process';
import {lstat,mkdir} from 'node:fs/promises';
import {isAbsolute,join,parse,resolve} from 'node:path';

const trustedWindowsSids=new Set(['S-1-5-18','S-1-5-32-544','S-1-3-0']);

async function assertNoSymlinkComponents(path,inspect=lstat){
 const target=resolve(path),root=parse(target).root,parts=target.slice(root.length).split(/[\\/]+/).filter(Boolean);
 let current=root;
 for(const part of parts){
  current=join(current,part);
  let info;try{info=await inspect(current);}catch(error){if(error?.code==='ENOENT')return;throw error;}
  if(info.isSymbolicLink())throw Error('browser_private_directory_symlink');
 }
}

function readWindowsAcl(path){
 const script=`
$ErrorActionPreference='Stop'
$path=$env:JOT_BROWSER_ACL_TARGET
$item=Get-Item -LiteralPath $path
$acl=$item.GetAccessControl()
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow} | ForEach-Object {$_.IdentityReference.Value})
$result=[pscustomobject]@{ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;userSid=$identity.User.Value;allowSids=$rules}
$result | ConvertTo-Json -Compress
`;
 const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{
  encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:16384,
  env:{...process.env,JOT_BROWSER_ACL_TARGET:path},
 });
 return JSON.parse(output.trim());
}

export async function assertPrivateBrowserDirectory(path,{platform=process.platform,windowsAclReader}={}){
 if(typeof path!=='string'||!path||!isAbsolute(path))throw Error('browser_private_directory_invalid');
 const target=resolve(path);await assertNoSymlinkComponents(target);
 let info;try{info=await lstat(target);}catch(error){if(error?.code==='ENOENT')throw Error('browser_private_directory_missing');throw error;}
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('browser_private_directory_invalid');
 if(platform==='win32'){
  let acl;try{acl=await (windowsAclReader??readWindowsAcl)(target);}catch{throw Error('browser_private_directory_permissions');}
  const userSid=acl?.userSid,ownerSid=acl?.ownerSid,allowSids=acl?.allowSids;
  const allowed=Array.isArray(allowSids)?allowSids:typeof allowSids==='string'?[allowSids]:undefined;
  if(typeof userSid!=='string'||typeof ownerSid!=='string'||!allowed)throw Error('browser_private_directory_permissions');
  const trusted=new Set([...trustedWindowsSids,userSid]);
  if(!trusted.has(ownerSid)||allowed.some(sid=>typeof sid!=='string'||!trusted.has(sid)))throw Error('browser_private_directory_permissions');
 }else{
  const currentUid=typeof process.getuid==='function'?process.getuid():undefined;
  if((currentUid!==undefined&&info.uid!==currentUid)||((info.mode&0o077)!==0))throw Error('browser_private_directory_permissions');
 }
 return target;
}

export async function ensurePrivateBrowserDirectory(path,{validator=assertPrivateBrowserDirectory}={}){
 if(typeof path!=='string'||!path||!isAbsolute(path))throw Error('browser_private_directory_invalid');
 if(typeof validator!=='function')throw Error('browser_private_directory_invalid');
 const target=resolve(path);await assertNoSymlinkComponents(target);
 try{await lstat(target);}catch(error){if(error?.code!=='ENOENT')throw error;await mkdir(target,{recursive:true,mode:0o700});}
 return validator(target);
}

export async function assertNoBrowserPathSymlink(path,{inspect}={}){
 if(typeof path!=='string'||!path||!isAbsolute(path))throw Error('browser_private_directory_invalid');
 if(inspect!==undefined&&typeof inspect!=='function')throw Error('browser_private_directory_invalid');
 await assertNoSymlinkComponents(resolve(path),inspect??lstat);
}
