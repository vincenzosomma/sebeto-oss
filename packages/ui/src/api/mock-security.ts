/**
 * In-memory security log for the mock API (v0.4 B): sample IT Ops events, filters, summary,
 * a fake hash chain, export and the emergency stop. The real log lives in the core.
 */
import {
  GENESIS_HASH, SECURITY_SEVERITIES, uuidv7,
  type Agent, type Id, type Page, type SecurityActor, type SecurityCategory, type SecurityEvent, type SecurityEventsQuery,
  type SecurityLockdownStatus, type SecuritySettings, type SecuritySeverity, type SecuritySummary, type SecurityVerifyResult, type Ticket,
} from '@sebeto/shared';
import { ApiHttpError } from './types';

const MIN = 60_000;

/** Not cryptographic: a stable 64-hex fingerprint for the demo chain. */
function fakeHash(input: string): string {
  let out = '';
  let h = 2166136261;
  for (let round = 0; out.length < 64; round++) {
    for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i) ^ round, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

export interface MockSecurityDeps {
  agents: () => Agent[];
  tickets: () => Ticket[];
  emit: (e: { type: 'security.event'; event: SecurityEvent } | { type: 'security.lockdown'; active: boolean }) => void;
  pauseAll: () => number;
}

interface Draft {
  category: SecurityCategory; action: string; severity?: SecuritySeverity; summary: string;
  actor?: SecurityActor; ticketId?: Id | null; agentId?: Id | null; data?: Record<string, unknown> | null; agoMin?: number;
}

export class MockSecurityLog {
  private events: SecurityEvent[] = [];
  private settings: SecuritySettings = { retentionDays: 0, jsonlMirror: false };
  private lock: SecurityLockdownStatus = { active: false, since: null, reason: null };

  constructor(private readonly deps: MockSecurityDeps) {
    this.seed();
  }

  private seed() {
    const agents = this.deps.agents();
    const tickets = this.deps.tickets();
    const byName = (n: string) => agents.find((a) => a.name === n) ?? null;
    const byNumber = (n: number) => tickets.find((t) => t.number === n) ?? null;
    const agentActor = (a: Agent | null): SecurityActor => ({ type: 'agent', id: a?.id ?? null, name: a?.name ?? 'Agent' });
    const you: SecurityActor = { type: 'user', id: null, name: 'You' };
    const analyst = byName('Analyst');
    const researcher = byName('Researcher');
    const automation = byName('Automation engineer');
    const sysadmin = byName('Sysadmin assistant');
    const comms = byName('Comms writer');
    const drafts: Draft[] = [
      { category: 'system', action: 'system.core_started', severity: 'notice', summary: 'Sebeto 0.4.0 started on 127.0.0.1:7600.', agoMin: 600, data: { version: '0.4.0', port: 7600 } },
      { category: 'auth', action: 'auth.refused.bad_token', severity: 'warning', summary: 'Refused a request with a wrong access token from 192.168.1.44: GET /api/v1/tickets (+12 more in the last minute)', agoMin: 420, data: { ip: '192.168.1.44', reason: 'bad_token', suppressedBefore: 12 } },
      { category: 'agent', action: 'agent.permission_changed', severity: 'warning', actor: you, agentId: comms?.id, summary: `${comms?.name ?? 'Comms writer'}: "Send email" changed from Ask to Allow (less safe).`, agoMin: 300, data: { key: 'email.send', from: 'ask', to: 'allow', loosened: true } },
      { category: 'agent', action: 'agent.permission_changed', severity: 'notice', actor: you, agentId: comms?.id, summary: `${comms?.name ?? 'Comms writer'}: "Send email" changed from Allow to Ask.`, agoMin: 290, data: { key: 'email.send', from: 'allow', to: 'ask', loosened: false } },
      { category: 'session', action: 'session.run_started', actor: agentActor(analyst), agentId: analyst?.id, ticketId: byNumber(101)?.id, summary: `${analyst?.name ?? 'Analyst'} started working (start).`, agoMin: 40 },
      { category: 'tool', action: 'tool.read_file', actor: agentActor(analyst), agentId: analyst?.id, ticketId: byNumber(101)?.id, summary: 'Read Incidents_W45.csv', agoMin: 38, data: { tool: 'read_file', path: 'Incidents_W45.csv', bytes: 182_331 } },
      { category: 'tool', action: 'tool.fetch_url', actor: agentActor(researcher), agentId: researcher?.id, ticketId: byNumber(109)?.id, summary: 'Read web page nvd.nist.gov', agoMin: 70, data: { tool: 'fetch_url', url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1187', untrusted: true } },
      { category: 'permission', action: 'permission.requested', severity: 'notice', actor: agentActor(researcher), agentId: researcher?.id, ticketId: byNumber(109)?.id, summary: 'Asked permission: read a web page (link found inside an untrusted page)', agoMin: 61, data: { key: 'web.read', untrustedInput: true } },
      { category: 'permission', action: 'permission.requested', severity: 'warning', actor: agentActor(automation), agentId: automation?.id, ticketId: byNumber(107)?.id, summary: 'Asked permission: change production (install 9 renewed certificates)', agoMin: 1, data: { key: 'prod.change' } },
      { category: 'permission', action: 'permission.denied', severity: 'warning', actor: you, agentId: sysadmin?.id, ticketId: byNumber(103)?.id, summary: 'Denied: open Assets_2026.xlsx outside the ticket folder', agoMin: 24, data: { key: 'fs.read', decision: 'deny' } },
      { category: 'tool', action: 'tool.run_command', severity: 'notice', actor: agentActor(sysadmin), agentId: sysadmin?.id, ticketId: byNumber(110)?.id, summary: 'Ran command (ok): Get-PSDrive -PSProvider FileSystem', agoMin: 3, data: { tool: 'run_command', shell: 'powershell', exitCode: 0 } },
      { category: 'session', action: 'session.run_ended', actor: agentActor(analyst), agentId: analyst?.id, ticketId: byNumber(106)?.id, summary: 'Run succeeded: turn finished ($0.1200, 15000 tokens).', agoMin: 3 * 24 * 60, data: { status: 'succeeded', costUsd: 0.12, tokensIn: 12000, tokensOut: 3000 } },
      { category: 'connector', action: 'connector.tools_reviewed', severity: 'notice', actor: you, summary: 'Tools of "Runbooks folder" were reviewed (3 tools).', agoMin: 2 * 24 * 60, data: { tools: [{ name: 'read', from: null, to: 'read' }] } },
    ];
    drafts.sort((a, b) => (b.agoMin ?? 0) - (a.agoMin ?? 0));
    for (const d of drafts) this.append(d, false);
  }

  private append(d: Draft, live: boolean): SecurityEvent {
    const prev = this.events[this.events.length - 1];
    const ticket = d.ticketId ? this.deps.tickets().find((t) => t.id === d.ticketId) : undefined;
    const base: Omit<SecurityEvent, 'hash'> = {
      id: uuidv7(), seq: (prev?.seq ?? 0) + 1, at: new Date(Date.now() - (d.agoMin ?? 0) * MIN).toISOString(),
      category: d.category, action: d.action, severity: d.severity ?? 'info',
      actor: d.actor ?? { type: 'system', id: null, name: 'Sebeto' },
      ticketId: d.ticketId ?? null, ticketNumber: ticket?.number ?? null, agentId: d.agentId ?? null, sessionId: null, runId: null,
      summary: d.summary, data: d.data ?? null, prevHash: prev?.hash ?? GENESIS_HASH,
    };
    const event: SecurityEvent = { ...base, hash: fakeHash(JSON.stringify(base)) };
    this.events.push(event);
    if (live) this.deps.emit({ type: 'security.event', event });
    return event;
  }

  record(d: Draft): SecurityEvent {
    return this.append({ ...d, agoMin: 0 }, true);
  }

  list(q: SecurityEventsQuery = {}): Page<SecurityEvent> {
    const cats = q.category ? q.category.split(',') : null;
    const sevs = q.severity ? q.severity.split(',') : null;
    const text = q.q?.toLowerCase();
    let items = [...this.events].reverse().filter((e) =>
      (!q.since || e.at >= q.since) && (!q.until || e.at <= q.until) && (!cats || cats.includes(e.category)) && (!sevs || sevs.includes(e.severity))
      && (!q.agentId || e.agentId === q.agentId) && (!q.ticketId || e.ticketId === q.ticketId) && (q.ticketNumber === undefined || e.ticketNumber === q.ticketNumber)
      && (!text || `${e.summary} ${e.action} ${e.actor.name} ${JSON.stringify(e.data)}`.toLowerCase().includes(text)));
    if (q.cursor) items = items.filter((e) => e.seq < Number(q.cursor));
    const limit = q.limit ?? 50;
    const page = items.slice(0, limit);
    return { items: page, nextCursor: items.length > limit ? String(page[page.length - 1]!.seq) : null };
  }

  summary(hours = 24): SecuritySummary {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const recent = this.events.filter((e) => e.at >= since);
    const bySeverity = Object.fromEntries(SECURITY_SEVERITIES.map((s) => [s, 0])) as Record<SecuritySeverity, number>;
    const byCategory: SecuritySummary['byCategory'] = {};
    const perAgent = new Map<Id, number>();
    for (const e of recent) {
      bySeverity[e.severity]++;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      if (e.agentId) perAgent.set(e.agentId, (perAgent.get(e.agentId) ?? 0) + 1);
    }
    const agents = this.deps.agents();
    return {
      hours, total: recent.length, bySeverity, byCategory,
      deniedPermissions: recent.filter((e) => e.action === 'permission.denied').length,
      untrustedReads: recent.filter((e) => e.category === 'tool' && e.data?.['untrusted'] === true).length,
      rejectedTriggers: recent.filter((e) => e.action === 'trigger.rejected').length,
      activeAgents: [...perAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([agentId, events]) => ({ agentId, events, name: agents.find((a) => a.id === agentId)?.name ?? 'Deleted agent' })),
      lockdown: this.lock.active,
    };
  }

  status(): SecurityLockdownStatus { return { ...this.lock }; }

  /** v0.5 I: true while the emergency stop is on. */
  get locked(): boolean { return this.lock.active; }

  verify(): SecurityVerifyResult {
    const r: SecurityVerifyResult = { ok: true, checked: this.events.length, firstSeq: this.events[0]?.seq ?? null, lastSeq: this.events.at(-1)?.seq ?? null, brokenAtSeq: null, problem: null };
    this.record({ category: 'system', action: 'system.integrity_checked', summary: `Integrity check passed: ${r.checked} event(s) are unchanged.`, data: { ...r } });
    return r;
  }

  export(format: 'jsonl' | 'csv'): { fileName: string; blob: Blob } {
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const body = format === 'jsonl'
      ? this.events.map((e) => JSON.stringify(e)).join('\n') + '\n'
      : ['seq,at,severity,category,action,actor_name,ticket_number,summary,hash', ...this.events.map((e) => [e.seq, e.at, e.severity, e.category, e.action, e.actor.name, e.ticketNumber, e.summary, e.hash].map(cell).join(','))].join('\r\n');
    this.record({ category: 'system', action: 'system.exported', severity: 'notice', summary: `The security log was exported as ${format.toUpperCase()}.`, actor: { type: 'user', id: null, name: 'You' } });
    return { fileName: `sebeto-security-demo.${format}`, blob: new Blob([body], { type: format === 'csv' ? 'text/csv' : 'application/x-ndjson' }) };
  }

  getSettings(): SecuritySettings { return { ...this.settings }; }

  updateSettings(patch: Partial<SecuritySettings>): SecuritySettings {
    if (patch.retentionDays !== undefined && (!Number.isInteger(patch.retentionDays) || patch.retentionDays < 0)) throw new ApiHttpError(400, 'invalid_settings', 'retentionDays must be a whole number of days (0 = keep forever)');
    this.settings = { ...this.settings, ...patch };
    this.record({ category: 'config', action: 'config.security_settings_changed', severity: 'notice', summary: 'Security log settings changed.', actor: { type: 'user', id: null, name: 'You' }, data: { ...this.settings } });
    return { ...this.settings };
  }

  emergencyStop(reason: string) {
    if (reason.trim().length < 3) throw new ApiHttpError(400, 'invalid_request', 'reason: please write a short reason');
    const you: SecurityActor = { type: 'user', id: null, name: 'You' };
    this.lock = { active: true, since: new Date().toISOString(), reason };
    this.deps.emit({ type: 'security.lockdown', active: true });
    this.record({ category: 'system', action: 'system.emergency_stop', severity: 'critical', actor: you, summary: `Emergency stop pressed: ${reason}`, data: { reason } });
    const paused = this.deps.pauseAll();
    this.record({ category: 'system', action: 'system.emergency_stop.agents_paused', severity: 'critical', actor: you, summary: `Emergency stop: ${paused} agent(s) paused.` });
    return { ok: true as const, cancelledRuns: 2, pausedAgents: paused, disabledTriggers: 0 };
  }

  release() {
    this.lock = { active: false, since: null, reason: null };
    this.deps.emit({ type: 'security.lockdown', active: false });
    this.record({ category: 'system', action: 'system.lockdown_released', severity: 'critical', actor: { type: 'user', id: null, name: 'You' }, summary: 'Emergency stop released. Agents stay paused until you resume them.' });
  }
}
