import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const module=await import('./catalog-view.js').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const contract=await import('./catalog-contract.js');
const summary={name:'notes',description:'Notes',source:'project-dsh',provider:'filesystem',invocation:{userInvocable:false,modelInvocable:true}};
const service=()=>({snapshot:async()=>({complete:true,skills:[summary]}),get:async()=>({...summary,content:'Body',metadata:{version:'1.2.3',private:'secret'},path:'private',resourceBase:{kind:'directory',path:'private'}})});

test('catalog reads only the DSH snapshot and never loads every skill body',async()=>{
 assert.equal(typeof module.readSkillCatalogView,'function');
 const skills=service();let gets=0;skills.get=async()=>{gets++;throw Error('catalog must not load skill bodies');};
 const value=await module.readSkillCatalogView({skills});
 assert.equal(value.complete,true);assert.deepEqual(value.items,[summary]);assert.equal(gets,0);
 assert.equal(value.execution_authorized,false);assert.equal(JSON.stringify(value).includes('private'),false);
});
test('catalog refuses discovery drift and exposes no optimistic items for incomplete discovery',async()=>{
 assert.equal(typeof module.readSkillCatalogView,'function');
 const skills=service();skills.snapshot=async()=>({complete:false,skills:[summary]});skills.get=()=>{throw Error('must not load incomplete catalog');};
 assert.deepEqual((await module.readSkillCatalogView({skills})).items,[]);
 assert.equal((await module.readSkillCatalogView({skills:service()})).complete,true);
});
test('selected resource view reads one named resource through DSH fs and returns inert text',async()=>{
 assert.equal(typeof module.readSkillResourceView,'function');const calls=[];
 const skills={snapshot:async()=>({complete:true,skills:[{...summary,invocation:{userInvocable:true,modelInvocable:true},resourceBase:{kind:'directory',path:'root/notes'}}]}),get:async name=>{
  calls.push(name);return {...summary,name,invocation:{userInvocable:true,modelInvocable:true},content:'instructions',resourceBase:{kind:'directory',path:`root/${name}`}};
 }};
 const fs={resolve:async(path,options)=>({path:path.startsWith('root/')?path:`${options?.cwd}/${path}`}),contains:(parent,child)=>child.path.startsWith(parent.path+'/'),
  stat:async target=>target.path==='root/notes'?{type:'directory',size:0,version:'v1'}:{type:'file',size:5,version:'v1'},
  readBytes:async()=>Buffer.from('hello','utf8')};
 const value=await module.readSkillResourceView({skills,fs,name:'notes',relativePath:'resources/help.md'});
 assert.deepEqual(calls,[]);assert.equal(value.text,'hello');assert.equal(value.name,'notes');
 assert.equal(value.relativePath,'resources/help.md');assert.equal(value.execution_authorized,false);
 assert.equal(JSON.stringify(value).includes('root/notes'),false);
});
test('selected resource contract checks the UTF-8 digest and rejects unsafe paths',async()=>{
 const text='hello',value={protocol:1,name:'notes',relativePath:'references/help.md',text,
  textSha256:createHash('sha256').update(text).digest('hex'),execution_authorized:false};
 assert.deepEqual(await contract.validateSkillResourceView(value),value);
 await assert.rejects(()=>contract.validateSkillResourceView({...value,textSha256:'0'.repeat(64)}),/skill_catalog_invalid/);
 await assert.rejects(()=>contract.validateSkillResourceView({...value,relativePath:'../outside.md'}),/skill_catalog_invalid/);
});
test('catalog consumes the pinned official registry and provider with project precedence',async t=>{
 assert.equal(typeof module.readSkillCatalogView,'function');
 const profile=process.env.M16_SKILL_STAGE_PROFILE;assert.ok(profile,'explicit isolated SDK profile required');
 const require=createRequire(join(profile,'package.json'));
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
 const {SkillRegistry}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-skill')).href);
 const {FileSystemSkillProvider}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-skill-filesystem')).href);
 const root=await mkdtemp(join(process.cwd(),'.test-tmp','m1601-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cwd=join(root,'project'),user=join(root,'user');await mkdir(join(cwd,'.git'),{recursive:true});
 for(const [dir,body,version] of [[join(cwd,'.dsh','skills','notes'),'PROJECT','2.0'],[join(user,'skills','notes'),'USER','1.0']]){
  await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),`---\nname: notes\ndescription: Notes\nmetadata:\n  version: '${version}'\n---\n${body}\n`);
 }
 const ctx=new Context(),skills=new SkillRegistry(ctx);let provider;
 const dispose=skills.registerProvider(control=>provider=new FileSystemSkillProvider(ctx,control,{includeDefaultRoots:true,dshHome:user,agentsHome:join(root,'agents'),customSkillDirs:[],watch:false}));
 t.after(async()=>{await dispose();});
 const first=await module.readSkillCatalogView({skills,cwd});
 assert.equal(first.items.length,1);assert.equal(first.items[0].source,'project-dsh');
 const file=join(cwd,'.dsh','skills','notes','SKILL.md');await writeFile(file,'---\nname: notes\ndescription: New notes\n---\nUPDATED\n');provider.observeHostMutation(file);
 const next=await module.readSkillCatalogView({skills,cwd});assert.notEqual(next.catalogSha256,first.catalogSha256);
});
