import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {hostSettingsSchemaFingerprint} from './host-settings-write-candidate.js';

const PROOF_FILE='.jot-settings-migration-proof.json';
const SOURCE_FILE='settings.yaml.imported';
const PACKAGE=Object.freeze({name:'@deepseek-ai/dsh-settings',version:'0.2.1-rc.2',
 integrity:'sha512-CtpetovAC2ZQ1rjIFYHbu1LOcGXTulP5IhlxKqDYSDhLEQGoU2L6LnN6HpGKuU/LBCAAN88ihP+B/2E5rTNcnQ=='});
const HASH=/^[a-f0-9]{64}$/;
const UNKNOWN=Object.freeze({state:'unknown'});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function canonical(value,depth=0){
 if(depth>24)throw new TypeError('host_settings_migration_proof_invalid');
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return`[${value.map(item=>canonical(item,depth+1)).join(',')}]`;
 if(record(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key],depth+1)}`).join(',')}}`;
 throw new TypeError('host_settings_migration_proof_invalid');
}
const hash=value=>createHash('sha256').update(value).digest('hex');

function readStableFile(path,root,maxBytes){
 const before=lstatSync(path),actual=realpathSync(path);
 if(!before.isFile()||before.isSymbolicLink()||dirname(actual)!==root||before.size<0||before.size>maxBytes)throw new TypeError('host_settings_migration_proof_file_invalid');
 const bytes=readFileSync(path),after=lstatSync(path);
 if(bytes.length>maxBytes||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new TypeError('host_settings_migration_proof_file_changed');
 return bytes;
}

/** Read only a DSH-published proof for the selected profile and namespace. */
export function createHostSettingsMigrationProofReader({profileHome,profileDirectory,namespace}={}){
 if(typeof profileHome!=='string'||!isAbsolute(profileHome)||typeof profileDirectory!=='string'||!isAbsolute(profileDirectory)
  ||typeof namespace!=='string'||namespace.length<1||namespace.length>128)return Object.freeze({read:()=>UNKNOWN});
 return Object.freeze({read(descriptor){
  try{
   const home=realpathSync(resolve(profileHome)),directory=realpathSync(resolve(profileDirectory));
   const marker=resolve(home,PROOF_FILE),markerBytes=readStableFile(marker,home,65536);
   const proof=JSON.parse(markerBytes.toString('utf8'));
   const rootKeys=['legacy_source_sha256','namespaces','package_integrity','package_name','package_version','profile_directory_sha256','proof_sha256','protocol','publisher','state'];
   if(!exact(proof,rootKeys)||proof.protocol!==1||proof.publisher!=='jot-dsh-settings-private-v1'
    ||proof.package_name!==PACKAGE.name||proof.package_version!==PACKAGE.version||proof.package_integrity!==PACKAGE.integrity
    ||proof.profile_directory_sha256!==hash(directory)||!['migrated','not_required'].includes(proof.state)
    ||proof.legacy_source_sha256!==null&&!HASH.test(proof.legacy_source_sha256)||!HASH.test(proof.proof_sha256??'')
    ||!Array.isArray(proof.namespaces)||proof.namespaces.length===0)return UNKNOWN;
   const {proof_sha256,...body}=proof;
   if(hash(canonical(body))!==proof_sha256)return UNKNOWN;
   const seenNamespaces=new Set();
   for(const entry of proof.namespaces){
    if(!exact(entry,['namespace','result_dsh_revision','schema_fingerprint','source_sections','state'])
     ||typeof entry.namespace!=='string'||entry.namespace.length<1||entry.namespace.length>128||seenNamespaces.has(entry.namespace)
     ||!Number.isSafeInteger(entry.result_dsh_revision)||entry.result_dsh_revision<0
     ||!['migrated','not_required'].includes(entry.state)||!HASH.test(entry.schema_fingerprint??'')
     ||!Array.isArray(entry.source_sections)||entry.source_sections.some(section=>typeof section!=='string')
     ||entry.state==='migrated'&&entry.source_sections.length===0||entry.state==='not_required'&&entry.source_sections.length!==0)return UNKNOWN;
    seenNamespaces.add(entry.namespace);
   }
   const matches=proof.namespaces.filter(row=>row?.namespace===namespace);
   if(matches.length!==1)return UNKNOWN;
   const row=matches[0];
   if(!exact(row,['namespace','result_dsh_revision','schema_fingerprint','source_sections','state'])
    ||!Number.isSafeInteger(row.result_dsh_revision)||row.result_dsh_revision<0
    ||!['migrated','not_required'].includes(row.state)||!HASH.test(row.schema_fingerprint??'')
    ||!Array.isArray(row.source_sections)||row.source_sections.some(section=>typeof section!=='string'))return UNKNOWN;
   if(descriptor?.ns!==namespace||!record(descriptor.schema)||hostSettingsSchemaFingerprint(descriptor.schema)!==row.schema_fingerprint)return UNKNOWN;
   const importedPath=resolve(home,SOURCE_FILE),legacyPath=resolve(home,'settings.yaml');
   if(existsSync(legacyPath))return UNKNOWN;
   if(proof.state==='not_required'){
    if(row.state!=='not_required'||proof.legacy_source_sha256!==null||existsSync(importedPath))return UNKNOWN;
   }else{
    if(proof.legacy_source_sha256===null)return UNKNOWN;
    const imported=readStableFile(importedPath,home,1048576);
    if(hash(imported)!==proof.legacy_source_sha256)return UNKNOWN;
   }
   return Object.freeze({state:row.state});
  }catch{return UNKNOWN;}
 }});
}
