import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';import {join,resolve} from 'node:path';
import {createNativeReplayProvenance} from '../native-replay-provenance.js';
test('host provenance is write-once, creation-scoped and outside the conversation log',async t=>{
 const base=resolve('.test-tmp');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'replay-provenance-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const provenance=createNativeReplayProvenance({root}),session={id:'session',header:{createdAt:1234}},stamp={protocol:1,fingerprint:'a'.repeat(64)};
 await assert.rejects(provenance.read(session));await provenance.create(session,stamp);assert.deepEqual(await provenance.read(session),stamp);await provenance.create(session,stamp);
 await assert.rejects(provenance.create(session,{...stamp,fingerprint:'b'.repeat(64)}),/conflict/);assert.deepEqual(await provenance.read(session),stamp);
 const newIncarnation={...session,header:{createdAt:1235}};await assert.rejects(provenance.read(newIncarnation));await provenance.create(newIncarnation,{...stamp,fingerprint:'c'.repeat(64)});assert.deepEqual(await provenance.read(session),stamp);await assert.rejects(provenance.read({id:'../escape',header:session.header}),/scope_invalid/);
 const signal=AbortSignal.abort();await assert.rejects(provenance.create(session,stamp,{signal}));
 const longest={id:'s'.repeat(191),header:session.header};await provenance.create(longest,stamp);assert.deepEqual(await provenance.read(longest),stamp);
 // A crash orphan is not a published record and cannot poison a future create.
 writeFileSync(join(root,'.pending-orphan-fixture'),'{');const concurrent={id:'concurrent',header:session.header};await Promise.all([provenance.create(concurrent,stamp),provenance.create(concurrent,stamp)]);assert.deepEqual(await provenance.read(concurrent),stamp);assert.deepEqual(readdirSync(root).filter(name=>name.startsWith('.pending-')),['.pending-orphan-fixture']);
});
