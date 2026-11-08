export type MisfirePolicy = 'coalesce' | 'skip' | 'catch_up';
export function misfirePolicy(value:unknown):{missed_triggers?:MisfirePolicy}{
  if(value===undefined)return {};
  if(!['coalesce','skip','catch_up'].includes(String(value))||typeof value!=='string')throw new Error('invalid_missed_triggers');
  return {missed_triggers:value as MisfirePolicy};
}
export type CalendarTrigger = { kind: 'daily' | 'weekly'; time: string; timezone: string; weekdays?: number[]; missed_triggers?:MisfirePolicy };

const DAY = 86400000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let result = formatters.get(timezone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-US', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(timezone, result);
  }
  return result;
}

export function normalizeCalendarTrigger(input: unknown): CalendarTrigger {
  const value = input as Record<string, unknown> | null;
  if (!value || (value.kind !== 'daily' && value.kind !== 'weekly')) throw new Error('unsupported_trigger');
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('invalid_calendar_time');
  if (typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > 100 ||
    value.timezone.trim() !== value.timezone || /^[+-]/.test(value.timezone)) throw new Error('invalid_timezone');
  try { formatter(value.timezone); } catch { throw new Error('invalid_timezone'); }
  if (value.kind === 'daily') {
    if (value.weekdays !== undefined) throw new Error('invalid_weekdays');
    return { kind: 'daily', time: value.time, timezone: value.timezone,...misfirePolicy(value.missed_triggers) };
  }
  if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 100 ||
    value.weekdays.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('invalid_weekdays');
  return { kind: 'weekly', time: value.time, timezone: value.timezone, weekdays: [...new Set<number>(value.weekdays)].sort((a,b) => a-b),...misfirePolicy(value.missed_triggers) };
}

// Interpret local calendar fields as a UTC scalar solely for comparing wall times.
function wallTime(format: Intl.DateTimeFormat, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  const date = new Date(0);
  date.setUTCFullYear(parts.year!, parts.month!-1, parts.day!);
  date.setUTCHours(parts.hour!, parts.minute!, parts.second!, 0);
  return date.getTime();
}

function occurrenceOnDate(format: Intl.DateTimeFormat, wall: number): number | null {
  const offsetAt = (instant: number) => wallTime(format, instant) - instant;
  // Both sides of an IANA offset transition are sampled around the local date,
  // including half-hour changes and complete date-line skips. No fixed-offset
  // or one-hour-DST assumption is used when inverting the wall time.
  const samples: { instant: number; offset: number }[] = [];
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = wall + hours*3600000;
    samples.push({ instant, offset: offsetAt(instant) });
  }
  const matches = [...new Set(samples.map(sample => sample.offset))].map(offset => wall-offset)
    .filter(instant => wallTime(format, instant) === wall).sort((a,b) => a-b);
  // A repeated wall time always owns the earliest UTC instant on that date.
  if (matches.length) return matches[0]!;

  // For a gap, find the transition boundary to the second rather than adding
  // the gap duration (02:30 in a 02:00–03:00 gap becomes 03:00, not 03:30).
  for (let index = 1; index < samples.length; index++) {
    const before = samples[index-1]!; const after = samples[index]!;
    if (after.offset <= before.offset) continue;
    let low = before.instant/1000; let high = after.instant/1000;
    while (high-low > 1) {
      const mid = Math.floor((low+high)/2);
      if (offsetAt(mid*1000) === before.offset) low=mid; else high=mid;
    }
    const instant = high*1000; const local = wallTime(format, instant);
    if (wallTime(format, instant-1000) < wall && local >= wall && Math.floor(local/DAY) === Math.floor(wall/DAY)) return instant;
  }
  return null; // An entire skipped date has no occurrence.
}

/** First calendar occurrence at/after from, or strictly after it when inclusive=false. */
export function nextCalendarOccurrence(input: unknown, from: Date | string | number, inclusive = true): string {
  const trigger = normalizeCalendarTrigger(input);
  const anchor = from instanceof Date ? from.getTime() : typeof from === 'number' ? from : Date.parse(from);
  if (!Number.isFinite(anchor) || !Number.isFinite(new Date(anchor).getTime())) throw new Error('invalid_calendar_anchor');
  const format = formatter(trigger.timezone);
  const day = Math.floor(wallTime(format, anchor)/DAY)*DAY;
  const [hour, minute] = trigger.time.split(':').map(Number);
  // A weekly rule finds a date within a week; the extra horizon accommodates
  // skipped dates and deliberately bounds work for malformed runtime dates.
  for (let days = 0; days < 370; days++) {
    const localDay = day+days*DAY;
    if (trigger.kind === 'weekly' && !trigger.weekdays!.includes(new Date(localDay).getUTCDay())) continue;
    const occurrence = occurrenceOnDate(format, localDay+hour!*3600000+minute!*60000);
    if (occurrence !== null && (inclusive ? occurrence >= anchor : occurrence > anchor)) return new Date(occurrence).toISOString();
  }
  throw new Error('calendar_occurrence_not_found');
}

export type CronTrigger = { kind: 'cron'; expression: string; timezone: string; missed_triggers?:MisfirePolicy };
type CronField = { values: number[]; wildcard: boolean };
type ParsedCron = { minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField };

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const WEEKDAY_ALIASES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};
const invalidCron = () => new Error('invalid_cron_expression');

function cronNumber(token: string, minimum: number, maximum: number, aliases: Record<string, number> = {}): number {
  const alias = aliases[token];
  if (alias !== undefined) return alias;
  if (!/^\d+$/.test(token)) throw invalidCron();
  const number = Number(token);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw invalidCron();
  return number;
}

function cronField(source: string, minimum: number, maximum: number, aliases: Record<string, number> = {}, weekday = false): CronField {
  const selected = new Set<number>();
  const parts = source.split(',');
  if (!parts.length || parts.some(part => !part)) throw invalidCron();
  for (const part of parts) {
    const division = part.split('/');
    if (division.length > 2 || !division[0] || (division.length === 2 && !/^\d+$/.test(division[1]!))) throw invalidCron();
    const step = division.length === 2 ? Number(division[1]) : 1;
    if (!Number.isSafeInteger(step) || step < 1) throw invalidCron();

    const base = division[0]!.toUpperCase();
    let first: number;
    let last: number;
    if (base === '*') {
      first = minimum;
      last = maximum;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2 || !range[0] || !range[1]) throw invalidCron();
      first = cronNumber(range[0], minimum, maximum, aliases);
      last = cronNumber(range[1], minimum, maximum, aliases);
      if (last < first) throw invalidCron();
    } else {
      first = cronNumber(base, minimum, maximum, aliases);
      last = division.length === 2 ? maximum : first;
    }
    for (let value = first; value <= last; value += step) {
      selected.add(weekday && value === 7 ? 0 : value);
    }
  }

  const values = [...selected].sort((a, b) => a - b);
  return { values, wildcard: source.toUpperCase() === '*' };
}

function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.split(' ');
  if (fields.length !== 5 || fields.some(field => !field)) throw invalidCron();
  return {
    minute: cronField(fields[0]!, 0, 59),
    hour: cronField(fields[1]!, 0, 23),
    day: cronField(fields[2]!, 1, 31),
    month: cronField(fields[3]!, 1, 12, MONTH_ALIASES),
    weekday: cronField(fields[4]!, 0, 7, WEEKDAY_ALIASES, true),
  };
}

export function normalizeCronTrigger(input: unknown): CronTrigger {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'cron' ||
    Object.keys(value).some(key => !['kind', 'expression', 'timezone','missed_triggers'].includes(key))) throw invalidCron();
  if (typeof value.expression !== 'string' || !value.expression.trim() || value.expression.length > 120) throw invalidCron();
  if (typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > 100 ||
    value.timezone.trim() !== value.timezone || /^[+-]/.test(value.timezone)) throw new Error('invalid_timezone');
  try { formatter(value.timezone); } catch { throw new Error('invalid_timezone'); }
  const expression = value.expression.trim().split(/\s+/).map(field => field.toUpperCase()).join(' ');
  parseCronExpression(expression);
  return { kind: 'cron', expression, timezone: value.timezone,...misfirePolicy(value.missed_triggers) };
}

/** First matching five-field Cron instant at/after from, or strictly after it. */
export function nextCronOccurrence(input: unknown, from: Date | string | number, inclusive = true): string {
  const trigger = normalizeCronTrigger(input);
  const anchor = from instanceof Date ? from.getTime() : typeof from === 'number' ? from : Date.parse(from);
  if (!Number.isFinite(anchor) || !Number.isFinite(new Date(anchor).getTime())) throw new Error('invalid_cron_anchor');

  const fields = parseCronExpression(trigger.expression);
  const format = formatter(trigger.timezone);
  const localNow = wallTime(format, anchor);
  const firstDay = Math.floor(localNow / DAY) * DAY;
  // Eight years covers the longest Gregorian leap-day interval (including 2100).
  for (let days = 0; days < 8 * 366; days++) {
    const localDay = firstDay + days * DAY;
    const date = new Date(localDay);
    const dayOfMonth = date.getUTCDate();
    const month = date.getUTCMonth() + 1;
    const dayOfWeek = date.getUTCDay();
    if (!fields.month.values.includes(month)) continue;

    const monthDayMatches = fields.day.values.includes(dayOfMonth);
    const weekdayMatches = fields.weekday.values.includes(dayOfWeek);
    const calendarDayMatches = fields.day.wildcard && fields.weekday.wildcard
      ? true
      : fields.day.wildcard
        ? weekdayMatches
        : fields.weekday.wildcard
          ? monthDayMatches
          : monthDayMatches || weekdayMatches;
    if (!calendarDayMatches) continue;

    for (const hour of fields.hour.values) {
      for (const minute of fields.minute.values) {
        const wall = localDay + hour * 3600000 + minute * 60000;
        if (days === 0 && wall < localNow) continue;
        const instant = occurrenceOnDate(format, wall);
        if (instant === null || (inclusive ? instant < anchor : instant <= anchor)) continue;
        return new Date(instant).toISOString();
      }
    }
  }
  throw new Error('cron_occurrence_not_found');
}
