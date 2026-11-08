import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {requireVerifiedChannelThread} from '../../src/channels/authority-proofs.ts';
test('Matrix authority rejects foreign rooms, owners and principals; other channels unchanged',()=>{
 const db=new DatabaseSync(':memory:');
 try {
 db.exec("CREATE TABLE ga_owner_matrix_binding_rooms(channel_binding_id,owner_id,principal,room_id); INSERT INTO ga_owner_matrix_binding_rooms VALUES('b','o','p','r'); BEGIN");
 const b={channel:'matrix',channel_binding_id:'b',owner_id:'o',principal:'p',version:1};
 assert.doesNotThrow(()=>requireVerifiedChannelThread(db,b,'r'));
 for(const room of ['','foreign'])assert.throws(()=>requireVerifiedChannelThread(db,b,room),/channel_authority_binding_invalid/);
 for(const change of [{owner_id:'foreign'},{principal:'foreign'},{channel_binding_id:'foreign'}])assert.throws(()=>requireVerifiedChannelThread(db,{...b,...change},'r'),/channel_authority_binding_invalid/);
 assert.doesNotThrow(()=>requireVerifiedChannelThread(db,{...b,channel:'telegram'},''));
 db.exec('ROLLBACK');
 assert.throws(()=>requireVerifiedChannelThread(db,b,'r'),/channel_authority_transaction_required/);
 }finally{db.close();}
});
