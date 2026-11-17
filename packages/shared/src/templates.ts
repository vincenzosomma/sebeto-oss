/**
 * Team templates (v0.3; docs/17 Agents & Skills.md "Team templates"): a ready-made team of agents
 * with their reporting lines and skills, added to the workspace in one step, or exported / imported
 * as a JSON file to share a team.
 *
 * API (all under /api/v1):
 *   GET    /templates                 → TeamTemplate[] (built-in first, then saved ones)
 *   POST   /templates                 TeamTemplate → TeamTemplate (save an imported template; id derived from name; builtin forced false)
 *   DELETE /templates/:id             → 204 (saved templates only; built-in ones cannot be deleted)
 *   POST   /templates/apply           ApplyTemplateBody → ApplyTemplateResponse (201)
 *   GET    /templates/export?agentIds=a,b   → TeamTemplate (the current team, or the listed agents and everyone below them)
 * WebSocket: { type: 'templates.changed' } after save/delete; applying sends agent.updated + skills.changed.
 */
import type { Agent, Id, PermissionKey, PermissionLevel, RuntimeId } from './types.js';
import type { Team } from './teams.js';

export const TEMPLATE_FORMAT = 'sebeto-team/1';

export interface TemplateAgent {
  /** Local key, unique inside the template ("lead", "analyst"). */
  key: string;
  name: string;
  role: string;
  job: string;
  /** Key of the manager inside the template; null = top of the team. */
  reportsTo: string | null;
  /** null/absent = the workspace's default AI when applied. */
  runtime?: RuntimeId | null;
  model?: string | null;
  heartbeatMinutes?: number;
  monthlyBudgetUsd?: number;
  /** Overrides on top of the defaults; never loosens production (ALWAYS_ASK still applies). */
  permissions?: Partial<Record<PermissionKey, PermissionLevel>>;
  /** Skill slugs, from this template's skills or already in the library. */
  skills: string[];
}

export interface TemplateSkill {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  needs?: PermissionKey[];
  connectors?: string[];
}

export interface TeamTemplate {
  format: typeof TEMPLATE_FORMAT;
  id: string;
  name: string;
  description: string;
  /** True for templates shipped with Sebeto. */
  builtin: boolean;
  agents: TemplateAgent[];
  skills: TemplateSkill[];
  /** Connector catalog ids the team works best with (informational). */
  suggestedConnectors?: string[];
  /**
   * v0.4: the Team created when the template is applied (teams.ts). slug defaults to the template id
   * (built-ins) or a slug of the name; colour to the next palette colour; routingHints to ''.
   */
  team?: TemplateTeam;
  /**
   * v0.9: several teams in one file (a whole workspace export). When present, `team` is ignored and
   * applying creates each team with its own members (agent keys) and lead; agents in no team stay
   * without a team.
   */
  teams?: TemplateTeamWithMembers[];
}

/** v0.9: one team of a multi-team file. */
export interface TemplateTeamWithMembers extends TemplateTeam {
  name: string;
  /** Agent keys in this team (each agent in at most one team). */
  memberKeys: string[];
  /** Agent key of the lead (default: the member highest in the org chart). */
  leadKey?: string | null;
}

/** v0.4: team settings carried by a template. */
export interface TemplateTeam {
  /** Team name (default: the template name). */
  name?: string;
  slug?: string;
  color?: string;
  routingHints?: string;
  /** v0.4 F/G (see Team). Applying keeps the lock only when that runtime is installed. */
  runtime?: RuntimeId | null;
  model?: string | null;
  lockRuntime?: boolean;
  requireScope?: boolean;
}

export interface ApplyTemplateBody {
  /** A built-in or saved template… */
  templateId?: string;
  /** …or a template object (e.g. from an imported file) applied without saving it. */
  template?: TeamTemplate;
  /** Put the team's top agents under this existing agent (null/absent = under You). */
  reportsTo?: Id | null;
  /** v0.4 F: run the whole team on this AI (overrides the template; null/absent = template or workspace default). */
  runtime?: RuntimeId | null;
  model?: string | null;
  /** v0.4 F: lock the team to that runtime. */
  lockRuntime?: boolean;
}

export interface ApplyTemplateResponse {
  /** Agents created, in template order (names get " 2", " 3"… if already taken). */
  agents: Agent[];
  /** Skill slugs added to the library. */
  skillsCreated: string[];
  /** Skill slugs that already existed and were reused (never overwritten). */
  skillsReused: string[];
  /** v0.4: the team created for these agents (lead = the template's top agent). */
  team?: Team;
  /** v0.9: every team created, when the file had several (`team` is then the first). */
  teams?: Team[];
  /** v0.4 F: what was not applied as asked, in plain words (e.g. "Ollama is not installed, so the team was created without the lock"). */
  warnings?: string[];
}

// ---- Org chart: deleting an agent (DELETE /api/v1/agents/:id)
/**
 * Deleting an agent: its open tickets move to the default agent, its direct reports move up to its
 * manager, its connector access and skills assignments are removed. Refused (409) while the agent is
 * running a ticket, or when it is the last agent.
 */
export interface DeleteAgentResponse {
  ok: true;
  /** Tickets reassigned to the default agent. */
  reassignedTickets: number;
  /** Direct reports moved up to the deleted agent's manager. */
  movedReports: number;
}
