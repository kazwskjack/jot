import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {buildServer} from '../../src/server.ts';
import {fileURLToPath} from 'node:url';
const templateRoot=fileURLToPath(new URL('../../file-engine/templates/',import.meta.url));

async function fixture(t){
 const parent=await mkdtemp(join(tmpdir(),'jot-git-api-')),root=join(parent,'repo');await mkdir(root);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,stdio:['ignore','pipe','pipe'],encoding:'utf8'});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic fixture');await writeFile(join(root,'note.txt'),'after\n');
 const service=await buildServer({databasePath:join(parent,'db.sqlite'),templateRoot,workspaces:['ws'],gitRepositories:[{owner_id:'owner',project_id:'project-git',root}]});
 service.db.prepare('INSERT INTO ga_projects(id,owner_id,title,is_default,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('project-git','owner','Git project',0,1,new Date().toISOString(),new Date().toISOString());
 t.after(async()=>{await service.app.close();service.db.close();assert.ok(resolve(parent).startsWith(resolve(tmpdir())));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const request=(url,owner='owner')=>service.app.inject({url,headers:{'x-user-id':owner}});return{...service,root,request};
}

test('owned project API returns a bounded Git snapshot and exact selected patch through declared contracts',async t=>{
 const f=await fixture(t),caps=(await f.request('/v1/capabilities')).json();assert.deepEqual(caps.git_workbench,{configured_projects:['project-git'],read_only:true});
 const response=await f.request('/v1/projects/project-git/git');assert.equal(response.statusCode,200,response.body);const state=response.json();assert.equal(state.project_id,'project-git');assert.equal(state.head.branch,'main');assert.equal(state.execution_authorized,false);assert.equal(JSON.stringify(state).includes(f.root),false);assert.match(response.headers['cache-control'],/no-store/);
 const patch=await f.request('/v1/projects/project-git/git/diff?path=note.txt&stage=working&snapshot_id='+state.snapshot_id);assert.equal(patch.statusCode,200,patch.body);assert.match(patch.json().patch,/\+after/);
 assert.deepEqual((await f.request('/v1/capabilities','foreign')).json().git_workbench.configured_projects,[]);
 assert.equal((await f.request('/v1/projects/project-git/git','foreign')).statusCode,404);
});

test('unknown selectors, stale content and deleted ownership cannot read current or former project contents',async t=>{
 const f=await fixture(t),state=(await f.request('/v1/projects/project-git/git')).json();
 for(const query of ['path=note.txt&stage=working&snapshot_id='+state.snapshot_id+'&root=elsewhere','path=..%2Fnote.txt&stage=working&snapshot_id='+state.snapshot_id,'path=note.txt&stage=unknown&snapshot_id='+state.snapshot_id])assert.equal((await f.request('/v1/projects/project-git/git/diff?'+query)).statusCode,400);
 await writeFile(join(f.root,'note.txt'),'changed after inspection\n');assert.equal((await f.request('/v1/projects/project-git/git/diff?path=note.txt&stage=working&snapshot_id='+state.snapshot_id)).statusCode,409);
 f.db.prepare("UPDATE ga_projects SET owner_id='foreign' WHERE id='project-git'").run();assert.equal((await f.request('/v1/projects/project-git/git')).statusCode,404);assert.deepEqual((await f.request('/v1/capabilities')).json().git_workbench.configured_projects,[]);
});

test('Git integration defaults to empty trusted bindings and never accepts runtime roots',async()=>{
 const f=await buildServer({databasePath:':memory:',templateRoot,workspaces:['ws']});try{
  assert.deepEqual((await f.app.inject({url:'/v1/capabilities',headers:{'x-user-id':'owner'}})).json().git_workbench,{configured_projects:[],read_only:true});
  const project=f.projects.create('owner',{title:'Unbound'});assert.equal((await f.app.inject({url:'/v1/projects/'+project.project_id+'/git',headers:{'x-user-id':'owner'}})).statusCode,503);
 }finally{await f.app.close();f.db.close();}
});

test('ownership is rechecked after asynchronous Git reads before any project bytes are published',async t=>{
 const f=await fixture(t),assertOwned=f.projects.assertOwned.bind(f.projects);let checks=0;
 f.projects.assertOwned=(project,owner)=>{if(++checks===2)f.db.prepare("UPDATE ga_projects SET owner_id='foreign' WHERE id='project-git'").run();return assertOwned(project,owner);};
 const response=await f.request('/v1/projects/project-git/git');assert.equal(response.statusCode,404,response.body);assert.equal(checks,2);assert.equal(response.body.includes('note.txt'),false);
});

test('operator Git configuration defaults to empty bindings and rejects malformed input without echoing it',async()=>{
 const {gitConfiguration}=await import('../../src/git/config.ts');assert.deepEqual(gitConfiguration({}),{gitRepositories:[]});
 for(const value of ['not-json','{}','false'])assert.throws(()=>gitConfiguration({GENERAL_AGENT_GIT_REPOSITORIES:value}),/^Error: git_configuration_invalid$/);
});

test('invalid or shared cross-owner repository bindings refuse startup before filesystem access',async()=>{
 for(const gitRepositories of [[{owner_id:'owner',project_id:'project',root:'relative'}],[{owner_id:'owner',project_id:'project',root:resolve('synthetic'),command:'unsafe'}],[{owner_id:'owner',project_id:'project',root:resolve('synthetic')},{owner_id:'other',project_id:'other',root:resolve('synthetic')} ]])await assert.rejects(buildServer({databasePath:':memory:',templateRoot,workspaces:['ws'],gitRepositories}));
});
