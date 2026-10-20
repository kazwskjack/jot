import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {completedWorkFixture} from './work-completion-source-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {GitWorkbench} from '../../src/git/service.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
export async function publicationReviewFixture(t,{outputPath='source.md'}={}){
 const f=await completedWorkFixture(t,{outputPath}),root=join(f.root,'configured-target');await mkdir(root);const git=(...args)=>execFileSync('git',['--no-optional-locks','-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');const base=f.workbench.readFile('owner','ws',f.scope.project_id,'source.md').content;await writeFile(join(root,'source.md'),base);git('add','.');git('commit','-m','Synthetic reviewed base');
 const module=await import('../../src/persistent-tasks/work-publication-intents.ts');module.installWorkPublicationIntents(f.db);
 const workbench=new GitWorkbench(new ProjectRepository(f.db),[{owner_id:'owner',project_id:f.scope.project_id,root}]),service=new module.WorkPublicationIntents(f.db,workbench),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id);
 const input={request_id:'prepare-publication',source_run_id:f.admission.run_id,source_sha256:source.source_sha256,paths:[outputPath]};return {...f,logicalWorkbench:f.workbench,rootTarget:root,base,git,source,service,workbench,input,module};
}
