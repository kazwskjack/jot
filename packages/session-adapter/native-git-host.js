import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createNativeGitTransport} from './native-git-transport.js';
import {createNativeWorkspaceFactoryGate} from './native-workspace-factory.js';
import {createNativeWorkspaceSourceHost,inspectNativeWorkspaceSource,assertNativeWorkspaceSourceAdmission,verifyNativeWorkspaceSourceCheckpoint} from './native-workspace-source.js';
import {createNativeInvariantReplay} from './native-invariant-replay.js';

export function normalizeNativeGitHostConfig(config){
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).sort().join(',')!=='databasePath,repositories,socket,tokenEnv'
  ||typeof config.databasePath!=='string'||!isAbsolute(config.databasePath)||typeof config.socket!=='string'
  ||typeof config.tokenEnv!=='string'||!/^JOT_[A-Z0-9_]{1,80}$/.test(config.tokenEnv)||!Array.isArray(config.repositories)||!config.repositories.length||config.repositories.length>256)throw Error('native_git_host_config_invalid');
 const seen=new Set(),repositories=config.repositories.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='owner_id,project_id,root'
   ||!['owner_id','project_id'].every(k=>typeof row[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row[k]))||typeof row.root!=='string'||!isAbsolute(row.root))throw Error('native_git_host_config_invalid');
  const key=row.owner_id+'\0'+row.project_id;if(seen.has(key))throw Error('native_git_host_config_invalid');seen.add(key);return Object.freeze({...row});
 });return Object.freeze({...config,repositories:Object.freeze(repositories)});
}

/** Mount beside the existing original native Host. The compiled Gateway
 * implementation is fixed relative to this package, never supplied over IPC.
 * It opens no native runtime and never creates or migrates a product schema. */
export async function createNativeGitHost({ctx,bridge,admissionGate,allowedPresets,config}){
 const settings=normalizeNativeGitHostConfig(config),token=process.env[settings.tokenEnv];
 if(typeof token!=='string'||token.length<32||!admissionGate||!(allowedPresets instanceof Set)||!allowedPresets.size||typeof bridge?.fetch!=='function')throw Error('native_git_host_unavailable');
 const originalFetch=bridge.fetch.bind(bridge),origin=bridge.origin,authorization='Bearer '+bridge.token;
 const observe=async signal=>{
  const response=await originalFetch(origin+'/internal/v1/workbench/native-git-database',{method:'POST',redirect:'error',headers:{authorization,'content-type':'application/json'},body:'{}',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])])});
  if(!response.ok)throw Error('native_git_database_changed');
  const reader=response.body?.getReader();if(!reader)throw Error('native_git_database_changed');const chunks=[];let bytes=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4096)throw Error('native_git_database_changed');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('native_git_database_changed');}
  if(!value||Object.keys(value).sort().join(',')!=='database_sha256,execution_authorized,protocol'||value.protocol!==1||value.execution_authorized!==false||!/^[a-f0-9]{64}$/.test(value.database_sha256))throw Error('native_git_database_changed');return value.database_sha256;
 };
 let db,factoryGate,transport,disposed=false,disposal;
 const dispose=()=>disposal??=(async()=>{disposed=true;await transport?.dispose();await factoryGate?.dispose();db?.close();})();
 try{
  const expected=await observe();
  // Refuse missing/aliased files before opening. All observations are repeated
  // after open and at synchronous native guards, including physical replacement.
  const path=realpathSync(settings.databasePath),stat=lstatSync(settings.databasePath,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||(process.platform==='win32'?path.toLowerCase()!==resolve(settings.databasePath).toLowerCase():path!==resolve(settings.databasePath)))throw Error('native_git_database_changed');
  const [{retainOriginalGitDatabase},{ProjectRepository},{GitWorkbench},{GitMutationIntents},{GitIndexExecutions},{WorkPublicationIntents},{WorkPublicationExecutions},{workspacePublicationSchema}]=await Promise.all([
   import('../gateway/dist/src/git/database-identity.js'),import('../gateway/dist/src/projects/repository.js'),import('../gateway/dist/src/git/service.js'),import('../gateway/dist/src/git/intents.js'),import('../gateway/dist/src/git/index-executions.js'),
   import('../gateway/dist/src/persistent-tasks/work-publication-intents.js'),import('../gateway/dist/src/persistent-tasks/work-publication-executions.js'),import('../gateway/dist/src/workbench/workspace-coordination-upgrade.js')]);
  db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=75;');
  const identity=retainOriginalGitDatabase(db);if(identity.sha256!==expected)throw Error('native_git_database_changed');
  const check=()=>{if(disposed)throw Error('native_git_host_unavailable');identity.assertCurrent();};
  const require=createRequire(ctx.get('profileContext').installAnchor),{SessionPersistence,SessionPersistenceNotFoundError}=require('@deepseek-ai/dsh-session-persistence'),{Session}=require('@deepseek-ai/dsh-session');
  const registry=ctx.agents,sessions=ctx.sessions,persistence=ctx.sessionPersistence;
  factoryGate=createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,notFoundError:SessionPersistenceNotFoundError});
  const source=createNativeWorkspaceSourceHost({bridge,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,backendClass:SessionPersistence,allowedPresets:new Set(allowedPresets),validateLog:createNativeInvariantReplay({Session}),projections:ctx.sessionProjections,factoryGate,admissionGate});
  const nativeWorkspaceHost={
   withReservedFamily(scope,controls,operation){check();return source.withReservedFamily(scope,{...controls,assertReservation(){check();return controls.assertReservation();}},operation);},
   inspect(context){check();return inspectNativeWorkspaceSource(context);},assertAdmission(context){check();return assertNativeWorkspaceSourceAdmission(context);},
   async verifyCheckpoint(context,checkpoint){check();await verifyNativeWorkspaceSourceCheckpoint(context,checkpoint);check();}
  };
  // Constructors share the existing Gateway classes, but this second process
  // must not install a missing schema or migrate a different deployment.
  let executions,publication;
  db.exec('BEGIN IMMEDIATE');
  try{
   const before=db.prepare('PRAGMA schema_version').get().schema_version,changes=db.prepare('SELECT total_changes() AS n').get().n;
   const projects=new ProjectRepository(db),git=new GitWorkbench(projects,settings.repositories),intents=new GitMutationIntents(db,projects,git);
   executions=new GitIndexExecutions(db,projects,git,intents,{nativeWorkspaceHost});
   publication=new WorkPublicationExecutions(db,git,new WorkPublicationIntents(db,git),{nativeWorkspaceHost});
   if(db.prepare('PRAGMA schema_version').get().schema_version!==before||db.prepare('SELECT total_changes() AS n').get().n!==changes)throw Error('native_git_database_changed');
   identity.assertCurrent();db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  transport=await createNativeGitTransport({socket:settings.socket,token,perform:async(scope,signal)=>{
   check();if(await observe(signal)!==identity.sha256)throw Error('native_git_database_changed');check();
   if(scope.operation_kind==='work_publication'){
    // Readiness is observed only. A request cannot install tables, migrate the
    // shared reservation enum or turn task completion into publication review.
    for(const table of ['wb_work_publication_intents','wb_work_publication_events','wb_work_publication_executions','wb_work_publication_admissions','wb_work_publication_journal'])if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))throw Error('native_work_publication_unavailable');
    if(workspacePublicationSchema(db)!=='publication')throw Error('native_work_publication_unavailable');
    return scope.command?publication.settlePublication(scope.owner_id,scope.project_id,scope.execution_id,scope.command,signal):publication.executePublication(scope.owner_id,scope.project_id,scope.execution_id,signal);
   }
   return executions.performReserved(scope.owner_id,scope.project_id,scope.execution_id,signal);
  }});
  return Object.freeze({dispose});
 }catch{await dispose();throw Error('native_git_host_unavailable');}
}
