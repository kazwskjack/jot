import {readFileSync,lstatSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHostBackup,verifyHostBackup,restoreHostBackup,restoreHostBackupForVerification,createWorkspaceCheckpointBackupProof} from './host-backup.ts';
import {canonicalJson} from '../db/canonical-json.ts';
const args=process.argv.slice(2),[action,first,second,third,ownerId,conversationId,maxEventsText,confirmation]=args;
function config(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error();const value=JSON.parse(readFileSync(path,'utf8'));if(!value||Object.keys(value).sort().join(',')!=='database,offline,roots'||typeof value.database!=='string'||value.offline!==true)throw new Error();return value;}
function checkpointSettings(path:string){
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('checkpoint_prune_config_invalid');
 const value=JSON.parse(readFileSync(path,'utf8'));
 if(!value||Object.keys(value).sort().join(',')!=='checkpointRoot,database,offline,verificationRoot,workbenchRoot'||value.offline!==true)throw Error('checkpoint_prune_config_invalid');
 for(const key of ['database','checkpointRoot','verificationRoot','workbenchRoot']){
  if(typeof value[key]!=='string'||value[key].length>4096||!isAbsolute(value[key]))throw Error('checkpoint_prune_config_invalid');
  const entry=lstatSync(value[key]);
  if(entry.isSymbolicLink()||(key==='database'?!entry.isFile():!entry.isDirectory()))throw Error('checkpoint_prune_config_invalid');
 }
 return value as {database:string;checkpointRoot:string;verificationRoot:string;workbenchRoot:string;offline:true};
}
async function checkpointPrune(){
 const [,settingsPath,bundle,backupId,owner,workspace,project,checkpoint]=args;
 const settings=checkpointSettings(settingsPath!);
 const target=join(settings.verificationRoot,'checkpoint-prune-'+randomUUID());
 let restored:ReturnType<typeof restoreHostBackupForVerification>|undefined;
 let db:DatabaseSync|undefined;
 try{
  restored=restoreHostBackupForVerification(bundle!,backupId!,target);
  const scope={owner_id:owner!,workspace_id:workspace!,project_id:project!,checkpoint_id:checkpoint!};
  const proof=createWorkspaceCheckpointBackupProof(restored.restore_verification,scope);
  const source=new DatabaseSync(settings.database,{readOnly:true});
  try{
   const row=source.prepare(`SELECT i.manifest_sha256,r.snapshot_id FROM wb_workspace_checkpoint_intents i
    JOIN wb_workspace_checkpoint_ready r ON r.checkpoint_id=i.checkpoint_id
    WHERE i.checkpoint_id=? AND i.owner_id=? AND i.workspace_id=? AND i.project_id=?`).get(checkpoint!,owner!,workspace!,project!);
   if(!row||row.manifest_sha256!==proof.manifest_sha256||row.snapshot_id!==proof.snapshot_id)throw Error('checkpoint_prune_source_mismatch');
  }finally{source.close();}
  const [{WorkbenchService},{WorkspaceCheckpointService}]=await Promise.all([import('../workbench/service.ts'),import('../workbench/workspace-checkpoints.ts')]);
  db=new DatabaseSync(settings.database);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const workbench=new WorkbenchService(db,{workspaceIds:[workspace!],root:settings.workbenchRoot});
  const verification=restored.restore_verification;
  const service=new WorkspaceCheckpointService(db,workbench,{storageRoot:settings.checkpointRoot,verifyBackupProof:(submitted,expected)=>{
   const verified=createWorkspaceCheckpointBackupProof(verification,scope);
   return canonicalJson(submitted)===canonicalJson(verified)&&verified.checkpoint_id===expected.checkpoint_id
    &&verified.snapshot_id===expected.snapshot_id&&verified.manifest_sha256===expected.manifest_sha256;
  }});
  return action==='checkpoint-prune-reconcile'
   ?await service.reconcilePrune(owner!,workspace!,project!,checkpoint!)
   :await service.prune(owner!,workspace!,project!,checkpoint!,proof);
 }finally{
  db?.close();
  if(restored){
   const child=relative(resolve(settings.verificationRoot),resolve(target));
   if(!child||child==='..'||child.startsWith('..\\')||child.startsWith('../')||isAbsolute(child))throw Error('checkpoint_prune_verification_scope_invalid');
   rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  }
 }
}
async function retentionReport(database:string,restoreVerification:unknown){let db:DatabaseSync|undefined;try{const {buildEventRetentionReport}=await import('../events/retention-report.ts');db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=75;');return buildEventRetentionReport(db,{restoreVerification});}catch{return {schema_version:1,mode:'unknown',reason:'event_retention_inventory_unavailable',candidates:[]};}finally{db?.close();}}
const checkpointAction=['checkpoint-prune','checkpoint-prune-reconcile'].includes(action??'');
const checkpointArgumentsValid=checkpointAction&&args.length===9&&args[8]==='--confirm-checkpoint-prune'
 &&args.slice(1,8).every(value=>!!value&&!value.startsWith('--'));
const cleanupAction=action==='restore-cleanup';
const cleanupMaxEvents=Number(maxEventsText);
const cleanupArgumentsValid=cleanupAction&&args.length===8&&!!first&&!!second&&!!third
 &&!!ownerId?.trim()&&!!conversationId?.trim()&&/^[1-9]\d*$/.test(maxEventsText??'')
 &&Number.isSafeInteger(cleanupMaxEvents)&&cleanupMaxEvents<=1000
 &&confirmation==='--confirm-retention-cleanup'&&!args.slice(1,7).some(arg=>arg.startsWith('--'));
const ordinaryArgumentsValid=['create','verify','restore'].includes(action??'')
 &&args.length===(action==='restore'?4:3)&&!!first&&!!second&&!args.some(arg=>arg.startsWith('--'));
if(!cleanupArgumentsValid&&!ordinaryArgumentsValid&&!checkpointArgumentsValid){console.error('usage: host-backup-main checkpoint-prune|checkpoint-prune-reconcile PRIVATE_CHECKPOINT_CONFIG PRIVATE_BUNDLE TRUSTED_SHA OWNER_ID WORKSPACE_ID PROJECT_ID CHECKPOINT_ID --confirm-checkpoint-prune | create PRIVATE_CONFIG NEW_PRIVATE_BUNDLE | verify PRIVATE_BUNDLE TRUSTED_SHA | restore PRIVATE_CONFIG PRIVATE_BUNDLE TRUSTED_SHA | restore-cleanup PRIVATE_CONFIG PRIVATE_BUNDLE TRUSTED_SHA OWNER_ID CONVERSATION_ID MAX_EVENTS --confirm-retention-cleanup');process.exitCode=2;}
else{try{let receipt;if(checkpointAction)receipt=await checkpointPrune();else if(action==='create')receipt=await createHostBackup(config(first!),second!);else if(action==='verify')receipt=verifyHostBackup(first!,second!);else if(action==='restore-cleanup'){const settings=config(first!),restored=restoreHostBackup(second!,third!,settings);let db:DatabaseSync|undefined;try{const {cleanupEventRetention}=await import('../events/retention-cleanup.ts');db=new DatabaseSync(settings.database);db.exec('PRAGMA busy_timeout=75;');const retention_cleanup=cleanupEventRetention(db,{ownerId:ownerId!,conversationId:conversationId!,restoreVerification:restored.restore_verification,explicit:true,maxEvents:cleanupMaxEvents});receipt={schema_version:1,backup_id:restored.backup_id,restored:true,retention_cleanup};}finally{db?.close();}}else{const settings=config(first!),restored=restoreHostBackup(second!,third!,settings);receipt={...restored,retention_report:await retentionReport(settings.database,restored.restore_verification)};}console.log(JSON.stringify(receipt));}catch{console.error('host_backup_operation_failed');process.exitCode=1;}}
