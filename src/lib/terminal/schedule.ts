// Pipeline schedules (Terminal): checking a schedule and finding when it next
// runs, in the schedule's time zone. Shared by the app (which stores the first
// next run) and the worker (which moves it on after each run).
//
//   interval  { minutes: 5..1440 }                 every N minutes
//   daily     { at: 'HH:MM' }
//   weekly    { days: [0..6] (0 = Sunday), at }
//   monthly   { day: 1..31, at }                    a short month runs on its last day
//   cron      { expr: 'm h dom mon dow' }           five fields: * , - / and numbers

export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'monthly' | 'cron';

export interface Schedule {
  kind: ScheduleKind;
  spec: Record<string, unknown>;
  timezone: string;
}

export type ScheduleProblem = 'kind' | 'interval' | 'time' | 'days' | 'day' | 'cron' | 'timezone';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface Matcher {
  minutes: Set<number>;
  hours: Set<number>;
  /** Days of the month; `lastDayFor` lets 31 mean the last day of a short month. */
  dom: Set<number> | null;
  months: Set<number>;
  dow: Set<number> | null;
  lastDayFor?: number;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function cronField(text: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === '*' ? min : Number(m[2]);
    const to = m[1] === '*' ? max : m[3] ? Number(m[3]) : m[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size ? out : null;
}

function matcherOf(schedule: Schedule): Matcher | ScheduleProblem {
  const { kind, spec } = schedule;
  const at = typeof spec.at === 'string' ? TIME.exec(spec.at) : null;
  const daily = at ? { minutes: new Set([Number(at[2])]), hours: new Set([Number(at[1])]) } : null;
  const anyMonth = new Set(range(1, 12));
  switch (kind) {
    case 'daily':
      return daily ? { ...daily, dom: null, months: anyMonth, dow: null } : 'time';
    case 'weekly': {
      if (!daily) return 'time';
      const days = Array.isArray(spec.days) ? spec.days : [];
      if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
        return 'days';
      return { ...daily, dom: null, months: anyMonth, dow: new Set(days as number[]) };
    }
    case 'monthly': {
      if (!daily) return 'time';
      const day = spec.day;
      if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) return 'day';
      return {
        ...daily,
        dom: new Set([day as number]),
        months: anyMonth,
        dow: null,
        lastDayFor: day as number,
      };
    }
    case 'cron': {
      const fields = typeof spec.expr === 'string' ? spec.expr.trim().split(/\s+/) : [];
      if (fields.length !== 5) return 'cron';
      const minutes = cronField(fields[0], 0, 59);
      const hours = cronField(fields[1], 0, 23);
      const dom = fields[2] === '*' ? null : cronField(fields[2], 1, 31);
      const months = cronField(fields[3], 1, 12);
      const dow = fields[4] === '*' ? null : cronField(fields[4].replace(/7/g, '0'), 0, 6);
      if (
        !minutes ||
        !hours ||
        !months ||
        (fields[2] !== '*' && !dom) ||
        (fields[4] !== '*' && !dow)
      )
        return 'cron';
      // At most every 5 minutes, like the interval schedule.
      const sorted = [...minutes].sort((a, b) => a - b);
      const gaps = sorted.map((m, i) =>
        i ? m - sorted[i - 1] : m + 60 - sorted[sorted.length - 1]
      );
      if (hours.size > 0 && sorted.length > 1 && Math.min(...gaps) < 5) return 'cron';
      return { minutes, hours, dom, months, dow };
    }
    default:
      return 'kind';
  }
}

function validZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Why a schedule is not valid, or null. */
export function scheduleProblem(schedule: Schedule): ScheduleProblem | null {
  if (!validZone(schedule.timezone)) return 'timezone';
  if (schedule.kind === 'interval') {
    const n = schedule.spec.minutes;
    return Number.isInteger(n) && (n as number) >= 5 && (n as number) <= 1440 ? null : 'interval';
  }
  const m = matcherOf(schedule);
  return typeof m === 'string' ? m : null;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(at: Date, timezone: string): LocalParts {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timezone, f);
  }
  const get = (type: string) => f!.formatToParts(at).find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

function dayMatches(m: Matcher, p: LocalParts): boolean {
  if (!m.months.has(p.month)) return false;
  let dom = m.dom ? m.dom.has(p.day) : true;
  if (m.lastDayFor && !dom) dom = p.day === daysInMonth(p.year, p.month) && m.lastDayFor > p.day;
  const dow = m.dow ? m.dow.has(p.weekday) : true;
  // As in cron: with both day fields restricted, either may match.
  if (m.dom && m.dow) return dom || dow;
  return dom && dow;
}

const MINUTE = 60_000;

/** The first run strictly after `after`, or null if none within about a year. */
export function nextRun(schedule: Schedule, after: Date = new Date()): Date | null {
  if (scheduleProblem(schedule)) return null;
  if (schedule.kind === 'interval') {
    return new Date(
      Math.floor(after.getTime() / MINUTE) * MINUTE + (schedule.spec.minutes as number) * MINUTE
    );
  }
  const m = matcherOf(schedule) as Matcher;
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = t + 400 * 86_400_000;
  while (t < end) {
    const p = localParts(new Date(t), schedule.timezone);
    if (!dayMatches(m, p)) {
      // To the next local midnight.
      t += ((23 - p.hour) * 60 + (60 - p.minute)) * MINUTE;
      continue;
    }
    if (!m.hours.has(p.hour)) {
      t += (60 - p.minute) * MINUTE;
      continue;
    }
    if (!m.minutes.has(p.minute)) {
      t += MINUTE;
      continue;
    }
    return new Date(t);
  }
  return null;
}
