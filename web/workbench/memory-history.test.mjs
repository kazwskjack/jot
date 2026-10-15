import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryRestoreReason,memoryRestoreInput} from './memory-history.mjs';
const memory={memory_id:'memory-example',version:3,status:'active',expires_at:null};
const version={version:1,status:'active',expires_at:null};

test('restoration UI requires a prior active unexpired revision and the same current version',()=>{
 assert.equal(memoryRestoreReason(memory,version,3),'');
 assert.match(memoryRestoreReason(memory,version,4),/更新/);
 for(const changed of [{...version,version:3},{...version,version:4},{...version,status:'deleted'},{...version,status:'superseded'},{...version,expires_at:'2020-01-01T00:00:00Z'}])assert.notEqual(memoryRestoreReason(memory,changed,3),'');
 for(const changed of [{...memory,status:'deleted'},{...memory,status:'superseded'},{...memory,expires_at:'2020-01-01T00:00:00Z'}])assert.notEqual(memoryRestoreReason(changed,version,3),'');
});

test('restore input includes only original CAS and source versions, never historical verification or authority',()=>{
 assert.deepEqual(memoryRestoreInput({...memory,owner_id:'do-not-send'}, {...version,verified:true},3),{expected_version:3,source_version:1});
 assert.throws(()=>memoryRestoreInput(memory,version,4),/更新/);
});
