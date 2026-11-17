/**
 * Which of the owner's Claude connectors an agent may use in a Claude Code session: the ones ticked
 * on the agent, plus the ones turned on for its team (team.claudeConnectors), plus the ones turned on
 * for all agents (settings.claudeConnectorsAllAgents). Every call still goes through the permission
 * gate (tools/server.ts approve_tool, docs/38).
 */
import type { Agent, AppSettings, Team } from '@sebeto/shared';

export function claudeConnectorsFor(
  agent: Pick<Agent, 'claudeConnectors'> | null | undefined,
  settings: Pick<AppSettings, 'claudeConnectorsAllAgents'> | null | undefined,
  team?: Pick<Team, 'claudeConnectors'> | null,
): string[] {
  if (!agent) return [];
  const out: string[] = [];
  for (const n of [...(agent.claudeConnectors ?? []), ...(team?.claudeConnectors ?? []), ...(settings?.claudeConnectorsAllAgents ?? [])]) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}
