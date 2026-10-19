import {DatabaseSync} from 'node:sqlite';
import {ProjectRepository} from '../../../src/projects/repository.ts';
import {GitWorkbench} from '../../../src/git/service.ts';
import {GitMutationIntents} from '../../../src/git/intents.ts';
import {GitIndexExecutions} from '../../../src/git/index-executions.ts';
const [root,database,execution,request,expected,phase]=process.argv.slice(2),db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON');
const projects=new ProjectRepository(db),workbench=new GitWorkbench(projects,[{owner_id:'owner',project_id:'project',root}]),intents=new GitMutationIntents(db,projects,workbench),executions=new GitIndexExecutions(db,projects,workbench,intents,{now:()=>Date.now()+60000});
if(phase==='before-receipt'){
 db.function('test_exit_before_control_receipt',()=>process.exit(73));
 db.exec('CREATE TRIGGER crash_before_control_receipt BEFORE INSERT ON wb_git_index_control_receipts BEGIN SELECT test_exit_before_control_receipt(); END');
}
await executions.abandon('owner','project',execution,{request_id:request,expected_state_sha256:expected,acknowledge_unknown:true});
if(phase==='after-receipt')process.exit(73);
throw Error('test_crash_not_reached');
