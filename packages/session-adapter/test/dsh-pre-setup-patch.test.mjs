import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {patchDshPreSetupSource} from '../dsh-pre-setup-patch.js';

test('pre-setup compatibility patch rejects unknown versions, modified sources and partial patches',()=>{
 for(const version of ['0.1.7-alpha.2','0.2.0-rc.2','0.2.0'])assert.throws(()=>patchDshPreSetupSource({version,runtimeSource:'unverified',declarationSource:'unverified'}),/dsh_pre_setup_patch_/);
});

test('the exact installed rc2 patch is deterministic, idempotent and retains native setup order',{skip:!process.env.JOT_DSH_RUNTIME_MODULES},()=>{
 const root=join(process.env.JOT_DSH_RUNTIME_MODULES,'dsh-agent-loop'),read=path=>readFileSync(join(root,path),'utf8'),input={version:JSON.parse(read('package.json')).version,runtimeSource:read('lib/index.js'),declarationSource:read('lib/types/index.d.ts')};
 const result=patchDshPreSetupSource(input);assert.equal(result.changed,true);assert.equal(result.protocol,1);assert.ok(result.runtimeSource.indexOf('"agent/before-setup"')<result.runtimeSource.indexOf('raceAbort(setup?.(prepared.agent.ctx'));assert.match(result.runtimeSource,/jotPreSetupHookProtocol = 1/);assert.match(result.declarationSource,/'agent\/before-setup'/);
 assert.equal(patchDshPreSetupSource({...input,runtimeSource:result.runtimeSource,declarationSource:result.declarationSource}).changed,false);
 assert.throws(()=>patchDshPreSetupSource({...input,runtimeSource:result.runtimeSource}));assert.throws(()=>patchDshPreSetupSource({...input,runtimeSource:input.runtimeSource+'\n'}));
});
