import {writeSync} from 'node:fs';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {WorkspaceCheckpointService} from '../../src/workbench/workspace-checkpoints.ts';

const [dbPath,storageRoot,workspaceRoot,projectId,checkpointId,reviewId,reviewSha,commandKey,targetPhase,nowValue,leaseMs]=process.argv.slice(2);
const db=openProductDatabase(dbPath);
const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:workspaceRoot});
let acknowledged=false;
const service=new WorkspaceCheckpointService(db,workbench,{
 storageRoot,
 now:()=>Number(nowValue),
 leaseMs:Number(leaseMs),
 onPhase:(phase,identity={})=>{
  if(acknowledged||phase!==targetPhase)return;
  acknowledged=true;
  writeSync(1,`${JSON.stringify({event:'durable_phase',phase,operation_id:identity.operation_id})}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60_000);
 },
});

try{
 await service.restore('owner','ws',{project_id:projectId,checkpoint_id:checkpointId,path:'source.md',review_id:reviewId,review_sha256:reviewSha,command_key:commandKey,guard:()=>{},signal:new AbortController().signal});
 process.exitCode=80;
}catch(error){
 console.error(error);
 process.exitCode=81;
}finally{
 db.close();
}
