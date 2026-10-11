import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeNotificationPolicy,notificationQuietUntil} from '../../src/persistent-tasks/notification-policy.ts';
const policy=(start,end,timezone='Asia/Hong_Kong')=>normalizeNotificationPolicy({min_interval_seconds:60,max_per_24_hours:20,quiet_hours:{start,end,timezone}});
const seconds=iso=>Date.parse(iso)/1000;
test('quiet hours use inclusive start and exclusive end in the configured timezone',()=>{
 const q=policy('22:00','08:00');
 assert.equal(notificationQuietUntil(q,seconds('2026-10-03T13:59:59Z')),null);
 assert.equal(notificationQuietUntil(q,seconds('2026-10-03T14:00:00Z')),seconds('2026-10-04T00:00:00Z'));
 assert.equal(notificationQuietUntil(q,seconds('2026-10-04T00:00:00Z')),null);
 const day=policy('13:00','14:00');assert.equal(notificationQuietUntil(day,seconds('2026-10-03T05:12:00Z')),seconds('2026-10-03T06:00:00Z'));
});
test('repeated and missing local end times resolve using actual instants rather than a fixed offset',()=>{
 assert.equal(notificationQuietUntil(policy('22:00','01:30','America/New_York'),seconds('2026-11-01T06:10:00Z')),seconds('2026-11-01T06:30:00Z'));
 assert.equal(notificationQuietUntil(policy('22:00','02:30','America/New_York'),seconds('2026-03-08T06:59:00Z')),seconds('2026-03-08T07:00:00Z'));
});
test('quiet policy validation rejects injected fields and incomplete or unbounded controls',()=>{
 const base={min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null};
 for(const input of [{...base,recipient:'foreign'},{...base,min_interval_seconds:86401},{...base,max_per_24_hours:NaN},{...base,quiet_hours:{start:'22:00',end:'08:00',timezone:'UTC',recipient:'foreign'}},{...base,quiet_hours:undefined}])assert.throws(()=>normalizeNotificationPolicy(input),/invalid_task_notification_settings/);
 assert.equal(notificationQuietUntil(normalizeNotificationPolicy(base),seconds('2026-10-03T00:00:00Z')),null);
});
