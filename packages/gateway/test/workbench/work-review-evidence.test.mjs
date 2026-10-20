import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../src/db/canonical-json.ts';
import {createWorkspaceDiff} from '../../src/always-on/workspace-diff.ts';
import {workspaceManifestHash} from '../../src/always-on/workspace-provider.ts';
import {projectWorkReviewEvidence} from '../../src/persistent-tasks/review-work-evidence.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';
import {readFileSync} from 'node:fs';

const hash=v=>createHash('sha256').update(canonicalJson(v)).digest('hex');
function evidence(){
 const base={protocol:1,provider:'snapshot-copy',paths:['report.md'],entries:[]};
 const result={...base,entries:[{kind:'file',path:'report.md',sha256:'a'.repeat(64),bytes:8,executable:false}]};
 const payload={protocol:1,grant_id:'grant',work_occurrence_id:'occ',cycle_id:'cycle',snapshot_id:'snapshot',selected_objective:'{"protocol":1,"kind":"selected_discovery_work","plans":[]}',source_sha256:'b'.repeat(64),source_record_sha256:'c'.repeat(64),plans_sha256:'d'.repeat(64),paths_sha256:'e'.repeat(64),base_manifest:base,base_manifest_sha256:workspaceManifestHash(base),result_manifest:result,result_manifest_sha256:workspaceManifestHash(result),diff:createWorkspaceDiff({base,base_sha256:workspaceManifestHash(base),result,result_sha256:workspaceManifestHash(result)}),write_receipt_ids:['proof'],call_set_sha256:'f'.repeat(64),binding_sha256:'0'.repeat(64)};
 return {...payload,inspection_sha256:hash(payload)};
}
test('work review projects full frozen inventories and diff without private host data or apply permission',()=>{
 assert.equal(projectWorkReviewEvidence(undefined),undefined);
 const original=evidence(),projected=projectWorkReviewEvidence(original);
 assert.equal(projected.source,'isolated');assert.equal(projected.execution_authorized,false);
 assert.deepEqual(projected.base_manifest,original.base_manifest);assert.deepEqual(projected.result_manifest,original.result_manifest);
 assert.deepEqual(projected.diff,original.diff);assert.equal(projected.selected_objective,original.selected_objective);
 assert.ok(Object.isFrozen(projected));original.result_manifest.entries[0].bytes=999;
 assert.equal(projected.result_manifest.entries[0].bytes,8);
});
test('changed inspection, inventory or diff is rejected even if an outer payload hash is recomputed',()=>{
 const invalidInspection=evidence();invalidInspection.inspection_sha256='1'.repeat(64);
 assert.throws(()=>projectWorkReviewEvidence(invalidInspection),/task_review_output_unavailable/);
 for(const change of [v=>v.result_manifest.entries[0].sha256='2'.repeat(64),v=>v.diff.changes=[]]){
  const value=structuredClone(evidence());change(value);assert.throws(()=>projectWorkReviewEvidence(value),/task_review_output_unavailable/);
  const {inspection_sha256,...payload}=value;value.inspection_sha256=hash(payload);
  assert.throws(()=>projectWorkReviewEvidence(value),/task_review_output_unavailable/);
 }
});

test('the original list response contract accepts frozen review evidence and denies host paths or apply claims',()=>{
 const validator=new ContractValidator(),operation=validator.operationFor('GET','/v1/interactions/{interaction_id}/outputs');
 const page={items:[],work_review:projectWorkReviewEvidence(evidence())};
 assert.equal(validator.validateResponse(operation,200,page).valid,true);
 for(const mutate of [v=>v.work_review.execution_authorized=true,v=>v.work_review.root='/host/private',v=>v.work_review.diff.execution_authorized=true,v=>v.work_review.result_manifest.entries[0].path='../secret']){
  const changed=structuredClone(page);mutate(changed);assert.equal(validator.validateResponse(operation,200,changed).valid,false);
 }
 const json=JSON.parse(readFileSync(new URL('../../contracts/openapi.json',import.meta.url),'utf8'));
 const yaml=readFileSync(new URL('../../contracts/openapi.yaml',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 for(const name of ['WorkReviewEntry','WorkReviewManifest','WorkReviewChange','WorkReviewDiff','TaskWorkReview','TaskReviewOutputPage']){
  const schemaSection=yaml.slice(yaml.indexOf('  schemas:\n'),yaml.indexOf('  parameters:\n'));
  const line=schemaSection.split('\n').find(s=>s.startsWith('    '+name+': '));assert.ok(line);assert.deepEqual(JSON.parse(line.slice(line.indexOf(':')+1)),json.components.schemas[name]);
 }
});
