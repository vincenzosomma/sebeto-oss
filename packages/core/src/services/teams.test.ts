import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Agent, RouteDecision, RuntimeAdapter, Team, Ticket, WsEvent } from '@sebeto/shared';
import type { AppContext, NewSecurityEvent, PlanningTurn, Repos } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createSkillStore, type SkillStore } from '../skills/store.js';
import { createServer } from '../api/server.js';
import { applyTemplate } from './templates.js';
import { createTeam, deleteTeam, listTeams, updateTeam } from './teams.js';
import { createAgent, deleteAgent, updateAgent } from './agents.js';
import { createTicket, listTickets, routeTicket, settleBackgroundRouting, updateTicket } from './tickets.js';
import { hintTerms, isConfident, pickTeamMember, route, routeByRules, scoreTeams, stem } from './routing.js';
import { acceptIntake, buildIntakeSystemPrompt, parseIntakeOutput } from './intake.js';

const TOKEN = 'r'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let repos: Repos;
let skills: SkillStore;
let events: WsEvent[];
let security: NewSecurityEvent[];
let turns: string[];
let turnReply: string | Error;

function adapter(id: string): RuntimeAdapter {
  return {
    id, displayName: id, capabilities: { tools: true, resume: true, costReport: true },
    detect: async () => ({ installed: true }),
    models: async () => ['haiku'],
    // eslint-disable-next-line require-yield
    run: async function* () { return; },
  };
}

const fakeTurn: PlanningTurn = async (input) => {
  turns.push(input.prompt);
  expect(input.budgetUsd).toBeLessThanOrEqual(0.02);
  if (turnReply instanceof Error) throw turnReply;
  return { text: turnReply, costUsd: 0.001, model: 'haiku' };
};

function makeCtx(): AppContext {
  const adapters = [adapter('mock'), adapter('claude-cli')];
  return {
    config: { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 1, runtimes: ['mock', 'claude-cli'], version: '0.4.0' },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    repos,
    queue: { enqueue: () => ({ id: 'job' }) } as unknown as AppContext['queue'],
    bus: { publish: (e) => { events.push(e); }, subscribe: () => () => undefined },
    state: {} as AppContext['state'],
    gate: {} as AppContext['gate'],
    snapshots: { init: async () => undefined } as unknown as AppContext['snapshots'],
    runtimes: { get: (id) => adapters.find((a) => a.id === id), list: () => adapters },
    skills,
    securityLog: { record: (e) => { security.push(e); return null; }, lockdown: () => false },
    planningTurn: fakeTurn,
  };
}

let ctx: AppContext;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-teams-'));
  ({ repos } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  skills = createSkillStore(dir, (slug) => repos.agents.list().filter((a) => a.skills.includes(slug)).map((a) => a.id));
  skills.seedIfEmpty();
  events = [];
  security = [];
  turns = [];
  turnReply = '{"teamSlug": null, "reason": "nothing fits"}';
  ctx = makeCtx();
});
afterEach(async () => {
  await settleBackgroundRouting();
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const bySlug = (slug: string) => listTeams(ctx).find((t) => t.slug === slug)!;
const agentNamed = (name: string) => repos.agents.list().find((a) => a.name === name)!;

async function allBuiltins(): Promise<void> {
  for (const id of ['service-desk', 'devops', 'infrastructure', 'security', 'red-team']) await applyTemplate(ctx, { templateId: id });
}

describe('teams CRUD and membership', () => {
  it('creates with a slug and palette colour, keeps names unique, lead joins the team', () => {
    const a = createAgent(ctx, { name: 'Alice', runtime: 'claude-cli' });
    const t = createTeam(ctx, { name: 'Network Ops', leadAgentId: a.id, routingHints: 'VPN, firewall' });
    expect(t).toMatchObject({ slug: 'network-ops', leadAgentId: a.id, memberIds: [a.id], routingHints: 'VPN, firewall' });
    expect(t.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(repos.agents.get(a.id)!.teamId).toBe(t.id);
    expect(() => createTeam(ctx, { name: 'network ops' })).toThrow(/already exists/);
    expect(createTeam(ctx, { name: 'Network Ops!' }).slug).toBe('network-ops-2');
    expect(() => createTeam(ctx, { name: 'X', slug: 'network-ops' })).toThrow(/already used/);
    expect(() => createTeam(ctx, { name: 'Y', color: 'red' })).toThrow(/Colour/);
    expect(events).toContainEqual({ type: 'teams.changed' });
    expect(security.map((s) => s.action)).toContain('team.created');
  });

  it('agents join and leave via teamId; leaving as lead clears the lead; a new lead joins', () => {
    const t = createTeam(ctx, { name: 'Desk' });
    const a = createAgent(ctx, { name: 'Ann', teamId: t.id });
    const b = createAgent(ctx, { name: 'Bob' });
    expect(a.teamId).toBe(t.id);
    expect(() => createAgent(ctx, { name: 'Zed', teamId: 'nope' })).toThrow(/does not exist/);
    updateTeam(ctx, t.id, { leadAgentId: a.id });
    updateAgent(ctx, b.id, { teamId: t.id });
    expect(listTeams(ctx)[0]!.memberIds.sort()).toEqual([a.id, b.id].sort());
    updateAgent(ctx, a.id, { teamId: null });
    expect(repos.teams!.get(t.id)).toMatchObject({ leadAgentId: null, memberIds: [b.id] });
    const c = createAgent(ctx, { name: 'Cat' });
    const updated = updateTeam(ctx, t.id, { leadAgentId: c.id, name: 'Service Desk', routingHints: 'printers' });
    expect(updated).toMatchObject({ name: 'Service Desk', leadAgentId: c.id, routingHints: 'printers', slug: 'desk' });
    expect(updated.memberIds).toContain(c.id);
    expect(security.map((s) => s.action)).toContain('team.member_changed');
  });

  it('deleting a team keeps its agents and tickets, without a team', async () => {
    const t = createTeam(ctx, { name: 'Ops' });
    const a = createAgent(ctx, { name: 'Ann', runtime: 'claude-cli', teamId: t.id });
    const tk = await createTicket(ctx, { title: 'x', goal: 'y', teamId: t.id });
    expect(tk).toMatchObject({ teamId: t.id, agentId: a.id });
    deleteTeam(ctx, t.id);
    expect(repos.agents.get(a.id)!.teamId).toBeNull();
    expect(repos.tickets.get(tk.id)!.teamId).toBeNull();
    expect(events.filter((e) => e.type === 'ticket.updated').at(-1)).toMatchObject({ ticket: { id: tk.id, teamId: null } });
    expect(() => deleteTeam(ctx, t.id)).toThrow(/not found/i);
  });

  it('deleting a lead agent leaves the team without a lead', () => {
    createAgent(ctx, { name: 'Other', runtime: 'claude-cli' });
    const a = createAgent(ctx, { name: 'Lead', runtime: 'claude-cli' });
    const t = createTeam(ctx, { name: 'T', leadAgentId: a.id });
    deleteAgent(ctx, a.id);
    expect(repos.teams!.get(t.id)).toMatchObject({ leadAgentId: null, memberIds: [] });
  });
});

describe('templates create teams', () => {
  it('Red Team is strict: every outbound key asks, production always asks', async () => {
    const res = await applyTemplate(ctx, { templateId: 'red-team' });
    expect(res.team).toMatchObject({ slug: 'red-team', name: 'Red Team' });
    for (const a of res.agents) {
      for (const k of ['script.run', 'web.read', 'email.send', 'tool.change', 'prod.change'] as const) expect(a.permissions[k]).toBe('ask');
      expect(a.job).toMatch(/scope/i);
    }
    expect(res.agents[0]!.job).toMatch(/rules of engagement/);
    expect(res.agents.find((a) => a.role.includes('Offensive'))!.job).toMatch(/denial-of-service/);
    expect(security.find((s) => s.action === 'team.created')).toMatchObject({ category: 'config', data: { templateId: 'red-team' } });
  });
});

describe('routing rules', () => {
  it('stems plurals and splits hints into keywords and phrases', () => {
    expect(['resets', 'patches', 'policies', 'access', 'servers'].map(stem)).toEqual(['reset', 'patch', 'policy', 'access', 'server']);
    const { keywords, phrases } = hintTerms('password resets, Outlook/Teams issues, IaC/Terraform');
    expect(keywords.map((k) => k.stem)).toEqual(expect.arrayContaining(['password', 'reset', 'outlook', 'iac', 'terraform']));
    expect(keywords.map((k) => k.stem)).not.toContain('issue'); // generic words never count
    expect(keywords.find((k) => k.stem === 'outlook')!.weight).toBe(1);
    expect(keywords.find((k) => k.stem === 'password')!.weight).toBe(0.5);
    expect(phrases.map((p) => p.display)).toContain('password resets');
    expect(isConfident(3, 0)).toBe(true);
    expect(isConfident(2, 2)).toBe(false);
    expect(isConfident(2, 1)).toBe(false);
    expect(isConfident(1, 0)).toBe(false);
  });

  it('routes clear IT Ops tickets to the right team and member, with a reason', async () => {
    await allBuiltins();
    const cases: Array<[string, string, string]> = [
      ['Reset password for Mario Rossi', 'He is locked out of his account after the holidays.', 'service-desk'],
      ['VPN down at the Naples office', 'Nobody can connect since 9:00.', 'infrastructure'],
      ['Pipeline failing on main', 'The CI build fails at the docker build step since yesterday.', 'devops'],
      ['Patch CVE-2026-1234 on Exchange', 'Check if we are affected and plan the patching.', 'security'],
      ['Pentest of the staging web app', 'Authorised penetration test of staging.example.com next week.', 'red-team'],
      ['La stampante del secondo piano non stampa', 'Gli utenti non riescono a stampare.', 'service-desk'],
    ];
    for (const [title, goal, slug] of cases) {
      const r = routeByRules(ctx, { title, goal });
      expect(r.confident, `${title}: ${JSON.stringify(r.scores.slice(0, 2).map((s) => [s.team.slug, s.score]))}`).toBe(true);
      expect(r.decision.teamId, title).toBe(bySlug(slug).id);
      expect(r.decision.by).toBe('rules');
      expect(r.decision.reason).toMatch(/→/);
      const agent = repos.agents.get(r.decision.agentId!)!;
      expect(agent.teamId).toBe(bySlug(slug).id);
    }
    const vpn = routeByRules(ctx, { title: 'VPN down at the Naples office', goal: 'x' }).decision;
    expect(vpn.reason).toMatch(/mentions VPN → Infrastructure/);
    // A member whose role/skills match beats the lead.
    const pipe = routeByRules(ctx, { title: 'Pipeline failing on main', goal: 'Review the pipeline and fix the build.' }).decision;
    expect(repos.agents.get(pipe.agentId!)!.name).toBe('CI/CD Engineer');
    expect(turns).toEqual([]); // no model call for clear tickets
  });

  it('v0.5 M: routes Italian tickets to the right team (built-in hints stay in English)', async () => {
    await allBuiltins();
    const cases: Array<[string, string, string]> = [
      // Service Desk
      ['Password scaduta per Gennaro Esposito', 'Da stamattina non riesce più ad entrare, gli serve una password nuova.', 'service-desk'],
      ["La stampante dell'ufficio acquisti non stampa", 'I documenti restano in coda e non esce niente.', 'service-desk'],
      ["Nuovo assunto lunedì all'amministrazione", 'Preparare utenza, casella di posta e portatile per Ciro Russo.', 'service-desk'],
      ['Account bloccato', 'La collega del secondo piano ha sbagliato la password tre volte.', 'service-desk'],
      // Infrastructure
      ['Server giù a Napoli', 'Il file server FS01 non risponde da stamattina alle 8.', 'infrastructure'],
      ['Backup fallito stanotte', 'Il job notturno sul NAS è andato in errore, verificare e rilanciare.', 'infrastructure'],
      ['Firewall: aprire la porta 443 verso il nuovo gestionale', 'Serve una regola sul firewall della sede.', 'infrastructure'],
      ['Disco pieno sul server di posta', 'Spazio su disco quasi finito sul volume dei log.', 'infrastructure'],
      // DevOps
      ['La pipeline di build fallisce', 'Da ieri la pipeline su main si ferma allo step di docker build.', 'devops'],
      ['Rilascio della versione 2.3 venerdì', 'Preparare il rilascio con checklist e piano di rollback.', 'devops'],
      ['Troppi allarmi da Grafana', 'Il monitoraggio manda avvisi di notte per niente, sistemare le soglie.', 'devops'],
      // Security
      ['Vulnerabilità critica su Exchange', 'È uscito un CVE nuovo: verificare se siamo esposti e pianificare la patch.', 'security'],
      ['Mail di phishing arrivata a tre colleghi', 'Controllare se qualcuno ha cliccato sul link e bloccare il mittente.', 'security'],
      ["Accessi sospetti sull'account del direttore", 'Login di notte da un paese estero, verificare subito.', 'security'],
      // Red Team
      ['Penetration test del portale fornitori', "Test autorizzato sull'ambiente di staging, perimetro scritto in allegato.", 'red-team'],
      ["Simulazione di phishing per l'ufficio amministrazione", 'Campagna autorizzata dalla direzione, da fare a dicembre.', 'red-team'],
      ['Test di intrusione sulla rete ospiti', 'Esercitazione red team concordata con il responsabile IT.', 'red-team'],
    ];
    for (const [title, goal, slug] of cases) {
      const r = routeByRules(ctx, { title, goal });
      expect(r.confident, `${title}: ${JSON.stringify(r.scores.slice(0, 3).map((s) => [s.team.slug, s.score, s.matched]))}`).toBe(true);
      expect(r.decision.teamId, title).toBe(bySlug(slug).id);
    }
    expect(turns).toEqual([]); // no model call for clear Italian tickets either
  });

  it('v0.6 P: strong security words weigh more, with the owner\'s real hints (English and Italian)', async () => {
    await allBuiltins();
    // The owner's real hints (docs/29 v0.5 Plan.md §M), set explicitly.
    updateTeam(ctx, bySlug('security').id, { routingHints: 'CVE, vulnerabilities, patching, security advisories, phishing, malware, security incidents, suspicious logins, access reviews, admin rights, hardening, SIEM, EDR, antivirus, MFA, compliance, GDPR' });
    updateTeam(ctx, bySlug('service-desk').id, { routingHints: 'password resets, account unlock, new users, leavers, printers, laptops, desktops, phones, Outlook, Microsoft Teams, email, Excel, OneDrive, SharePoint, software install, access requests, shared folders, how-to questions' });
    const teams = listTeams(ctx);
    const score = (title: string, goal: string, slug: string) => scoreTeams({ title, goal }, teams).find((s) => s.team.slug === slug)!.score;

    // The tie of v0.5 M: "phishing" (Security) vs "email" (Service Desk), 3 vs 3. Now 3 + 5 vs 3.
    expect(score('Email di phishing', '', 'security')).toBe(8);
    expect(score('Email di phishing', '', 'service-desk')).toBe(3); // "email" is not a strong word: unchanged
    expect(score('A user received a suspicious phishing email', '', 'security')).toBe(9.5); // phishing 3 + suspicious 1.5 + 5
    expect(score('A user received a suspicious phishing email', '', 'service-desk')).toBe(6); // user 3 + email 3
    // A simulation is not an incident: no strong points for anyone.
    expect(score('Phishing simulation for the finance office', '', 'security')).toBe(3);

    const cases: Array<[string, string, string]> = [
      // English
      ['A user received a suspicious phishing email', 'Please check.', 'security'],
      ['Phishing email', 'Mario forwarded it to us.', 'security'],
      ['Laptop infected with malware', 'The antivirus flagged it this morning.', 'security'],
      ['Suspicious login on Outlook', 'Login from abroad at 3 AM.', 'security'],
      ['Phishing simulation for the finance office', 'Authorised campaign in December.', 'red-team'],
      ['Outlook keeps asking for the password', 'Email works on the phone.', 'service-desk'],
      // Italian
      ['Email di phishing', 'Mario ha inoltrato il messaggio.', 'security'],
      ['Malware sul portatile di Gennaro', "L'antivirus ha segnalato un file.", 'security'],
      ['Accesso sospetto sul PC di Mario', 'Login di notte da un paese estero.', 'security'],
      ['Computer compromesso da un ransomware', 'Isolare subito la macchina.', 'security'],
      ['Simulazione di phishing per la contabilità', 'Campagna autorizzata dalla direzione.', 'red-team'],
      ['Casella di posta piena', 'Outlook dice che la casella ha finito lo spazio.', 'service-desk'],
    ];
    for (const [title, goal, slug] of cases) {
      const r = routeByRules(ctx, { title, goal });
      expect(r.confident, `${title}: ${JSON.stringify(r.scores.slice(0, 3).map((s) => [s.team.slug, s.score, s.matched]))}`).toBe(true);
      expect(r.decision.teamId, title).toBe(bySlug(slug).id);
    }
    expect(routeByRules(ctx, { title: 'Email di phishing', goal: '' }).decision.reason).toMatch(/^mentions phishing/);
    expect(turns).toEqual([]);
  });

  it('v0.6 P: strong words count only when they are in the team\'s own hints', () => {
    const mail = createTeam(ctx, { name: 'Mail', routingHints: 'email, mailboxes' });
    createTeam(ctx, { name: 'Printers', routingHints: 'printers' });
    const s = scoreTeams({ title: 'Phishing email', goal: '' }, listTeams(ctx));
    expect(s.find((x) => x.team.id === mail.id)!.score).toBe(3); // "email" only: "phishing" is not in its hints
    expect(s.find((x) => x.team.slug === 'printers')!.score).toBe(0);
  });

  it('tags and the project hint add points', async () => {
    await allBuiltins();
    const teams = listTeams(ctx);
    const base = scoreTeams({ title: 'Look at this', goal: 'Something about alerts' }, teams);
    const tagged = scoreTeams({ title: 'Look at this', goal: 'Something about alerts', tags: ['security'] }, teams);
    expect(tagged.find((s) => s.team.slug === 'security')!.score).toBeGreaterThan(base.find((s) => s.team.slug === 'security')!.score);
    const sec = bySlug('security');
    const score = (counts: Array<{ teamId: string; count: number }>) =>
      scoreTeams({ title: 'x', goal: 'a phishing mail' }, teams, counts).find((s) => s.team.slug === 'security')!.score;
    expect(score([{ teamId: sec.id, count: 3 }])).toBe(score([]) + 1);
    expect(score([{ teamId: sec.id, count: 1 }])).toBe(score([])); // one ticket is not a pattern
  });

  it('ambiguous → Chief of Staff (validated); invalid JSON or errors → fallback', async () => {
    await allBuiltins();
    const vague = { title: 'Mario has a problem', goal: 'Please look into what Mario said this morning.' };
    expect(routeByRules(ctx, vague).confident).toBe(false);

    turnReply = 'Sure! {"teamSlug": "infrastructure", "agentName": "Sysadmin Assistant", "reason": "Sounds like a server issue"}';
    const d1 = await route(ctx, vague);
    expect(d1).toMatchObject({ teamId: bySlug('infrastructure').id, agentId: agentNamed('Sysadmin Assistant').id, by: 'chief-of-staff' });
    expect(d1.reason).toBe('Chief of Staff: Sounds like a server issue → Infrastructure');
    expect(turns[0]).toContain('Mario has a problem');

    turnReply = '{"teamSlug": "infrastructure", "agentName": "Nobody Real", "reason": "x"}';
    expect((await route(ctx, vague)).agentId).toBe(agentNamed('Infrastructure Lead').id); // unknown name → best member / lead

    turnReply = '{"teamSlug": "accounting", "reason": "x"}';
    const d2 = await route(ctx, vague);
    expect(d2).toMatchObject({ teamId: null, by: 'fallback', confidence: 0 });
    expect(d2.reason).toMatch(/not a valid team/);

    turnReply = 'I think Infrastructure.';
    expect((await route(ctx, vague)).by).toBe('fallback');

    turnReply = new Error('the planning model took too long');
    const d3 = await route(ctx, vague);
    expect(d3).toMatchObject({ teamId: null, by: 'fallback' });
    expect(d3.reason).toMatch(/took too long/);
    expect(d3.agentId).toBe(repos.agents.list().find((a) => !a.paused && a.runtime !== 'mock')!.id); // default agent
  });

  it('no teams → fallback without calling the model', async () => {
    createAgent(ctx, { name: 'Assistant', runtime: 'claude-cli' });
    const d = await route(ctx, { title: 'VPN down', goal: 'x' });
    expect(d).toMatchObject({ teamId: null, by: 'fallback' });
    expect(d.reason).toMatch(/no teams yet/i);
    expect(turns).toEqual([]);
  });

  it('never picks a paused agent; the test agent only when it is the only option', () => {
    const t = createTeam(ctx, { name: 'Net', routingHints: 'VPN' });
    const mock = createAgent(ctx, { name: 'Test agent', runtime: 'mock', teamId: t.id });
    const lead = createAgent(ctx, { name: 'Net Lead', runtime: 'claude-cli', teamId: t.id, role: 'Network lead' });
    updateTeam(ctx, t.id, { leadAgentId: lead.id });
    const vpnExpert = createAgent(ctx, { name: 'VPN Expert', runtime: 'claude-cli', teamId: t.id, role: 'VPN engineer', job: 'Fix VPN tunnels.' });
    const input = { title: 'VPN tunnel down', goal: 'Fix it' };
    const team = (): Team => repos.teams!.get(t.id)!;
    expect(pickTeamMember(team(), repos.agents.list(), input)!.agent.id).toBe(vpnExpert.id);
    updateAgent(ctx, vpnExpert.id, { paused: true });
    expect(pickTeamMember(team(), repos.agents.list(), input)!.agent.id).toBe(lead.id);
    updateAgent(ctx, lead.id, { paused: true });
    expect(pickTeamMember(team(), repos.agents.list(), input)!.agent.id).toBe(mock.id);
    updateAgent(ctx, mock.id, { paused: true });
    expect(pickTeamMember(team(), repos.agents.list(), input)).toBeNull();
  });
});

describe('tickets with teams', () => {
  it("teamId 'auto': clear → routed at creation with audit + security event", async () => {
    await allBuiltins();
    const t = await createTicket(ctx, { title: 'VPN down at the Naples office', goal: 'Nobody can connect.', teamId: 'auto' });
    expect(t.teamId).toBe(bySlug('infrastructure').id);
    expect(repos.agents.get(t.agentId!)!.teamId).toBe(bySlug('infrastructure').id);
    const routed = repos.audit.listForTicket(t.id).items.find((e) => e.summary.startsWith('Routed to'))!;
    expect(routed.summary).toMatch(/^Routed to Infrastructure → Infrastructure Lead: mentions .*VPN/);
    expect((routed.data as { routing: RouteDecision }).routing.by).toBe('rules');
    expect(security.find((s) => s.action === 'ticket.routed')).toMatchObject({ category: 'ticket', ticketId: t.id });
  });

  it("teamId 'auto': unsure → created at once without a team, then routed by the Chief of Staff in the background", async () => {
    await allBuiltins();
    turnReply = '{"teamSlug": "security", "reason": "Possible phishing"}';
    const t = await createTicket(ctx, { title: 'Strange message', goal: 'Mario got a weird message and clicked it.', teamId: 'auto', start: true });
    expect(t.teamId).toBeNull();
    await settleBackgroundRouting();
    const after = repos.tickets.get(t.id)!;
    expect(after.teamId).toBe(bySlug('security').id);
    expect(after.agentId).toBe(agentNamed('Security Lead').id);
    expect(events.filter((e): e is Extract<WsEvent, { type: 'ticket.updated' }> => e.type === 'ticket.updated').at(-1)!.ticket.teamId).toBe(bySlug('security').id);
    expect(repos.audit.listForTicket(t.id).items.at(-1)!.summary).toMatch(/Chief of Staff: Possible phishing → Security/);
  });

  it('v0.6 O: the Chief of Staff\'s routing call is recorded on the ticket (rules-only routing costs nothing)', async () => {
    await allBuiltins();
    turnReply = '{"teamSlug": "security", "reason": "Possible phishing"}';
    const t = await createTicket(ctx, { title: 'Strange message', goal: 'Mario got a weird message and clicked it.', teamId: 'auto' });
    await settleBackgroundRouting();
    await createTicket(ctx, { title: 'VPN down at the Naples office', goal: 'Nobody can connect.', teamId: 'auto' }); // clear: rules, no call
    await settleBackgroundRouting();
    const day = new Date();
    const r = repos.costs!.report({
      from: new Date(day.getTime() - 86_400_000).toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString(), groupBy: [], top: 10,
    });
    expect(r.planning).toEqual([{ purpose: 'routing', costUsd: 0.001, paidUsd: 0.001, calls: 1, failed: 0, tokensIn: 0, tokensOut: 0 }]);
    expect(r.topTickets.map((x) => [x.ticketId, x.planningUsd])).toEqual([[t.id, 0.001]]);
  });

  it('a manual team without an agent → its best member or lead; with an agent → that agent; filter by team', async () => {
    await allBuiltins();
    const infra = bySlug('infrastructure');
    const a = await createTicket(ctx, { title: 'Check backups', goal: 'Weekly check', teamId: infra.id });
    expect(a.teamId).toBe(infra.id);
    expect(repos.agents.get(a.agentId!)!.teamId).toBe(infra.id);
    const b = await createTicket(ctx, { title: 'Anything', goal: 'x', teamId: infra.id, agentId: agentNamed('Capacity Planner').id });
    expect(b.agentId).toBe(agentNamed('Capacity Planner').id);
    const c = await createTicket(ctx, { title: 'No team', goal: 'x', teamId: null });
    expect(c.teamId).toBeNull();
    const d = await createTicket(ctx, { title: 'Agent only', goal: 'x', agentId: agentNamed('CVE Researcher').id });
    expect(d.teamId).toBe(bySlug('security').id); // inherits the agent's team
    await expect(createTicket(ctx, { title: 'x', goal: 'y', teamId: 'nope' })).rejects.toThrow(/does not exist/);

    const titles = (q: Parameters<typeof listTickets>[1]) => listTickets(ctx, q).items.map((t) => t.title).sort();
    expect(titles({ teamId: infra.id })).toEqual(['Anything', 'Check backups']);
    expect(titles({ teamId: 'none' })).toEqual(['No team']);
  });

  it('update: a team moves the ticket to a member unless started; null clears; auto routes', async () => {
    await allBuiltins();
    const t = await createTicket(ctx, { title: 'Printer jam', goal: 'Floor 2', teamId: null });
    const sec = bySlug('security');
    const moved = updateTicket(ctx, t.id, { teamId: sec.id });
    expect(moved.teamId).toBe(sec.id);
    expect(repos.agents.get(moved.agentId!)!.teamId).toBe(sec.id);
    expect(updateTicket(ctx, t.id, { teamId: null }).teamId).toBeNull();
    const auto = updateTicket(ctx, t.id, { teamId: 'auto' });
    expect(auto.teamId).toBe(bySlug('service-desk').id);

    // Started tickets keep their agent: only the team changes.
    const s = await createTicket(ctx, { title: 'Started', goal: 'x', teamId: null });
    repos.sessions.create({ ticketId: s.id, agentId: s.agentId, runtime: 'claude-cli', model: null, reason: 'new' });
    const before = repos.tickets.get(s.id)!.agentId;
    const r = await routeTicket(ctx, s.id);
    expect(r.ticket.agentId).toBe(before);
    expect(updateTicket(ctx, s.id, { teamId: sec.id }).agentId).toBe(before);
  });
});

describe('intake proposals carry a team', () => {
  it('the system prompt lists teams; proposals keep valid teams, drop unknown ones, default to the agent team', async () => {
    await allBuiltins();
    const agents: Agent[] = repos.agents.list();
    const teams = listTeams(ctx);
    const prompt = buildIntakeSystemPrompt(agents, '2026-11-12', teams);
    expect(prompt).toContain(`teamId "${bySlug('devops').id}": DevOps. Handles: CI/CD`);
    const raw = JSON.stringify({
      reply: 'ok',
      proposals: [
        { key: 'p1', title: 'Fix pipeline', goal: 'g', agentId: null, teamId: bySlug('devops').id, costCapUsd: 2, dependsOn: [] },
        { key: 'p2', title: 'Bad team', goal: 'g', agentId: null, teamId: 'nope', costCapUsd: 2, dependsOn: [] },
        { key: 'p3', title: 'Agent team', goal: 'g', agentId: agentNamed('CVE Researcher').id, costCapUsd: 2, dependsOn: [] },
      ],
    });
    const { proposals } = parseIntakeOutput(raw, agents, teams);
    expect(proposals.map((p) => p.teamId)).toEqual([bySlug('devops').id, null, bySlug('security').id]);
    const created: Ticket[] = await acceptIntake(ctx, { proposals: [proposals[0]!] });
    expect(created[0]).toMatchObject({ teamId: bySlug('devops').id });
    expect(repos.agents.get(created[0]!.agentId!)!.teamId).toBe(bySlug('devops').id);
  });
});

describe('teams and routing API', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await createServer(ctx); });
  afterEach(async () => { await app.close(); });
  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers: auth, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('CRUD, preview, route, ticket filter, agent teamId, settings', async () => {
    await allBuiltins();
    expect((await req('GET', '/teams')).json().map((t: Team) => t.slug).sort()).toEqual(['devops', 'infrastructure', 'red-team', 'security', 'service-desk']);
    const created = await req('POST', '/teams', { name: 'Facilities', routingHints: 'badges, desks, air conditioning' });
    expect(created.statusCode).toBe(201);
    const fac = created.json() as Team;
    expect((await req('POST', '/teams', { name: 'Facilities' })).statusCode).toBe(409);
    expect((await req('PATCH', `/teams/${fac.id}`, { color: '#2E7D5B' })).json().color).toBe('#2E7D5B');

    const preview = await req('POST', '/routing/preview', { title: 'Badge does not open the door', goal: 'New badges for the Naples office' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ teamId: fac.id, by: 'rules' });
    expect(repos.tickets.list({}).items).toHaveLength(0); // no side effects
    const quick = await req('POST', '/routing/preview', { title: 'Mario has a problem', goal: 'Look at it', rulesOnly: true });
    expect(quick.json()).toMatchObject({ teamId: null, by: 'fallback' });
    expect(turns).toEqual([]); // rulesOnly never calls the model

    const agent = await req('POST', '/agents', { name: 'Facility Bot', runtime: 'claude-cli', teamId: fac.id });
    expect(agent.json().teamId).toBe(fac.id);
    expect((await req('PATCH', `/agents/${agent.json().id}`, { teamId: null })).json().teamId).toBeNull();

    const t = (await req('POST', '/tickets', { title: 'VPN down', goal: 'Office VPN', teamId: 'auto' })).json() as Ticket;
    expect(t.teamId).toBe(bySlug('infrastructure').id);
    const manual = (await req('POST', '/tickets', { title: 'Something', goal: 'x', teamId: fac.id })).json() as Ticket;
    expect(manual.teamId).toBe(fac.id);
    const routed = await req('POST', `/tickets/${manual.id}/route`);
    expect(routed.statusCode).toBe(200);
    expect(routed.json().decision.by).toBe('fallback'); // 'Something' matches nothing; fake Chief of Staff finds no team
    expect(routed.json().ticket.teamId).toBeNull();
    const filtered = (await req('GET', `/tickets?teamId=${bySlug('infrastructure').id}`)).json();
    expect(filtered.items.map((x: Ticket) => x.id)).toEqual([t.id]);
    expect((await req('PATCH', `/tickets/${t.id}`, { teamId: fac.id })).json().teamId).toBe(fac.id);

    expect((await req('DELETE', `/teams/${fac.id}`)).statusCode).toBe(204);
    expect((await req('GET', `/tickets/${t.id}`)).json().ticket.teamId).toBeNull();

    expect((await req('GET', '/settings')).json().newTicketTeam).toBe('manual');
    expect((await req('PATCH', '/settings', { newTicketTeam: 'auto' })).statusCode).toBe(503); // no settings store in this ctx
    expect((await req('PATCH', '/settings', { newTicketTeam: 'sometimes' })).statusCode).toBe(400);
  });
});
