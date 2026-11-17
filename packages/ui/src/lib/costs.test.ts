import { describe, expect, it } from 'vitest';
import type { CostDay } from '@sebeto/shared';
import { OTHER_COLOR, OTHER_KEY, SERIES_COLORS, budgetPercent, costsQueryFor, niceMax, periodRange, seriesColor, stackDays } from './costs';
import { initialState, reducer } from '../store/reducer';
import { MockApi } from '../api/mock';

const NOW = new Date('2026-11-13T23:30:00.000Z');
const day = (d: string, byRuntime: Record<string, number>, byProject: Record<string, number> = {}): CostDay => ({
  day: d, costUsd: Object.values(byRuntime).reduce((a, b) => a + b, 0), runs: 1, tokensIn: 0, tokensOut: 0, byRuntime, byProject,
});

describe('cost periods', () => {
  it('uses UTC days, today included', () => {
    expect(periodRange('7d', NOW)).toEqual({ from: '2026-11-07T00:00:00.000Z', to: '2026-11-14T00:00:00.000Z' });
    expect(periodRange('30d', NOW).from).toBe('2026-10-15T00:00:00.000Z');
    expect(periodRange('90d', NOW).from).toBe('2026-08-16T00:00:00.000Z');
    expect(periodRange('month', NOW)).toEqual({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-14T00:00:00.000Z' });
  });
  it('passes the board filters on', () => {
    expect(costsQueryFor('7d', 'p1', null, NOW)).toMatchObject({ projectId: 'p1', groupBy: ['project', 'team', 'agent', 'runtime'], top: 10 });
    expect(costsQueryFor('7d', null, 'none', NOW)).toMatchObject({ teamId: 'none' });
    expect(costsQueryFor('7d', null, null, NOW)).not.toHaveProperty('projectId');
  });
});

describe('stacked daily chart', () => {
  it('stacks by total (biggest first) and folds extra keys into Other', () => {
    const days = [
      day('2026-11-01', { 'claude-cli': 1, a: 0.1, b: 0.2 }),
      day('2026-11-02', { 'claude-cli': 0.5, c: 0.05, 'chief-of-staff': 0.3 }),
      day('2026-11-03', {}),
    ];
    const s = stackDays(days, 'runtime', 3);
    expect(s.keys).toEqual(['claude-cli', 'chief-of-staff', OTHER_KEY]);
    expect(s.bars[0]!.segments).toEqual([
      { key: 'claude-cli', value: 1, y0: 0, y1: 1 },
      { key: OTHER_KEY, value: 0.30000000000000004, y0: 1, y1: 1.3 },
    ]);
    expect(s.bars[2]!.segments).toEqual([]);
    expect(s.max).toBeCloseTo(1.3);
    expect(stackDays(days, 'runtime').keys).toEqual(['claude-cli', 'chief-of-staff', 'b', 'a', 'c']);
  });
  it('stacks by project', () => {
    const s = stackDays([day('2026-11-01', { x: 1 }, { p1: 0.25, none: 0.75 })], 'project');
    expect(s.keys).toEqual(['none', 'p1']);
  });
  it('keeps colours by entity', () => {
    expect(seriesColor('runtime', 'claude-cli', {}, 4)).toBe(SERIES_COLORS[0]);
    expect(seriesColor('runtime', OTHER_KEY)).toBe(OTHER_COLOR);
    expect(seriesColor('project', 'p1', { p1: '#2E7D5B' })).toBe('#2E7D5B');
    expect(seriesColor('project', 'none', { none: '#000000' })).toBe(OTHER_COLOR);
  });
  it('rounds the axis and budget share', () => {
    expect(niceMax(0)).toBe(0.01);
    expect(niceMax(0.73)).toBe(1);
    expect(niceMax(1.3)).toBe(2);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(34)).toBe(50);
    expect(budgetPercent(5, 20)).toBe(25);
    expect(budgetPercent(5, 0)).toBeNull();
  });
});

describe('Costs page', () => {
  it('is a page in the store', () => {
    const s = reducer(initialState({ selectedId: 't1' }), { type: 'setPage', page: 'costs' });
    expect(s.page).toBe('costs');
    expect(s.selectedId).toBeNull();
  });
  it('the mock report adds up', async () => {
    const api = new MockApi({ speed: 0 });
    const r = await api.costs({ ...periodRange('90d'), groupBy: ['project', 'agent', 'day'] });
    const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
    expect(r.days).toHaveLength(90);
    expect(r.totals.costUsd).toBeGreaterThan(0);
    expect(sum(r.days.map((d) => d.costUsd))).toBeCloseTo(r.totals.costUsd, 5);
    expect(sum(r.groups.project!.map((g) => g.costUsd))).toBeCloseTo(r.totals.costUsd, 5);
    expect(sum([r.split.paid.costUsd, r.split.free.costUsd])).toBeCloseTo(r.totals.costUsd, 5);
    expect(r.split.free.costUsd).toBe(0);
    expect(r.split.free.runs).toBeGreaterThan(0);
    expect(r.topTickets.length).toBeGreaterThan(0);
    expect(r.topTickets[0]!.costUsd).toBeGreaterThanOrEqual(r.topTickets.at(-1)!.costUsd);
  });
  it('v0.6 O: the mock counts the Chief of Staff by purpose, with nothing left out', async () => {
    const api = new MockApi({ speed: 0 });
    const r = await api.costs(periodRange('90d'));
    expect(r.notCounted).toEqual([]);
    expect(r.planning.map((g) => g.purpose)).toEqual(expect.arrayContaining(['routing', 'intake', 'memory_note', 'categorise']));
    expect(r.planning.reduce((n, g) => n + g.costUsd, 0)).toBeCloseTo(r.totals.planningUsd, 5);
    expect(r.planning.reduce((n, g) => n + g.calls, 0)).toBe(r.totals.planningCalls);
  });
});
