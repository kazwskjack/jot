import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHostProfile} from '../create-profile.mjs';
import {apply as registerStandardPreset} from '../standard-preset.mjs';

async function isolated(fn){const root=await mkdtemp(join(tmpdir(),'jot-host-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('creates a real official profile without secrets or automatic activation',()=>isolated(async root=>{
 const result=await createHostProfile({home:root,name:'jot',adapter:resolve('../session-adapter/index.js')});
 const manifest=JSON.parse(await readFile(join(result.directory,'package.json'),'utf8'));
 assert.equal(manifest.dependencies['@deepseek-ai/dsh'],'0.2.0-rc.2');
 assert.deepEqual(manifest.dsh.profile.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
 assert.equal(manifest.dsh.profile.patchReload,'startup');
 const lock=JSON.parse(await readFile(join(result.directory,'package-lock.json'),'utf8'));
 assert.equal(lock.name,manifest.name);assert.equal(lock.version,manifest.version);assert.equal(lock.lockfileVersion,3);
 assert.deepEqual(lock.packages[''].dependencies,manifest.dependencies);
 assert.equal(lock.packages['node_modules/@deepseek-ai/dsh'].version,'0.2.0-rc.2');
 for(const [path,entry] of Object.entries(lock.packages)){if(!path)continue;assert.match(entry.resolved,/^https:\/\/registry\.npmjs\.org\//);assert.match(entry.integrity,/^sha512-/);assert.equal(entry.link,undefined);}
 const source=await readFile(join(result.directory,'cordis.patch.yml'),'utf8');
 assert.match(source,/!!js process\.cwd\(\)/);
 const patch=JSON.parse(source.replace('!!js process.cwd()','null'));
 assert.equal(patch.find(row=>row.id==='session-log-deepseek').disabled,true);
 assert.equal(patch.find(row=>row.id==='session-telemetry-otel').disabled,true);
 const insert=patch.find(row=>row.insert).insert,adapter=insert.find(row=>row.id==='jot-session-adapter');
 assert.deepEqual(adapter.inject,['jotHostReady']);
 assert.equal(adapter.config.nativeContinuation,false);assert.equal(adapter.config.nativeRoles,false);
 assert.equal(adapter.config.voiceEnabled,false);assert.equal(adapter.config.host,'127.0.0.1');
 assert.equal(adapter.config.tokenEnv,'JOT_SESSION_ADAPTER_TOKEN');
 assert.equal(adapter.config.nativeClaimedInputRecovery,undefined);
 assert.match(insert.find(row=>row.id==='preset-jot-general').name,/standard-preset\.mjs$/);
 assert.match(adapter.name,/^file:/);
 assert.equal(await readFile(join(result.directory,'cordis.yml'),'utf8'),'[]\n');
 assert.equal(await readFile(join(result.directory,'.gitignore'),'utf8'),'.env\nnode_modules/\n');
}));
test('refuses overwrite and invalid profile identity before changing existing data',()=>isolated(async root=>{
 const args={home:root,name:'jot',adapter:resolve('../session-adapter/index.js')};await createHostProfile(args);
 const marker=join(root,'profiles','jot','operator.txt');await writeFile(marker,'keep');
 await assert.rejects(createHostProfile(args),/EEXIST/);assert.equal(await readFile(marker,'utf8'),'keep');
 for(const name of ['../other','a/b','','desktop'])await assert.rejects(createHostProfile({...args,name}),/host_profile_config_invalid/);
 await assert.rejects(createHostProfile({...args,home:'relative'}),/host_profile_config_invalid/);
 await assert.rejects(createHostProfile({...args,adapter:'relative.js'}),/host_profile_config_invalid/);
}));
test('does not create a profile for a missing or non-file adapter',()=>isolated(async root=>{
 await mkdir(join(root,'directory'));
 for(const adapter of [join(root,'missing.js'),join(root,'directory')])await assert.rejects(createHostProfile({home:root,name:'jot',adapter}));
}));
test('preset registration refuses unknown launcher identity before importing any SDK code',()=>isolated(async root=>{
 await assert.rejects(registerStandardPreset({get:()=>undefined}),/jot_host_installation_missing/);
 const anchor=join(root,'package.json');await writeFile(anchor,JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.7-alpha.2'}));
 await assert.rejects(registerStandardPreset({get:()=>({installAnchor:anchor})}),/jot_host_runtime_version_mismatch/);
}));
test('host plugin package has the identity required by the official request inventory',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(manifest.name,'jot-dsh-host-preparation');assert.equal(manifest.version,'0.1.0');
});
