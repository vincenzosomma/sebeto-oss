/**
 * Pure helpers for team templates (packages/shared/src/templates.ts): the small tree on each card,
 * a light check of imported team files (the core validates fully), and the export file name.
 */
import { TEMPLATE_FORMAT, type TeamTemplate, type TemplateAgent } from '@sebeto/shared';
import type { MessageKey } from '../i18n/catalog';

export const MAX_TEAM_FILE_BYTES = 2 * 1024 * 1024;

export interface TemplateRow {
  agent: TemplateAgent;
  depth: number;
}

/** Depth-first rows in template order; agents with an unknown manager (or in a loop) go to the top. */
export function templateTree(t: Pick<TeamTemplate, 'agents'>): TemplateRow[] {
  const keys = new Set(t.agents.map((a) => a.key));
  const children = new Map<string | null, TemplateAgent[]>();
  for (const a of t.agents) {
    const parent = a.reportsTo && keys.has(a.reportsTo) && a.reportsTo !== a.key ? a.reportsTo : null;
    children.set(parent, [...(children.get(parent) ?? []), a]);
  }
  const rows: TemplateRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      if (seen.has(a.key)) continue;
      seen.add(a.key);
      rows.push({ agent: a, depth });
      walk(a.key, depth + 1);
    }
  };
  walk(null, 0);
  for (const a of t.agents) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    rows.push({ agent: a, depth: 0 });
    walk(a.key, 1);
  }
  return rows;
}

export type TeamFileCheck = { ok: true; template: TeamTemplate } | { ok: false; error: MessageKey };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Light client-side check of an imported team file, so the preview makes sense. The core re-validates everything. */
export function checkTeamFile(text: string): TeamFileCheck {
  if (text.length > MAX_TEAM_FILE_BYTES) return { ok: false, error: 'tt.err.tooBig' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'tt.err.json' };
  }
  if (!isObj(data) || data.format !== TEMPLATE_FORMAT) return { ok: false, error: 'tt.err.format' };
  const { agents, skills } = data;
  if (typeof data.name !== 'string' || !Array.isArray(agents) || agents.length === 0 || !Array.isArray(skills)) return { ok: false, error: 'tt.err.format' };
  if (agents.length > 30 || skills.length > 50) return { ok: false, error: 'tt.err.tooBig' };
  const keys = new Set<string>();
  for (const a of agents) {
    if (!isObj(a) || typeof a.key !== 'string' || typeof a.name !== 'string' || !Array.isArray(a.skills)) return { ok: false, error: 'tt.err.format' };
    if (keys.has(a.key)) return { ok: false, error: 'tt.err.reports' };
    keys.add(a.key);
  }
  const manager = new Map(agents.map((a) => [(a as TemplateAgent).key, (a as TemplateAgent).reportsTo ?? null] as const));
  for (const [key, boss] of manager) {
    if (boss !== null && !keys.has(boss)) return { ok: false, error: 'tt.err.reports' };
    const seen = new Set([key]);
    for (let cur = boss; cur !== null; cur = manager.get(cur) ?? null) {
      if (seen.has(cur)) return { ok: false, error: 'tt.err.cycle' };
      seen.add(cur);
    }
  }
  for (const s of skills) {
    if (!isObj(s) || typeof s.slug !== 'string' || typeof s.instructions !== 'string') return { ok: false, error: 'tt.err.format' };
  }
  return { ok: true, template: { ...(data as unknown as TeamTemplate), builtin: false } };
}

/** sebeto-team-YYYY-MM-DD.json (local date). */
export function teamFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `sebeto-team-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

const CONNECTOR_LABELS: Record<string, string> = {
  microsoft: 'Microsoft 365',
  google: 'Google',
  gmail: 'Gmail',
  folder: 'Folder',
  custom: 'MCP',
};

export function connectorLabel(id: string): string {
  return CONNECTOR_LABELS[id] ?? id;
}
