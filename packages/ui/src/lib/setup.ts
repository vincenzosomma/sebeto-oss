/** Pure helpers for the first-run setup wizard (roadmap v0.2 item 7). */
import type { Agent, RuntimeInfo } from '@sebeto/shared';

export type RuntimeStatus = 'ready' | 'signin' | 'missing';

/** Ready = installed and not known to be signed out. */
export function runtimeStatus(r: Pick<RuntimeInfo, 'detection'>): RuntimeStatus {
  if (!r.detection.installed) return 'missing';
  if (r.detection.loggedIn === false) return 'signin';
  return 'ready';
}

/**
 * The agent used for "Automatic": mirrors packages/core/src/default-agent.ts (the oldest active agent
 * with a real AI runtime; the test agent only when there is nothing else).
 */
export function pickDefaultAgent(agents: Agent[]): Agent | undefined {
  const byAge = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return byAge.find((a) => !a.paused && a.runtime !== 'mock')
    ?? byAge.find((a) => a.runtime !== 'mock')
    ?? byAge.find((a) => !a.paused)
    ?? byAge[0];
}

/** Real runtimes first (ready ones on top), the free test agent last. */
export function sortRuntimes(list: RuntimeInfo[]): RuntimeInfo[] {
  const rank = (r: RuntimeInfo) => (r.id === 'mock' ? 3 : runtimeStatus(r) === 'ready' ? 0 : runtimeStatus(r) === 'signin' ? 1 : 2);
  return list.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

export interface RuntimeChoice { runtime: string; model: string | null }

/**
 * What the picker shows first: the default agent's runtime when it is ready, otherwise the first ready
 * real runtime, otherwise whatever the agent has now. The model is kept only if the runtime offers it.
 */
export function initialChoice(agent: Pick<Agent, 'runtime' | 'model'> | undefined, runtimes: RuntimeInfo[]): RuntimeChoice | null {
  const ready = runtimes.filter((r) => runtimeStatus(r) === 'ready');
  const current = agent ? ready.find((r) => r.id === agent.runtime) : undefined;
  const pick = (current && current.id !== 'mock' ? current : undefined)
    ?? ready.find((r) => r.id !== 'mock')
    ?? current
    ?? ready[0];
  if (!pick) return agent ? { runtime: agent.runtime, model: agent.model } : null;
  const model = agent && agent.runtime === pick.id && agent.model && pick.models.includes(agent.model) ? agent.model : null;
  return { runtime: pick.id, model };
}

/** True when ?setup=1 is in the address (forces the wizard, e.g. for screenshots in mock mode). */
export function setupForced(href: string): boolean {
  try {
    return new URL(href).searchParams.get('setup') === '1';
  } catch {
    return false;
  }
}
