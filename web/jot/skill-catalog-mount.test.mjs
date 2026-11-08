import test from 'node:test';import assert from 'node:assert/strict';
const module=await import('./skill-catalog-mount.js').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const ownerScope='a'.repeat(64);

test('catalog panel mounts only for an active non-ordinary run with a current owner scope',()=>{
 assert.equal(typeof module.catalogMountForRun,'function');
 assert.deepEqual(module.catalogMountForRun('run-1',ownerScope,false),{runId:'run-1',ownerScope});
 for(const input of [
  [undefined,ownerScope,false],['run-1','',false],['run-1','bad-scope',false],['run-1',ownerScope,true],
 ])assert.equal(module.catalogMountForRun(...input),null);
});

test('using a user-invocable skill only adds the native DSH gesture to the draft',()=>{
 assert.equal(typeof module.skillGestureDraft,'function');
 assert.equal(module.skillGestureDraft('please help','notes'),'please help\n/notes');
 assert.equal(module.skillGestureDraft('  ','notes'),'/notes');
 assert.throws(()=>module.skillGestureDraft('','../outside'),/skill_catalog_invalid/);
});
