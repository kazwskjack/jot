import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeReplayProfile} from '../native-replay-profile.js';

test('reviewed artifact continuity is deterministic, private and fails closed on drift',async t=>{
 const base=resolve('.test-tmp');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'replay-profile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'reviewed.js');writeFileSync(path,'reviewed source');let reviewed=true;
 const options={id:'task-profile',auditId:'review-v1',artifacts:[{id:'runtime',path,sha256:createHash('sha256').update('reviewed source').digest('hex')}],verifyComposition:async()=>({verified:reviewed})};
 const profile=createNativeReplayProfile(options),first=await profile.read();assert.deepEqual(await profile.read(),first);assert.equal(JSON.stringify(first).includes(root),false);
 const subject={id:'host-only-agent'},observed=[];const staged=createNativeReplayProfile({...options,verifyComposition:async request=>{observed.push({phase:request.phase,agent:request.agent});return {verified:true};}});
 assert.deepEqual(await staged.read({phase:'prepared',agent:subject}),await staged.read({phase:'bound',agent:subject}));assert.deepEqual(observed,[{phase:'prepared',agent:subject},{phase:'bound',agent:subject}]);await assert.rejects(staged.read({phase:'unknown'}),/phase_invalid/);
 await assert.rejects(profile.read({presetId:'different'}),/preset_changed/);reviewed=false;await assert.rejects(profile.read(),/unreviewed/);reviewed=true;
 const abort=new AbortController();abort.abort();await assert.rejects(profile.read({signal:abort.signal}));
 writeFileSync(path,'changed source');await assert.rejects(profile.read(),/source_changed/);
 assert.throws(()=>createNativeReplayProfile({...options,artifacts:[...options.artifacts,...options.artifacts]}),/config_invalid/);
});
