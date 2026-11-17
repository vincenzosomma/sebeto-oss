/**
 * In-memory implementation of SebetoApi with IT Ops sample data and simulated agent replies.
 * Enabled with `?mock=1` or VITE_MOCK=1, so the UI runs without the core server.
 */
import {
  DEFAULT_PERMISSIONS, uuidv7,
  type Agent, type AuditEvent, type CreateAgentBody, type CreateTicketBody, type DecidePermissionBody,
  type HealthResponse, type Id, type ListTicketsQuery, type Message, type MoveTicketBody, type PermissionKey,
  type CommandSpec, type PermissionRequest, type PostMessageBody, type TrustedCommand, type TicketAttachment, attachmentNote,
  type ConnectMailBody, type MailConnectorStatus,
  type IntakeTurnBody, type IntakeTurnResponse, type IntakeAcceptBody, type IntakeAcceptResponse, type ProposedTicket, type AppSettings,
  type ConnectorsResponse, type ConnectorInfo, type AddConnectorBody, type UpdateConnectorBody, type CatalogEntry,
  type OAuthAppStatus, type OAuthProviderId, type SetOAuthAppBody, type StartOAuthResponse, type DisconnectMailResponse,
  type Project, type ProjectSummary, type CreateProjectBody, type UpdateProjectBody, type TagCount, normalizeTags, splitTagQuery, type Run, type RuntimeInfo, type Ticket, type TicketDetail,
  type TicketPage, type TicketStatus, type UpdateAgentBody, type UpdateTicketBody, type WsEvent,
  type Skill, type SkillBody, type DiagnosticsReport, type DeleteAgentResponse,
  type TeamTemplate, type TemplateAgent, type ApplyTemplateBody, type ApplyTemplateResponse,
  PROJECT_COLORS, type Team, type CreateTeamBody, type UpdateTeamBody, type RoutePreviewBody, type RouteDecision, type RouteTicketResponse,
  MAX_SCOPE_CHARS, type SetTicketScopeBody, LOCKDOWN_MESSAGE, TEAM_POLICY_ERRORS,
} from '@sebeto/shared';
import { ApiHttpError, type SebetoApi, type SessionListQuery, type SubscribeOptions } from './types';
import type { ApplyCategoriesBody, OpenSessionBody, SuggestCategoriesBody, UpdateSessionEntryBody } from '@sebeto/shared';
import { MockSessionLibrary } from './mock-sessions';
import { pickDefaultAgent, slugify } from '../lib/agents';
import { MOCK_TEMPLATES } from './mock-templates';
import { MockTriggers } from './mock-triggers';
import { MockAiConnections } from './mock-ai-connections';
import type { CreateAiConnectionBody, UpdateAiConnectionBody } from '@sebeto/shared';
import type { CreateTriggerBody, UpdateTriggerBody, TriggerTestBody } from '@sebeto/shared';
import { MockSecurityLog } from './mock-security';
import type { EmergencyStopBody, SecurityEventsQuery, SecuritySettings } from '@sebeto/shared';
import { mockRoute } from '../lib/teams';
import { MockMemory } from './mock-memory';
import { mockCostsReport } from './mock-costs';
import { MockBackups } from './mock-backups';
import type { BackupSettings, CreateBackupBody, VerifyBackupBody } from '@sebeto/shared';
import type { CostsQuery } from '@sebeto/shared';
import type { MemoryGraphQuery, MemoryListQuery } from './types';
import type { MemoryBackfillBody, SaveMemoryNoteBody } from '@sebeto/shared';

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const now = () => new Date().toISOString();

interface Seed {
  number: number;
  title: string;
  goal: string;
  status: TicketStatus;
  agent: string;
  folder: string;
  agoMin: number;
  cost: number;
  msgs: Array<{ role: Message['role']; text: string; author?: string }>;
  log: string[];
  snapshot?: boolean;
  perm?: { key: PermissionKey; title: string; detail: string; provenance?: string; command?: CommandSpec };
}

const AGENTS: Array<Pick<Agent, 'name' | 'role' | 'job' | 'runtime'>> = [
  { name: 'Analyst', role: 'Service Desk analyst', job: 'Reads service desk exports and writes clear summaries.', runtime: 'claude-cli' },
  { name: 'Comms writer', role: 'Internal communications', job: 'Writes short, friendly notices for staff.', runtime: 'claude-cli' },
  { name: 'Sysadmin assistant', role: 'Infrastructure', job: 'Keeps inventories, runbooks and folders tidy.', runtime: 'claude-cli' },
  { name: 'Automation engineer', role: 'Infrastructure automation', job: 'Automates certificate renewals and routine changes.', runtime: 'codex' },
  { name: 'Researcher', role: 'Security research', job: 'Checks advisories and vendor docs.', runtime: 'gemini' },
];

const SEEDS: Seed[] = [
  {
    number: 101, title: 'Summarise last week’s incidents', status: 'in_progress', agent: 'Analyst', folder: 'ServiceDesk/Incidents',
    agoMin: 2, cost: 0.38, goal: 'Summarise last week’s incidents into the top 5 root causes, with two examples each.',
    msgs: [
      { role: 'user', text: 'Summarise last week’s incidents into the top 5 root causes, with two examples each.' },
      { role: 'agent', text: 'On it. I found 214 tickets in the service desk export. I’ll group them by root cause and pick clear examples.' },
    ],
    log: ['Opened Incidents_W45.csv', 'Grouped 142 tickets into 7 draft causes', 'Reading incident tickets · 142 of 214'],
  },
  {
    number: 102, title: 'Draft maintenance notice for staff', status: 'needs_you', agent: 'Comms writer', folder: 'Comms/Notices',
    agoMin: 8, cost: 0.21, goal: 'Write the notice for Saturday’s email server maintenance (22:00–02:00). Mention the webmail fallback.',
    msgs: [
      { role: 'user', text: 'Write the notice for Saturday’s email server maintenance (22:00–02:00). Mention the webmail fallback.' },
      { role: 'handoff', author: 'Analyst → Comms writer · handoff from T-101', text: 'Top 5 incident causes attached. Cause #2 (full mailboxes) is worth a tip in the notice.' },
      { role: 'handoff', author: 'Comms writer → Service Desk Lead · review', text: 'First draft ready (180 words). Please check the tone.' },
      { role: 'handoff', author: 'Service Desk Lead → Comms writer · approved', text: 'Clear and short. Send it to the owner.' },
      { role: 'agent', text: 'Here’s the draft. I wasn’t sure whether to include the IT hotline number. Should I?' },
    ],
    log: ['Read the last 3 maintenance notices for tone', 'Pulled the window from change CHG-2291', 'Wrote Notice_Maintenance.docx', 'Draft ready. Approve the tone?'],
    snapshot: true,
    perm: {
      key: 'email.send', title: 'Permission needed: send email',
      detail: 'Wants to send Notice_Maintenance to all 1,240 staff via Outlook. The Comms writer is set to “Ask me first” for emails.',
    },
  },
  {
    number: 103, title: 'Clean up asset inventory', status: 'blocked', agent: 'Sysadmin assistant', folder: 'Infra/Assets',
    agoMin: 25, cost: 0.05, goal: 'Remove duplicate laptops and fix the serial number formats in the asset inventory.',
    msgs: [
      { role: 'user', text: 'Remove duplicate laptops and fix the serial number formats in the asset inventory.' },
      { role: 'agent', text: 'I can’t open Assets_2026.xlsx. It’s outside this ticket’s folder. Can you grant access or move it into Infra/Assets?' },
    ],
    log: ['Looked for inventory files', 'Needs access to Assets_2026.xlsx'],
  },
  {
    number: 104, title: 'Compare 3 backup solutions', status: 'backlog', agent: 'Analyst', folder: 'Research/Backup',
    agoMin: 26 * 60, cost: 0, goal: 'Compare 3 backup solutions on price, retention, restore time and setup effort.',
    msgs: [{ role: 'system', text: 'Ticket created from intake. Press Start when ready.' }],
    log: [],
  },
  {
    number: 105, title: 'Plan Windows 11 rollout', status: 'backlog', agent: 'Sysadmin assistant', folder: 'Infra/Win11',
    agoMin: 50 * 60, cost: 0, goal: 'Propose a phased Windows 11 rollout schedule per office.',
    msgs: [{ role: 'agent', text: 'Ticket created. I’ll propose a phased schedule once you add the device count per office.' }],
    log: [],
  },
  {
    number: 107, title: 'Renew expiring SSL certificates', status: 'in_progress', agent: 'Automation engineer', folder: 'Infra/Certs',
    agoMin: 0.3, cost: 0.62, goal: 'Find certificates expiring in the next 30 days and renew them.',
    msgs: [
      { role: 'user', text: 'Find certificates expiring in the next 30 days and renew them.' },
      { role: 'agent', text: 'I found 14. I’m renewing them in staging now and will show you the list before touching production.' },
    ],
    log: ['Scanned 86 hosts', 'Found 14 certificates expiring within 30 days', 'Renewed 9 of 14 certificates in staging'],
    snapshot: true,
    perm: {
      key: 'prod.change', title: 'Permission needed: change production',
      detail: 'Wants to install 9 renewed certificates on the production web servers. They were tested in staging first.',
    },
  },
  {
    number: 109, title: 'Check new CVEs for our firewall', status: 'needs_you', agent: 'Researcher', folder: 'Security/CVE',
    agoMin: 60, cost: 0.44, goal: 'Check whether any new CVEs affect our firewall model and firmware.',
    msgs: [
      { role: 'user', text: 'Check whether any new CVEs affect our firewall model and firmware.' },
      { role: 'agent', text: 'Three CVEs match our firmware, and one is rated critical. Should I draft a patch plan for the critical one first?' },
    ],
    log: ['Searched NVD and vendor advisories', 'Matched firmware 7.2.4', 'Wrote CVE_report.xlsx', 'Found 3 CVEs. Which to prioritise?'],
    perm: {
      key: 'web.read', title: 'Permission needed: read a web page',
      detail: 'Wants to open the vendor’s PSIRT page to confirm the fixed firmware version.',
      provenance: 'Link found inside the CVE-2026-1187 description (nvd.nist.gov)',
    },
  },
  {
    number: 110, title: 'Check free disk space on file servers', status: 'needs_you', agent: 'Sysadmin assistant', folder: 'Infra/Storage',
    agoMin: 4, cost: 0.03, goal: 'Check free disk space on this machine and warn me about any drive under 15% free.',
    msgs: [
      { role: 'user', text: 'Check free disk space on this machine and warn me about any drive under 15% free.' },
      { role: 'agent', text: 'I need to run a read-only command to list the disks and their free space.' },
    ],
    log: ['Needs to run a command'],
    perm: {
      key: 'script.run', title: 'Permission needed: run a command',
      detail: 'Shell: bash\nFolder: /Users/you/.sebeto/workspace/tickets/T-110\nReason: List disks and free space (read-only)\n\ndf -h',
      command: { shell: 'bash', command: 'df -h' },
    },
  },
  {
    number: 111, title: 'HELP-612 Wi-Fi keeps dropping in meeting room 2', status: 'needs_you', agent: 'Analyst', folder: 'ServiceDesk/HelpDesk',
    agoMin: 2, cost: 0.04, goal: 'New IT request from Jane Doe in #help-desk.\n\nJira ticket: HELP-612\n\nRequest:\nThe Wi-Fi keeps dropping on my laptop in meeting room 2, every few minutes.\n\nUse the Help Desk triage skill: classify it, draft the reply, then ask to post it in the thread.',
    msgs: [
      { role: 'agent', text: '*self_help* (confidence 0.86) · P3\nJane’s laptop loses Wi-Fi in meeting room 2; likely a stale saved network. If it continues, IT should check that room’s access point.\n\n*Draft reply:*\nHi Jane! Please try forgetting the network and joining again. If it still drops, reply here and we will check the access point in that room.' },
    ],
    log: ['Read the request', 'Classified: self_help, P3', 'Drafted the reply', 'Wants to post the reply in the #help-desk thread'],
    perm: {
      key: 'tool.change', title: 'Permission needed: claude.ai Slack: slack_send_message',
      detail: 'Claude connector: claude.ai Slack\nTool: slack_send_message\n\n{\n  "channel_id": "C0HELP01",\n  "thread_ts": "1794850000.000100",\n  "message": "Hi Jane! Please try forgetting the network and joining again. If it still drops, reply here and we will check the access point in that room."\n}',
      provenance: 'Slack #help-desk (message from Jane Doe)',
    },
  },
  {
    number: 106, title: 'Organise runbooks folder', status: 'done', agent: 'Sysadmin assistant', folder: 'Infra/Runbooks',
    agoMin: 3 * 24 * 60, cost: 0.12, goal: 'Rename the runbooks to system_task_date and sort them into a folder per system.',
    msgs: [
      { role: 'user', text: 'Rename the runbooks to system_task_date and sort them into a folder per system.' },
      { role: 'agent', text: 'Done. 84 runbooks renamed and sorted. 4 had no clear system; I listed them in Unsorted.txt.' },
    ],
    log: ['Read 88 documents', 'Renamed 84 files', '84 runbooks renamed and sorted by system'],
    snapshot: true,
  },
  {
    number: 108, title: 'Write VPN setup KB article', status: 'done', agent: 'Comms writer', folder: 'ServiceDesk/KB',
    agoMin: 6 * 24 * 60, cost: 0.29, goal: 'Write a step-by-step KB article for setting up the new VPN client on Windows and Mac.',
    msgs: [
      { role: 'user', text: 'Write a step-by-step KB article for setting up the new VPN client on Windows and Mac.' },
      { role: 'agent', text: 'Done, with screenshot placeholders. Someone should test the Mac steps on a real device.' },
    ],
    log: ['Read the vendor install guide', 'Wrote 12 steps per OS', 'KB article ready for review'],
    snapshot: true,
  },
];

const ARCHIVE = [
  'Reset MFA for new starters', 'Export mailbox sizes', 'Tidy printer drivers share', 'Document DHCP scopes',
  'Check UPS battery dates', 'Summarise October change log', 'List shared mailboxes without owners', 'Archive old VPN profiles',
  'Review guest Wi-Fi policy', 'Inventory meeting-room screens', 'Draft password reset KB', 'Check backup job failures',
];

const fakeOid = () => Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export interface MockOptions {
  /** Multiplier for simulated delays (0 = instant, for tests). */
  speed?: number;
}

export class MockApi implements SebetoApi {
  readonly mode = 'mock' as const;
  private agents = new Map<Id, Agent>();
  private tickets = new Map<Id, Ticket>();
  private messages: Message[] = [];
  private events: AuditEvent[] = [];
  private perms = new Map<Id, PermissionRequest>();
  private trusted: TrustedCommand[] = [];
  private mail: MailConnectorStatus = { connected: false };
  private settings: AppSettings = { intakeModel: 'haiku', setupCompleted: true, newTicketTeam: 'manual', autoTags: true, budgetBlocks: true };
  private teams = new Map<Id, Team>();
  private connectors: ConnectorInfo[] = [];
  private runs = new Map<Id, Run>();
  private skills: Array<Omit<Skill, 'usedBy'>> = [];
  private savedTemplates: TeamTemplate[] = [];
  private listeners = new Set<(e: WsEvent) => void>();
  private nextNumber = 111;
  private readonly speed: number;

  constructor(opts: MockOptions = {}) {
    this.speed = opts.speed ?? 1;
    this.seed();
    this.seedTeam();
    // v0.4 §D: one board ticket came from an alert (shows the origin badge).
    const alerted = [...this.tickets.values()].find((t) => t.number === 110);
    if (alerted) alerted.origin = { kind: 'trigger', triggerKind: 'webhook', source: 'Alertmanager', untrusted: true };
    const askIt = [...this.tickets.values()].find((t) => t.number === 111);
    if (askIt) askIt.origin = { kind: 'trigger', triggerKind: 'slack', source: 'Slack #help-desk', untrusted: true };
    this.seedTeams();
  }

  // ---------- v0.4 teams (demo data + the same rules as the core, simplified)
  private seedTeams() {
    const find = (name: string) => [...this.agents.values()].find((a) => a.name === name);
    const make = (name: string, slug: string, color: string, hints: string, members: string[]) => {
      const ids = members.map((m) => find(m)?.id).filter((x): x is Id => !!x);
      const t: Team = { id: uuidv7(), slug, name, description: '', color, leadAgentId: ids[0] ?? null, routingHints: hints, memberIds: ids, runtime: null, model: null, lockRuntime: false, requireScope: false, claudeConnectors: [], createdAt: now(), updatedAt: now() };
      this.teams.set(t.id, t);
      for (const id of ids) this.agents.set(id, { ...this.agents.get(id)!, teamId: t.id });
    };
    make('Infrastructure', 'infrastructure', '#2E7D5B', 'servers, VMware, storage, backup, network, VPN, firewall, DNS, certificates', ['Sysadmin assistant', 'Automation engineer']);
    make('Service Desk', 'service-desk', '#0E5A8A', 'password resets, accounts, printers, laptops, Outlook, Teams, access requests', ['Analyst', 'Comms writer']);
    make('Security', 'security', '#B5532C', 'CVE, patching, vulnerabilities, phishing, incidents, access reviews, hardening', ['Researcher']);
    for (const t of this.tickets.values()) {
      const teamId = t.agentId ? this.agents.get(t.agentId)?.teamId ?? null : null;
      this.tickets.set(t.id, { ...t, teamId });
    }
  }
  private teamWithMembers(t: Team): Team {
    return { ...t, memberIds: [...this.agents.values()].filter((a) => a.teamId === t.id).map((a) => a.id) };
  }
  private teamsChanged() { this.emit({ type: 'teams.changed' }); }
  /** v0.4 F/G: the same 409s as the core. */
  private lockedError(team: Team, runtime: string, what: string) {
    return new ApiHttpError(409, 'runtime_locked', `${what} belongs to the team "${team.name}", whose AI is locked to ${team.runtime}. It cannot use ${runtime}. Turn the lock off in Teams first if you really want this.`);
  }
  private scopeTeam(t: Pick<Ticket, 'teamId' | 'agentId'>): Team | undefined {
    for (const id of [t.teamId, t.agentId ? this.agents.get(t.agentId)?.teamId : null]) {
      const team = id ? this.teams.get(id) : undefined;
      if (team?.requireScope) return team;
    }
    return undefined;
  }
  /** v0.5 I: the same 409 lockdown as the core (one security event per refusal). */
  private assertNotLocked(route: string, ticketId: Id | null = null) {
    if (!this.securityLog?.locked) return;
    const t = ticketId ? this.tickets.get(ticketId) : undefined;
    this.security.record({
      category: 'system', action: 'system.run_refused', severity: 'warning', actor: { type: 'user', id: null, name: 'You' },
      ticketId, agentId: t?.agentId ?? null,
      summary: `Emergency stop is on: refused a request that would wake an agent${t ? ` for T-${t.number}` : ''} (${route}).`,
      data: { route, reason: 'lockdown' },
    });
    throw new ApiHttpError(409, TEAM_POLICY_ERRORS.lockdown, LOCKDOWN_MESSAGE);
  }
  private assertScope(t: Ticket) {
    const team = t.scope ? undefined : this.scopeTeam(t);
    if (team) throw new ApiHttpError(409, 'scope_required', `The team "${team.name}" needs a written scope before this ticket can start. Add it in the ticket's Scope box, tick the confirmation, then start again.`);
  }
  async setTicketScope(id: Id, body: SetTicketScopeBody): Promise<Ticket> {
    await this.wait();
    this.mustTicket(id);
    if (body.confirm !== true) throw new ApiHttpError(400, 'scope_not_confirmed', 'Tick "I confirm this scope is written and authorised" to save it.');
    if (!body.text.trim()) throw new ApiHttpError(400, 'scope_empty', 'Write the scope, or load it from a file.');
    if (body.text.length > MAX_SCOPE_CHARS) throw new ApiHttpError(400, 'scope_too_long', 'The scope is too long.');
    if (this.activeRun(id)) throw new ApiHttpError(409, 'run_active', 'Stop the running agent before changing the scope.');
    const bytes = new TextEncoder().encode(body.text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.addEvent(id, 'info', `Scope added and confirmed by you (sha256 ${sha256.slice(0, 12)}…, ${body.text.length} characters)`);
    return this.patchTicket(id, { scope: { text: body.text, fileName: body.fileName ?? null, sha256, confirmedAt: now() } });
  }
  async clearTicketScope(id: Id): Promise<Ticket> {
    await this.wait();
    if (this.activeRun(id)) throw new ApiHttpError(409, 'run_active', 'Stop the running agent before removing the scope.');
    this.addEvent(id, 'info', 'Scope removed by you');
    return this.patchTicket(id, { scope: null });
  }
  private routeInput(t: Pick<Ticket, 'title' | 'goal' | 'tags' | 'projectId'>): RoutePreviewBody {
    return { title: t.title, goal: t.goal, tags: t.tags ?? [], projectId: t.projectId ?? null };
  }
  private decide(input: RoutePreviewBody): RouteDecision {
    return mockRoute(input, [...this.teams.values()].map((t) => this.teamWithMembers(t)), [...this.agents.values()]);
  }
  private bestMember(teamId: Id): Id | null {
    const team = this.teams.get(teamId);
    const members = [...this.agents.values()].filter((a) => a.teamId === teamId && !a.paused);
    return members.find((a) => a.id === team?.leadAgentId)?.id ?? members[0]?.id ?? null;
  }
  private applyRoute(id: Id, d: RouteDecision): Ticket {
    const cur = this.mustTicket(id);
    const patch: Partial<Ticket> = { teamId: d.teamId };
    if (d.agentId && !cur.currentSessionId) patch.agentId = d.agentId;
    const t = this.patchTicket(id, patch);
    const team = d.teamId ? this.teams.get(d.teamId)?.name ?? 'a team' : 'no team';
    const e: AuditEvent = { id: uuidv7(), ticketId: id, runId: null, kind: 'info', summary: `Routed to ${team} → ${this.agentName(t)}: ${d.reason}`, data: { routing: d }, createdAt: now() };
    this.events.push(e);
    this.emit({ type: 'event.created', event: e });
    return t;
  }

  async listTeams(): Promise<Team[]> {
    await this.wait(60);
    return [...this.teams.values()].map((t) => this.teamWithMembers(t)).sort((a, b) => a.name.localeCompare(b.name));
  }
  async createTeam(body: CreateTeamBody): Promise<Team> {
    await this.wait();
    const name = body.name.trim();
    if ([...this.teams.values()].some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new ApiHttpError(409, 'team_exists', `A team called "${name}" already exists.`);
    let slug = body.slug || slugify(name) || 'team';
    for (let n = 2; [...this.teams.values()].some((t) => t.slug === slug); n++) slug = `${slugify(name)}-${n}`;
    const t: Team = {
      id: uuidv7(), slug, name, description: body.description ?? '', color: body.color ?? PROJECT_COLORS[this.teams.size % PROJECT_COLORS.length]!,
      leadAgentId: body.leadAgentId ?? null, routingHints: body.routingHints ?? '', memberIds: [], runtime: body.runtime ?? null, model: body.runtime ? body.model ?? null : null,
      lockRuntime: !!body.lockRuntime && !!body.runtime, requireScope: !!body.requireScope, claudeConnectors: [...(body.claudeConnectors ?? [])], createdAt: now(), updatedAt: now(),
    };
    if (body.lockRuntime && !body.runtime) throw new ApiHttpError(400, 'team_lock_needs_runtime', 'Choose the team\'s AI before locking the team to it.');
    this.teams.set(t.id, t);
    if (t.leadAgentId) await this.updateAgent(t.leadAgentId, { teamId: t.id });
    this.teamsChanged();
    return this.teamWithMembers(t);
  }
  async updateTeam(id: Id, body: UpdateTeamBody): Promise<Team> {
    await this.wait();
    const cur = this.teams.get(id);
    if (!cur) throw new ApiHttpError(404, 'not_found', 'Team not found');
    if (body.name && [...this.teams.values()].some((t) => t.id !== id && t.name.toLowerCase() === body.name!.trim().toLowerCase())) {
      throw new ApiHttpError(409, 'team_exists', `A team called "${body.name}" already exists.`);
    }
    const { applyToMembers, ...fields } = body;
    const t: Team = { ...cur, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), updatedAt: now() };
    if (body.runtime !== undefined && body.runtime !== cur.runtime && body.model === undefined) t.model = null;
    if (!t.runtime) { t.model = null; if (t.lockRuntime) throw new ApiHttpError(400, 'team_lock_needs_runtime', 'Choose the team\'s AI before locking the team to it.'); }
    this.teams.set(id, t);
    // Same rule as the core: forced when the lock turns on or a locked team changes runtime.
    if (t.runtime && (applyToMembers || (t.lockRuntime && (!cur.lockRuntime || t.runtime !== cur.runtime)))) {
      for (const a of [...this.agents.values()].filter((x) => x.teamId === id)) {
        const next = { ...a, runtime: t.runtime, model: t.model ?? null };
        this.agents.set(a.id, next);
        this.emit({ type: 'agent.updated', agent: next });
      }
    }
    if (body.leadAgentId) await this.updateAgent(body.leadAgentId, { teamId: id });
    this.teamsChanged();
    return this.teamWithMembers(t);
  }
  async deleteTeam(id: Id): Promise<void> {
    await this.wait();
    if (!this.teams.delete(id)) throw new ApiHttpError(404, 'not_found', 'Team not found');
    for (const a of this.agents.values()) if (a.teamId === id) { const next = { ...a, teamId: null }; this.agents.set(a.id, next); this.emit({ type: 'agent.updated', agent: next }); }
    for (const t of this.tickets.values()) if (t.teamId === id) this.patchTicket(t.id, { teamId: null });
    this.teamsChanged();
  }
  async previewRoute(body: RoutePreviewBody): Promise<RouteDecision> {
    await this.wait(150);
    return this.decide(body);
  }
  async routeTicket(id: Id): Promise<RouteTicketResponse> {
    await this.wait(300);
    const decision = this.decide(this.routeInput(this.mustTicket(id)));
    return { ticket: this.applyRoute(id, decision), decision };
  }

  // ---------- v0.4 §D triggers (api/mock-triggers.ts)
  private triggerMock = new MockTriggers((e) => this.emit(e));
  async listTriggers() { await this.wait(); return this.triggerMock.list(); }
  async createTrigger(body: CreateTriggerBody) { await this.wait(); return this.triggerMock.create(body); }
  async updateTrigger(id: Id, body: UpdateTriggerBody) { await this.wait(); return this.triggerMock.update(id, body); }
  async deleteTrigger(id: Id) { await this.wait(); this.triggerMock.remove(id); }
  async rotateTriggerSecret(id: Id) { await this.wait(); return this.triggerMock.rotate(id); }
  async testTrigger(id: Id, body: TriggerTestBody) { await this.wait(); return this.triggerMock.test(id, body); }
  async listTriggerFires(id: Id, limit?: number) { await this.wait(); return this.triggerMock.listFires(id, limit); }

  // ---------- seed data
  private seed() {
    const byName = new Map<string, Agent>();
    for (const a of AGENTS) {
      const agent: Agent = {
        id: uuidv7(), name: a.name, role: a.role, job: a.job, runtime: a.runtime, model: null, reportsTo: null,
        heartbeatMinutes: 60, monthlyBudgetUsd: 30, permissions: { ...DEFAULT_PERMISSIONS }, paused: false, skills: [],
        createdAt: ago(30 * 24 * 60 * MIN),
      };
      this.agents.set(agent.id, agent);
      byName.set(a.name, agent);
    }
    for (const s of SEEDS) {
      const at = ago(s.agoMin * MIN);
      const created = ago((s.agoMin + 30) * MIN);
      const agent = byName.get(s.agent) ?? null;
      const t: Ticket = {
        id: uuidv7(), number: s.number, title: s.title, goal: s.goal, status: s.status, agentId: agent?.id ?? null,
        runtime: null, model: null, currentSessionId: null, folder: `C:/Sebeto/${s.folder}`, costCapUsd: 2, costUsd: s.cost,
        parentId: null, dependsOn: [], createdAt: created, updatedAt: at,
      };
      this.tickets.set(t.id, t);
      let run: Run | null = null;
      if (s.status !== 'backlog') {
        run = {
          id: uuidv7(), sessionId: uuidv7(), ticketId: t.id, jobId: null, trigger: 'start',
          status: s.status === 'in_progress' ? 'running' : 'succeeded', startedAt: created,
          endedAt: s.status === 'in_progress' ? null : at, tokensIn: 12000, tokensOut: 3000, costUsd: s.cost, exitReason: null,
          snapshotBefore: s.snapshot ? fakeOid() : null, snapshotAfter: null,
        };
        this.runs.set(run.id, run);
      }
      s.msgs.forEach((m, i) => {
        this.messages.push({
          id: uuidv7(), ticketId: t.id, runId: run?.id ?? null, role: m.role,
          author: m.author ?? (m.role === 'user' ? 'You' : m.role === 'system' ? 'Sebeto' : s.agent), text: m.text,
          createdAt: ago((s.agoMin + 20 - i) * MIN),
        });
      });
      this.events.push({ id: uuidv7(), ticketId: t.id, runId: null, kind: 'info', summary: 'Ticket created', data: null, createdAt: created });
      if (s.snapshot && run) {
        this.events.push({
          id: uuidv7(), ticketId: t.id, runId: run.id, kind: 'snapshot', summary: `Snapshot saved before changing ${s.folder}`,
          data: null, createdAt: ago((s.agoMin + 15) * MIN),
        });
      }
      s.log.forEach((summary, i) => {
        this.events.push({
          id: uuidv7(), ticketId: t.id, runId: run?.id ?? null, kind: 'tool', summary, data: null,
          createdAt: ago((s.agoMin + s.log.length - i) * MIN),
        });
      });
      if (s.perm) {
        const p: PermissionRequest = {
          id: uuidv7(), ticketId: t.id, runId: run?.id ?? null, agentId: agent?.id ?? null, key: s.perm.key, title: s.perm.title,
          detail: s.perm.detail, provenance: s.perm.provenance ?? null, command: s.perm.command ?? null, state: 'pending',
          alwaysAllowed: false, taskScoped: false, createdAt: at, decidedAt: null,
        };
        this.perms.set(p.id, p);
      }
    }
    // Extra completed tickets so pagination ("Show more") has something to show.
    const agentIds = [...this.agents.keys()];
    ARCHIVE.forEach((title, i) => {
      const t: Ticket = {
        id: uuidv7(), number: 80 + i, title, goal: title, status: 'done', agentId: agentIds[i % agentIds.length] ?? null,
        runtime: null, model: null, currentSessionId: null, folder: 'C:/Sebeto/Archive', costCapUsd: 2,
        costUsd: Math.round((0.05 + i * 0.03) * 100) / 100, parentId: null, dependsOn: [],
        createdAt: ago((10 + i) * 24 * 60 * MIN), updatedAt: ago((9 + i) * 24 * 60 * MIN),
      };
      this.tickets.set(t.id, t);
      this.events.push({ id: uuidv7(), ticketId: t.id, runId: null, kind: 'status', summary: 'Completed', data: null, createdAt: t.updatedAt });
    });
    // Like the core: every ticket carries its latest audit event, so cards show it right after a reload.
    const latest = new Map<Id, AuditEvent>();
    for (const e of this.events) {
      const cur = latest.get(e.ticketId);
      if (!cur || cur.createdAt <= e.createdAt) latest.set(e.ticketId, e);
    }
    for (const t of this.tickets.values()) {
      const e = latest.get(t.id);
      t.lastActivity = e ? { summary: e.summary, at: e.createdAt } : null;
    }
  }

  // ---------- helpers
  private emit(e: WsEvent) {
    for (const l of this.listeners) l(e);
  }
  private later(ms: number, fn: () => void) {
    setTimeout(fn, ms * this.speed);
  }
  private wait(ms = 120) {
    return new Promise<void>((r) => setTimeout(r, ms * this.speed));
  }
  private mustTicket(id: Id): Ticket {
    const t = this.tickets.get(id);
    if (!t) throw new ApiHttpError(404, 'not_found', 'Ticket not found');
    return t;
  }
  private agentName(t: Ticket) {
    return (t.agentId && this.agents.get(t.agentId)?.name) || 'Agent';
  }
  private patchTicket(id: Id, patch: Partial<Ticket>): Ticket {
    const t = { ...this.mustTicket(id), ...patch, updatedAt: now() };
    this.tickets.set(id, t);
    this.emit({ type: 'ticket.updated', ticket: t });
    return t;
  }
  private addMessage(ticketId: Id, role: Message['role'], author: string, text: string, runId: Id | null = null): Message {
    const m: Message = { id: uuidv7(), ticketId, runId, role, author, text, createdAt: now() };
    this.messages.push(m);
    this.emit({ type: 'message.created', message: m });
    return m;
  }
  private addEvent(ticketId: Id, kind: AuditEvent['kind'], summary: string, runId: Id | null = null) {
    const e: AuditEvent = { id: uuidv7(), ticketId, runId, kind, summary, data: null, createdAt: now() };
    this.events.push(e);
    const t = this.tickets.get(ticketId);
    // Keep the stored ticket's lastActivity current (no ticket.updated: event.created already tells the UI).
    if (t) this.tickets.set(ticketId, { ...t, lastActivity: { summary, at: e.createdAt } });
    this.emit({ type: 'event.created', event: e });
  }
  private activeRun(ticketId: Id): Run | undefined {
    return [...this.runs.values()].find((r) => r.ticketId === ticketId && (r.status === 'running' || r.status === 'queued'));
  }
  private setRun(run: Run) {
    this.runs.set(run.id, run);
    this.emit({ type: 'run.updated', run });
  }

  /** Simulates one agent run: a couple of steps, a cost bump, then a reply that needs the user. */
  private simulateRun(ticketId: Id, trigger: Run['trigger'], reply: string) {
    const t = this.mustTicket(ticketId);
    const prev = this.activeRun(ticketId);
    if (prev) this.setRun({ ...prev, status: 'succeeded', endedAt: now() });
    const run: Run = {
      id: uuidv7(), sessionId: t.currentSessionId ?? uuidv7(), ticketId, jobId: null, trigger, status: 'running', startedAt: now(),
      endedAt: null, tokensIn: 0, tokensOut: 0, costUsd: 0, exitReason: null, snapshotBefore: fakeOid(), snapshotAfter: null,
    };
    this.setRun(run);
    this.patchTicket(ticketId, { status: 'in_progress', currentSessionId: run.sessionId });
    this.addEvent(ticketId, 'snapshot', 'Snapshot saved before working', run.id);
    const name = this.agentName(t);
    const alive = () => this.runs.get(run.id)?.status === 'running';
    this.later(900, () => {
      if (alive()) this.addEvent(ticketId, 'tool', 'Read the files in the ticket folder', run.id);
    });
    this.later(1800, () => {
      if (!alive()) return;
      this.addEvent(ticketId, 'tool', 'Wrote a first draft', run.id);
      const cur = this.mustTicket(ticketId);
      this.patchTicket(ticketId, { costUsd: Math.round((cur.costUsd + 0.07) * 100) / 100 });
    });
    this.later(2800, () => {
      if (!alive()) return;
      this.addMessage(ticketId, 'agent', name, reply, run.id);
      const cur = this.runs.get(run.id) ?? run;
      this.setRun({ ...cur, status: 'succeeded', endedAt: now(), costUsd: 0.07, tokensIn: 5200, tokensOut: 900 });
      this.addEvent(ticketId, 'status', 'Waiting for your answer', run.id);
      this.patchTicket(ticketId, { status: 'needs_you' });
    });
  }

  // ---------- SebetoApi
  async health(): Promise<HealthResponse> {
    return { ok: true, version: '0.1.0-mock', workspace: 'IT Ops workspace' };
  }

  async listTickets(q: ListTicketsQuery = {}): Promise<TicketPage> {
    await this.wait();
    const split = splitTagQuery(q.q ?? '');
    const needle = split.text.toLowerCase();
    const wantTags = normalizeTags([...(q.tag ? [q.tag] : []), ...split.tags]);
    let list = [...this.tickets.values()].filter((t) => !!t.deletedAt === !!q.deleted);
    if (q.status) list = list.filter((t) => t.status === q.status);
    if (q.projectId === 'none') list = list.filter((t) => !t.projectId);
    else if (q.projectId) list = list.filter((t) => t.projectId === q.projectId);
    if (wantTags.length) list = list.filter((t) => wantTags.every((tag) => (t.tags ?? []).includes(tag)));
    if (q.teamId === 'none') list = list.filter((t) => !t.teamId);
    else if (q.teamId) list = list.filter((t) => t.teamId === q.teamId);
    if (needle) {
      list = list.filter((t) => {
        const hay = `t-${t.number} ${t.title} ${t.goal}`.toLowerCase();
        if (hay.includes(needle)) return true;
        return this.messages.some((m) => m.ticketId === t.id && m.text.toLowerCase().includes(needle));
      });
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = q.cursor ? Number(q.cursor) || 0 : 0;
    const limit = q.limit ?? 50;
    const items = list.slice(offset, offset + limit);
    const next = offset + limit < list.length ? String(offset + limit) : null;
    return { items, nextCursor: next };
  }

  async createTicket(body: CreateTicketBody, internal = false): Promise<Ticket> {
    await this.wait();
    if (body.start && !internal) this.assertNotLocked('POST /tickets (start)');
    const number = this.nextNumber++;
    const t: Ticket = {
      id: uuidv7(), number, title: body.title, goal: body.goal, status: 'backlog', agentId: body.agentId ?? null,
      runtime: body.runtime ?? null, model: body.model ?? null, currentSessionId: null, folder: `C:/Sebeto/Tickets/T-${number}`,
      costCapUsd: body.costCapUsd ?? 2, costUsd: 0, parentId: body.parentId ?? null, dependsOn: body.dependsOn ?? [],
      projectId: body.projectId ?? null, tags: normalizeTags(body.tags ?? []),
      teamId: body.teamId && body.teamId !== 'auto' ? body.teamId : body.teamId === undefined && body.agentId ? this.agents.get(body.agentId)?.teamId ?? null : null,
      createdAt: now(), updatedAt: now(), lastActivity: null,
    };
    if (t.teamId && !t.agentId) t.agentId = this.bestMember(t.teamId);
    if (!t.agentId) t.agentId = pickDefaultAgent([...this.agents.values()])?.id ?? null;
    for (const id of [t.teamId, t.agentId ? this.agents.get(t.agentId)?.teamId : null]) {
      const team = id ? this.teams.get(id) : undefined;
      if (body.runtime && team?.lockRuntime && team.runtime !== body.runtime) throw this.lockedError(team, body.runtime, 'This ticket');
    }
    if (body.start) this.assertScope(t);
    this.tickets.set(t.id, t);
    this.emit({ type: 'ticket.updated', ticket: t });
    if (body.goal.trim()) this.addMessage(t.id, 'user', 'You', body.goal);
    this.addEvent(t.id, 'info', 'Ticket created');
    if (body.teamId === 'auto') this.applyRoute(t.id, this.decide(this.routeInput(t)));
    if (body.start) {
      this.later(300, () =>
        this.simulateRun(t.id, 'start', `I’ve made a start on “${t.title}”. Before I finish: which format do you want at the end?`),
      );
    }
    return t;
  }

  async getTicket(id: Id): Promise<TicketDetail> {
    await this.wait(80);
    const ticket = this.mustTicket(id);
    return {
      ticket,
      messages: this.messages.filter((m) => m.ticketId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      events: this.events.filter((e) => e.ticketId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      permissions: [...this.perms.values()].filter((p) => p.ticketId === id),
      runs: [...this.runs.values()].filter((r) => r.ticketId === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      children: [...this.tickets.values()].filter((t) => t.parentId === id),
      parent: ticket.parentId ? this.tickets.get(ticket.parentId) ?? null : null,
    };
  }

  async deleteTicket(id: Id): Promise<Ticket> {
    await this.wait();
    const t = this.patchTicket(id, { deletedAt: new Date().toISOString() });
    this.emit({ type: 'ticket.deleted', ticketId: id });
    return t;
  }

  async restoreTicket(id: Id): Promise<Ticket> {
    await this.wait();
    return this.patchTicket(id, { deletedAt: null });
  }

  async purgeTicket(id: Id): Promise<void> {
    await this.wait();
    this.tickets.delete(id);
    this.emit({ type: 'ticket.deleted', ticketId: id });
  }

  async updateTicket(id: Id, body: UpdateTicketBody): Promise<Ticket> {
    await this.wait();
    const { teamId, ...rest } = body;
    const patch: Partial<Ticket> = rest.tags ? { ...rest, tags: normalizeTags(rest.tags) } : { ...rest };
    if (teamId !== undefined && teamId !== 'auto') {
      patch.teamId = teamId;
      const cur = this.mustTicket(id);
      if (teamId && body.agentId === undefined && !cur.currentSessionId && this.agents.get(cur.agentId ?? '')?.teamId !== teamId) {
        patch.agentId = this.bestMember(teamId) ?? cur.agentId;
      }
    }
    const t = this.patchTicket(id, patch);
    return teamId === 'auto' ? this.applyRoute(id, this.decide(this.routeInput(t))) : t;
  }

  async moveTicket(id: Id, body: MoveTicketBody): Promise<Ticket> {
    await this.wait();
    const t = this.mustTicket(id);
    if (t.status === body.status) return t;
    this.addEvent(id, 'status', `Moved by you: ${t.status.replace('_', ' ')} → ${body.status.replace('_', ' ')}`);
    return this.patchTicket(id, { status: body.status });
  }

  private readonly attachments = new Map<string, Blob>();

  async uploadAttachment(id: Id, name: string, data: string): Promise<TicketAttachment> {
    await this.wait();
    this.mustTicket(id);
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'file';
    const type = /\.(png|jpe?g|gif|webp)$/i.test(safe) ? `image/${safe.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg')}` : 'application/octet-stream';
    this.attachments.set(`${id}/${safe}`, new Blob([bytes], { type }));
    return { name: safe, path: `attachments/${safe}`, size: bytes.length, type };
  }

  async getAttachment(id: Id, name: string): Promise<Blob> {
    const b = this.attachments.get(`${id}/${name}`);
    if (!b) throw new ApiHttpError(404, 'not_found', 'No such attachment');
    return b;
  }

  async postMessage(id: Id, body: PostMessageBody): Promise<Message> {
    await this.wait();
    const t = this.mustTicket(id);
    this.assertNotLocked('POST /tickets/:id/messages', id);
    this.assertScope(t);
    const m = this.addMessage(id, 'user', 'You', `${body.text || 'See the attached file(s).'}${attachmentNote(body.attachments ?? [])}`);
    if (!this.activeRun(id) && t.status !== 'done') {
      this.later(400, () =>
        this.simulateRun(id, 'message', 'Got it. I’ve updated the work with that. Anything else before I mark it complete?'),
      );
    }
    return m;
  }

  async startTicket(id: Id): Promise<void> {
    await this.wait();
    const t = this.mustTicket(id);
    this.assertNotLocked('POST /tickets/:id/start', id);
    this.assertScope(t);
    if (this.activeRun(id)) throw new ApiHttpError(409, 'already_running', 'This ticket is already running');
    this.simulateRun(id, 'start', `I’ve worked on “${t.title}”. The draft is in the ticket folder. Should I continue?`);
  }

  async cancelTicket(id: Id): Promise<void> {
    await this.wait();
    const run = this.activeRun(id);
    if (run) this.setRun({ ...run, status: 'cancelled', endedAt: now(), exitReason: 'cancelled by user' });
    this.addMessage(id, 'system', 'Sebeto', 'Run cancelled. Nothing else will happen until you start it again.');
    this.addEvent(id, 'status', 'Run cancelled by you', run?.id ?? null);
    this.patchTicket(id, { status: 'backlog' });
  }

  async undoRun(ticketId: Id, runId: Id): Promise<void> {
    await this.wait();
    const run = this.runs.get(runId);
    if (!run?.snapshotBefore) throw new ApiHttpError(400, 'no_snapshot', 'This run has no snapshot to restore');
    this.setRun({ ...run, snapshotBefore: null });
    this.addEvent(ticketId, 'snapshot', 'All changes from this run were reverted to the snapshot', runId);
    this.addMessage(ticketId, 'system', 'Sebeto', 'Changes reverted to the snapshot taken before the run.');
  }

  private oauth: Record<OAuthProviderId, OAuthAppStatus> = {
    microsoft: { provider: 'microsoft', source: 'builtin', clientId: 'demo-client-id', tenant: 'common', hasSecret: false },
    google: { provider: 'google', source: 'none', clientId: null, tenant: null, hasSecret: false },
  };

  async oauthApps(): Promise<OAuthAppStatus[]> { await this.wait(); return [this.oauth.microsoft, this.oauth.google]; }

  async setOAuthApp(provider: OAuthProviderId, body: SetOAuthAppBody): Promise<OAuthAppStatus> {
    await this.wait();
    this.oauth[provider] = body.clientId
      ? { provider, source: 'custom', clientId: body.clientId, tenant: provider === 'microsoft' ? body.tenant || 'common' : null, hasSecret: !!body.clientSecret }
      : { provider, source: provider === 'microsoft' ? 'builtin' : 'none', clientId: provider === 'microsoft' ? 'demo-client-id' : null, tenant: provider === 'microsoft' ? 'common' : null, hasSecret: false };
    return this.oauth[provider];
  }

  async startOAuth(provider: OAuthProviderId): Promise<StartOAuthResponse> {
    await this.wait();
    if (this.oauth[provider].source === 'none') throw new ApiHttpError(400, 'oauth_invalid', 'No sign-in app is set up.');
    // Demo: pretend the owner signed in a moment later.
    this.later(1500, () => {
      this.mail = { connected: true, provider, address: provider === 'microsoft' ? 'mario.rossi@contoso.it' : 'mario.rossi@gmail.com', connectedAt: now(), servers: null, calendar: true };
      this.emit({ type: 'connectors.changed' });
    });
    return { authUrl: 'about:blank' };
  }

  async listConnectors(): Promise<ConnectorsResponse> {
    await this.wait();
    const catalog: CatalogEntry[] = [
      { id: 'microsoft', name: 'Microsoft 365 / Outlook', category: 'Email & calendar', availability: 'builtin', fields: [], description: 'Work, school or personal Microsoft account, with "Sign in with Microsoft".', capabilities: 'Read email and calendar; send email (with your approval).' },
      { id: 'google', name: 'Google (Gmail & Calendar)', category: 'Email & calendar', availability: 'builtin', fields: [], description: 'Google Workspace or personal Google account, with "Sign in with Google".', capabilities: 'Read Gmail and Calendar; send email (with your approval).' },
      { id: 'gmail', name: 'Gmail (app password)', category: 'Email & calendar', availability: 'builtin', fields: [], description: 'Your Gmail mailbox, connected with an app password.', capabilities: 'Search and read your email; send email from your address.' },
      { id: 'folder', name: 'Folder', category: 'Files', availability: 'preset', fields: [{ key: 'path', label: 'Folder', kind: 'path', placeholder: 'D:\\Shares\\Runbooks' }], description: 'A folder on this computer or a mapped share.', capabilities: 'List, search and read files in that folder.' },
      { id: 'custom', name: 'Your own MCP server', category: 'Custom', availability: 'custom', fields: [], description: 'Any MCP server, by command or URL.', capabilities: 'Whatever tools the server offers, after your review.' },
      { id: 'jira', name: 'Jira', category: 'Tickets & projects', availability: 'planned', fields: [], description: 'Atlassian Jira issues.', capabilities: 'Search and comment on issues.' },
    ];
    return { catalog, installed: this.connectors.map((c) => ({ ...c })) };
  }

  async addConnector(body: AddConnectorBody): Promise<ConnectorInfo> {
    await this.wait(800);
    const tool = (name: string, suggested: 'read' | 'change') => ({ name, description: `${name.replace(/_/g, ' ')} (demo)`, level: suggested, suggested, reviewed: false, inputSchema: { type: 'object' }, fingerprint: name });
    const c: ConnectorInfo = {
      id: uuidv7(), name: body.name, catalogId: body.catalogId,
      transport: body.transport ?? { type: 'stdio', command: 'npx', args: ['-y', 'demo-server'] },
      settings: (body.settings ?? []).map((s) => (s.secret ? { name: s.name, secret: true } : { ...s })),
      enabled: true, allowedAgents: body.allowedAgents ?? null, status: 'connected', error: null, createdAt: now(),
      tools: [tool('list_files', 'read'), tool('read_file', 'read'), tool('write_file', 'change')],
    };
    this.connectors.push(c);
    return { ...c };
  }

  async updateConnector(id: Id, patch: UpdateConnectorBody): Promise<ConnectorInfo> {
    await this.wait();
    const c = this.connectors.find((x) => x.id === id);
    if (!c) throw new ApiHttpError(404, 'not_found', 'Connector not found');
    if (patch.name) c.name = patch.name;
    if (patch.enabled !== undefined) { c.enabled = patch.enabled; c.status = patch.enabled ? 'connected' : 'disabled'; }
    if (patch.allowedAgents !== undefined) c.allowedAgents = patch.allowedAgents;
    for (const p of patch.tools ?? []) { const t = c.tools.find((x) => x.name === p.name); if (t) { t.level = p.level; t.reviewed = true; } }
    return { ...c };
  }

  async refreshConnector(id: Id): Promise<ConnectorInfo> {
    await this.wait(500);
    const c = this.connectors.find((x) => x.id === id);
    if (!c) throw new ApiHttpError(404, 'not_found', 'Connector not found');
    return { ...c };
  }

  async removeConnector(id: Id): Promise<void> {
    await this.wait();
    this.connectors = this.connectors.filter((x) => x.id !== id);
  }

  // ---- v0.7 R AI connections (api/mock-ai-connections.ts)
  private aiMock = new MockAiConnections((e) => this.emit(e), (runtimeId) => [
    ...[...this.teams.values()].filter((t) => t.runtime === runtimeId).map((t) => `team ${t.name}`),
    ...[...this.agents.values()].filter((a) => a.runtime === runtimeId).map((a) => a.name),
  ]);
  async listAiConnections() { await this.wait(); return this.aiMock.list(); }
  async addAiConnection(body: CreateAiConnectionBody) { await this.wait(); return this.aiMock.create(body); }
  async updateAiConnection(id: Id, patch: UpdateAiConnectionBody) {
    await this.wait();
    const cur = this.aiMock.list().find((c) => c.id === id);
    const locked = cur ? [...this.teams.values()].find((t) => t.lockRuntime && t.runtime === cur.runtimeId) : undefined;
    if (cur && locked && ((patch.kind && patch.kind !== cur.kind) || (patch.baseUrl && patch.baseUrl.trim().replace(/\/+$/, '') !== cur.baseUrl))) {
      throw new ApiHttpError(409, 'runtime_locked', `The team "${locked.name}" is locked to "${cur.name}", so its address and kind cannot change (ticket content would go somewhere else). Turn the lock off in Teams first.`);
    }
    return this.aiMock.update(id, patch);
  }
  async removeAiConnection(id: Id) { await this.wait(); this.aiMock.remove(id); }
  async testAiConnection(id: Id) { await this.wait(600); return this.aiMock.test(id); }

  async getSettings(): Promise<AppSettings> { await this.wait(); return { ...this.settings }; }
  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> { await this.wait(); this.settings = { ...this.settings, ...patch }; return { ...this.settings }; }

  async intakeTurn(body: IntakeTurnBody): Promise<IntakeTurnResponse> {
    await this.wait(700);
    const owner = body.messages.filter((m) => m.role === 'user').map((m) => m.text.trim());
    const all = owner.join(' ');
    // Demo rule: a very short first request gets one clarifying question; otherwise a proposal.
    if (owner.length === 1 && all.length < 30) {
      return { reply: 'Happy to help. Which systems or people does this involve, and is there a deadline?', proposals: [], costUsd: 0, model: this.settings.intakeModel };
    }
    const agent = [...this.agents.values()].find((a) => /Sysadmin/.test(a.name)) ?? [...this.agents.values()][0];
    const title = owner[0]!.replace(/\s+/g, ' ').slice(0, 70);
    const proposals: ProposedTicket[] = [
      { key: 'p1', title: title.charAt(0).toUpperCase() + title.slice(1), goal: all, agentId: agent?.id ?? null, teamId: agent?.teamId ?? null, costCapUsd: 2, dependsOn: [], why: 'Infrastructure work fits the Sysadmin assistant.' },
    ];
    if (/\b(report|email|notify|tell)\b/i.test(all)) {
      const comms = [...this.agents.values()].find((a) => /Comms/.test(a.name));
      proposals.push({ key: 'p2', title: 'Write a short summary for the team', goal: 'When the first ticket is done, write a 5-line summary of the findings for the IT team.', agentId: comms?.id ?? null, teamId: comms?.teamId ?? null, costCapUsd: 1, dependsOn: ['p1'], why: 'The Comms writer turns results into a clear notice.' });
    }
    return { reply: `Here is my proposal (${proposals.length} ticket${proposals.length > 1 ? 's' : ''}). You can edit anything before creating.`, proposals, costUsd: 0, model: this.settings.intakeModel };
  }

  async acceptIntake(body: IntakeAcceptBody): Promise<IntakeAcceptResponse> {
    if (body.start) this.assertNotLocked('POST /intake/accept (start)');
    const ids = new Map<string, Id>();
    const tickets: Ticket[] = [];
    for (const p of body.proposals) {
      const t = await this.createTicket({ title: p.title, goal: p.goal, agentId: p.agentId, ...(p.teamId !== undefined ? { teamId: p.teamId } : {}), costCapUsd: p.costCapUsd, dependsOn: p.dependsOn.map((k) => ids.get(k)!).filter(Boolean), start: !!body.start && p.dependsOn.length === 0 }, true);
      ids.set(p.key, t.id);
      tickets.push(t);
    }
    return { tickets };
  }

  async mailStatus(): Promise<MailConnectorStatus> {
    await this.wait();
    return this.mail;
  }

  async connectMail(body: ConnectMailBody): Promise<MailConnectorStatus> {
    await this.wait(600);
    // Demo rule: any 16-letter app password works; anything else is "refused by Gmail".
    if (body.password.replace(/\s+/g, '').length !== 16) {
      throw new ApiHttpError(400, 'mail_auth', 'Gmail refused the login. Check the address and use an app password (16 letters from myaccount.google.com/apppasswords), not your normal password.');
    }
    this.mail = {
      connected: true, provider: body.provider, address: body.address.trim().toLowerCase(), connectedAt: now(),
      servers: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 }, calendar: false,
    };
    return this.mail;
  }

  async disconnectMail(): Promise<DisconnectMailResponse> {
    await this.wait();
    const provider = this.mail.connected ? this.mail.provider : null;
    this.mail = { connected: false };
    const accountUrl = provider === 'microsoft' ? 'https://account.microsoft.com/privacy/app-access'
      : provider === 'google' ? 'https://myaccount.google.com/connections'
      : provider === 'gmail' ? 'https://myaccount.google.com/apppasswords' : null;
    return { ok: true, provider, revokedAtProvider: provider === 'google', accountUrl };
  }

  async listTrustedCommands(): Promise<TrustedCommand[]> {
    await this.wait();
    return [...this.trusted];
  }

  async removeTrustedCommand(id: Id): Promise<void> {
    await this.wait();
    const before = this.trusted.length;
    this.trusted = this.trusted.filter((c) => c.id !== id);
    if (this.trusted.length === before) throw new ApiHttpError(404, 'not_found', 'Trusted command not found');
    this.emit({ type: 'trusted.changed', commands: [...this.trusted] });
  }

  async decidePermission(id: Id, body: DecidePermissionBody): Promise<PermissionRequest> {
    await this.wait();
    const p = this.perms.get(id);
    if (!p) throw new ApiHttpError(404, 'not_found', 'Permission request not found');
    if (p.state === 'pending') this.assertNotLocked('POST /permissions/:id/decide', p.ticketId);
    const always = body.decision === 'always';
    const task = body.decision === 'task';
    if (always && (p.key !== 'script.run' || !p.command)) {
      throw new ApiHttpError(400, 'not_trustable', 'Only a plain system command can be always allowed');
    }
    if (task && p.key === 'prod.change') {
      throw new ApiHttpError(400, 'not_task_scopable', 'This action must be approved each time');
    }
    const allowed = body.decision !== 'deny';
    if (p.connector ? (task || always) : body.decision === 'team') throw new ApiHttpError(400, 'not_applicable', 'That choice does not apply to this request.');
    if (p.connector && allowed) {
      const name = p.connector.name;
      if (body.decision === 'team' && p.connector.teamId) {
        const tm = this.teams.get(p.connector.teamId);
        if (tm && !tm.claudeConnectors.includes(name)) { this.teams.set(tm.id, { ...tm, claudeConnectors: [...tm.claudeConnectors, name] }); this.teamsChanged(); }
      } else if (p.agentId) {
        const a = this.agents.get(p.agentId);
        if (a && !(a.claudeConnectors ?? []).includes(name)) {
          const na = { ...a, claudeConnectors: [...(a.claudeConnectors ?? []), name] };
          this.agents.set(a.id, na); this.emit({ type: 'agent.updated', agent: na });
        }
      }
    }
    const next: PermissionRequest = { ...p, state: allowed ? 'allowed' : 'denied', alwaysAllowed: always, taskScoped: task, decidedAt: now() };
    this.perms.set(id, next);
    this.emit({ type: 'permission.updated', request: next });
    if (always && p.command && !this.trusted.some((c) => c.shell === p.command!.shell && c.command === p.command!.command)) {
      this.trusted.push({ id: uuidv7(), shell: p.command.shell, command: p.command.command, requestId: p.id, createdAt: now() });
      this.emit({ type: 'trusted.changed', commands: [...this.trusted] });
    }
    this.addEvent(p.ticketId, 'permission', always ? `Always allowed (trusted command): ${p.title}` : task ? `Allowed for this task: ${p.title}` : allowed ? `Allowed once: ${p.title}` : `Denied: ${p.title}`);
    const t = this.mustTicket(p.ticketId);
    if (allowed) {
      this.later(300, () =>
        this.simulateRun(p.ticketId, 'permission', 'Done. That step went through without problems. Shall I close the ticket?'),
      );
    } else {
      this.later(500, () =>
        this.addMessage(p.ticketId, 'agent', this.agentName(t), 'Understood, I won’t do that. How would you like me to proceed instead?'),
      );
    }
    return next;
  }

  private projects = new Map<Id, Project>();

  async listProjects(): Promise<ProjectSummary[]> {
    await this.wait();
    return [...this.projects.values()].sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name)).map((p) => {
      const counts: ProjectSummary['counts'] = {};
      let costUsd = 0;
      for (const t of this.tickets.values()) if (t.projectId === p.id) { counts[t.status] = (counts[t.status] ?? 0) + 1; costUsd += t.costUsd; }
      return { ...p, counts, costUsd };
    });
  }

  async createProject(body: CreateProjectBody): Promise<Project> {
    await this.wait();
    if ([...this.projects.values()].some((p) => p.name.toLowerCase() === body.name.trim().toLowerCase())) throw new ApiHttpError(409, 'project_exists', `A project called "${body.name}" already exists.`);
    const palette = ['#0E5A8A', '#2E7D5B', '#B5532C', '#7A4FA0', '#C08A1E'];
    const p: Project = { id: uuidv7(), name: body.name.trim(), description: body.description ?? '', color: body.color ?? palette[this.projects.size % palette.length]!, archived: false, createdAt: now(), updatedAt: now() };
    this.projects.set(p.id, p);
    this.emit({ type: 'project.updated', project: p });
    return p;
  }

  async updateProject(id: Id, body: UpdateProjectBody): Promise<Project> {
    await this.wait();
    const cur = this.projects.get(id);
    if (!cur) throw new ApiHttpError(404, 'not_found', 'Project not found');
    const p: Project = { ...cur, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), updatedAt: now() };
    this.projects.set(id, p);
    this.emit({ type: 'project.updated', project: p });
    return p;
  }

  async deleteProject(id: Id): Promise<void> {
    await this.wait();
    this.projects.delete(id);
    for (const t of this.tickets.values()) if (t.projectId === id) this.patchTicket(t.id, { projectId: null });
    this.emit({ type: 'project.deleted', projectId: id });
  }

  async listTags(): Promise<TagCount[]> {
    await this.wait();
    const counts = new Map<string, number>();
    for (const t of this.tickets.values()) for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  async listAgents(): Promise<Agent[]> {
    await this.wait(60);
    return [...this.agents.values()];
  }

  async createAgent(body: CreateAgentBody): Promise<Agent> {
    const team = body.teamId ? this.teams.get(body.teamId) : undefined;
    if (team?.lockRuntime && body.runtime && body.runtime !== team.runtime) throw this.lockedError(team, body.runtime, body.name);
    const inherit = team?.runtime && (team.lockRuntime || !body.runtime);
    const a: Agent = {
      id: uuidv7(), name: body.name, role: body.role ?? '', job: body.job ?? '', runtime: inherit ? team!.runtime! : body.runtime ?? 'mock',
      model: inherit ? team!.model ?? null : body.model ?? null, reportsTo: body.reportsTo ?? null, heartbeatMinutes: body.heartbeatMinutes ?? 60,
      monthlyBudgetUsd: body.monthlyBudgetUsd ?? 20, permissions: { ...DEFAULT_PERMISSIONS, ...body.permissions }, skills: [],
      paused: false, createdAt: now(), teamId: body.teamId ?? null,
    };
    this.agents.set(a.id, a);
    this.emit({ type: 'agent.updated', agent: a });
    if (a.teamId) this.teamsChanged();
    return a;
  }

  async updateAgent(id: Id, body: UpdateAgentBody): Promise<Agent> {
    const cur = this.agents.get(id);
    if (!cur) throw new ApiHttpError(404, 'not_found', 'Agent not found');
    const { permissions, ...rest } = body;
    const a: Agent = { ...cur, ...rest, permissions: { ...cur.permissions, ...permissions } } as Agent;
    // v0.4 F (same rule as the core): joining a team with an AI takes it; a locked team refuses another runtime.
    const runtimeChange = body.runtime !== undefined && body.runtime !== cur.runtime ? body.runtime : undefined;
    const team = a.teamId ? this.teams.get(a.teamId) : undefined;
    const joining = body.teamId !== undefined && !!body.teamId && body.teamId !== (cur.teamId ?? null);
    if (team?.lockRuntime && team.runtime && runtimeChange !== undefined && runtimeChange !== team.runtime) throw this.lockedError(team, runtimeChange, cur.name);
    if (joining && team?.runtime && (team.lockRuntime || runtimeChange === undefined)) { a.runtime = team.runtime; if (body.model === undefined || runtimeChange === undefined) a.model = team.model ?? null; }
    this.agents.set(id, a);
    this.emit({ type: 'agent.updated', agent: a });
    if (body.teamId !== undefined && (cur.teamId ?? null) !== (a.teamId ?? null)) {
      const old = cur.teamId ? this.teams.get(cur.teamId) : undefined;
      if (old?.leadAgentId === id) this.teams.set(old.id, { ...old, leadAgentId: null });
      this.teamsChanged();
    }
    return a;
  }

  /** Same rules as the core (simplified): open tickets → default agent, reports move up, connector lists drop it. */
  async deleteAgent(id: Id): Promise<DeleteAgentResponse> {
    await this.wait();
    const agent = this.agents.get(id);
    if (!agent) throw new ApiHttpError(404, 'not_found', 'Agent not found');
    const rest = [...this.agents.values()].filter((a) => a.id !== id);
    if (rest.length === 0) throw new ApiHttpError(409, 'last_agent', `${agent.name} is your only agent.`);
    const mine = [...this.tickets.values()].filter((t) => t.agentId === id);
    if (mine.some((t) => this.activeRun(t.id))) throw new ApiHttpError(409, 'agent_busy', `${agent.name} is working on a ticket right now.`);
    const target = pickDefaultAgent(rest)!;
    let reassignedTickets = 0;
    for (const t of mine) {
      if (t.status === 'done') { this.tickets.set(t.id, { ...t, agentId: null }); continue; }
      this.addEvent(t.id, 'info', `Agent ${agent.name} was removed; reassigned to ${target.name}. The new agent starts a fresh session.`);
      this.patchTicket(t.id, { agentId: target.id, currentSessionId: null });
      reassignedTickets++;
    }
    this.agents.delete(id);
    this.emit({ type: 'agent.deleted', agentId: id });
    let movedReports = 0;
    for (const a of rest) {
      if (a.reportsTo !== id) continue;
      const next = { ...a, reportsTo: agent.reportsTo };
      this.agents.set(a.id, next);
      this.emit({ type: 'agent.updated', agent: next });
      movedReports++;
    }
    let connectorsChanged = false;
    this.connectors = this.connectors.map((c) => {
      if (!c.allowedAgents?.includes(id)) return c;
      connectorsChanged = true;
      return { ...c, allowedAgents: c.allowedAgents.filter((x) => x !== id) };
    });
    if (connectorsChanged) this.emit({ type: 'connectors.changed' });
    return { ok: true, reassignedTickets, movedReports };
  }

  async listClaudeConnectors() {
    return [
      { name: 'claude.ai Atlassian – Acme', slug: 'claude_ai_Atlassian_Acme', connected: true, status: 'Connected' },
      { name: 'claude.ai Slack', slug: 'claude_ai_Slack', connected: true, status: 'Connected' },
    ];
  }

  async listRuntimes(): Promise<RuntimeInfo[]> {
    return [
      { id: 'mock', displayName: 'Mock runtime', detection: { installed: true, version: '0.1.0' }, models: ['mock'] },
      { id: 'claude-cli', displayName: 'Claude Code', detection: { installed: true, version: '2.0.0', loggedIn: true }, models: ['sonnet', 'opus', 'haiku'] },
      { id: 'ollama', displayName: 'Ollama', detection: { installed: true, version: '0.12.0' }, models: ['qwen3-vl:4b-instruct', 'llama3.1:8b'] },
      { id: 'codex', displayName: 'Codex CLI', detection: { installed: false, problem: 'Not installed' }, models: [] },
      ...this.aiMock.runtimes(),
    ];
  }

  /** A plausible redacted report built from the mock state (the real one is redacted by the core). */
  async getDiagnostics(): Promise<DiagnosticsReport> {
    await this.wait();
    const byStatus: Record<string, number> = {};
    for (const t of this.tickets.values()) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const runtimes = await this.listRuntimes();
    const mail = this.mail.connected
      ? { connected: true as const, provider: this.mail.provider, address: this.mail.address.replace(/^(.)[^@]*/, '$1***'), calendar: this.mail.calendar }
      : { connected: false as const };
    return {
      format: 'sebeto-diagnostics/1',
      app: {
        version: '0.2.0-mock', generatedAt: now(), node: '24.11.0', electron: '38.2.0', shell: 'desktop', platform: 'win32', arch: 'x64',
        osRelease: '10.0.26300', uptimeSeconds: 5421, workspace: '<home>\\.sebeto\\workspace', maxParallelRuns: 3, enabledRuntimes: ['mock', 'claude-cli', 'ollama'],
      },
      storage: {
        schemaVersion: 4, dbBytes: 1_384_448, ticketsByStatus: byStatus, agents: this.agents.size, skills: 4,
        runsLast7Days: { succeeded: 23, failed: 2, cancelled: 1 }, jobsByState: { done: 41, failed: 1 },
      },
      runtimes: runtimes.map((r) => ({
        id: r.id, displayName: r.displayName, installed: r.detection.installed, version: r.detection.version ?? null,
        loggedIn: r.detection.loggedIn ?? null, problem: r.detection.problem ?? null, models: r.models.length,
      })),
      settings: { ...this.settings },
      connectors: {
        mail,
        oauthApps: [{ provider: 'microsoft', source: 'builtin' }, { provider: 'google', source: 'none' }],
        custom: [{ catalogId: 'custom', transport: 'http', host: 'mcp.contoso.com', enabled: true, status: 'connected', error: null, toolsByLevel: { read: 3, change: 1 }, unreviewedTools: 0 }],
      },
      recentProblems: {
        errors: [
          { ticket: 'T-4', at: ago(95 * MIN), summary: 'Could not reach https://status.contoso.com (timeout after 30 s)' },
          { ticket: 'T-2', at: ago(26 * 60 * MIN), summary: 'IMAP login failed for m***@gmail.com: password=<secret>' },
        ],
        failedRuns: [{ ticket: 'T-4', at: ago(95 * MIN), trigger: 'start', exitReason: 'Claude Code stopped unexpectedly (exit code 1).' }],
      },
    };
  }

  // ---------- skills (docs/17 Agents & Skills.md)
  /** Seeds a small org chart, sample IT Ops skills and one connector limited to some agents. */
  private seedTeam() {
    const find = (name: string) => [...this.agents.values()].find((a) => a.name === name);
    const set = (name: string, patch: Partial<Agent>) => {
      const a = find(name);
      if (a) this.agents.set(a.id, { ...a, ...patch });
    };
    const analyst = find('Analyst')?.id ?? null;
    const sys = find('Sysadmin assistant')?.id ?? null;
    set('Comms writer', { reportsTo: analyst });
    set('Researcher', { reportsTo: analyst, model: 'gemini-2.5-pro' });
    set('Automation engineer', { reportsTo: sys });
    set('Analyst', { model: 'sonnet' });
    set('Sysadmin assistant', { model: 'sonnet' });

    const at = ago(7 * 24 * 60 * MIN);
    const skill = (name: string, description: string, needs: PermissionKey[], instructions: string, connectors: string[] = [], files: string[] = []) =>
      this.skills.push({ slug: slugify(name), name, description, instructions, needs, connectors, files, version: 1, updatedAt: at });
    skill('Incident summary', 'Groups incident exports by root cause, with examples.', ['fs.read'],
      '# Incident summary\n1. Load the export from the ticket folder.\n2. Group tickets by root cause, not by category.\n3. For each group: count, one clear example, and the fix if known.\n4. End with the top 3 actions for next week.',
      [], ['template.xlsx']);
    skill('Maintenance notice', 'Writes short maintenance and change notices for staff.', ['fs.write', 'email.send'],
      '# Maintenance notice\n- Say what changes, when and for how long in the first two lines.\n- Tell people what they need to do (often nothing).\n- Always add the IT hotline and the rollback time.\n- Keep it under 120 words. Never send without approval.',
      ['gmail']);
    skill('CVE triage', 'Matches new CVEs to our models and firmware and rates priority.', ['web.read', 'fs.read'],
      '# CVE triage\n1. Read the vendor advisory and the NVD entry.\n2. Check the inventory in the ticket folder for matching models and firmware.\n3. Rate: critical (exposed and exploited), high, or later.\n4. Propose a patch window; never change devices yourself.');
    skill('Runbook writer', 'Turns notes and command history into clear step-by-step runbooks.', ['fs.read', 'fs.write'],
      '# Runbook writer\n- One runbook per task, named "<system> - <task>.md".\n- Number the steps; give each the exact command and the expected result.\n- Add a "How to roll back" section.\n- Mark every step that touches production.',
      ['Runbooks share']);
    set('Analyst', { skills: ['incident-summary'] });
    set('Comms writer', { skills: ['maintenance-notice'] });
    set('Researcher', { skills: ['cve-triage'] });
    set('Sysadmin assistant', { skills: ['runbook-writer', 'incident-summary'] });

    const allowed = [sys, find('Automation engineer')?.id].filter((x): x is Id => !!x);
    this.connectors.push({
      id: uuidv7(), name: 'Runbooks share', catalogId: 'folder',
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'demo-folder-server'] },
      settings: [{ name: 'path', secret: false, value: 'D:\\Shares\\Runbooks' }], enabled: true, allowedAgents: allowed,
      status: 'connected', error: null, createdAt: at,
      tools: [{ name: 'list_files', description: 'List files (demo)', level: 'read', suggested: 'read', reviewed: true, inputSchema: { type: 'object' }, fingerprint: 'list_files' }],
    });
  }

  private toSkill(s: Omit<Skill, 'usedBy'>): Skill {
    const usedBy = [...this.agents.values()].filter((a) => a.skills.includes(s.slug)).map((a) => a.id);
    return { ...s, needs: [...s.needs], connectors: [...s.connectors], files: [...s.files], usedBy };
  }

  private checkSkillBody(body: SkillBody) {
    if (!body.name?.trim() || !slugify(body.name)) throw new ApiHttpError(400, 'invalid', 'The skill needs a name with at least one letter or digit');
  }

  async listSkills(): Promise<Skill[]> {
    await this.wait(60);
    return this.skills.map((s) => this.toSkill(s));
  }

  async createSkill(body: SkillBody): Promise<Skill> {
    await this.wait();
    this.checkSkillBody(body);
    const slug = slugify(body.name);
    if (this.skills.some((s) => s.slug === slug)) throw new ApiHttpError(409, 'exists', `A skill called "${slug}" already exists`);
    const s: Omit<Skill, 'usedBy'> = {
      slug, name: body.name.trim(), description: body.description.trim(), instructions: body.instructions,
      needs: [...(body.needs ?? [])], connectors: [...(body.connectors ?? [])], files: [], version: 1, updatedAt: now(),
    };
    this.skills.push(s);
    this.emit({ type: 'skills.changed' });
    return this.toSkill(s);
  }

  async updateSkill(slug: string, body: SkillBody): Promise<Skill> {
    await this.wait();
    this.checkSkillBody(body);
    const i = this.skills.findIndex((s) => s.slug === slug);
    if (i === -1) throw new ApiHttpError(404, 'not_found', 'Skill not found');
    const cur = this.skills[i]!;
    const next: Omit<Skill, 'usedBy'> = {
      ...cur, name: body.name.trim(), description: body.description.trim(), instructions: body.instructions,
      needs: [...(body.needs ?? cur.needs)], connectors: [...(body.connectors ?? cur.connectors)],
      version: cur.version + 1, updatedAt: now(),
    };
    this.skills[i] = next;
    this.emit({ type: 'skills.changed' });
    return this.toSkill(next);
  }

  async deleteSkill(slug: string): Promise<void> {
    await this.wait();
    if (!this.skills.some((s) => s.slug === slug)) throw new ApiHttpError(404, 'not_found', 'Skill not found');
    this.skills = this.skills.filter((s) => s.slug !== slug);
    for (const a of [...this.agents.values()]) {
      if (!a.skills.includes(slug)) continue;
      const next: Agent = { ...a, skills: a.skills.filter((x) => x !== slug) };
      this.agents.set(a.id, next);
      this.emit({ type: 'agent.updated', agent: next });
    }
    this.emit({ type: 'skills.changed' });
  }

  async assignSkills(agentId: Id, slugs: string[]): Promise<Agent> {
    await this.wait();
    const cur = this.agents.get(agentId);
    if (!cur) throw new ApiHttpError(404, 'not_found', 'Agent not found');
    const unknown = slugs.find((x) => !this.skills.some((s) => s.slug === x));
    if (unknown) throw new ApiHttpError(400, 'unknown_skill', `Unknown skill: ${unknown}`);
    const a: Agent = { ...cur, skills: [...new Set(slugs)] };
    this.agents.set(agentId, a);
    this.emit({ type: 'agent.updated', agent: a });
    this.emit({ type: 'skills.changed' });
    return a;
  }

  // ---------- team templates (packages/shared/src/templates.ts), simplified
  async listTemplates(): Promise<TeamTemplate[]> {
    await this.wait(60);
    return structuredClone([...MOCK_TEMPLATES, ...this.savedTemplates]);
  }

  async saveTemplate(template: TeamTemplate): Promise<TeamTemplate> {
    await this.wait();
    const base = slugify(template.name) || 'team';
    let id = base;
    const taken = (x: string) => [...MOCK_TEMPLATES, ...this.savedTemplates].some((t) => t.id === x);
    for (let n = 2; taken(id); n++) id = `${base}-${n}`;
    const saved: TeamTemplate = { ...structuredClone(template), id, builtin: false };
    this.savedTemplates.push(saved);
    this.emit({ type: 'templates.changed' });
    return structuredClone(saved);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.wait();
    if (MOCK_TEMPLATES.some((t) => t.id === id)) throw new ApiHttpError(409, 'template_builtin', 'Built-in templates cannot be deleted');
    if (!this.savedTemplates.some((t) => t.id === id)) throw new ApiHttpError(404, 'not_found', 'Template not found');
    this.savedTemplates = this.savedTemplates.filter((t) => t.id !== id);
    this.emit({ type: 'templates.changed' });
  }

  async applyTemplate(body: ApplyTemplateBody): Promise<ApplyTemplateResponse> {
    await this.wait(300);
    const template = body.template ?? [...MOCK_TEMPLATES, ...this.savedTemplates].find((t) => t.id === body.templateId);
    if (!template) throw new ApiHttpError(404, 'not_found', 'Template not found');
    const top = body.reportsTo ?? null;
    if (top && !this.agents.has(top)) throw new ApiHttpError(400, 'unknown_agent', 'Agent not found');
    const skillsCreated: string[] = [];
    const skillsReused: string[] = [];
    for (const s of template.skills) {
      if (this.skills.some((x) => x.slug === s.slug)) { skillsReused.push(s.slug); continue; }
      this.skills.push({ slug: s.slug, name: s.name, description: s.description, instructions: s.instructions, needs: [...(s.needs ?? [])], connectors: [...(s.connectors ?? [])], files: [], version: 1, updatedAt: now() });
      skillsCreated.push(s.slug);
    }
    const taken = new Set([...this.agents.values()].map((a) => a.name.toLowerCase()));
    const unique = (name: string) => {
      let c = name;
      for (let n = 2; taken.has(c.toLowerCase()); n++) c = `${name} ${n}`;
      taken.add(c.toLowerCase());
      return c;
    };
    // v0.4 F/G: the request's AI overrides the template's; a lock needs an installed runtime.
    const warnings: string[] = [];
    const installed = (await this.listRuntimes()).filter((r) => r.detection.installed).map((r) => r.id);
    let aiRuntime: string | null = body.runtime !== undefined ? body.runtime : template.team?.runtime ?? null;
    const aiModel: string | null = aiRuntime ? (body.model !== undefined ? body.model : template.team?.model ?? null) : null;
    let aiLock = !!(body.lockRuntime ?? template.team?.lockRuntime);
    if (aiRuntime && !installed.includes(aiRuntime)) {
      warnings.push(`${aiRuntime} is not installed on this computer, so the team uses the usual AI${aiLock ? ' and is not locked' : ''}.`);
      aiRuntime = null;
    }
    if (!aiRuntime) aiLock = false;
    const created = new Map<string, Agent>();
    const create = (t: TemplateAgent): Agent => {
      const done = created.get(t.key);
      if (done) return done;
      const manager = t.reportsTo ? template.agents.find((a) => a.key === t.reportsTo) : undefined;
      const reportsTo = manager ? create(manager).id : top;
      const runtimes = ['mock', 'claude-cli', 'ollama'];
      const a: Agent = {
        id: uuidv7(), name: unique(t.name), role: t.role, job: t.job,
        runtime: aiRuntime ?? (t.runtime && runtimes.includes(t.runtime) ? t.runtime : 'claude-cli'), model: aiRuntime ? aiModel : t.runtime === 'claude-cli' ? t.model ?? null : null,
        reportsTo, heartbeatMinutes: t.heartbeatMinutes ?? 60, monthlyBudgetUsd: t.monthlyBudgetUsd ?? 20,
        permissions: { ...DEFAULT_PERMISSIONS, ...t.permissions, 'prod.change': t.permissions?.['prod.change'] === 'never' ? 'never' : 'ask' },
        paused: false, createdAt: now(), skills: [...new Set(t.skills)].filter((x) => this.skills.some((s) => s.slug === x)),
      };
      this.agents.set(a.id, a);
      created.set(t.key, a);
      return a;
    };
    const made = template.agents.map(create);
    // v0.4: the template creates a team (lead = top agent, every agent a member).
    const baseSlug = template.team?.slug ?? (template.builtin ? template.id : slugify(template.name));
    let slug = baseSlug;
    for (let n = 2; [...this.teams.values()].some((t) => t.slug === slug); n++) slug = `${baseSlug}-${n}`;
    const baseName = template.team?.name ?? template.name;
    let teamName = baseName;
    for (let n = 2; [...this.teams.values()].some((t) => t.name.toLowerCase() === teamName.toLowerCase()); n++) teamName = `${baseName} ${n}`;
    const lead = made.find((a) => a.reportsTo === top) ?? made[0]!;
    const team: Team = {
      id: uuidv7(), slug, name: teamName, description: template.description, color: template.team?.color ?? PROJECT_COLORS[this.teams.size % PROJECT_COLORS.length]!,
      leadAgentId: lead.id, routingHints: template.team?.routingHints ?? '', memberIds: made.map((a) => a.id),
      runtime: aiRuntime, model: aiRuntime ? aiModel : null, lockRuntime: aiLock, requireScope: !!template.team?.requireScope, claudeConnectors: [], createdAt: now(), updatedAt: now(),
    };
    this.teams.set(team.id, team);
    const agents = made.map((a) => { const next = { ...a, teamId: team.id }; this.agents.set(a.id, next); return next; });
    for (const a of agents) this.emit({ type: 'agent.updated', agent: a });
    this.emit({ type: 'skills.changed' });
    this.teamsChanged();
    return { agents, skillsCreated, skillsReused, team, ...(warnings.length ? { warnings } : {}) };
  }

  async exportTemplate(agentIds: Id[] = []): Promise<TeamTemplate> {
    await this.wait();
    const all = [...this.agents.values()];
    const keep = new Set<Id>(agentIds.length ? [] : all.map((a) => a.id));
    const stack = [...agentIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (keep.has(id)) continue;
      keep.add(id);
      for (const a of all) if (a.reportsTo === id) stack.push(a.id);
    }
    const team = all.filter((a) => keep.has(a.id));
    const keyOf = new Map(team.map((a, i) => [a.id, `${slugify(a.name) || 'agent'}-${i + 1}`]));
    const used = new Set(team.flatMap((a) => a.skills));
    const date = now().slice(0, 10);
    return {
      format: 'sebeto-team/1', id: `team-${date}`, name: 'My team', description: `Exported from Sebeto on ${date}`, builtin: false,
      agents: team.map((a) => ({
        key: keyOf.get(a.id)!, name: a.name, role: a.role, job: a.job, reportsTo: (a.reportsTo && keyOf.get(a.reportsTo)) || null,
        runtime: a.runtime, model: a.model, heartbeatMinutes: a.heartbeatMinutes, monthlyBudgetUsd: a.monthlyBudgetUsd, skills: [...a.skills],
      })),
      skills: this.skills.filter((s) => used.has(s.slug)).map((s) => ({ slug: s.slug, name: s.name, description: s.description, instructions: s.instructions, needs: [...s.needs], connectors: [...s.connectors] })),
    };
  }

  // ---------- session library (v0.4 §A), see mock-sessions.ts
  private sessionLib = new MockSessionLibrary({
    createTicket: (input) => this.createTicket(input),
    getTicket: (id) => this.tickets.get(id),
    ticketByNumber: (n) => [...this.tickets.values()].find((t) => t.number === n),
    reopen: (id) => this.moveTicket(id, { status: 'needs_you' }),
    emitChanged: () => this.emit({ type: 'sessions.changed' }),
  });
  async listSessions(q: SessionListQuery = {}) { await this.wait(80); return this.sessionLib.list(q); }
  async sessionCategories() { await this.wait(40); return this.sessionLib.categories(); }
  async scanSessions() { await this.wait(600); return this.sessionLib.scan(); }
  async sessionTranscript(id: Id, limit?: number) { await this.wait(80); return this.sessionLib.transcript(id, limit); }
  async updateSession(id: Id, body: UpdateSessionEntryBody) { await this.wait(); return this.sessionLib.update(id, body); }
  async openSession(id: Id, body: OpenSessionBody = {}) { await this.wait(); return this.sessionLib.open(id, body); }
  async deleteSession(id: Id) { await this.wait(); this.sessionLib.remove(id); }
  async suggestSessionCategories(body: SuggestCategoriesBody) { await this.wait(body.mode === 'ai' ? 900 : 200); return this.sessionLib.suggest(body, [...this.teams.values()]); }
  async applySessionCategories(body: ApplyCategoriesBody) { await this.wait(); return this.sessionLib.apply(body, [...this.teams.values()]); }
  // ---------- v0.4 B: security log (api/mock-security.ts)
  private securityLog: MockSecurityLog | null = null;
  private get security(): MockSecurityLog {
    this.securityLog ??= new MockSecurityLog({
      agents: () => [...this.agents.values()],
      tickets: () => [...this.tickets.values()],
      emit: (e) => this.emit(e),
      pauseAll: () => {
        let n = 0;
        for (const a of [...this.agents.values()]) {
          if (a.paused) continue;
          const next: Agent = { ...a, paused: true };
          this.agents.set(a.id, next);
          this.emit({ type: 'agent.updated', agent: next });
          n++;
        }
        return n;
      },
    });
    return this.securityLog;
  }
  async listSecurityEvents(q: SecurityEventsQuery = {}) { await this.wait(60); return this.security.list(q); }
  async securitySummary(hours = 24) { await this.wait(60); return this.security.summary(hours); }
  async securityStatus() { await this.wait(30); return this.security.status(); }
  async verifySecurityLog() { await this.wait(400); return this.security.verify(); }
  async exportSecurityLog(format: 'jsonl' | 'csv') { await this.wait(); return this.security.export(format); }
  async emergencyStop(body: EmergencyStopBody) { await this.wait(300); return this.security.emergencyStop(body.reason); }
  async releaseLockdown() { await this.wait(); this.security.release(); }
  async getSecuritySettings() { await this.wait(30); return this.security.getSettings(); }
  async updateSecuritySettings(patch: Partial<SecuritySettings>) { await this.wait(); return this.security.updateSettings(patch); }

  // ---------- v0.4 E: memory graph (api/mock-memory.ts)
  private memoryStore: MockMemory | null = null;
  private get memory(): MockMemory {
    this.memoryStore ??= new MockMemory(() => this.emit({ type: 'memory.changed' }));
    return this.memoryStore;
  }
  async listMemoryNotes(q: MemoryListQuery = {}) { await this.wait(60); return this.memory.list(q); }
  async getMemoryNote(id: Id) { await this.wait(40); return this.memory.get(id); }
  async createMemoryNote(body: SaveMemoryNoteBody) { await this.wait(); return this.memory.create(body); }
  async updateMemoryNote(id: Id, body: SaveMemoryNoteBody) { await this.wait(); return this.memory.update(id, body); }
  async deleteMemoryNote(id: Id) { await this.wait(); this.memory.remove(id); }
  async approveMemoryNote(id: Id) { await this.wait(); return this.memory.approve(id); }
  async memoryGraph(q: MemoryGraphQuery = {}) { await this.wait(60); return this.memory.graph(q); }
  async memoryRelated(name: string) { await this.wait(40); return this.memory.related(name); }
  async reindexMemory() { await this.wait(300); const i = this.memory.info(); return { notes: i.notes + i.proposed, links: i.links, ms: 12 }; }
  async backfillMemory(body: MemoryBackfillBody = {}) { await this.wait(400); return this.memory.backfill(body); }
  async memoryInfo() { await this.wait(30); return this.memory.info(); }

  // ---------- v0.5 L: cost dashboard (api/mock-costs.ts)
  async costs(q: CostsQuery = {}) {
    await this.wait(80);
    const names: Record<string, string> = { 'claude-cli': 'Claude Code', ollama: 'Ollama', mock: 'Mock runtime', codex: 'Codex CLI', gemini: 'Gemini CLI' };
    return mockCostsReport(q, {
      agents: () => [...this.agents.values()], tickets: () => [...this.tickets.values()],
      projects: () => [...this.projects.values()], teams: () => [...this.teams.values()], runtimeName: (id) => names[id] ?? null,
    });
  }

  // ---------- v0.7 Q: workspace backups (api/mock-backups.ts)
  private readonly backups = new MockBackups();
  async listBackups() { await this.wait(40); return this.backups.list(); }
  async backupEstimate() { await this.wait(60); return this.backups.estimate(); }
  async createBackup(body: CreateBackupBody) { await this.wait(700); return this.backups.create(body); }
  async downloadBackup(name: string) { await this.wait(); return this.backups.download(name); }
  async verifyBackup(name: string, body: VerifyBackupBody = {}) { await this.wait(500); return this.backups.verify(name, body); }
  async deleteBackup(name: string) { await this.wait(); this.backups.remove(name); }
  async updateBackupSettings(patch: Partial<BackupSettings>) { await this.wait(); return this.backups.updateSettings(patch); }

  subscribe(listener: (event: WsEvent) => void, options: SubscribeOptions = {}): () => void {
    this.listeners.add(listener);
    options.onStatus?.('open');
    // Latest activity comes with the tickets (lastActivity); only pending permissions are replayed.
    setTimeout(() => {
      if (!this.listeners.has(listener)) return;
      for (const p of this.perms.values()) if (p.state === 'pending') listener({ type: 'permission.created', request: p });
    }, 0);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
