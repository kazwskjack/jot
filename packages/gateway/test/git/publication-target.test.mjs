import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,link,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {GitRepositoryInspection} from '../../src/git/inspection.ts';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const parent=await mkdtemp(join(tmpdir(),'publication-target-')),root=join(parent,'repo');await mkdir(root);
 const git=(...args)=>execFileSync('git',['--no-optional-locks','-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'Original reviewed base\n');git('add','--','note.txt');git('commit','-m','Synthetic base');
 t.after(async()=>{assert.ok(resolve(parent).startsWith(resolve(tmpdir())));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20})});
 return{parent,root,git,repository:new GitRepositoryInspection({root})};
}

test('publication target reads clean and absent nested paths without staging or modifying the repository',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'unrelated.txt'),'Keep unrelated work');const index=await readFile(join(f.root,'.git','index')),status=f.git('status','--porcelain');
 assert.equal(typeof f.repository.publicationTarget,'function');
 const read=await f.repository.publicationTarget(['note.txt','new/deep/result.md']);
 assert.equal(read.witness.kind,'publication_target');assert.equal(read.witness.execution_authorized,false);assert.match(read.witness.target_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(read.witness.files.map(x=>[x.path,x.kind]),[['new/deep/result.md','missing'],['note.txt','file']]);
 assert.equal(read.witness.files[1].sha256,sha('Original reviewed base\n'));assert.equal(read.contents.get('note.txt').toString(),'Original reviewed base\n');assert.equal(read.contents.has('new/deep/result.md'),false);
 assert.equal(JSON.stringify(read.witness).includes(f.root),false);assert.deepEqual(await readFile(join(f.root,'.git','index')),index);assert.equal(f.git('status','--porcelain'),status);
 assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'Original reviewed base\n');await assert.rejects(readFile(join(f.root,'new/deep/result.md')),{code:'ENOENT'});
 const old=await f.repository.inspect();await assert.rejects(f.repository.freeze(old.snapshot_id,['note.txt']),/git_path_unavailable/,'existing stage selection remains dirty-only');
 assert.deepEqual((await f.repository.publicationTarget(['new/deep/result.md','note.txt'])).witness,read.witness);
});

test('clean target byte changes and replaced parent identities change the publication witness',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'docs'));await writeFile(join(f.root,'docs/change.md'),'Same bytes');
 const first=await f.repository.publicationTarget(['note.txt','docs/change.md']);await writeFile(join(f.root,'note.txt'),'Changed reviewed base\n');
 assert.notEqual((await f.repository.publicationTarget(['note.txt','docs/change.md'])).witness.target_sha256,first.witness.target_sha256);
 const before=await f.repository.publicationTarget(['docs/change.md']);await rename(join(f.root,'docs'),join(f.root,'docs-old'));await mkdir(join(f.root,'docs'));await writeFile(join(f.root,'docs/change.md'),'Same bytes');
 assert.notEqual((await f.repository.publicationTarget(['docs/change.md'])).witness.target_sha256,before.witness.target_sha256);
});

test('a target altered during its read cannot become a completed review witness',async t=>{
 const f=await fixture(t);let changed=false;
 class Changed extends GitRepositoryInspection{async bytes(path,...args){const value=await super.bytes(path,...args);if(path===join(f.root,'note.txt')&&!changed){changed=true;await writeFile(path,'Raced target bytes\n')}return value}}
 await assert.rejects(new Changed({root:f.root}).publicationTarget(['note.txt']),/git_snapshot_changed|git_publication_target_changed/);
});


test('publication target rejects private paths, case aliases, duplicate and overlapping selections',async t=>{
 const f=await fixture(t);for(const paths of [[],['../note.txt'],['.env'],['.git/config'],['note.txt','NOTE.txt'],['new','new/child.md'],['NOTE.txt']])await assert.rejects(()=>f.repository.publicationTarget(paths),/git_intent_invalid|workspace_|git_path_unavailable/);
 await link(join(f.root,'note.txt'),join(f.root,'hardlink.txt'));await assert.rejects(()=>f.repository.publicationTarget(['note.txt']),/git_path_unavailable/);
 await mkdir(join(f.root,'directory'));await assert.rejects(()=>f.repository.publicationTarget(['directory']),/git_path_unavailable/);
});

test('a symlinked target ancestor never supplies publication bytes',async t=>{
 const f=await fixture(t);await mkdir(join(f.parent,'outside'));await writeFile(join(f.parent,'outside/ordinary.txt'),'Not target material');
 try{await symlink(join(f.parent,'outside'),join(f.root,'linked'),'junction')}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('OS cannot create the controlled symlink fixture');return}throw e}
 await assert.rejects(()=>f.repository.publicationTarget(['linked/ordinary.txt']),/git_path_unavailable/);
});

test('cancellation while reading actual target bytes returns no successful witness',async t=>{
 const f=await fixture(t),controller=new AbortController();
 class Cancelled extends GitRepositoryInspection{async bytes(path,...args){const value=await super.bytes(path,...args);if(path===join(f.root,'note.txt'))controller.abort();return value}}
 await assert.rejects(()=>new Cancelled({root:f.root}).publicationTarget(['note.txt'],controller.signal),/abort|cancel/i);
});

test('new HEAD and index states replace the before-state digest without touching target bytes',async t=>{
 const f=await fixture(t),before=await f.repository.publicationTarget(['note.txt']);await writeFile(join(f.root,'other.txt'),'Unrelated committed file');f.git('add','--','other.txt');
 const staged=await f.repository.publicationTarget(['note.txt']);assert.notEqual(staged.witness.index_sha256,before.witness.index_sha256);assert.notEqual(staged.witness.target_sha256,before.witness.target_sha256);
 f.git('commit','-m','Synthetic unrelated change');const committed=await f.repository.publicationTarget(['note.txt']);assert.notEqual(committed.witness.head.oid,before.witness.head.oid);assert.equal(committed.contents.get('note.txt').toString(),'Original reviewed base\n');
});

test('configured clean filters and external diff do not run during target reads',async t=>{
 const f=await fixture(t),marker=join(f.parent,'forbidden-filter');f.git('config','filter.fixture.clean','echo forbidden > '+JSON.stringify(marker.replaceAll('\\','/')));f.git('config','filter.fixture.required','true');f.git('config','diff.external','echo forbidden > '+JSON.stringify(marker.replaceAll('\\','/')));
 await writeFile(join(f.root,'.gitattributes'),'note.txt filter=fixture\n');const result=await f.repository.publicationTarget(['note.txt']);assert.equal(result.contents.get('note.txt').toString(),'Original reviewed base\n');await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('the configured workbench rechecks the actual project owner after awaited target reads',async t=>{
 const f=await fixture(t),{DatabaseSync}=await import('node:sqlite'),{ProjectRepository}=await import('../../src/projects/repository.ts'),{GitWorkbench}=await import('../../src/git/service.ts'),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE ga_projects(id TEXT PRIMARY KEY,owner_id TEXT)');db.prepare('INSERT INTO ga_projects VALUES(?,?)').run('project','owner');
 const workbench=new GitWorkbench(new ProjectRepository(db),[{owner_id:'owner',project_id:'project',root:f.root}]);const repository=workbench.indexEffects('owner','project'),original=repository.publicationTarget.bind(repository);
 repository.publicationTarget=async(...args)=>{const result=await original(...args);db.prepare('UPDATE ga_projects SET owner_id=?').run('foreign');return result};
 await assert.rejects(()=>workbench.publicationTarget('owner','project',['note.txt']),/project_not_found/);
});


test('a nested repository is not silently treated as the configured publication root',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'nested'));f.git('init','--initial-branch=main','nested');await writeFile(join(f.root,'nested/note.txt'),'Another repository');
 await assert.rejects(()=>f.repository.publicationTarget(['nested/note.txt']),/git_path_unavailable/);
});
