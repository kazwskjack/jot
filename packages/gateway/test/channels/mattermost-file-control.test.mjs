import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './fixtures/mattermost-file-test-support.mjs';
import {proveMattermostAttachmentObservation} from '../../src/channels/mattermost-attachment-control.ts';

test('original file observation schema and proof reject mutable, foreign, malformed or oversized custody',async t=>{
 const f=await setup(t);await f.start();await f.emit();f.post={...f.post,id:'file-post',message:'Read file',file_ids:['provider-file']};await f.emit();
 const db=f.product.db,row=db.prepare('SELECT * FROM ga_mattermost_attachment_observations').get();assert.ok(row);
 const account={instance:'https://chat.example.test',botUserId:'bot-account'};
 assert.equal(proveMattermostAttachmentObservation(db,account,row).event.message_id,'file-post');
 for(const changed of [{owner_id:'mallory'},{binding_version:2},{source_sha256:'0'.repeat(64)},{source_json:row.source_json+' '},{source_json:'x'.repeat(65537)}])assert.throws(()=>proveMattermostAttachmentObservation(db,account,{...row,...changed}));
 assert.throws(()=>db.prepare("UPDATE ga_mattermost_attachment_observations SET owner_id='mallory'").run(),/mattermost_source_immutable/);
 assert.throws(()=>db.prepare('DELETE FROM ga_mattermost_attachment_observations').run(),/mattermost_source_immutable/);
 const keys=Object.keys(row),insert=db.prepare('INSERT INTO ga_mattermost_attachment_observations('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')');
 for(const changed of [{source_sha256:Buffer.alloc(64,97)},{source_sha256:'A'.repeat(64)},{source_json:'"'+'x'.repeat(65537)+'"'},{binding_version:0},{created_at:-1},{channel_binding_id:'foreign-binding'}])assert.throws(()=>insert.run(...keys.map(key=>({...row,post_id:'invalid-post',...changed})[key])));
 assert.deepEqual(db.prepare('SELECT * FROM ga_mattermost_attachment_observations').get(),row);
});
