import test from 'node:test';import assert from 'node:assert/strict';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';

test('source review history pages validated immutable originals without target effects',async t=>{
 const f=await publicationReviewFixture(t),ids=[];
 for(let n=0;n<27;n++)ids.push((await f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:'history-'+n})).intent_id);
 const changes=f.db.prepare('SELECT total_changes() n').get().n,first=f.service.history('owner',f.scope.project_id,f.input.source_run_id);
 assert.equal(first.items.length,25);assert.ok(first.next_cursor);const second=f.service.history('owner',f.scope.project_id,f.input.source_run_id,first.next_cursor);
 assert.equal(second.items.length,2);assert.equal(second.next_cursor,null);assert.deepEqual([...first.items,...second.items].map(item=>item.intent_id).sort(),ids.sort());
 assert.equal(new Set([...first.items,...second.items].map(item=>item.intent_id)).size,27);assert.equal(JSON.stringify(first).includes(f.root),false);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.throws(()=>f.service.history('foreign',f.scope.project_id,f.input.source_run_id),/project_not_found/);
 assert.throws(()=>f.service.history('owner',f.scope.project_id,'other-source',first.next_cursor),/work_publication_not_found/);
 assert.throws(()=>f.service.history('owner',f.scope.project_id,f.input.source_run_id,'../escape'),/work_publication_invalid/);
});
