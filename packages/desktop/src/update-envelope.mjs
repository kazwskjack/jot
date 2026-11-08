import {createHash,verify as verifySignature} from 'node:crypto';

const envelopeKeys=['arch','channel','keyId','manifestBytes','manifestPath','manifestSha256','minimumUpdaterProtocol','platform','platformArtifacts','product','profile','protocol','sequence','signature','sourceCommit','sourceTag','version'];
const artifactKeys=['path','sha256'];
const manifestFileKeys=['bytes','mode','path','sha256'];
const releaseManifestKeys=['databaseProtocol','files','license','packages','protocol','source'];
const sha256Pattern=/^[a-f0-9]{64}$/;
const commitPattern=/^[a-f0-9]{40,64}$/;
const sequencePattern=/^[1-9][0-9]{0,19}$/;
const semanticVersionPattern=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const keyIdPattern=/^[A-Za-z0-9._-]{1,64}$/;
const domain=Buffer.from('JOT-DESKTOP-UPDATE\0v1\0');
const maxEnvelopeBytes=64*1024,maxManifestBytes=16*1024*1024;
const portableManifestKeys=['protocol','status','appVersion','sourceCommit','sourceTreeSha256','target','packageRoot','entry','userData',
 'releaseOpsV2Profile','installOrActivationPerformed','electron','appLockSha256','rootLockSha256','runtimeReceiptSha256','build','files'];
const portablePrefix='Jot-Desktop/';
const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':isRecord(value)?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
function fail(code){throw new Error(code);}
function exactKeys(value,expected){return isRecord(value)&&Object.keys(value).sort().join(',')===expected.slice().sort().join(',');}
function safeRelativePath(value){
 if(typeof value!=='string'||!value||value.length>4096||value.includes('\\')||value.startsWith('/')||/^[A-Za-z]:/.test(value)||/[\x00-\x1f\x7f]/.test(value))return false;
 return !value.split('/').some(part=>!part||part==='.'||part==='..');
}
function manifestUrl(path,policy){
 if(typeof path!=='string'||!path||path.length>2048||path.includes('\\')||path.includes('%')||path.includes('?')||path.includes('#')||path.startsWith('/')||path.includes(':')||!/^[-A-Za-z0-9._/]+$/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))fail('desktop_update_manifest_path_invalid');
 const base=policy.origin+policy.pathPrefix+'/',url=new URL(path,base);
 if(url.origin!==policy.origin||!url.pathname.startsWith(policy.pathPrefix+'/')||url.username||url.password||url.search||url.hash)fail('desktop_update_manifest_origin_invalid');
 return url.href;
}
function decodeSignature(value){
 if(typeof value!=='string'||! /^[A-Za-z0-9_-]{86}$/.test(value))fail('desktop_update_signature_invalid');
 const bytes=Buffer.from(value,'base64url');if(bytes.length!==64||bytes.toString('base64url')!==value)fail('desktop_update_signature_invalid');
 return bytes;
}
function parseCanonical(rawBytes,maxBytes,errorCode){
 if(!Buffer.isBuffer(rawBytes)||rawBytes.length===0||rawBytes.length>maxBytes)fail(errorCode);
 let text,value;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(rawBytes);value=JSON.parse(text);}catch{fail(errorCode);}
 if(!isRecord(value)||text!==canonical(value)+'\n')fail(errorCode==='desktop_update_envelope_invalid'?'desktop_update_envelope_noncanonical':'desktop_update_manifest_noncanonical');
 return value;
}
function parsePortableManifest(rawBytes,envelope){
 if(!Buffer.isBuffer(rawBytes)||rawBytes.length!==envelope.manifestBytes||rawBytes.length>maxManifestBytes)fail('desktop_update_manifest_length_mismatch');
 let text,manifest;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(rawBytes);manifest=JSON.parse(text);}catch{fail('desktop_update_manifest_invalid');}
 if(!isRecord(manifest)||text!==JSON.stringify(manifest,null,2)+'\n'||hash(rawBytes)!==envelope.manifestSha256)
  fail('desktop_update_manifest_digest_mismatch');
 if(!exactKeys(manifest,portableManifestKeys)||manifest.protocol!=='jot.desktop.portable.v1'||manifest.status!=='candidate'||
  manifest.appVersion!==envelope.version||manifest.sourceCommit!==envelope.sourceCommit||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)||
  !sha256Pattern.test(manifest.sourceTreeSha256??'')||!exactKeys(manifest.target,['platform','arch'])||
  manifest.target.platform!==envelope.platform||manifest.target.arch!==envelope.arch||manifest.packageRoot!==portablePrefix||
  !exactKeys(manifest.entry,['manifest','main'])||manifest.entry.manifest!=='resources/app/package.json'||manifest.entry.main!=='apps/desktop/main-entry.mjs'||
  !exactKeys(manifest.userData,['insidePackage','root','preserves'])||manifest.userData.insidePackage!==false||
  manifest.userData.root!=='%APPDATA%/Jot'||!Array.isArray(manifest.userData.preserves)||
  manifest.userData.preserves.join('\0')!=='jot.db\0files/\0desktop-notifications.json'||manifest.releaseOpsV2Profile!=='not-verified'||
  manifest.installOrActivationPerformed!==false)fail('desktop_update_manifest_source_mismatch');
 const electron=manifest.electron;
 if(!exactKeys(electron,['version','platform','arch','archiveSha256','executableSha256','inventorySha256','runtimeFiles','nodeVersion','nodeModuleAbi','napiVersion'])||
  !semanticVersionPattern.test(electron.version??'')||electron.platform!==envelope.platform||electron.arch!==envelope.arch||
  !sha256Pattern.test(electron.archiveSha256??'')||!sha256Pattern.test(electron.executableSha256??'')||
  !sha256Pattern.test(electron.inventorySha256??'')||typeof electron.nodeVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(electron.nodeVersion)||
  typeof electron.nodeModuleAbi!=='string'||!/^\d+$/.test(electron.nodeModuleAbi)||typeof electron.napiVersion!=='string'||!/^\d+$/.test(electron.napiVersion)||
  !Array.isArray(electron.runtimeFiles)||hash(Buffer.from(JSON.stringify(electron.runtimeFiles)))!==electron.inventorySha256||
  !sha256Pattern.test(manifest.appLockSha256??'')||!sha256Pattern.test(manifest.rootLockSha256??'')||
  !sha256Pattern.test(manifest.runtimeReceiptSha256??'')||!exactKeys(manifest.build,['nodeVersion','npmVersion','viteVersion','rootLockSha256'])||
  ![manifest.build.nodeVersion,manifest.build.npmVersion,manifest.build.viteVersion].every(value=>typeof value==='string'&&value.length>0)||
  manifest.build.rootLockSha256!==manifest.rootLockSha256)fail('desktop_update_manifest_invalid');
 const files=new Map();let previous='';
 for(const item of manifest.files){
  if(!exactKeys(item,['path','size','sha256'])||typeof item.path!=='string'||!item.path.startsWith(portablePrefix)||
   !safeRelativePath(item.path)||/[\x00-\x1f\x7f]/.test(item.path)||!Number.isSafeInteger(item.size)||item.size<0||!sha256Pattern.test(item.sha256)||
   item.path.localeCompare(previous,'en')<0)fail('desktop_update_manifest_invalid');
  const relative=item.path.slice(portablePrefix.length),segments=relative.split('/');
  if(!relative||segments.some(part=>!part||part==='.'||part==='..'||/^\.env(?:$|\.)/i.test(part)||/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log)$/i.test(part))||
   segments.some(part=>['.git','.data','.cache','.jot-state','.test-tmp','coverage','logs','profile','user-data'].includes(part.toLowerCase())))
   fail('desktop_update_manifest_path_invalid');
  const folded=item.path.toLocaleLowerCase('en-US');if(files.has(folded))fail('desktop_update_manifest_invalid');files.set(folded,item);previous=item.path;
 }
 if(files.size<1)fail('desktop_update_manifest_invalid');
 for(const runtime of electron.runtimeFiles){
  if(!exactKeys(runtime,['path','size','sha256'])||typeof runtime.path!=='string'||!safeRelativePath(runtime.path)||
   !Number.isSafeInteger(runtime.size)||runtime.size<0||!sha256Pattern.test(runtime.sha256))fail('desktop_update_manifest_invalid');
 }
 for(const artifact of envelope.platformArtifacts){
  const file=files.get(artifact.path.toLocaleLowerCase('en-US'));
  if(!file||file.sha256!==artifact.sha256)fail('desktop_update_platform_artifact_unbound');
 }
 if(envelope.platform==='win32'){
  const nativePaths=[...files.values()].filter(file=>/\.(?:exe|dll|msi|msix|sys|ocx|com|node)$/i.test(file.path)).map(file=>file.path.toLocaleLowerCase('en-US')).sort();
  const signedPaths=envelope.platformArtifacts.map(artifact=>artifact.path.toLocaleLowerCase('en-US')).sort();
  if(nativePaths.join('\n')!==signedPaths.join('\n'))fail('desktop_update_platform_artifact_incomplete');
 }
 return manifest;
}
function validateArtifactList(value){
 if(!Array.isArray(value)||value.length<1||value.length>128)fail('desktop_update_platform_artifacts_invalid');
 const seen=new Set();
 for(const item of value){
  if(!exactKeys(item,artifactKeys)||!safeRelativePath(item.path)||!sha256Pattern.test(item.sha256))fail('desktop_update_platform_artifacts_invalid');
  const key=item.path.toLocaleLowerCase('en-US');if(seen.has(key))fail('desktop_update_platform_artifacts_invalid');seen.add(key);
 }
 return value;
}
function windowsNativePath(value){return /\.(?:exe|dll|msi|msix|sys|ocx|com|node)$/i.test(value);}

export function verifyUpdateEnvelope({rawBytes,policy,platform=policy?.platform,arch=policy?.arch,channel=policy?.channel,product=policy?.product,currentSequence,currentEnvelopeDigest}={}){
 if(!policy?.enabled)fail(policy?.reason??'desktop_update_policy_unavailable');
 const envelope=parseCanonical(rawBytes,maxEnvelopeBytes,'desktop_update_envelope_invalid');
 if(!exactKeys(envelope,envelopeKeys)||envelope.protocol!==1)fail('desktop_update_envelope_invalid');
 if(envelope.product!==product||envelope.channel!==channel||envelope.platform!==platform||envelope.arch!==arch||envelope.profile!==(policy.profile??'standalone'))fail('desktop_update_target_mismatch');
 if(typeof envelope.version!=='string'||!semanticVersionPattern.test(envelope.version)||typeof envelope.sourceTag!=='string'||![envelope.version,'v'+envelope.version].includes(envelope.sourceTag)||typeof envelope.sourceCommit!=='string'||!commitPattern.test(envelope.sourceCommit))fail('desktop_update_source_identity_invalid');
 if(!Number.isSafeInteger(envelope.minimumUpdaterProtocol)||envelope.minimumUpdaterProtocol<1||envelope.minimumUpdaterProtocol>1)fail('desktop_update_protocol_unsupported');
 if(typeof envelope.sequence!=='string'||!sequencePattern.test(envelope.sequence))fail('desktop_update_sequence_invalid');
 if(!Number.isSafeInteger(envelope.manifestBytes)||envelope.manifestBytes<1||envelope.manifestBytes>maxManifestBytes||typeof envelope.manifestSha256!=='string'||!sha256Pattern.test(envelope.manifestSha256))fail('desktop_update_manifest_digest_invalid');
 validateArtifactList(envelope.platformArtifacts);
 if(envelope.platform==='win32'&&envelope.platformArtifacts.some(artifact=>!windowsNativePath(artifact.path)))fail('desktop_update_platform_artifacts_invalid');
 if(typeof envelope.keyId!=='string'||! /^[A-Za-z0-9._-]{1,64}$/.test(envelope.keyId))fail('desktop_update_key_id_invalid');
 const publicKey=policy.trustedKeys?.[envelope.keyId];if(!publicKey)fail('desktop_update_key_untrusted');
 const signatureBytes=decodeSignature(envelope.signature);
 const {signature:_signature,...unsigned}=envelope;
 if(!verifySignature(null,Buffer.concat([domain,Buffer.from(canonical(unsigned),'utf8')]),publicKey,signatureBytes))fail('desktop_update_signature_invalid');
 const url=manifestUrl(envelope.manifestPath,policy),digest=hash(rawBytes),sequence=BigInt(envelope.sequence),minimum=BigInt(policy.minimumSequence);
 if(sequence<minimum)fail('desktop_update_sequence_rollback');
 if(currentSequence!==undefined&&currentSequence!==null){
  if(typeof currentSequence!=='string'||! /^(0|[1-9][0-9]{0,19})$/.test(currentSequence))fail('desktop_update_sequence_state_invalid');
  const current=BigInt(currentSequence);
  if(sequence<current)fail('desktop_update_sequence_rollback');
  if(sequence===current&&(typeof currentEnvelopeDigest!=='string'||currentEnvelopeDigest!==digest))fail('desktop_update_sequence_replay');
 }
 return Object.freeze({...envelope,manifestUrl:url,envelopeDigest:digest});
}

export function verifyUpdateManifest({rawBytes,envelope}={}){
 if(!envelope||!Number.isSafeInteger(envelope.manifestBytes)||typeof envelope.manifestSha256!=='string')fail('desktop_update_manifest_binding_invalid');
 if(envelope.profile==='desktop-electron')return parsePortableManifest(rawBytes,envelope);
 if(envelope.profile!=='standalone')fail('desktop_update_manifest_binding_invalid');
 if(!Buffer.isBuffer(rawBytes)||rawBytes.length!==envelope.manifestBytes)fail('desktop_update_manifest_length_mismatch');
 const manifest=parseCanonical(rawBytes,maxManifestBytes,'desktop_update_manifest_invalid');
 if(hash(canonical(manifest))!==envelope.manifestSha256)fail('desktop_update_manifest_digest_mismatch');
 if(!exactKeys(manifest,releaseManifestKeys)||manifest.protocol!==1||!exactKeys(manifest.source,['commit','tag'])||manifest.source.tag!==envelope.sourceTag||manifest.source.commit!==envelope.sourceCommit||!Array.isArray(manifest.files))fail('desktop_update_manifest_source_mismatch');
 const files=new Map();let previous='';
 for(const item of manifest.files){
  if(!exactKeys(item,manifestFileKeys)||!safeRelativePath(item.path)||!sha256Pattern.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0||![100644,100755].includes(item.mode)||item.path.localeCompare(previous,'en')<0)fail('desktop_update_manifest_invalid');
  const folded=item.path.toLocaleLowerCase('en-US');if(files.has(folded))fail('desktop_update_manifest_invalid');files.set(folded,item);previous=item.path;
 }
 for(const artifact of envelope.platformArtifacts){
  const file=files.get(artifact.path.toLocaleLowerCase('en-US'));
  if(!file||file.sha256!==artifact.sha256)fail('desktop_update_platform_artifact_unbound');
 }
 if(envelope.platform==='win32'){
  const nativePaths=[...files.values()].filter(file=>windowsNativePath(file.path)).map(file=>file.path.toLocaleLowerCase('en-US')).sort();
  const signedPaths=envelope.platformArtifacts.map(artifact=>artifact.path.toLocaleLowerCase('en-US')).sort();
  if(nativePaths.join('\n')!==signedPaths.join('\n'))fail('desktop_update_platform_artifact_incomplete');
 }
 return manifest;
}
