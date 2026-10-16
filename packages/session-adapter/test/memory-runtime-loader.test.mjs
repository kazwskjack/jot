import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,rm,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {loadMemoryExtractionRuntime} from '../memory-runtime-loader.js';
import {createOptionalMemoryExtractionHost} from '../optional-memory-extraction.js';
const installed=process.env.JOT_DSH_RUNTIME_MODULES;
test('missing optional extraction runtime is explicit and does not import a main agent',async()=>{
 await assert.rejects(loadMemoryExtractionRuntime(resolve('.test-tmp/nonexistent-memory-runtime')),/memory_extraction_runtime_unavailable/);
});
test('reviewed upstream package loads only at its pinned bytes and SDK versions',{skip:!installed},async t=>{
 const root=resolve(installed,'..'),runtime=await loadMemoryExtractionRuntime(root);assert.equal(runtime.plugin.name,'dsh-memory');assert.equal(typeof runtime.Context,'function');assert.equal(typeof runtime.BlockAssembler,'function');
 const base=resolve('.test-tmp/plugin-loader');await mkdir(base,{recursive:true});const scratch=await mkdtemp(join(base,'case-'));t.after(()=>rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 const copied=join(scratch,'@dsh-external/dsh-memory');await cp(join(root,'@dsh-external/dsh-memory'),copied,{recursive:true});await appendFile(join(copied,'lib/store.js'),'\n// changed after review\n');
 await assert.rejects(loadMemoryExtractionRuntime(scratch),/memory_extraction_runtime_integrity/);
});


test('optional extraction readiness can fail without failing the ordinary Host',async()=>{
 assert.equal(createOptionalMemoryExtractionHost({}),undefined);
 for(const config of [{root:'relative',modulesRoot:'relative',maxOutputTokens:20},{root:resolve('.test-tmp/unused-memory'),modulesRoot:resolve('.test-tmp/nonexistent-memory-runtime'),maxOutputTokens:20}]){
  const host=createOptionalMemoryExtractionHost({config,bridge:{},llm:{},route:{provider:'fixture',model:'fixture'}});assert.deepEqual(await host.readiness(),{ready:false,reason:'memory_extraction_runtime_unavailable'});await assert.rejects(host.run({}),/memory_extraction_runtime_unavailable/);await host.dispose();
 }
});


test('a configured reviewed runtime reports ready without starting a model',{skip:!installed},async()=>{
 let calls=0;const host=createOptionalMemoryExtractionHost({config:{root:resolve('.test-tmp/unused-ready-memory'),modulesRoot:resolve(installed,'..'),maxOutputTokens:20},bridge:{bindingFor(){},async guardBudget(){},async request(){}},llm:{async *stream(){calls++;}},route:{provider:'fixture',model:'fixture'}});
 assert.deepEqual(await host.readiness(),{ready:true});assert.equal(calls,0);await host.dispose();assert.equal((await host.readiness()).ready,false);
});
