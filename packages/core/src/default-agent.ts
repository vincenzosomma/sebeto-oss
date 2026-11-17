import type { Agent } from '@sebeto/shared';

/**
 * The agent used when the user picks "Automatic" or a ticket has no agent:
 * the oldest active agent with a real AI runtime. The free test agent ('mock') is only chosen
 * when it is the only agent, so tickets never silently run on the fake agent.
 */
export function pickDefaultAgent(agents: Agent[]): Agent | undefined {
  const byAge = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return byAge.find((a) => !a.paused && a.runtime !== 'mock')
    ?? byAge.find((a) => a.runtime !== 'mock')
    ?? byAge.find((a) => !a.paused)
    ?? byAge[0];
}
