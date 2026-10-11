import test from 'node:test';import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {normalizeExecutionLease,assertExecutionLease} from '../../src/workbench/execution-lease.ts';
function fixture(){const db=openProductDatabase(':memory:');db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run('run-1','worker-1',3,'2000','now');return db;}
test('execution fence is frozen, strict and cannot coerce another worker generation',()=>{
 const input={owner:'worker-1',generation:3};const lease=normalizeExecutionLease(input);input.generation=4;assert.equal(lease.generation,3);assert.ok(Object.isFrozen(lease));
 for(const value of [undefined,null,[],{}, {owner:'worker-1',generation:'3'},{owner:'worker-1',generation:0},{owner:'worker-1',generation:NaN},{owner:'worker-1',generation:3,renew:true},{owner:'',generation:3}])assert.throws(()=>normalizeExecutionLease(value),/workbench_execution_lease_revoked/);
});
test('native execution compares the original fence without acquiring or renewing a lease',()=>{
 const db=fixture();try{const original=normalizeExecutionLease({owner:'worker-1',generation:3});assertExecutionLease(db,'run-1',original,()=>1000);db.prepare('UPDATE ga_worker_leases SET generation=4').run();assert.throws(()=>assertExecutionLease(db,'run-1',original,()=>1000),/workbench_execution_lease_revoked/);assert.equal(db.prepare('SELECT generation FROM ga_worker_leases').get().generation,4);}finally{db.close()}
});
test('owner changes, missing rows, expired and malformed expiry fail closed',()=>{
 const db=fixture();try{const lease=normalizeExecutionLease({owner:'worker-1',generation:3});assert.throws(()=>assertExecutionLease(db,'unknown',lease,()=>1000));assert.throws(()=>assertExecutionLease(db,'run-1',lease,()=>2000));db.prepare("UPDATE ga_worker_leases SET expires_at='not-a-time'").run();assert.throws(()=>assertExecutionLease(db,'run-1',lease,()=>1000));db.prepare("UPDATE ga_worker_leases SET expires_at='2000',owner='worker-2'").run();assert.throws(()=>assertExecutionLease(db,'run-1',lease,()=>1000));}finally{db.close()}
});
