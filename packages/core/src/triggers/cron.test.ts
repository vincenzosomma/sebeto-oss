import { describe, expect, it } from 'vitest';
import { CronError, cronProblem, nextRun, nextRuns, parseCron } from '@sebeto/shared';

/** Local time helper: new Date(y, m-1, d, h, mi). */
const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
const fmt = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'never');

describe('cron parser', () => {
  it('parses *, lists, ranges, steps, names and 7 = Sunday', () => {
    const s = parseCron('*/15 8-10,14 1,15 JAN-mar mon-fri');
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([8, 9, 10, 14]);
    expect([...s.days]).toEqual([1, 15]);
    expect([...s.months]).toEqual([1, 2, 3]);
    expect([...s.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0]);
    expect([...parseCron('5/20 * * * *').minutes]).toEqual([5, 25, 45]);
    expect([...parseCron('0 0 * * 0-7/2').weekdays].sort()).toEqual([0, 2, 4, 6]);
    expect(parseCron('  0   8 *  * 1 ').source).toBe('0 8 * * 1');
  });

  it('rejects bad expressions with a plain message', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '1,,2 * * * *', '1-2-3 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
    expect(cronProblem('0 8 * * 1')).toBeNull();
    expect(cronProblem('0 0 31 2 *')).toMatch(/never happens/);
    expect(cronProblem('nope')).toMatch(/5 parts/);
  });

  it('computes the next run strictly after the given time (local time)', () => {
    const mondays8 = parseCron('0 8 * * 1');
    // 2026-11-12 is a Thursday.
    expect(fmt(nextRun(mondays8, at(2026, 11, 12, 9, 30)))).toBe('2026-11-16 08:00');
    expect(fmt(nextRun(mondays8, at(2026, 11, 16, 8, 0)))).toBe('2026-11-23 08:00'); // exactly due → the next one
    expect(fmt(nextRun(mondays8, at(2026, 11, 16, 7, 59)))).toBe('2026-11-16 08:00');
    expect(fmt(nextRun(parseCron('*/15 * * * *'), new Date(2026, 10, 12, 9, 14, 59)))).toBe('2026-11-12 09:15');
  });

  it('handles month ends, leap years and year rollover', () => {
    expect(fmt(nextRun(parseCron('0 9 1 * *'), at(2026, 12, 15)))).toBe('2027-01-01 09:00');
    expect(fmt(nextRun(parseCron('0 0 31 * *'), at(2026, 11, 1)))).toBe('2026-12-31 00:00'); // November has 30 days
    expect(fmt(nextRun(parseCron('0 12 29 2 *'), at(2026, 3, 1)))).toBe('2028-02-29 12:00');
    expect(fmt(nextRun(parseCron('59 23 31 12 *'), at(2026, 12, 31, 23, 59)))).toBe('2027-12-31 23:59');
    expect(nextRun(parseCron('0 0 30 2 *'), at(2026, 1, 1))).toBeNull();
  });

  it('day-of-month OR day-of-week when both are restricted (classic cron)', () => {
    // The 13th, or any Friday.
    const runs = nextRuns(parseCron('0 0 13 * 5'), at(2026, 11, 1), 4).map(fmt);
    expect(runs).toEqual(['2026-11-06 00:00', '2026-11-13 00:00', '2026-11-20 00:00', '2026-11-27 00:00']);
    // Only the day of month restricted.
    expect(nextRuns(parseCron('0 0 13 * *'), at(2026, 11, 1), 2).map(fmt)).toEqual(['2026-11-13 00:00', '2026-12-13 00:00']);
  });

  it('nextRuns gives the preview list', () => {
    expect(nextRuns(parseCron('30 7 * * 1-5'), at(2026, 11, 13, 8), 3).map(fmt)).toEqual(['2026-11-16 07:30', '2026-11-17 07:30', '2026-11-18 07:30']);
  });
});
