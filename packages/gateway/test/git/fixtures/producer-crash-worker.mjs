import {DatabaseSync} from 'node:sqlite';import {ProjectRepository} from '../../../src/projects/repository.ts';import {GitWorkbench} from '../../../src/git/service.ts';import {GitMutationIntents} from '../../../src/git/intents.ts';import {GitIndexExecutions} from '../../../src/git/index-executions.ts';
const [root,path,id]=process.argv.slice(2),db=new DatabaseSync(path),projects=new ProjectRepository(db),git=new GitWorkbench(projects,[{owner_id:'owner',project_id:'project',root}]),intents=new GitMutationIntents(db,projects,git),executions=new GitIndexExecutions(db,projects,git,intents);
git.indexEffects('owner','project').prepareIndex=async()=>process.exit(73);
await executions.perform('owner','project',id);throw Error('test_crash_not_reached');
