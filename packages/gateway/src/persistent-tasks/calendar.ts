export type CalendarTrigger = { kind: 'daily' | 'weekly'; time: string; timezone: string; weekdays?: number[] };

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
    return { kind: 'daily', time: value.time, timezone: value.timezone };
  }
  if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 100 ||
    value.weekdays.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('invalid_weekdays');
  return { kind: 'weekly', time: value.time, timezone: value.timezone, weekdays: [...new Set<number>(value.weekdays)].sort((a,b) => a-b) };
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
