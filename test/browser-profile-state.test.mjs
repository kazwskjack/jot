import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {assertBrowserProfileGeneration,browserProfileGeneration,initializeBrowserProfileState,revokeBrowserProfileGeneration} from '../src/browser-profile-state.mjs';

function fixture(t){const db=new DatabaseSync(':memory:');initializeBrowserProfileState(db);t.after(()=>db.close());return db;}

test('profile generation cannot adopt an existing profile or recreate a missing active profile',t=>{
 const db=fixture(t),ownerKey='a'.repeat(64);
 assert.throws(()=>browserProfileGeneration(db,ownerKey,true),/browser_profile_generation_unknown/);
 assert.equal(db.prepare('SELECT count(*) AS count FROM browser_profile_generations').get().count,0);
 assert.equal(browserProfileGeneration(db,ownerKey,false),1);
 assert.equal(browserProfileGeneration(db,ownerKey,true),1);
 assert.throws(()=>browserProfileGeneration(db,ownerKey,false),/browser_profile_generation_unknown/);
});

test('profile revoke CAS advances once and permanently denies the old generation',t=>{
 const db=fixture(t),ownerKey='b'.repeat(64);browserProfileGeneration(db,ownerKey,false);
 assert.deepEqual(revokeBrowserProfileGeneration(db,ownerKey,1),{generation:2,status:'revoked'});
 assert.throws(()=>revokeBrowserProfileGeneration(db,ownerKey,1),/browser_profile_generation_conflict/);
 assert.throws(()=>assertBrowserProfileGeneration(db,ownerKey,1),/browser_profile_revoked/);
 assert.throws(()=>browserProfileGeneration(db,ownerKey,true),/browser_profile_revoked/);
});
