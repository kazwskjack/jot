import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';

test('Matrix consumed proof recovers read-only after durable reopen beyond TTL; foreign and pending proofs stay refused',t=>{
 const parent=resolve('.test-tmp/matrix-consumed-ttl');mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,'case-')),path=join(root,'db.sqlite');let db=openProductDatabase(path),now=1000;
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const make=()=>new OwnerChannelBindings(db,{enabled:['matrix','wecom'],now:()=>now});
 let bindings=make();const principal='@alice:example.org',context={provider_thread_id:'!original:example.org'};
 const accepted=bindings.create('alice','matrix'),pending=bindings.create('bob','matrix'),foreign=bindings.create('alice','wecom');
 const receipt=bindings.acceptProof('matrix',principal,accepted.code,context);
 const frozen=JSON.stringify(db.prepare('SELECT * FROM ga_owner_channel_challenges ORDER BY challenge_id').all());
 db.close();now=1601;db=openProductDatabase(path);bindings=make();
 const changes=()=>Number(db.prepare('SELECT total_changes() n').get().n),before=changes();
 for(let n=0;n<2;n++)assert.deepEqual(bindings.acceptProof('matrix',principal,accepted.code,context),receipt);
 for(const [who,code,room] of [
  ['@mallory:example.org',accepted.code,context],
  [principal,accepted.code,{provider_thread_id:'!foreign:example.org'}],
  [principal,foreign.code,context],
  [principal,pending.code,context],
  [principal,'A'.repeat(43),context]
 ])assert.throws(()=>bindings.acceptProof('matrix',who,code,room),/channel_binding_proof_invalid/);
 assert.equal(changes(),before,'recovery and refusals do not consume or dispatch');
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM ga_owner_channel_challenges ORDER BY challenge_id').all()),frozen);
 assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings').get().n),1);
 assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_runs').get().n),0);
 bindings.revoke('alice',accepted.channel_binding_id,1);
 assert.throws(()=>bindings.acceptProof('matrix',principal,accepted.code,context),/channel_binding_proof_invalid/);
});
