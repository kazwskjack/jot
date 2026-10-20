import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {join} from 'node:path';

test('pre-storage admission rejects unknown artifacts before creating a compatibility output',async()=>{
 const module=await import('../dsh-storage-admission-patch.js');
 assert.throws(()=>module.patchDshStorageAdmissionSource({version:'unknown',runtimeSource:'unverified',declarationSource:'unverified'}),/dsh_/);
});
test('reviewed pre-storage delta is idempotent and preserves the separately reviewed pending-input mechanism',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES},async()=>{
 const {patchDshStorageAdmissionSource}=await import('../dsh-storage-admission-patch.js'),root=join(process.env.JOT_DSH_RUNTIME_MODULES,'dsh-agent-loop');
 const input={version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,runtimeSource:readFileSync(join(root,'lib/index.js'),'utf8'),declarationSource:readFileSync(join(root,'lib/types/index.d.ts'),'utf8')};
 for(const pendingInputWake of [false,true]){
  const result=patchDshStorageAdmissionSource({...input,pendingInputWake});assert.equal(result.nativeAdmissionProtocol,1);assert.equal(result.changed,true);
  assert.match(result.runtimeSource,/jotStorageAdmissionHookProtocol = 1/);
  assert.match(result.declarationSource,/'agent-loop\/before-storage'/);
  assert.equal(patchDshStorageAdmissionSource({...input,pendingInputWake,runtimeSource:result.runtimeSource,declarationSource:result.declarationSource}).changed,false);
  assert.throws(()=>patchDshStorageAdmissionSource({...input,pendingInputWake,runtimeSource:result.runtimeSource+'\n',declarationSource:result.declarationSource}),/dsh_/);
  if(pendingInputWake)assert.match(result.runtimeSource,/jotResumePendingInputs/);
 }
});
