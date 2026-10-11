import test from 'node:test';
import assert from 'node:assert/strict';
import * as helper from './memory-form.mjs';
test('editing round-trips every source and expiry, preserves CAS, and isolates mutable form state',()=>{
 assert.equal(typeof helper.memoryFormFromMemory,'function');
 const memory={memory_id:'m',version:3,content:'Fact',verified:true,provenance:[{kind:'document',reference:'notes/a.md'},{kind:'url',reference:'https://example.invalid'}],source_revision:'rev-2',expires_at:'2026-10-03T04:00:00.000Z',supersedes:'old'};
 const form=helper.memoryFormFromMemory(memory);
 assert.deepEqual(helper.memoryInput(form,{scope:'private',agent_id:'a',lifecycle:true,editing:memory}),{scope:'private',agent_id:'a',content:'Fact',verified:true,expected_version:3,provenance:memory.provenance,source_revision:'rev-2',expires_at:'2026-10-03T04:00:00.000Z',supersedes:'old'});
 form.provenance[0].reference='changed';assert.equal(memory.provenance[0].reference,'notes/a.md');
 const blank=helper.blankMemoryForm();assert.equal(blank.content,'');assert.deepEqual(blank.provenance,[]);assert.equal(blank.expires_at,'');
});
test('new memory controls stay absent from old CRUD payload and timestamps require explicit timezone',()=>{
 assert.equal(typeof helper.memoryInput,'function');
 const form={content:' Fact ',verified:false,provenance:[{kind:'url',reference:'source'}],source_revision:'rev',expires_at:'2026-10-03T12:00:00+08:00',supersedes:''};
 assert.deepEqual(helper.memoryInput(form,{scope:'project',project_id:'p',lifecycle:false}),{scope:'project',project_id:'p',content:'Fact',verified:false});
 assert.equal(helper.memoryInput(form,{scope:'project',project_id:'p',lifecycle:true}).expires_at,'2026-10-03T04:00:00.000Z');
 assert.throws(()=>helper.memoryInput({...form,expires_at:'2026-10-03T12:00'},{scope:'project',project_id:'p',lifecycle:true}));
 assert.throws(()=>helper.memoryInput({...form,provenance:Array(21).fill({kind:'url',reference:'source'})},{scope:'project',project_id:'p',lifecycle:true}));
});
test('current scope query explicitly restricts private member or shared project and expiry view',()=>{
 assert.equal(typeof helper.memoryQuery,'function');
 assert.equal(helper.memoryQuery({scope:'private',agent_id:'a /1',project_id:'p',lifecycle:true,include_expired:true}),'?scope=private&agent_id=a+%2F1&include_expired=true');
 assert.equal(helper.memoryQuery({scope:'project',agent_id:'a',project_id:'p /1',lifecycle:true,include_expired:false}),'?scope=project&project_id=p+%2F1&include_expired=false');
 assert.equal(helper.memoryQuery({scope:'private',agent_id:'a',lifecycle:false}),'?agent_id=a');
 assert.equal(helper.memoryExpired({expires_at:'2026-10-03T04:00:00Z'},Date.parse('2026-10-03T04:00:00Z')),true);
});
test('expiry refuses impossible calendar dates and times before normalizing a valid explicit timezone',()=>{
 const options={scope:'project',project_id:'p',lifecycle:true};
 for(const expires_at of ['2026-02-30T12:00:00Z','2026-02-29T12:00:00Z','2100-02-29T12:00:00Z','2026-04-31T12:00:00Z','2026-13-01T12:00:00Z','2026-01-00T12:00:00Z','2026-10-03T24:00:00Z','2026-10-03T12:60:00Z','2026-10-03T12:00:60Z','2026-10-03T12:00:00+24:00','2026-10-03T12:00:00+08:60','2026-10-03T12:00:00z'])assert.throws(()=>helper.memoryInput({...helper.blankMemoryForm(),content:'Fact',expires_at},options),undefined,expires_at);
 assert.equal(helper.memoryInput({...helper.blankMemoryForm(),content:'Fact',expires_at:'2028-02-29T12:30:10+08:00'},options).expires_at,'2028-02-29T04:30:10.000Z');
 assert.equal(helper.memoryInput({...helper.blankMemoryForm(),content:'Fact',expires_at:'2000-02-29T12:30:10Z'},options).expires_at,'2000-02-29T12:30:10.000Z');
});
test('download creates scoped JSON Blob and revokes its object URL without external delivery',async()=>{
 assert.equal(typeof helper.downloadMemoryExport,'function');
 let blob,clicked=0,removed=0;const revoked=[];const anchor={click(){clicked++;},remove(){removed++;}};
 const env={document:{createElement(){return anchor;},body:{appendChild(){}}},URL:{createObjectURL(value){blob=value;return 'blob:local';},revokeObjectURL(value){revoked.push(value);}}};
 const value={schema_version:1,workspace_id:'ws',exported_at:'2026-10-02T00:00:00Z',items:[{memory_id:'m',scope:'private',agent_id:'a'}]};
 helper.downloadMemoryExport(value,{scope:'private',agent_id:'a'},env);
 assert.equal(blob.type,'application/json');assert.deepEqual(JSON.parse(await blob.text()),value);assert.equal(anchor.href,'blob:local');assert.match(anchor.download,/private.*\.json$/);assert.equal(clicked,1);assert.equal(removed,1);assert.deepEqual(revoked,['blob:local']);
 assert.throws(()=>helper.downloadMemoryExport({...value,items:[{memory_id:'other',scope:'private',agent_id:'b'}]},{scope:'private',agent_id:'a'},env));
});
