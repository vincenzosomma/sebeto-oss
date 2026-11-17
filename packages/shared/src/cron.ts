/**
 * A small 5-field cron parser in local time (docs/28 v0.4 Plan.md §D, scheduled tasks).
 *
 *   minute hour day-of-month month day-of-week
 *   "0 8 * * 1"      Mondays at 08:00
 *   "*\/15 * * * *"   every 15 minutes
 *   "0 9 1 * *"      the first day of every month at 09:00
 *   "30 7 * * 1-5"   weekdays at 07:30
 *
 * Supports `*`, lists `a,b`, ranges `a-b`, steps `*\/n`, `a-b/n`, `a/n`, month names (JAN…DEC) and
 * day names (SUN…SAT); day-of-week 7 is Sunday too. Like classic cron, when BOTH day-of-month and
 * day-of-week are restricted, a day matches when EITHER matches.
 */

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day-of-month field was '*' (unrestricted). */
  anyDay: boolean;
  /** Day-of-week field was '*' (unrestricted). */
  anyWeekday: boolean;
  source: string;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldDef { name: string; min: number; max: number; names?: string[]; namesBase?: number }
const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, namesBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, namesBase: 0 },
];

function parseValue(raw: string, def: FieldDef): number {
  const up = raw.toUpperCase();
  if (def.names) {
    const i = def.names.indexOf(up);
    if (i >= 0) return i + (def.namesBase ?? 0);
  }
  if (!/^\d{1,2}$/.test(raw)) throw new CronError(`"${raw}" is not a valid ${def.name}`);
  const n = Number(raw);
  if (n < def.min || n > def.max) throw new CronError(`${def.name} must be between ${def.min} and ${def.max} (got ${n})`);
  return n;
}

function parseField(text: string, def: FieldDef): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`Empty item in the ${def.name} field`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`"${part}" has more than one "/"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d{1,2}$/.test(stepPart) || Number(stepPart) < 1) throw new CronError(`"${stepPart}" is not a valid step`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = def.min;
      hi = def.max === 7 ? 6 : def.max;
    } else if (rangePart!.includes('-')) {
      const [a, b, more] = rangePart!.split('-');
      if (more !== undefined || !a || !b) throw new CronError(`"${rangePart}" is not a valid range`);
      lo = parseValue(a, def);
      hi = parseValue(b, def);
      if (lo > hi) throw new CronError(`The range "${rangePart}" goes backwards`);
    } else {
      lo = parseValue(rangePart!, def);
      // "a/n" means from a to the end of the field.
      hi = stepPart !== undefined ? (def.max === 7 ? 6 : def.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(def.max === 7 && v === 7 ? 0 : v);
  }
  return out;
}

/** Parse a 5-field cron expression; throws CronError with a plain-language message. */
export function parseCron(expr: string): CronSpec {
  const source = expr.trim().replace(/\s+/g, ' ');
  const fields = source.split(' ');
  if (fields.length !== 5 || !source) throw new CronError('A schedule needs 5 parts: minute hour day month weekday (e.g. "0 8 * * 1")');
  const [mi, ho, dm, mo, dw] = fields as [string, string, string, string, string];
  return {
    minutes: parseField(mi, FIELDS[0]!),
    hours: parseField(ho, FIELDS[1]!),
    days: parseField(dm, FIELDS[2]!),
    months: parseField(mo, FIELDS[3]!),
    weekdays: parseField(dw, FIELDS[4]!),
    anyDay: dm === '*',
    anyWeekday: dw === '*',
    source,
  };
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  const dom = spec.days.has(d.getDate());
  const dow = spec.weekdays.has(d.getDay());
  if (spec.anyDay && spec.anyWeekday) return true;
  if (spec.anyDay) return dow;
  if (spec.anyWeekday) return dom;
  return dom || dow;
}

/** Search horizon: 5 years covers Feb 29 and every other valid expression. */
const HORIZON_MS = 5 * 366 * 24 * 60 * 60_000;

/**
 * The first time strictly after `after` (local time, whole minutes) that matches, or null when the
 * expression never matches (e.g. "0 0 31 2 *").
 */
export function nextRun(spec: CronSpec, after: Date): Date | null {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + HORIZON_MS;
  while (d.getTime() <= limit) {
    if (!spec.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

/** The next `count` runs after `after`. */
export function nextRuns(spec: CronSpec, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let cur: Date | null = after;
  while (out.length < count && cur) {
    cur = nextRun(spec, cur);
    if (cur) out.push(cur);
  }
  return out;
}

/** Validation helper: null when valid, else the reason. */
export function cronProblem(expr: string): string | null {
  try {
    const spec = parseCron(expr);
    if (!nextRun(spec, new Date())) return 'This schedule never happens (check the day and month)';
    return null;
  } catch (err) {
    return err instanceof CronError ? err.message : 'Invalid schedule';
  }
}
