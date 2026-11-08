import test from 'node:test';
import assert from 'node:assert/strict';

const calendar = await import('../../src/persistent-tasks/calendar.ts');

const trigger = (expression, timezone = 'UTC') => ({ kind: 'cron', expression, timezone });
function next(expression, from, inclusive = true, timezone = 'UTC') {
  assert.equal(typeof calendar.nextCronOccurrence, 'function', 'Cron next-occurrence calculation must exist');
  return calendar.nextCronOccurrence(trigger(expression, timezone), from, inclusive);
}

test('Cron trigger normalizes whitespace and case-insensitive month and weekday aliases', () => {
  assert.equal(typeof calendar.normalizeCronTrigger, 'function', 'Cron trigger validation must exist');
  assert.deepEqual(calendar.normalizeCronTrigger(trigger('  5   9-17/2  1,15  jan-mar  mon-fri  ')), {
    kind: 'cron', expression: '5 9-17/2 1,15 JAN-MAR MON-FRI', timezone: 'UTC'
  });
});

test('Cron next occurrence can be inclusive at the exact minute or strictly later', () => {
  assert.equal(next('0 9 * * *', '2026-01-05T09:00:00.000Z'), '2026-01-05T09:00:00.000Z');
  assert.equal(next('0 9 * * *', '2026-01-05T09:00:00.000Z', false), '2026-01-06T09:00:00.000Z');
});

test('Cron Sunday accepts both zero and seven', () => {
  assert.equal(next('0 0 * * 0', '2026-01-05T00:00:00.000Z'), '2026-01-11T00:00:00.000Z');
  assert.equal(next('0 0 * * 7', '2026-01-05T00:00:00.000Z'), '2026-01-11T00:00:00.000Z');
});

test('Cron lists, ranges, steps and aliases select the next matching local minute', () => {
  assert.equal(next('15,45 8-10/2 * jan,mar mon-fri', '2026-01-05T08:50:00.000Z'),
    '2026-01-05T10:15:00.000Z');
});

test('restricted day-of-month and weekday fields match with OR semantics', () => {
  assert.equal(next('0 0 1 * MON', '2026-01-06T00:00:00.000Z'), '2026-01-12T00:00:00.000Z');
  // Full-range syntax remains a restricted field; both restricted fields are ORed.
  assert.equal(next('0 0 1-31 * MON', '2026-01-06T00:00:00.000Z'), '2026-01-06T00:00:00.000Z');
});

test('Cron leap-day schedules advance to the next valid leap year', () => {
  assert.equal(next('0 9 29 FEB *', '2025-03-01T00:00:00.000Z'), '2028-02-29T09:00:00.000Z');
});

test('Cron spring-gap times move to the first valid wall instant on that date', () => {
  assert.equal(next('30 2 * * *', '2026-03-08T05:00:00.000Z', true, 'America/New_York'),
    '2026-03-08T07:00:00.000Z');
});

test('Cron fall-fold times choose the first instant and do not replay the second after restart', () => {
  assert.equal(next('30 1 * * *', '2026-11-01T05:45:00.000Z', true, 'America/New_York'),
    '2026-11-02T06:30:00.000Z');
});

test('Cron rejects invalid field count, values, ranges, steps, aliases and extensions', () => {
  assert.equal(typeof calendar.normalizeCronTrigger, 'function', 'Cron trigger validation must exist');
  assert.throws(() => calendar.normalizeCronTrigger({ ...trigger('0 9 * * *'), extra: 'reject' }), /invalid_cron_expression/);
  for (const expression of [
    '* * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *',
    '0 0 * * 8', '*/0 * * * *', '9-1 * * * *', '0 0 ? * MON', '@daily',
    '0 0 31 FEB * extra'
  ]) assert.throws(() => calendar.normalizeCronTrigger(trigger(expression)), /invalid_cron_expression/);
});

test('Cron rejects invalid IANA zones and invalid anchors explicitly', () => {
  assert.equal(typeof calendar.normalizeCronTrigger, 'function', 'Cron trigger validation must exist');
  assert.equal(typeof calendar.nextCronOccurrence, 'function', 'Cron next-occurrence calculation must exist');
  assert.throws(() => calendar.normalizeCronTrigger(trigger('0 9 * * *', 'Mars/Olympus')), /invalid_timezone/);
  assert.throws(() => next('0 9 * * *', 'not-a-date'), /invalid_cron_anchor/);
});

test('a calendar-impossible Cron date fails within the bounded search horizon', () => {
  assert.equal(typeof calendar.nextCronOccurrence, 'function', 'Cron next-occurrence calculation must exist');
  assert.throws(() => next('0 0 31 FEB *', '2026-01-01T00:00:00.000Z'), /cron_occurrence_not_found/);
});
