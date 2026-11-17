/**
 * Mock session library (v0.4 §A) for the demo mode: a few Sebeto and Claude Code sessions, search,
 * categories, scan, preview, edit, open and remove. Tickets are created / reopened through hooks
 * into MockApi so the board updates like with the real core.
 */
import {
  GENERAL_CATEGORY, GENERIC_CATEGORIES, SUGGEST_BATCH_SIZE, SUGGEST_DEFAULT_COST_USD, SUGGEST_DEFAULT_LIMIT, SUGGEST_MAX_COST_USD,
  normalizeTag, normalizeTags, uuidv7,
  type ApplyCategoriesBody, type ApplyCategoriesResult, type Id, type OpenSessionBody, type OpenSessionResponse, type SessionCategoryCount,
  type SessionEntry, type SessionScanResult, type SessionSource, type SessionTranscript, type SuggestCategoriesBody, type SuggestCategoriesResult,
  type Team, type Ticket, type UpdateSessionEntryBody,
} from '@sebeto/shared';
import { ApiHttpError } from './types';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

export interface MockSessionHooks {
  /** Create a ticket like POST /tickets would (board event included). */
  createTicket(input: { title: string; goal: string; runtime: string }): Promise<Ticket>;
  getTicket(id: Id): Ticket | undefined;
  ticketByNumber(n: number): Ticket | undefined;
  /** Move a ticket (cause user). */
  reopen(id: Id): Promise<Ticket>;
  emitChanged(): void;
}

interface DemoEntry extends SessionEntry { transcript: SessionTranscript['turns'] }

function demo(p: Partial<DemoEntry> & Pick<DemoEntry, 'title' | 'summary' | 'source'>): DemoEntry {
  const last = p.lastActivityAt ?? ago(1);
  return {
    id: uuidv7(), externalSessionId: p.source === 'claude-code' ? crypto.randomUUID() : null, sessionId: null, ticketId: null, ticketNumber: null,
    category: '', tags: [], cwd: null, runtime: p.source === 'claude-code' ? 'claude-cli' : 'claude-cli', model: 'claude-haiku-4-5', messageCount: 6,
    costUsd: 0, startedAt: last, lastActivityAt: last, pinned: false, transcript: [], ...p,
  };
}

export class MockSessionLibrary {
  private entries: DemoEntry[] = [
    demo({
      source: 'sebeto', title: 'Summarise last week’s incidents', category: 'service-desk', tags: ['incidents'], ticketNumber: 101, costUsd: 0.38,
      summary: 'Top 5 root causes of last week’s incidents. Outcome: full mailboxes and VPN timeouts lead; examples attached in the report.',
      lastActivityAt: ago(0.1), pinned: true,
      transcript: [
        { role: 'user', text: 'Summarise last week’s incidents into the top 5 root causes, with two examples each.', at: ago(0.2) },
        { role: 'agent', text: 'On it. I found 214 tickets in the service desk export.', at: ago(0.15) },
      ],
    }),
    demo({
      source: 'sebeto', title: 'Archive old VPN profiles', category: 'infrastructure', tags: ['vpn'], ticketNumber: 87, costUsd: 0.26,
      summary: 'Archive VPN profiles not used for 6 months. Outcome: 41 profiles archived; the list is in archived-profiles.csv.',
      lastActivityAt: ago(9),
      transcript: [
        { role: 'user', text: 'Archive the VPN profiles nobody used in the last 6 months.', at: ago(10) },
        { role: 'tool', text: 'Used tool run_command', at: ago(10) },
        { role: 'agent', text: 'Done. 41 profiles archived; the list is in archived-profiles.csv.', at: ago(9) },
      ],
    }),
    demo({
      source: 'claude-code', title: 'Check CVE-2026-1234 on the Naples file servers', category: 'security', cwd: 'C:\\Ops\\cve-checks',
      summary: 'Asked: are the Naples file servers affected by CVE-2026-1234? — Last answer: two servers run the affected SMB version; patch KB5050 fixes it.',
      lastActivityAt: ago(3), messageCount: 14,
      transcript: [
        { role: 'user', text: 'Are the Naples file servers affected by CVE-2026-1234?', at: ago(3.1) },
        { role: 'tool', text: 'Used tool Read', at: ago(3.05) },
        { role: 'agent', text: 'Two servers (NAP-FS01, NAP-FS02) run the affected SMB version. KB5050 fixes it.', at: ago(3) },
      ],
    }),
    demo({
      source: 'claude-code', title: 'Write a runbook for the weekly backup check', cwd: 'C:\\Ops\\runbooks',
      summary: 'Asked: write a runbook for checking the weekly backups. — Last answer: runbook saved as backup-check.md with 7 steps.',
      lastActivityAt: ago(12), messageCount: 8,
      transcript: [
        { role: 'user', text: 'Write a runbook for checking the weekly backups.', at: ago(12.1) },
        { role: 'agent', text: 'Saved backup-check.md with 7 steps, including the restore test.', at: ago(12) },
      ],
    }),
  ];
  private scanned = false;

  constructor(private readonly hooks: MockSessionHooks) {}

  private must(id: Id): DemoEntry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new ApiHttpError(404, 'not_found', `Session ${id} not found`);
    return e;
  }

  private pub(e: DemoEntry): SessionEntry {
    // Demo Sebeto entries point at seeded tickets by number.
    if (!e.ticketId && e.ticketNumber !== null) e.ticketId = this.hooks.ticketByNumber(e.ticketNumber)?.id ?? null;
    const { transcript: _t, ...rest } = e;
    return { ...rest, tags: [...rest.tags] };
  }

  list(q: { q?: string; category?: string; source?: SessionSource }): { items: SessionEntry[]; nextCursor: null } {
    const words = (q.q ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const items = this.entries
      .filter((e) => !q.source || e.source === q.source)
      .filter((e) => !q.category || (q.category === '-' ? e.category === '' : e.category === q.category))
      .filter((e) => {
        const hay = `${e.title} ${e.summary} ${e.category} ${e.tags.join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((e) => this.pub(e));
    return { items, nextCursor: null };
  }

  categories(): SessionCategoryCount[] {
    const counts = new Map<string, number>();
    for (const e of this.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  }

  scan(): SessionScanResult {
    if (this.scanned) return { found: 2, added: 0, updated: 0, skipped: 2 };
    this.scanned = true;
    this.entries.push(demo({
      source: 'claude-code', title: 'Clean up old user accounts in Active Directory', cwd: 'C:\\Ops\\ad-cleanup',
      summary: 'Asked: list AD accounts not used for 90 days. — Last answer: 37 accounts found, export saved as stale-accounts.csv.',
      lastActivityAt: ago(5), messageCount: 10,
      transcript: [{ role: 'user', text: 'List AD accounts not used for 90 days.', at: ago(5) }, { role: 'agent', text: '37 accounts found.', at: ago(5) }],
    }));
    this.hooks.emitChanged();
    return { found: 2, added: 1, updated: 0, skipped: 1 };
  }

  get(id: Id): SessionEntry { return this.pub(this.must(id)); }

  transcript(id: Id, limit = 30): SessionTranscript {
    const e = this.must(id);
    return { entryId: id, turns: e.transcript.slice(-limit), truncated: e.transcript.length > limit };
  }

  update(id: Id, body: UpdateSessionEntryBody): SessionEntry {
    const e = this.must(id);
    if (body.title !== undefined) e.title = body.title.trim() || e.title;
    if (body.summary !== undefined) e.summary = body.summary;
    if (body.category !== undefined) {
      e.category = body.category.trim() ? normalizeTag(body.category) ?? '' : '';
      e.categorySource = e.category ? 'owner' : null;
    }
    if (body.tags !== undefined) e.tags = normalizeTags(body.tags);
    if (body.pinned !== undefined) e.pinned = body.pinned;
    this.hooks.emitChanged();
    return this.pub(e);
  }

  // ---------- v0.5 K auto-categorise (demo: keyword rules; the "AI" mode is simulated, no model call)
  private uncategorised(ids?: Id[]): DemoEntry[] {
    return this.entries
      .filter((e) => e.categorySource !== 'owner' && (e.category === '' || (!e.categorySource && GENERIC_CATEGORIES.includes(e.category))))
      .filter((e) => !ids || ids.includes(e.id))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  private choices(teams: Team[]): string[] {
    const out = teams.map((t) => t.slug);
    for (const c of this.categories()) if (c.category && !GENERIC_CATEGORIES.includes(c.category) && !out.includes(c.category)) out.push(c.category);
    return [...out, GENERAL_CATEGORY];
  }

  suggest(body: SuggestCategoriesBody, teams: Team[]): SuggestCategoriesResult {
    const mode = body.mode ?? 'rules';
    const dryRun = body.dryRun !== false;
    const maxCostUsd = Math.max(0, Math.min(body.maxCostUsd ?? SUGGEST_DEFAULT_COST_USD, SUGGEST_MAX_COST_USD));
    const entries = this.uncategorised(body.ids).slice(0, body.limit ?? SUGGEST_DEFAULT_LIMIT);
    const res: SuggestCategoriesResult = {
      mode, dryRun, considered: entries.length, suggestions: [], applied: 0, skipped: { locked: 0, noMatch: 0, invalid: 0, budget: 0 },
      modelCalls: 0, costUsd: 0, maxCostUsd, choices: this.choices(teams), error: null,
    };
    const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
    const match = (e: DemoEntry) => {
      const text = new Set(words(`${e.title} ${e.summary} ${e.cwd ?? ''}`).map((w) => w.replace(/s$/, '')));
      let best: { slug: string; hits: string[] } | null = null;
      for (const t of teams) {
        const hits = [...new Set(words(t.routingHints).map((w) => w.replace(/s$/, '')))].filter((w) => text.has(w));
        if (hits.length && (!best || hits.length > best.hits.length)) best = { slug: t.slug, hits };
      }
      return best;
    };
    if (mode === 'ai') res.modelCalls = Math.ceil(entries.length / SUGGEST_BATCH_SIZE);
    for (const e of entries) {
      const m = match(e);
      if (mode === 'rules') {
        if (m) res.suggestions.push({ entryId: e.id, title: e.title, current: e.category, category: m.slug, source: 'rules', reason: m.hits.slice(0, 4).join(', ') });
        else res.skipped.noMatch++;
      } else if (res.costUsd + 0.0004 > maxCostUsd) res.skipped.budget++;
      else {
        res.costUsd = Math.round((res.costUsd + 0.0004) * 1e6) / 1e6;
        res.suggestions.push({ entryId: e.id, title: e.title, current: e.category, category: m?.slug ?? GENERAL_CATEGORY, source: 'auto', reason: 'Chief of Staff' });
      }
    }
    if (!dryRun) res.applied = this.apply({ items: res.suggestions.map((s) => ({ id: s.entryId, category: s.category, source: s.source })) }, teams).applied;
    return res;
  }

  apply(body: ApplyCategoriesBody, teams: Team[]): ApplyCategoriesResult {
    const choices = this.choices(teams);
    const open = new Set(this.uncategorised().map((e) => e.id));
    let applied = 0;
    for (const it of body.items) {
      const e = this.entries.find((x) => x.id === it.id);
      const cat = normalizeTag(it.category) ?? '';
      if (!e || !open.has(e.id) || !choices.includes(cat)) continue;
      open.delete(e.id);
      e.category = cat;
      e.categorySource = it.source;
      applied++;
    }
    if (applied) this.hooks.emitChanged();
    return { applied, skipped: body.items.length - applied };
  }

  remove(id: Id): void {
    this.must(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.hooks.emitChanged();
  }

  async open(id: Id, body: OpenSessionBody = {}): Promise<OpenSessionResponse> {
    const e = this.must(id);
    this.pub(e); // resolves demo ticket links
    const linked = e.ticketId ? this.hooks.getTicket(e.ticketId) : undefined;
    if (linked) {
      if (linked.status !== 'done') return { ticket: linked, action: 'existing' };
      const ticket = await this.hooks.reopen(linked.id);
      this.hooks.emitChanged();
      return { ticket, action: 'reopened' };
    }
    if (e.source === 'sebeto') throw new ApiHttpError(409, 'ticket_missing', 'The ticket of this session is not in the demo data.');
    const ticket = await this.hooks.createTicket({
      title: body.title?.trim() || e.title, goal: `Continue the earlier Claude Code session: ${e.summary}`, runtime: 'claude-cli',
    });
    e.ticketId = ticket.id;
    e.ticketNumber = ticket.number;
    this.hooks.emitChanged();
    return { ticket, action: 'created' };
  }
}
