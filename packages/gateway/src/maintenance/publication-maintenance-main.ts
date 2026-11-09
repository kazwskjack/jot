import {inspectPublicationMaintenance,applyPublicationMaintenance,applyGitCommitMaintenance,applyGitBranchMaintenance,applyGitInitializationMaintenance,applyGitReinitializationMaintenance} from './publication-maintenance.ts';
const args=process.argv.slice(2),[action,database,digest,confirmation]=args;
if(!database||action==='inspect'&&args.length!==2||action!=='inspect'&&(args.length!==4||confirmation!=='--confirm-offline')||!['inspect','apply','apply-commit','rollback-commit','apply-branch','rollback-branch','apply-init','rollback-init','apply-reinit','rollback-reinit'].includes(action??'')){
 console.error('usage: publication-maintenance-main inspect ABSOLUTE_DATABASE | apply|apply-commit|rollback-commit|apply-branch|rollback-branch|apply-init|rollback-init|apply-reinit|rollback-reinit ABSOLUTE_DATABASE EXPECTED_DATABASE_SHA --confirm-offline');process.exitCode=2;
}else try{
 const input={expected_database_sha256:digest,offline:true};
 const maintenance=action==='apply-reinit'||action==='rollback-reinit'?applyGitReinitializationMaintenance
  :action==='apply-init'||action==='rollback-init'?applyGitInitializationMaintenance
  :action==='apply-branch'||action==='rollback-branch'?applyGitBranchMaintenance:applyGitCommitMaintenance;
 const result=action==='inspect'?inspectPublicationMaintenance(database):action==='apply'?applyPublicationMaintenance(database,input):maintenance(database,input,action==='rollback-commit'||action==='rollback-branch'||action==='rollback-init'||action==='rollback-reinit');
 console.log(JSON.stringify(result));
}catch(error){const message=error instanceof Error?error.message:'';console.error(/^(?:publication_maintenance_[a-z_]+|git_commit_upgrade_[a-z_]+|workspace_publication_upgrade_[a-z_]+|native_git_database_changed)$/.test(message)?message:'publication_maintenance_failed');process.exitCode=1}
