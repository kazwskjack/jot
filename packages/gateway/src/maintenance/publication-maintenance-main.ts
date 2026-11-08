import {inspectPublicationMaintenance,applyPublicationMaintenance,applyGitCommitMaintenance} from './publication-maintenance.ts';
const args=process.argv.slice(2),[action,database,digest,confirmation]=args;
if(!database||action==='inspect'&&args.length!==2||action!=='inspect'&&(args.length!==4||confirmation!=='--confirm-offline')||!['inspect','apply','apply-commit','rollback-commit'].includes(action??'')){
 console.error('usage: publication-maintenance-main inspect ABSOLUTE_DATABASE | apply|apply-commit|rollback-commit ABSOLUTE_DATABASE EXPECTED_DATABASE_SHA --confirm-offline');process.exitCode=2;
}else try{
 const input={expected_database_sha256:digest,offline:true};
 const result=action==='inspect'?inspectPublicationMaintenance(database):action==='apply'?applyPublicationMaintenance(database,input):applyGitCommitMaintenance(database,input,action==='rollback-commit');
 console.log(JSON.stringify(result));
}catch(error){const message=error instanceof Error?error.message:'';console.error(/^(?:publication_maintenance_[a-z_]+|git_commit_upgrade_[a-z_]+|workspace_publication_upgrade_[a-z_]+|native_git_database_changed)$/.test(message)?message:'publication_maintenance_failed');process.exitCode=1}
