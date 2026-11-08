import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,realpathSync,mkdirSync,readdirSync,openSync,readSync,closeSync,fstatSync,copyFileSync,readFileSync,writeFileSync,chmodSync,chownSync} from 'node:fs';
import {resolve,dirname,relative,sep,parse} from 'node:path';
import {canonicalJson} from '../db/canonical-json.ts';
import {notificationArchiveFiles} from '../channels/notification-archive.ts';
import {validateWorkspaceRecoveryRecord} from '../always-on/snapshot-provider.ts';
import {workspaceManifestHash, type WorkspaceManifestEntry} from '../always-on/workspace-provider.ts';
const kinds=['database','workspaces','artifacts','sessions','host-config','notification-archives'] as const;
type Kind=typeof kinds[number];type Root={kind:Kind;path:string;entries?:string[]};type Fingerprint={sha256:string;bytes:number};
type Posix={uid:number;gid:number;mode:number};
type File=Fingerprint&{kind:Kind;path:string;executable:boolean;posix?:Posix};
type Manifest={schema_version:1|2|3;scope:'offline-local-host';roots:Root[];database:{kind:'database';path:string};directories:Array<{kind:Kind;path:string;posix?:Posix}>;files:File[]};
export interface HostRestoreVerificationReceipt {
 schema_version:1;
 backup_id:string;
 restored:true;
 database_integrity_verified:true;
 reference_paths_verified:true;
 file_contents_verified:true;
}
type RestoreVerificationBinding={backupId:string;database:string;databaseFingerprint:Fingerprint;walFingerprint:Fingerprint|null;eventSnapshot:string|null;roots:Root[];inventoryFingerprint:string;sourceRoots?:Root[];verificationRoot?:string};
const issuedRestoreVerifications=new WeakMap<object,RestoreVerificationBinding>();
function eventSnapshot(db:DatabaseSync){
 if(!table(db,'ga_events'))return null;
 const primaryKey=db.prepare('PRAGMA table_info(ga_events)').all()
  .filter(column=>Number(column.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk));
 if(!primaryKey.length)return null;
 const order=primaryKey.map(column=>'"'+String(column.name).replaceAll('"','""')+'"').join(',');
 const digest=createHash('sha256');let count=0;
 for(const row of db.prepare(`SELECT * FROM ga_events ORDER BY ${order}`).iterate()){digest.update(canonicalJson(row));digest.update('\n');count++;}
 return `${count}:${digest.digest('hex')}`;
}
function optionalFingerprint(path:string):Fingerprint|null{return existsSync(path)?fingerprint(path):null;}
function normalizedPath(path:string){const absolute=resolve(path);return process.platform==='win32'?absolute.toLowerCase():absolute;}
/** Only an unchanged database and restored file inventory covered by this in-process receipt qualifies. */
export function isHostRestoreVerificationReceipt(value:unknown,db:DatabaseSync):value is HostRestoreVerificationReceipt{
 if(!value||typeof value!=='object')return false;
 const receipt=value as Partial<HostRestoreVerificationReceipt>;
 const binding=issuedRestoreVerifications.get(value);
 if(!binding||receipt.schema_version!==1||typeof receipt.backup_id!=='string'||!/^[a-f0-9]{64}$/.test(receipt.backup_id)
  ||receipt.restored!==true||receipt.database_integrity_verified!==true
  ||receipt.reference_paths_verified!==true||receipt.file_contents_verified!==true||binding.eventSnapshot===null)return false;
 try{
  if(binding.verificationRoot&&fingerprint(resolve(binding.verificationRoot,'manifest.json')).sha256!==binding.backupId)return false;
  const main=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main');
  if(typeof main?.file!=='string'||!main.file||normalizedPath(main.file)!==normalizedPath(binding.database))return false;
  const database=resolve(main.file);
  if(existsSync(database+'-journal'))return false;
  if(canonicalJson(fingerprint(database))!==canonicalJson(binding.databaseFingerprint))return false;
  const wal=optionalFingerprint(database+'-wal'),expectedWal=binding.walFingerprint;
  if((wal?.bytes??0)!==(expectedWal?.bytes??0)||((wal?.bytes??0)>0&&canonicalJson(wal)!==canonicalJson(expectedWal)))return false;
  if(eventSnapshot(db)!==binding.eventSnapshot)return false;
  if(hash(canonicalJson(inventory(binding.roots,database)))!==binding.inventoryFingerprint)return false;
  return receipt.backup_id===binding.backupId;
 }catch{return false;}
}
const maximumFiles=100000,maximumManifest=16*1024*1024;
const fail=(code='host_backup_invalid'):never=>{throw new Error(code);};
const hash=(bytes:string)=>createHash('sha256').update(bytes).digest('hex');
function safe(path:string){const absolute=resolve(path);for(let current=absolute;;){try{if(lstatSync(current).isSymbolicLink())fail();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const parent=dirname(current);if(parent===current)return absolute;current=parent;}}
function permissions(path:string):{posix?:Posix}{if(process.platform==='win32')return {};const stat=lstatSync(path);if(stat.mode&0o7000)fail('host_backup_special_permissions_unsupported');return {posix:{uid:stat.uid,gid:stat.gid,mode:stat.mode&0o777}};}
function validPermissions(value:unknown){const p=value as Posix;return !!p&&Object.keys(p).sort().join(',')==='gid,mode,uid'&&[p.uid,p.gid].every(n=>Number.isSafeInteger(n)&&n>=0&&n<4294967295)&&Number.isInteger(p.mode)&&p.mode>=0&&p.mode<=0o777;}
function restorePermissions(path:string,p:Posix){chownSync(path,p.uid,p.gid);chmodSync(path,p.mode);}
function inside(path:string,root:string){return path===root||path.startsWith(root+sep);}
function rootsOf(value:Root[],offline:boolean){
 if(offline!==true||!Array.isArray(value)||value.length!==kinds.length)fail('host_backup_offline_config_required');
 const roots=value.map(root=>{
  const keys=root&&Object.keys(root).sort().join(',');
  if(!root||!['kind,path','entries,kind,path'].includes(keys!)||!kinds.includes(root.kind)||typeof root.path!=='string'||!root.path||resolve(root.path)===parse(resolve(root.path)).root)fail();
  const result:Root={kind:root.kind,path:safe(root.path)};
  if(keys==='entries,kind,path'){
   if(!Array.isArray(root.entries)||!root.entries.length||root.entries.length>128)fail();
   const entries=root.entries!.map(entry=>{
    if(typeof entry!=='string'||!entry||entry.length>4096||/[\\:\x00-\x1f]/.test(entry)||entry.startsWith('/')||entry.split('/').some(part=>!part||part==='.'||part==='..'))fail();
    return entry;
   }).sort();
   for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++)if(entries[i]===entries[j]||entries[j]!.startsWith(entries[i]!+'/'))fail('host_backup_overlapping_entries');
   result.entries=entries;
  }
  return result;
 }).sort((a,b)=>a.kind.localeCompare(b.kind));
 if(new Set(roots.map(root=>root.kind)).size!==kinds.length)fail();
 for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(roots[i]!.path===roots[j]!.path)fail('host_backup_overlapping_roots');
 return roots;
}
function selected(root:Root,path:string,directory=false){
 const absolute=resolve(path);if(!inside(absolute,root.path))return false;if(!root.entries)return true;
 return root.entries.some(entry=>{const target=resolve(root.path,entry);return inside(absolute,target)||(directory&&inside(target,absolute));});
}
function child(root:string,path:string,empty=false){if(typeof path!=='string'||(!path&&!empty)||/[\\:\x00-\x1f]/.test(path)||path.startsWith('/')||(path&&path.split('/').some(part=>!part||part==='.'||part==='..')))fail();const result=resolve(root,path);if(!inside(result,root))fail();return safe(result);}
function fingerprint(path:string):Fingerprint{safe(path);const fd=openSync(path,'r');try{const stat=fstatSync(fd);if(!stat.isFile()||!Number.isSafeInteger(stat.size))fail();const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;digest.update(buffer.subarray(0,count));bytes+=count;}if(bytes!==stat.size)fail();return {sha256:digest.digest('hex'),bytes};}finally{closeSync(fd);}}
function integrity(db:DatabaseSync){if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)fail();}
function table(db:DatabaseSync,name:string){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function copiedPath(roots:Root[],bundle:string,path:string){const absolute=resolve(path),root=[...roots].sort((a,b)=>b.path.length-a.path.length).find(root=>selected(root,absolute));if(!root)return fail('host_backup_reference_outside_roots');return child(resolve(bundle,'trees',root.kind),relative(root.path,absolute).split(sep).join('/'),true);}
function contentIntegrity(db:DatabaseSync,resolveFile:(path:string)=>string){
 for(const name of ['ga_artifact_versions','ga_artifact_parts']){if(!table(db,name))continue;const columns=db.prepare(`PRAGMA table_info(${name})`).all();if(!['artifact_id','sha256','size_bytes','server_path'].every(column=>columns.some(row=>row.name===column)))continue;const archive=table(db,'ga_artifact_archives');const rows=db.prepare(`SELECT v.server_path,v.sha256,v.size_bytes FROM ${name} v ${archive?"LEFT JOIN ga_artifact_archives a ON a.artifact_id=v.artifact_id WHERE COALESCE(a.local_state,'present')='present'":''}`).all();for(const row of rows){try{const actual=fingerprint(resolveFile(String(row.server_path)));if(actual.sha256!==row.sha256||actual.bytes!==row.size_bytes)fail();}catch{fail('host_backup_content_invalid');}}}
 notificationArchiveFiles(db,original=>resolveFile(original));
}
/** Absolute references must remain within the explicitly selected host trees.
 * Original locations are preserved: no rewriting immutable artifact paths. */
function references(db:DatabaseSync,roots:Root[]){for(const [name,column] of [['ga_uploads','server_path'],['ga_artifact_versions','server_path'],['ga_artifact_parts','server_path'],['wb_task_notification_archives','root'],['wb_task_notification_digest_archives','root']]){if(!table(db,name!))continue;const columns=db.prepare(`PRAGMA table_info(${name})`).all();if(!columns.some(row=>row.name===column))continue;for(const row of db.prepare(`SELECT ${column} AS path FROM ${name}`).all()){if(typeof row.path!=='string'||!row.path||!roots.some(root=>selected(root,resolve(String(row.path)))))fail('host_backup_reference_outside_roots');}}}
function inventory(roots:Root[],database:string){
 const databaseFiles=new Set([database,database+'-wal',database+'-shm'].filter(path=>existsSync(path)).map(path=>realpathSync.native(path)));
 const files:File[]=[],directories:Manifest['directories']=[],seen=new Set<string>();
 for(const root of roots){
  if(!lstatSync(safe(root.path)).isDirectory())fail();
  const addDirectory=(folder:string)=>{
   const path=relative(root.path,folder).split(sep).join('/');child(root.path,path,true);const key=root.kind+'/'+path;
   if(!seen.has(key)){seen.add(key);directories.push({kind:root.kind,path,...permissions(folder)});}
  };
  const visit=(file:string,depth:number)=>{
   if(depth>100||files.length+directories.length>maximumFiles)fail('host_backup_limit');
   safe(file);if(roots.some(other=>other.kind!==root.kind&&other.path===file))return;
   if(databaseFiles.has(realpathSync.native(file)))return;
   const stat=lstatSync(file);
   if(stat.isDirectory()){addDirectory(file);for(const entry of readdirSync(file).sort())visit(child(file,entry),depth+1);}
   else if(stat.isFile()){if(/-(wal|shm|journal)$/.test(file))fail('host_backup_runtime_checkpoint_required');files.push({kind:root.kind,path:relative(root.path,file).split(sep).join('/'),executable:!!(stat.mode&0o100),...permissions(file),...fingerprint(file)});}
   else fail();
  };
  if(root.entries){
   addDirectory(root.path);
   for(const entry of root.entries){
    const file=child(root.path,entry);lstatSync(file);
    for(let folder=dirname(file);inside(folder,root.path);folder=dirname(folder)){addDirectory(folder);if(folder===root.path)break;}
    visit(file,0);
   }
  }else{addDirectory(root.path);for(const entry of readdirSync(root.path).sort())visit(child(root.path,entry),1);}
 }
 return {files,directories};
}
function encode(manifest:Manifest){const value=canonicalJson(manifest);if(Buffer.byteLength(value)>maximumManifest)fail('host_backup_limit');return value;}
function isolatedTarget(target:string,roots:Root[]){const path=safe(target);if(existsSync(path))fail('host_backup_target_exists');if(roots.some(root=>inside(path,root.path)||inside(root.path,path)))fail('host_backup_overlapping_roots');return path;}
export async function createHostBackup(input:{database:string;roots:Root[];offline:boolean},target:string){
 const roots=rootsOf(input.roots,input.offline),database=safe(input.database),databaseRoot=roots.find(root=>root.kind==='database')!;if(!selected(databaseRoot,database)||database===databaseRoot.path)fail();const destination=isolatedTarget(target,roots);const source=new DatabaseSync(database,{readOnly:true});
 try{integrity(source);references(source,roots);contentIntegrity(source,path=>safe(path));const version=source.prepare('PRAGMA data_version').get(),before=inventory(roots,database),databasePermissions=permissions(database);mkdirSync(destination,{mode:0o700});const databaseRelative=relative(databaseRoot.path,database).split(sep).join('/'),snapshot=child(resolve(destination,'trees','database'),databaseRelative);mkdirSync(dirname(snapshot),{recursive:true,mode:0o700});await backup(source,snapshot);chmodSync(snapshot,0o600);
  for(const directory of before.directories)mkdirSync(child(resolve(destination,'trees',directory.kind),directory.path,true),{recursive:true,mode:0o700});for(const file of before.files){const from=child(roots.find(root=>root.kind===file.kind)!.path,file.path),to=child(resolve(destination,'trees',file.kind),file.path);copyFileSync(from,to);chmodSync(to,file.executable?0o700:0o600);if(canonicalJson(fingerprint(to))!==canonicalJson({sha256:file.sha256,bytes:file.bytes}))fail('host_backup_source_changed');}
  if(canonicalJson(databasePermissions)!==canonicalJson(permissions(database))||canonicalJson(before)!==canonicalJson(inventory(roots,database))||canonicalJson(version)!==canonicalJson(source.prepare('PRAGMA data_version').get()))fail('host_backup_source_changed');const snapshotDb=new DatabaseSync(snapshot,{readOnly:true});try{integrity(snapshotDb);references(snapshotDb,roots);}finally{snapshotDb.close();}
  const manifest:Manifest={schema_version:process.platform!=='win32'?3:roots.some(root=>root.entries)?2:1,scope:'offline-local-host',roots,database:{kind:'database',path:databaseRelative},directories:before.directories,files:[...before.files,{kind:'database',path:databaseRelative,executable:false,...databasePermissions,...fingerprint(snapshot)}]},encoded=encode(manifest),id=hash(encoded);writeFileSync(resolve(destination,'manifest.json'),encoded,{flag:'wx',mode:0o600});verifyHostBackup(destination,id);return {backup_id:id,file_count:manifest.files.length,root_count:roots.length,verified:true};
 }finally{source.close();}
}
function manifestOf(bundle:string,expected:string):Manifest{if(!/^[a-f0-9]{64}$/.test(expected))fail();const path=safe(resolve(bundle,'manifest.json'));if(lstatSync(path).size>maximumManifest)fail();const encoded=readFileSync(path,'utf8');if(hash(encoded)!==expected)fail();const manifest=JSON.parse(encoded) as Manifest;if(canonicalJson(manifest)!==encoded||Object.keys(manifest).sort().join(',')!=='database,directories,files,roots,schema_version,scope'||![1,2,3].includes(manifest.schema_version)||manifest.scope!=='offline-local-host')fail();const validatedRoots=rootsOf(manifest.roots,true);if(manifest.schema_version===1&&validatedRoots.some(root=>root.entries))fail();if(!Array.isArray(manifest.files)||!Array.isArray(manifest.directories)||manifest.files.length+manifest.directories.length>maximumFiles||Object.keys(manifest.database).sort().join(',')!=='kind,path'||manifest.database.kind!=='database')fail();const seen=new Set<string>();for(const file of manifest.files){if(Object.keys(file).sort().join(',')!==(manifest.schema_version===3?'bytes,executable,kind,path,posix,sha256':'bytes,executable,kind,path,sha256')||(manifest.schema_version===3&&!validPermissions(file.posix))||!kinds.includes(file.kind)||typeof file.executable!=='boolean'||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256))fail();const sourceRoot=validatedRoots.find(root=>root.kind===file.kind);if(!sourceRoot||!selected(sourceRoot,child(sourceRoot.path,file.path)))fail();const key=file.kind+'/'+file.path;if(seen.has(key))fail();seen.add(key);if(canonicalJson(fingerprint(child(resolve(bundle,'trees',file.kind),file.path)))!==canonicalJson({sha256:file.sha256,bytes:file.bytes}))fail();}if(!seen.has('database/'+manifest.database.path))fail();for(const directory of manifest.directories){if(Object.keys(directory).sort().join(',')!==(manifest.schema_version===3?'kind,path,posix':'kind,path')||(manifest.schema_version===3&&!validPermissions(directory.posix))||!kinds.includes(directory.kind)||!selected(validatedRoots.find(root=>root.kind===directory.kind)!,child(validatedRoots.find(root=>root.kind===directory.kind)!.path,directory.path,true),true)||!lstatSync(child(resolve(bundle,'trees',directory.kind),directory.path,true)).isDirectory())fail();}return manifest;}
export function verifyHostBackup(bundle:string,expected:string){try{const manifest=manifestOf(bundle,expected),db=new DatabaseSync(child(resolve(bundle,'trees','database'),manifest.database.path),{readOnly:true});try{integrity(db);references(db,manifest.roots);contentIntegrity(db,path=>copiedPath(manifest.roots,bundle,path));}finally{db.close();}return {backup_id:expected,file_count:manifest.files.length,root_count:manifest.roots.length,verified:true};}catch{fail();}}
/** Caller must stop every writer. Restore full roots only when absent, or explicit entries only when absent;
 * never mutate immutable paths, overwrite live data or start workers. */
export function restoreHostBackup(bundle:string,expected:string,input:{roots:Root[];offline:boolean}){const roots=rootsOf(input.roots,input.offline),receipt=verifyHostBackup(bundle,expected),manifest=manifestOf(bundle,expected);if(manifest.schema_version===3){if(process.platform==='win32')fail('host_backup_posix_restore_required');const uid=process.getuid!(),groups=process.getgroups!();if(uid!==0&&[...manifest.files,...manifest.directories].some(entry=>entry.posix!.uid!==uid||!groups.includes(entry.posix!.gid)))fail('host_backup_ownership_privilege_required');}const existingDirectories=new Set(manifest.directories.map(entry=>child(roots.find(root=>root.kind===entry.kind)!.path,entry.path,true)).filter(path=>existsSync(path)));if(canonicalJson(roots)!==canonicalJson(manifest.roots))fail('host_backup_restore_roots_mismatch');for(const root of roots){safe(root.path);if(root.entries){if(existsSync(root.path)&&!lstatSync(root.path).isDirectory())fail();for(const entry of root.entries)if(existsSync(child(root.path,entry)))fail('host_backup_target_exists');}else if(existsSync(root.path))fail('host_backup_target_exists');}const database=child(roots.find(root=>root.kind==='database')!.path,manifest.database.path);for(const path of [database,database+'-wal',database+'-shm',database+'-journal'])if(existsSync(safe(path)))fail('host_backup_target_exists');for(const root of roots)mkdirSync(root.path,{recursive:true,mode:0o700});for(const directory of manifest.directories)mkdirSync(child(roots.find(root=>root.kind===directory.kind)!.path,directory.path,true),{recursive:true,mode:0o700});for(const file of manifest.files){const destination=child(roots.find(root=>root.kind===file.kind)!.path,file.path);mkdirSync(dirname(destination),{recursive:true,mode:0o700});copyFileSync(child(resolve(bundle,'trees',file.kind),file.path),destination);if(file.posix)restorePermissions(destination,file.posix);else chmodSync(destination,file.executable?0o700:0o600);if(canonicalJson(fingerprint(destination))!==canonicalJson({sha256:file.sha256,bytes:file.bytes}))fail();}let restoredEventSnapshot:string|null=null;const db=new DatabaseSync(database,{readOnly:true});try{integrity(db);references(db,roots);restoredEventSnapshot=eventSnapshot(db);}finally{db.close();}for(const directory of [...manifest.directories].sort((a,b)=>b.path.length-a.path.length)){const path=child(roots.find(root=>root.kind===directory.kind)!.path,directory.path,true);if(directory.posix&&!existingDirectories.has(path))restorePermissions(path,directory.posix);}const restoreVerification=Object.freeze({schema_version:1 as const,backup_id:expected,restored:true as const,database_integrity_verified:true as const,reference_paths_verified:true as const,file_contents_verified:true as const});issuedRestoreVerifications.set(restoreVerification,{backupId:expected,database,databaseFingerprint:fingerprint(database),walFingerprint:optionalFingerprint(database+'-wal'),eventSnapshot:restoredEventSnapshot,roots,inventoryFingerprint:hash(canonicalJson(inventory(roots,database)))});return {...receipt,restored:true,restore_verification:restoreVerification};}


/** Restore an independent verification copy. Absolute references remain in the
 * database and are checked against their corresponding restored private tree. */
export function restoreHostBackupForVerification(bundle: string, expected: string, target: string) {
 const receipt = verifyHostBackup(bundle, expected);
 const manifest = manifestOf(bundle, expected);
 const destination = isolatedTarget(target, manifest.roots);
 const bundleRoot = safe(bundle);
 if (inside(destination, bundleRoot) || inside(bundleRoot, destination)) fail('host_backup_overlapping_roots');
 if (manifest.schema_version === 3) {
  if (process.platform === 'win32') fail('host_backup_posix_restore_required');
  const uid = process.getuid!();
  const groups = process.getgroups!();
  if (uid !== 0 && [...manifest.files, ...manifest.directories].some(entry =>
   entry.posix!.uid !== uid || !groups.includes(entry.posix!.gid),
  )) fail('host_backup_ownership_privilege_required');
 }
 const roots = manifest.roots.map(root => ({
  ...root,
  path: resolve(destination, 'trees', root.kind),
  ...(root.entries ? {entries: [...root.entries]} : {}),
 }));
 mkdirSync(destination, {mode: 0o700});
 for (const root of roots) mkdirSync(root.path, {recursive: true, mode: 0o700});
 for (const directory of manifest.directories) {
  const root = roots.find(root => root.kind === directory.kind)!;
  mkdirSync(child(root.path, directory.path, true), {recursive: true, mode: 0o700});
 }
 for (const file of manifest.files) {
  const root = roots.find(root => root.kind === file.kind)!;
  const restored = child(root.path, file.path);
  mkdirSync(dirname(restored), {recursive: true, mode: 0o700});
  copyFileSync(child(resolve(bundleRoot, 'trees', file.kind), file.path), restored);
  if (file.posix) restorePermissions(restored, file.posix);
  else chmodSync(restored, file.executable ? 0o700 : 0o600);
  if (canonicalJson(fingerprint(restored)) !== canonicalJson({sha256: file.sha256, bytes: file.bytes})) fail();
 }
 writeFileSync(resolve(destination, 'manifest.json'), encode(manifest), {flag: 'wx', mode: 0o600});
 verifyHostBackup(destination, expected);
 for (const directory of [...manifest.directories].sort((left, right) => right.path.length - left.path.length)) {
  if (directory.posix) {
   const root = roots.find(root => root.kind === directory.kind)!;
   restorePermissions(child(root.path, directory.path, true), directory.posix);
  }
 }
 const database = child(roots.find(root => root.kind === 'database')!.path, manifest.database.path);
 const db = new DatabaseSync(database, {readOnly: true});
 let restoredEventSnapshot: string | null;
 try {
  integrity(db);
  references(db, manifest.roots);
  contentIntegrity(db, original => copiedPath(manifest.roots, destination, original));
  restoredEventSnapshot = eventSnapshot(db);
 } finally { db.close(); }
 const restoreVerification: HostRestoreVerificationReceipt = Object.freeze({
  schema_version: 1,
  backup_id: expected,
  restored: true,
  database_integrity_verified: true,
  reference_paths_verified: true,
  file_contents_verified: true,
 });
 issuedRestoreVerifications.set(restoreVerification, {
  backupId: expected,
  database,
  databaseFingerprint: fingerprint(database),
  walFingerprint: optionalFingerprint(database + '-wal'),
  eventSnapshot: restoredEventSnapshot,
  roots,
  inventoryFingerprint: hash(canonicalJson(inventory(roots, database))),
  sourceRoots: structuredClone(manifest.roots),
  verificationRoot: destination,
 });
 return {
  ...receipt,
  scope: 'isolated-restore-verification' as const,
  restored: true,
  database,
  roots: structuredClone(roots),
  restore_verification: restoreVerification,
 };
}


/** A serialized proof has authority only when rechecked with the live, private
 * restore capability and the exact original checkpoint identity. */
export function createWorkspaceCheckpointBackupProof(
 restoreVerification: unknown,
 scope: {owner_id: string; workspace_id: string; project_id: string; checkpoint_id: string},
) {
 if (!scope || Object.keys(scope).sort().join(',') !== 'checkpoint_id,owner_id,project_id,workspace_id'
  || Object.values(scope).some(value => typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value))) {
  fail('host_backup_checkpoint_scope_invalid');
 }
 const binding = restoreVerification && typeof restoreVerification === 'object'
  ? issuedRestoreVerifications.get(restoreVerification) : undefined;
 if (!binding?.sourceRoots || !binding.verificationRoot) return fail('host_backup_checkpoint_verification_required');
 let db: DatabaseSync | undefined;
 try {
  db = new DatabaseSync(binding.database, {readOnly: true});
  if (!isHostRestoreVerificationReceipt(restoreVerification, db)) fail('host_backup_checkpoint_verification_invalid');
  const checkpoint = db.prepare(`SELECT i.manifest_json,i.manifest_sha256,r.snapshot_id,r.receipt_json,r.receipt_sha256,
   a.record_json,a.record_sha256 FROM wb_workspace_checkpoint_intents i
   JOIN wb_workspace_checkpoint_ready r ON r.checkpoint_id=i.checkpoint_id
   JOIN wb_workspace_checkpoint_artifacts a ON a.checkpoint_id=i.checkpoint_id AND a.snapshot_id=r.snapshot_id
   WHERE i.checkpoint_id=? AND i.owner_id=? AND i.workspace_id=? AND i.project_id=?`)
   .get(scope.checkpoint_id, scope.owner_id, scope.workspace_id, scope.project_id);
  if (!checkpoint || typeof checkpoint.record_json !== 'string' || typeof checkpoint.snapshot_id !== 'string'
   || hash(checkpoint.record_json) !== checkpoint.record_sha256) return fail('host_backup_checkpoint_invalid');
  const record = validateWorkspaceRecoveryRecord(JSON.parse(checkpoint.record_json), checkpoint.snapshot_id);
  if (workspaceManifestHash(record.manifest) !== checkpoint.manifest_sha256
   || canonicalJson(record.manifest) !== checkpoint.manifest_json
   || typeof checkpoint.receipt_json !== 'string' || hash(checkpoint.receipt_json) !== checkpoint.receipt_sha256) {
   return fail('host_backup_checkpoint_invalid');
  }
  const receipt = JSON.parse(checkpoint.receipt_json);
  if (receipt.protocol !== 1 || receipt.checkpoint_id !== scope.checkpoint_id || receipt.project_id !== scope.project_id
   || receipt.workspace_id !== scope.workspace_id || receipt.snapshot_id !== checkpoint.snapshot_id
   || receipt.manifest_sha256 !== checkpoint.manifest_sha256 || receipt.status !== 'ready'
   || receipt.execution_authorized !== false || receipt.restore_authorized !== false) fail('host_backup_checkpoint_invalid');
  const restoredRoot = copiedPath(binding.sourceRoots, binding.verificationRoot, record.isolated_root.path);
  const actual = inventory([{kind: 'workspaces', path: restoredRoot}], binding.database);
  const entries: WorkspaceManifestEntry[] = actual.files.map(file => ({
   path: file.path, kind: 'file', sha256: file.sha256, bytes: file.bytes, executable: file.executable,
  }));
  for (const directory of actual.directories) {
   if (directory.path) entries.push({path: directory.path, kind: 'directory'});
  }
  for (const entry of record.manifest.entries) {
   if (entry.kind === 'absent') {
    if (existsSync(child(restoredRoot, entry.path))) fail('host_backup_checkpoint_manifest_changed');
    entries.push(entry);
   }
  }
  if (workspaceManifestHash({...record.manifest, entries}) !== checkpoint.manifest_sha256
   || !isHostRestoreVerificationReceipt(restoreVerification, db)) fail('host_backup_checkpoint_manifest_changed');
  return Object.freeze({
   protocol: 1,
   backup_id: binding.backupId,
   ...scope,
   snapshot_id: checkpoint.snapshot_id,
   manifest_sha256: String(checkpoint.manifest_sha256),
   execution_authorized: false,
   restore_authorized: false,
  });
 } catch {
  return fail('host_backup_checkpoint_verification_failed');
 } finally { db?.close(); }
}
