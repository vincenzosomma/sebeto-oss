import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CHIEF_OF_STAFF_COST_KEY, type CostGroup, type CostPlanningGroup, type CostsReport, type PlanningPurpose } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage, formatCost } from '../lib/format';
import { entityColor } from '../lib/theme';
import { HeaderActions } from './HeaderActions';
import {
  COST_PERIODS, OTHER_KEY, budgetPercent, costsQueryFor, niceMax, seriesColor, stackDays,
  type CostPeriod, type CostStackBy,
} from '../lib/costs';

const PERIOD_KEY: Record<CostPeriod, MessageKey> = {
  '7d': 'cost.period.7d', '30d': 'cost.period.30d', '90d': 'cost.period.90d', month: 'cost.period.month',
};

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch { return fallback; }
}
function writePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* private mode: fine */ }
}

/** The Costs page (v0.5 §L): totals, a daily stacked bar chart, breakdowns, top tickets, budgets. */
export function CostsPage({ onMenu }: { onMenu: () => void }) {
  const { state, api, actions } = useStore();
  const { t, locale } = useI18n();
  const [period, setPeriod] = useState<CostPeriod>(() => readPref('sebeto.costs.period', COST_PERIODS, '30d'));
  const [stackBy, setStackBy] = useState<CostStackBy>(() => readPref('sebeto.costs.stack', ['runtime', 'project'] as const, 'runtime'));
  const [report, setReport] = useState<CostsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = useCallback((n: number) => formatCost(n, locale), [locale]);
  const num = useMemo(() => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-US'), [locale]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.costs(costsQueryFor(period, state.projectFilter, state.teamFilter)));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [api, period, state.projectFilter, state.teamFilter]);
  useEffect(() => { void load(); }, [load]);

  const projectName = (id: string | null) => (id && id !== 'none' ? state.projects?.[id]?.name ?? id : t('cost.noProject'));
  const filterLabel = [
    state.projectFilter ? (state.projectFilter === 'none' ? t('cost.filter.noProject') : state.projects?.[state.projectFilter]?.name ?? '') : null,
    state.teamFilter ? (state.teamFilter === 'none' ? t('cost.filter.noTeam') : state.teams?.[state.teamFilter]?.name ?? '') : null,
  ].filter(Boolean).join(' · ');

  const groupName = (by: 'project' | 'team' | 'agent' | 'runtime', g: CostGroup): string => {
    if (g.key === CHIEF_OF_STAFF_COST_KEY) return t('cost.chief');
    if (g.key === null) return t(by === 'project' ? 'cost.noProject' : by === 'team' ? 'cost.noTeam' : 'cost.noAgent');
    return g.label ?? g.key;
  };
  const seriesName = (key: string): string => {
    if (key === OTHER_KEY) return t('cost.other');
    if (stackBy === 'project') return projectName(key);
    if (key === CHIEF_OF_STAFF_COST_KEY) return t('cost.chief');
    return report?.groups.runtime?.find((g) => g.key === key)?.label ?? key;
  };

  const totals = report?.totals;
  const pct = report ? budgetPercent(report.budget.spentUsd, report.budget.limitUsd) : null;

  return (
    <div className="sec costs">
      <header className="header">
        <button type="button" className="icon-btn header__menu" onClick={onMenu} aria-label={t('header.menu')}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="header__text">
          <h1 className="header__title">{t('cost.title')}</h1>
          <p className="header__summary">{t('cost.summary')}</p>
        </div>
        <label className="field costs-period">
          <span className="field__label">{t('cost.period')}</span>
          <select className="input input--sm" value={period} onChange={(e) => { const p = e.target.value as CostPeriod; setPeriod(p); writePref('sebeto.costs.period', p); }}>
            {COST_PERIODS.map((p) => <option key={p} value={p}>{t(PERIOD_KEY[p])}</option>)}
          </select>
        </label>
        <HeaderActions />
      </header>

      <div className="sec-body">
        {error && <p className="sec-error" role="alert">{error}</p>}
        {filterLabel && (
          <p className="sec-notice costs-filter" role="status">
            <span>{t('cost.filtered', { filter: filterLabel })}</span>
            <button type="button" className="sec-link" onClick={() => { actions.setProjectFilter(null); actions.setTeamFilter(null); }}>{t('cost.filtered.clear')}</button>
          </p>
        )}

        <section aria-labelledby="cost-tiles-h">
          <h2 id="cost-tiles-h" className="section-label">{t('cost.tiles.heading')}</h2>
          <div className="sec-tiles">
            <div className="sec-tile costs-tile">
              <span className="sec-tile__n">{totals ? money(totals.costUsd) : '–'}</span>
              <span className="sec-tile__label">{t('cost.tiles.total')}</span>
              {totals && <span className="small muted">{t('cost.tiles.tickets', { tickets: totals.tickets })}</span>}
            </div>
            <div className="sec-tile costs-tile">
              <span className="sec-tile__n">{report ? money(report.split.paid.costUsd) : '–'}</span>
              <span className="sec-tile__label">{t('cost.tiles.paid')}</span>
              {report && <span className="small muted">{t('cost.tiles.freeRuns', { runs: report.split.paid.runs, tokens: num.format(report.split.paid.tokensIn + report.split.paid.tokensOut) })}</span>}
            </div>
            <div className="sec-tile costs-tile">
              <span className="sec-tile__n">{report ? money(report.split.free.costUsd) : '–'}</span>
              <span className="sec-tile__label">{t('cost.tiles.free')}</span>
              {report && <span className="small muted">{t('cost.tiles.freeRuns', { runs: report.split.free.runs, tokens: num.format(report.split.free.tokensIn + report.split.free.tokensOut) })}</span>}
            </div>
            <div className="sec-tile costs-tile">
              <span className="sec-tile__n">{totals ? money(totals.planningUsd) : '–'}</span>
              <span className="sec-tile__label">{t('cost.tiles.planning')}</span>
              {totals && <span className="small muted">{t('cost.tiles.planningCalls', { calls: totals.planningCalls })}</span>}
            </div>
            <div className={`sec-tile costs-tile${pct !== null && pct >= 100 ? ' sec-tile--crit' : pct !== null && pct >= 80 ? ' sec-tile--warn' : ''}`}>
              <span className="sec-tile__n">{report ? money(report.budget.spentUsd) : '–'}</span>
              <span className="sec-tile__label">{t('cost.tiles.budget', { month: report?.budget.month ?? '' })}</span>
              {report && (pct === null
                ? <span className="small muted">{t('cost.tiles.noBudget')}</span>
                : <span className="small muted">{t('cost.tiles.budgetOf', { spent: money(report.budget.spentUsd), limit: money(report.budget.limitUsd), pct })}</span>)}
            </div>
          </div>
        </section>

        <section className="costs-card" aria-labelledby="cost-chart-h">
          <div className="costs-card__head">
            <h2 id="cost-chart-h" className="section-label">{t('cost.chart.heading')}</h2>
            <div className="costs-seg" role="group" aria-label={t('cost.chart.stack')}>
              <span className="small muted">{t('cost.chart.stack')}</span>
              {(['runtime', 'project'] as const).map((b) => (
                <button key={b} type="button" className={`costs-seg__btn${stackBy === b ? ' costs-seg__btn--on' : ''}`} aria-pressed={stackBy === b}
                  onClick={() => { setStackBy(b); writePref('sebeto.costs.stack', b); }}>
                  {t(b === 'runtime' ? 'cost.chart.byRuntime' : 'cost.chart.byProject')}
                </button>
              ))}
            </div>
          </div>
          {report ? (
            <DailyChart report={report} stackBy={stackBy} seriesName={seriesName} money={money} />
          ) : <p className="muted small" role="status">{loading ? t('cost.loading') : ''}</p>}
          <p className="small muted costs-note">{t('cost.chart.utc')}</p>
        </section>

        {report && (
          <div className="costs-tables">
            <GroupTable title={t('cost.table.project')} rows={report.groups.project ?? []} name={(g) => groupName('project', g)} total={report.totals.costUsd} money={money} />
            <GroupTable title={t('cost.table.team')} rows={report.groups.team ?? []} name={(g) => groupName('team', g)} total={report.totals.costUsd} money={money} />
            <GroupTable title={t('cost.table.agent')} rows={report.groups.agent ?? []} name={(g) => groupName('agent', g)} total={report.totals.costUsd} money={money} />
            <PlanningTable rows={report.planning ?? []} total={report.totals.planningUsd} money={money} />

            <section className="costs-card" aria-labelledby="cost-top-h">
              <h2 id="cost-top-h" className="section-label">{t('cost.top.heading')}</h2>
              {report.topTickets.length === 0 ? <p className="muted small">{t('cost.top.empty')}</p> : (
                <ol className="costs-top">
                  {report.topTickets.map((tk) => (
                    <li key={tk.ticketId}>
                      <button type="button" className="sec-link costs-top__title" onClick={() => actions.select(tk.ticketId)}>
                        <span className="costs-top__num">T-{tk.number}</span> {tk.title}
                      </button>
                      <span className="costs-top__cost">
                        {money(tk.costUsd)}
                        {tk.planningUsd > 0 && <span className="small muted"> · {t('cost.top.planning', { cost: money(tk.planningUsd) })}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="costs-card" aria-labelledby="cost-budget-h">
              <h2 id="cost-budget-h" className="section-label">{t('cost.budget.heading')}</h2>
              {report.budget.agents.length === 0 ? <p className="muted small">{t('cost.budget.empty')}</p> : (
                <ul className="costs-budget">
                  {report.budget.agents.map((a) => {
                    const p = budgetPercent(a.spentUsd, a.monthlyBudgetUsd);
                    const over = p !== null && p >= 100;
                    return (
                      <li key={a.agentId}>
                        <div className="costs-budget__row">
                          <span>{a.name}</span>
                          <span className="small">{money(a.spentUsd)} / {money(a.monthlyBudgetUsd)}{over && <strong className="costs-over"> · {t('cost.budget.over')}</strong>}</span>
                        </div>
                        <div className="costs-meter" aria-hidden="true">
                          <span className={`costs-meter__fill${over ? ' costs-meter__fill--over' : p !== null && p >= 80 ? ' costs-meter__fill--warn' : ''}`} style={{ width: `${Math.min(100, p ?? 0)}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function GroupTable({ title, rows, name, total, money }: {
  title: string; rows: CostGroup[]; name: (g: CostGroup) => string; total: number; money: (n: number) => string;
}) {
  const { t } = useI18n();
  return (
    <section className="costs-card">
      <h2 className="section-label">{title}</h2>
      {rows.length === 0 ? <p className="muted small">{t('cost.top.empty')}</p> : (
        <table className="sec-table costs-table">
          <thead>
            <tr>
              <th scope="col">{t('cost.col.name')}</th>
              <th scope="col" className="num">{t('cost.col.cost')}</th>
              <th scope="col" className="num">{t('cost.col.runs')}</th>
              <th scope="col">{t('cost.col.share')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const share = total > 0 ? g.costUsd / total : 0;
              return (
                <tr key={g.key ?? '-'}>
                  <td>{name(g)}</td>
                  <td className="num">{money(g.costUsd)}</td>
                  <td className="num">{g.runs}</td>
                  <td className="costs-share" title={`${Math.round(share * 100)}%`}>
                    <span className="costs-meter"><span className="costs-meter__fill" style={{ width: `${Math.round(share * 100)}%` }} /></span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

const PURPOSE_KEY: Record<PlanningPurpose, MessageKey> = {
  routing: 'cost.purpose.routing', intake: 'cost.purpose.intake', memory_note: 'cost.purpose.memory_note',
  categorise: 'cost.purpose.categorise', other: 'cost.purpose.other',
};

/** v0.6 O: the Chief of Staff's planning calls by purpose (routing, intake chat, memory notes, categories). */
function PlanningTable({ rows, total, money }: { rows: CostPlanningGroup[]; total: number; money: (n: number) => string }) {
  const { t } = useI18n();
  return (
    <section className="costs-card" aria-labelledby="cost-planning-h">
      <h2 id="cost-planning-h" className="section-label">{t('cost.planning.heading')}</h2>
      {rows.length === 0 ? <p className="muted small">{t('cost.planning.empty')}</p> : (
        <table className="sec-table costs-table">
          <thead>
            <tr>
              <th scope="col">{t('cost.col.purpose')}</th>
              <th scope="col" className="num">{t('cost.col.cost')}</th>
              <th scope="col" className="num">{t('cost.col.calls')}</th>
              <th scope="col">{t('cost.col.share')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const share = total > 0 ? g.costUsd / total : 0;
              return (
                <tr key={g.purpose}>
                  <td>
                    {t(PURPOSE_KEY[g.purpose] ?? 'cost.purpose.other')}
                    {g.failed > 0 && <span className="small muted"> · {t('cost.planning.failed', { n: g.failed })}</span>}
                  </td>
                  <td className="num">{money(g.costUsd)}</td>
                  <td className="num">{g.calls}</td>
                  <td className="costs-share" title={`${Math.round(share * 100)}%`}>
                    <span className="costs-meter"><span className="costs-meter__fill" style={{ width: `${Math.round(share * 100)}%` }} /></span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

const CHART_H = 220;
const PAD = { top: 12, right: 8, bottom: 24, left: 56 };

function DailyChart({ report, stackBy, seriesName, money }: {
  report: CostsReport; stackBy: CostStackBy; seriesName: (k: string) => string; money: (n: number) => string;
}) {
  const { t, locale } = useI18n();
  const { state } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.floor(el.clientWidth)));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const stack = useMemo(() => stackDays(report.days, stackBy), [report.days, stackBy]);
  const projectColors = useMemo(() => Object.fromEntries(Object.values(state.projects ?? {}).map((p) => [p.id, p.color])), [state.projects]);
  const colorOf = (key: string) => entityColor(seriesColor(stackBy, key, projectColors, stack.keys.indexOf(key)));
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }), [locale]);
  const fmtDay = (d: string) => dayFmt.format(new Date(`${d}T00:00:00Z`));

  const top = niceMax(stack.max);
  const plotW = width - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const n = stack.bars.length || 1;
  const band = plotW / n;
  const barW = Math.max(1, Math.min(28, band * 0.72));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const labelEvery = Math.ceil(n / Math.max(2, Math.floor(plotW / 64)));
  const hovered = hover !== null ? stack.bars[hover] : null;

  return (
    <div className="costs-chart" ref={wrapRef}>
      {stack.max === 0 && <p className="muted small costs-chart__empty">{t('cost.chart.empty')}</p>}
      <svg width={width} height={CHART_H} role="img" aria-label={t('cost.chart.heading')} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'costs-axis' : 'costs-grid'} />
            <text x={PAD.left - 6} y={y(v)} className="costs-tick" textAnchor="end" dominantBaseline="middle">{money(v)}</text>
          </g>
        ))}
        {stack.bars.map((b, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          return (
            <g key={b.day}>
              {b.segments.map((s) => {
                const y0 = y(s.y0);
                const y1 = y(s.y1);
                const h = Math.max(0, y0 - y1);
                return <rect key={s.key} x={x} y={y1} width={barW} height={Math.max(h, 0.5)} rx={Math.min(2, barW / 3)} style={{ fill: colorOf(s.key) }} className="costs-bar" />;
              })}
              {i % labelEvery === 0 && (
                <text x={PAD.left + i * band + band / 2} y={CHART_H - 6} className="costs-tick" textAnchor="middle">{fmtDay(b.day)}</text>
              )}
              <rect x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} fill="transparent"
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
                <title>{t('cost.chart.tip', { day: fmtDay(b.day), cost: money(b.total), runs: b.runs })}</title>
              </rect>
              {hover === i && <rect x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} className="costs-hover" pointerEvents="none" />}
            </g>
          );
        })}
      </svg>
      {hovered && (
        <div className="costs-tip" style={{ left: Math.min(width - 200, Math.max(0, PAD.left + (hover ?? 0) * band + band / 2 - 90)) }} role="status">
          <strong>{fmtDay(hovered.day)}</strong> · {money(hovered.total)} · {hovered.runs} {t('cost.col.runs').toLowerCase()}
          {hovered.segments.length > 0 && (
            <ul>
              {[...hovered.segments].reverse().map((s) => (
                <li key={s.key}><span className="costs-swatch" style={{ background: colorOf(s.key) }} />{seriesName(s.key)} <span className="muted">{money(s.value)}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {stack.keys.length > 0 && (
        <ul className="costs-legend">
          {stack.keys.map((k) => (
            <li key={k}><span className="costs-swatch" style={{ background: colorOf(k) }} />{seriesName(k)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
