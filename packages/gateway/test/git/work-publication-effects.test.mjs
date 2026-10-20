import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
async function fixture(t,outputPath='source.md'){
 const f=await publicationReviewFixture(t,{outputPath}),review=await f.service.prepare('owner',f.scope.project_id,f.input),kernel=f.workbench.indexEffects('owner',f.scope.project_id);
 assert.equal(typeof kernel.preparePublication,'function');assert.equal(typeof kernel.applyPublication,'function');const materials=new FinalizedWorkSources(f.db).readSelection('owner',f.admission.run_id,f.input.paths,f.source.source_sha256).files;return{...f,review,kernel,materials};
}
function authority(change={}){const facts=[];return{facts,authorize(){},prepared(value){facts.push({kind:'prepared',value});},intent(value){facts.push({kind:'intent',value});},apply(value,operation){const result=operation();facts.push({kind:'effect',value,result});return result;},completed(value){facts.push({kind:'completed',value});},...change};}
test('original reviewed text publishes exact bytes while preserving Git index and HEAD',async t=>{
 const f=await fixture(t),index=await readFile(join(f.rootTarget,'.git/index')),head=f.git('rev-parse','HEAD'),before=f.base,plan=await f.kernel.preparePublication(f.review.target,f.review.changes,f.materials),auth=authority();
 assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),before);const result=await f.kernel.applyPublication(plan,auth);
 assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),index);assert.equal(f.git('rev-parse','HEAD'),head);
 assert.equal(result.state,'applied');assert.deepEqual(result.files.map(file=>file.path),['source.md']);assert.equal(result.files[0].sha256,f.source.files[0].sha256);assert.equal(result.execution_authorized,false);
 assert.deepEqual(auth.facts.filter(f=>f.kind==='intent').map(f=>f.value.phase),['stage','publish']);assert.ok(!JSON.stringify(result).includes(f.root));
 await assert.rejects(f.kernel.applyPublication(plan,auth),/git_publication_plan_consumed/);
});
test('a reviewed new nested file creates only its missing parents and never touches unrelated source files',async t=>{
 const f=await fixture(t,'nested/deep/result.md'),plan=await f.kernel.preparePublication(f.review.target,f.review.changes,f.materials),auth=authority();
 await f.kernel.applyPublication(plan,auth);assert.equal(await readFile(join(f.rootTarget,'nested/deep/result.md'),'utf8'),'Exact reviewed work content');assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);
 assert.deepEqual(auth.facts.filter(f=>f.kind==='intent').map(f=>f.value.phase),['directory','directory','stage','publish']);assert.deepEqual((await readdir(join(f.rootTarget,'nested/deep'))).sort(),['result.md']);
});
test('changed original target bytes refuse preparation without scratch files or target writes',async t=>{
 const f=await fixture(t);await writeFile(join(f.rootTarget,'source.md'),'Unrelated outside edit');const before=await readdir(f.rootTarget);
 await assert.rejects(f.kernel.preparePublication(f.review.target,f.review.changes,f.materials),/git_publication_target_changed/);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Unrelated outside edit');assert.deepEqual(await readdir(f.rootTarget),before);
});
test('authority revocation after staging cannot publish the prepared bytes',async t=>{
 const f=await fixture(t),plan=await f.kernel.preparePublication(f.review.target,f.review.changes,f.materials),auth=authority({authorize(){if(auth.facts.some(f=>f.kind==='effect'&&f.value.phase==='stage'))throw Error('original_review_revoked');}});
 await assert.rejects(f.kernel.applyPublication(plan,auth),/original_review_revoked/);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);assert.equal(auth.facts.filter(f=>f.kind==='completed').length,0);
 assert.ok(auth.facts.some(f=>f.kind==='effect'&&f.value.phase==='stage'),'retained staging evidence is distinct from file publication');
});
test('a lost post-publication acknowledgement is not rolled back, replayed or presented as successful',async t=>{
 const f=await fixture(t),plan=await f.kernel.preparePublication(f.review.target,f.review.changes,f.materials),auth=authority({apply(step,operation){const result=operation();if(step.phase==='publish')throw Error('original_ack_lost');auth.facts.push({kind:'effect',value:step,result});return result;}});
 await assert.rejects(f.kernel.applyPublication(plan,auth),/original_ack_lost/);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');assert.equal(auth.facts.filter(f=>f.kind==='completed').length,0);
 await assert.rejects(f.kernel.applyPublication(plan,auth),/git_publication_plan_consumed/);
});
test('an outside writer at a new target cannot be overwritten by a reviewed add',async t=>{
 const f=await fixture(t,'new.md'),plan=await f.kernel.preparePublication(f.review.target,f.review.changes,f.materials),auth=authority({intent(step){auth.facts.push({kind:'intent',value:step});if(step.phase==='publish')writeFileSync(join(f.rootTarget,'new.md'),'Outside new file');}});
 await assert.rejects(f.kernel.applyPublication(plan,auth),/git_publication_target_changed/);assert.equal(await readFile(join(f.rootTarget,'new.md'),'utf8'),'Outside new file');assert.equal(auth.facts.filter(f=>f.kind==='completed').length,0);
});
