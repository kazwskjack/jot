import assert from 'node:assert/strict';
import test from 'node:test';

const calendar = await import('../../src/persistent-tasks/calendar.ts');
function next(trigger, from, inclusive = true) {
  assert.equal(typeof calendar.nextCalendarOccurrence, 'function', 'calendar calculator must be exported');
  return calendar.nextCalendarOccurrence(trigger, from, inclusive);
}
const daily = (time, timezone) => ({ kind: 'daily', time, timezone });

test('calendar trigger validation normalizes weekly days and rejects ambiguous inputs', () => {
  assert.equal(typeof calendar.normalizeCalendarTrigger, 'function');
  const normalize = calendar.normalizeCalendarTrigger;
  assert.deepEqual(normalize({ kind:'weekly', time:'09:05', timezone:'Asia/Hong_Kong', weekdays:[5,1,5] }),
    { kind:'weekly', time:'09:05', timezone:'Asia/Hong_Kong', weekdays:[1,5] });
  for (const time of [undefined,'9:05','24:00','12:60','12:00:00',1200]) assert.throws(() => normalize(daily(time,'UTC')), /invalid_calendar_time/);
  for (const timezone of [undefined,'','Mars/Olympus','+05:45',' UTC ']) assert.throws(() => normalize(daily('09:00',timezone)), /invalid_timezone/);
  for (const weekdays of [undefined,[],[7],[-1],[1.5],['1']]) assert.throws(() => normalize({kind:'weekly',time:'09:00',timezone:'UTC',weekdays}), /invalid_weekdays/);
  assert.throws(() => normalize({...daily('09:00','UTC'),weekdays:[1]}), /invalid_weekdays/);
});

test('calendar first due is inclusive and advancement is strictly after now', () => {
  const trigger = daily('08:00','Asia/Hong_Kong');
  assert.equal(next(trigger,'2026-10-01T00:00:00Z'),'2026-10-01T00:00:00.000Z');
  assert.equal(next(trigger,'2026-10-01T00:00:00Z',false),'2026-10-02T00:00:00.000Z');
  assert.equal(next(trigger,'2026-10-01T00:00:00.001Z'),'2026-10-02T00:00:00.000Z');
});

test('weekly weekdays use the local date across a UTC year boundary', () => {
  assert.equal(next({kind:'weekly',time:'00:15',timezone:'Pacific/Kiritimati',weekdays:[5]},'2026-12-31T09:00:00Z'),
    '2026-12-31T10:15:00.000Z');
});

test('spring gap shifts to the first valid local instant on that date', () => {
  assert.equal(next(daily('02:30','America/New_York'),'2026-03-08T00:00:00Z'),'2026-03-08T07:00:00.000Z');
  assert.equal(next(daily('02:30','America/New_York'),'2026-03-08T07:00:00Z',false),'2026-03-09T06:30:00.000Z');
});

test('fall fold chooses only the first local occurrence even when now lies between duplicates', () => {
  const trigger = daily('01:30','America/New_York');
  assert.equal(next(trigger,'2026-11-01T00:00:00Z'),'2026-11-01T05:30:00.000Z');
  assert.equal(next(trigger,'2026-11-01T05:45:00Z'),'2026-11-02T06:30:00.000Z');
});

test('calendar handles quarter hour offsets and half hour DST changes', () => {
  assert.equal(next(daily('09:00','Asia/Kathmandu'),'2026-10-01T00:00:00Z'),'2026-10-01T03:15:00.000Z');
  assert.equal(next(daily('09:00','Pacific/Chatham'),'2026-09-30T12:00:00Z'),'2026-09-30T19:15:00.000Z');
  assert.equal(next(daily('02:15','Australia/Lord_Howe'),'2026-10-03T12:00:00Z'),'2026-10-03T15:30:00.000Z');
  assert.equal(next(daily('01:45','Australia/Lord_Howe'),'2026-04-04T12:00:00Z'),'2026-04-04T14:45:00.000Z');
  assert.equal(next(daily('01:45','Australia/Lord_Howe'),'2026-04-04T15:00:00Z'),'2026-04-05T15:15:00.000Z');
});

test('an entirely skipped local date advances to the next valid matching date', () => {
  assert.equal(next(daily('12:00','Pacific/Apia'),'2011-12-30T00:00:00Z'),'2011-12-30T22:00:00.000Z');
  assert.equal(next({kind:'weekly',time:'12:00',timezone:'Pacific/Apia',weekdays:[5]},'2011-12-30T00:00:00Z'),
    '2012-01-05T22:00:00.000Z');
});

test('invalid calendar anchor fails explicitly', () => {
  assert.throws(() => next(daily('09:00','UTC'),'invalid'), /invalid_calendar_anchor/);
});
