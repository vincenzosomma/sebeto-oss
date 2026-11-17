/** Pure helpers for the Costs page (v0.5 §L): periods, the stacked daily chart, colours. */
import { CHIEF_OF_STAFF_COST_KEY, type CostDay, type CostsQuery, type Id } from '@sebeto/shared';

export type CostPeriod = '7d' | '30d' | '90d' | 'month';
export const COST_PERIODS: readonly CostPeriod[] = ['7d', '30d', '90d', 'month'];
export type CostStackBy = 'runtime' | 'project';

const DAY = 86_400_000;

/** The period as UTC [from, to): the last N UTC days (today included), or this UTC month up to today. */
export function periodRange(period: CostPeriod, now = new Date()): { from: string; to: string } {
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const from = period === 'month'
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    : tomorrow - ({ '7d': 7, '30d': 30, '90d': 90 } as const)[period] * DAY;
  return { from: new Date(from).toISOString(), to: new Date(tomorrow).toISOString() };
}

/** The request for a period and the board's project/team filter. */
export function costsQueryFor(period: CostPeriod, projectFilter: Id | 'none' | null, teamFilter: Id | 'none' | null, now = new Date()): CostsQuery {
  return {
    ...periodRange(period, now), groupBy: ['project', 'team', 'agent', 'runtime'], top: 10,
    ...(projectFilter ? { projectId: projectFilter } : {}), ...(teamFilter ? { teamId: teamFilter } : {}),
  };
}

/**
 * Categorical colours in fixed order, as CSS variables so they follow the light/dark theme
 * (styles/tokens.css --series-*; lib/contrast.test.ts checks them against the surface in both).
 * Use them with `style={{ fill }}` / `background`, not SVG presentation attributes.
 */
export const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'] as const;
export const OTHER_COLOR = 'var(--series-other)';
export const OTHER_KEY = '__other';
/** Runtimes keep the same colour whatever else is on the chart (colour follows the entity). */
const RUNTIME_COLOR: Record<string, string> = {
  'claude-cli': SERIES_COLORS[0], 'claude-sdk': SERIES_COLORS[0], [CHIEF_OF_STAFF_COST_KEY]: SERIES_COLORS[1], ollama: SERIES_COLORS[3], mock: OTHER_COLOR,
};

export function seriesColor(by: CostStackBy, key: string, projectColors: Record<string, string> = {}, index = 0): string {
  if (key === OTHER_KEY || key === 'none') return OTHER_COLOR;
  if (by === 'project') return projectColors[key] ?? SERIES_COLORS[index % SERIES_COLORS.length]!;
  return RUNTIME_COLOR[key] ?? [SERIES_COLORS[2], SERIES_COLORS[4]][index % 2]!;
}

export interface StackSegment { key: string; value: number; y0: number; y1: number }
export interface StackBar { day: string; total: number; runs: number; segments: StackSegment[] }
export interface StackedSeries { keys: string[]; bars: StackBar[]; max: number }

/**
 * Stack each day's cost by runtime or project. Keys are ordered by their total over the period
 * (biggest at the bottom); beyond `maxKeys` they fold into OTHER_KEY.
 */
export function stackDays(days: readonly CostDay[], by: CostStackBy, maxKeys = 5): StackedSeries {
  const field = by === 'runtime' ? 'byRuntime' : 'byProject';
  const totals = new Map<string, number>();
  for (const d of days) for (const [k, v] of Object.entries(d[field])) totals.set(k, (totals.get(k) ?? 0) + v);
  const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const kept = ranked.length > maxKeys ? ranked.slice(0, maxKeys - 1) : ranked;
  const keys = ranked.length > kept.length ? [...kept, OTHER_KEY] : kept;
  let max = 0;
  const bars = days.map((d) => {
    const values = new Map<string, number>();
    for (const [k, v] of Object.entries(d[field])) {
      const key = kept.includes(k) ? k : OTHER_KEY;
      values.set(key, (values.get(key) ?? 0) + v);
    }
    let y = 0;
    const segments: StackSegment[] = [];
    for (const key of keys) {
      const value = values.get(key) ?? 0;
      if (value <= 0) continue;
      segments.push({ key, value, y0: y, y1: y + value });
      y += value;
    }
    max = Math.max(max, y);
    return { day: d.day, total: d.costUsd, runs: d.runs, segments };
  });
  return { keys, bars, max };
}

/** A round axis top: 1, 2, 2.5 or 5 × 10^n, at least `value` (0 → 1 cent). */
export function niceMax(value: number): number {
  if (!(value > 0)) return 0.01;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= value - 1e-12) return m * exp;
  return 10 * exp;
}

/** Used share of a budget, 0–100+ (null when there is no budget). */
export function budgetPercent(spent: number, limit: number): number | null {
  return limit > 0 ? Math.round((spent / limit) * 100) : null;
}
