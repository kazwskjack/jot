import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {ProjectRepository} from '../../../src/projects/repository.ts';
import {GitWorkbench} from '../../../src/git/service.ts';
import {GitMutationIntents} from '../../../src/git/intents.ts';
import {GitIndexExecutions} from '../../../src/git/index-executions.ts';

const [root,database,intent,request,phase]=process.argv.slice(2);
const db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON');
const projects=new ProjectRepository(db),workbench=new GitWorkbench(projects,[{owner_id:'owner',project_id:'project',root}]);
const intents=new GitMutationIntents(db,projects,workbench),executions=new GitIndexExecutions(db,projects,workbench,intents);
const review=intents.get('owner','project',intent);
// Test-only filesystem instrumentation: production code has no crash switches.
let linked=0,unlinked=0;const placed=new Set();
const link=fs.linkSync,unlink=fs.unlinkSync;
fs.linkSync=(from,to)=>{
 if(!String(from).includes('jot-index-lock-'))return link(from,to);
 const ordinal=++linked;if(phase==='before-link-'+ordinal)process.exit(73);
 const result=link(from,to);placed.add(String(from));if(phase==='after-link-'+ordinal)process.exit(73);return result;
};
fs.unlinkSync=path=>{
 const result=unlink(path);
 if(placed.delete(String(path))&&phase==='after-unlink-'+(++unlinked))process.exit(73);
 return result;
};
syncBuiltinESMExports();
if(phase==='before-record'){
 db.function('test_exit_before_record',()=>process.exit(73));
 db.exec('CREATE TRIGGER crash_before_preparation BEFORE INSERT ON wb_git_index_preparations BEGIN SELECT test_exit_before_record(); END');
}
await executions.execute('owner','project',intent,{request_id:request,expected_version:review.version,review_sha256:review.review_sha256});
throw Error('test_crash_not_reached');
