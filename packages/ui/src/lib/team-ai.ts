/**
 * Pure helpers for v0.4 F (team AI + lock) and G (written scope) in the UI.
 * The core enforces both; the UI only explains and disables what would be refused.
 */
import { MAX_SCOPE_CHARS, type Agent, type Id, type RuntimeInfo, type Team, type Ticket } from '@sebeto/shared';

type Teams = Record<Id, Team> | null | undefined;
type Agents = Record<Id, Agent>;

/** The team if it is locked to a runtime, else null. */
export function lockedTeam(teams: Teams, teamId: Id | null | undefined): Team | null {
  const t = teamId ? teams?.[teamId] : undefined;
  return t?.lockRuntime && t.runtime ? t : null;
}

/** The locked team that rules a ticket: its own team, else its agent's team. */
export function ticketLockTeam(ticket: Pick<Ticket, 'teamId' | 'agentId'>, teams: Teams, agents: Agents): Team | null {
  return lockedTeam(teams, ticket.teamId) ?? lockedTeam(teams, ticket.agentId ? agents[ticket.agentId]?.teamId : null);
}

/** The team that needs a written scope for a ticket (its own team, else its agent's team), or null. */
export function ticketScopeTeam(ticket: Pick<Ticket, 'teamId' | 'agentId'>, teams: Teams, agents: Agents): Team | null {
  for (const id of [ticket.teamId, ticket.agentId ? agents[ticket.agentId]?.teamId : null]) {
    const t = id ? teams?.[id] : undefined;
    if (t?.requireScope) return t;
  }
  return null;
}

/** Display name of a runtime id (falls back to the id). */
export function runtimeName(runtimes: RuntimeInfo[] | null | undefined, id: string | null | undefined): string {
  if (!id) return '';
  return runtimes?.find((r) => r.id === id)?.displayName ?? id;
}

export function isInstalled(runtimes: RuntimeInfo[] | null | undefined, id: string | null | undefined): boolean {
  return !!id && !!runtimes?.find((r) => r.id === id)?.detection.installed;
}

/** Runtimes local to this computer (no cloud AI): used to suggest one for the Red Team. */
export const LOCAL_RUNTIMES: readonly string[] = ['ollama'];

/**
 * The AI to preselect when adding a template: the template's own runtime when it has one; for the
 * Red Team a local runtime (Ollama) when installed, locked; otherwise nothing (the usual AI).
 */
export function suggestedTemplateAi(templateId: string, templateRuntime: string | null | undefined, runtimes: RuntimeInfo[] | null | undefined): { runtime: string; lock: boolean; local: boolean } | null {
  if (templateRuntime) return { runtime: templateRuntime, lock: false, local: LOCAL_RUNTIMES.includes(templateRuntime) };
  if (templateId === 'red-team') {
    const local = LOCAL_RUNTIMES.find((id) => isInstalled(runtimes, id));
    if (local) return { runtime: local, lock: true, local: true };
  }
  return null;
}

/** Largest scope file the browser reads (the text itself is capped at MAX_SCOPE_CHARS). */
export const MAX_SCOPE_FILE_BYTES = 200_000;

export type ScopeFileProblem = 'scope.fileType' | 'scope.fileBig' | null;

/** Only .txt / .md files, and not too big. */
export function checkScopeFile(name: string, size: number): ScopeFileProblem {
  if (!/\.(txt|md|markdown)$/i.test(name)) return 'scope.fileType';
  if (size > MAX_SCOPE_FILE_BYTES) return 'scope.fileBig';
  return null;
}

/** The scope text can be saved: not empty, not too long, confirmed. */
export function scopeReady(text: string, confirmed: boolean): boolean {
  return confirmed && text.trim().length > 0 && text.length <= MAX_SCOPE_CHARS;
}

/** First 12 characters of a sha256, for display. */
export const shortHash = (sha256: string) => sha256.slice(0, 12);
