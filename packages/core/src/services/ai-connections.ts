/**
 * v0.7 R: AI connections API (packages/shared/src/ai-connections.ts).
 *
 *  - Every add / change / removal is a security event (category 'connector'), with names, kind and
 *    host only: never the API key (the event says only whether a key is set or was changed).
 *  - The v0.4 F team lock: a team locked to `openai:<id>` keeps running on exactly that connection.
 *    Because the connection decides where ticket content goes, its address and kind cannot change
 *    while a locked team uses it (409 runtime_locked), and no connection can be removed while an
 *    agent or team uses it (409 ai_connection_in_use).
 */
import {
  AI_CONNECTION_ERRORS, TEAM_POLICY_ERRORS,
  type AiConnection, type AiConnectionTestResult, type CreateAiConnectionBody, type Id, type UpdateAiConnectionBody,
} from '@sebeto/shared';
import { AiConnectionError } from '../connectors/ai-connections.js';
import type { AppContext } from '../contracts.js';
import { AppError, badRequest, notFound, unavailable } from './errors.js';

function store(ctx: AppContext) {
  if (!ctx.aiConnections) throw unavailable('AI connections are not enabled (add "openai" to SEBETO_RUNTIMES).');
  return ctx.aiConnections;
}

function mapErr(err: unknown, id?: Id): never {
  if (err instanceof AiConnectionError) throw err.code === 'not_found' ? notFound('AI connection', id ?? '') : badRequest(err.message, 'ai_connection_invalid');
  throw err;
}

const hostOf = (c: AiConnection) => {
  try { return new URL(c.baseUrl).host; } catch { return c.baseUrl; }
};

/** What a security event may say about a connection (no key, ever). */
const describe = (c: AiConnection) => ({
  connectionId: c.id, runtime: c.runtimeId, name: c.name, kind: c.kind, host: hostOf(c), baseUrl: c.baseUrl,
  defaultModel: c.defaultModel, hasApiKey: c.hasApiKey, allowPrivateHttp: c.allowPrivateHttp,
});

function changed(ctx: AppContext) {
  ctx.bus.publish({ type: 'connectors.changed' });
}

/** Agents and teams that use the connection's runtime. */
function usersOf(ctx: AppContext, c: AiConnection) {
  const agents = ctx.repos.agents.list().filter((a) => a.runtime === c.runtimeId);
  const teams = (ctx.repos.teams?.list() ?? []).filter((t) => t.runtime === c.runtimeId);
  return { agents, teams };
}

export function listAiConnections(ctx: AppContext): AiConnection[] {
  return ctx.aiConnections?.list() ?? [];
}

export async function createAiConnection(ctx: AppContext, body: CreateAiConnectionBody): Promise<AiConnection> {
  let c: AiConnection;
  try { c = await store(ctx).create(body); } catch (err) { return mapErr(err); }
  ctx.securityLog?.record({
    category: 'connector', action: 'connector.ai_added', severity: c.kind === 'remote' ? 'warning' : 'notice',
    summary: `AI connection "${c.name}" was added (${c.kind}, ${hostOf(c)}${c.hasApiKey ? ', with an API key' : ''}).` +
      (c.kind === 'remote' ? ' Tickets run on it send their content to that provider.' : ''),
    data: describe(c),
  });
  ctx.log.info({ connectionId: c.id, kind: c.kind, host: hostOf(c) }, 'AI connection added');
  changed(ctx);
  return c;
}

export async function updateAiConnection(ctx: AppContext, id: Id, patch: UpdateAiConnectionBody): Promise<AiConnection> {
  const s = store(ctx);
  const cur = s.get(id);
  if (!cur) throw notFound('AI connection', id);
  // Where the data goes cannot change under a locked team (e.g. a local Red Team AI pointed at the cloud).
  const locked = (ctx.repos.teams?.list() ?? []).find((t) => t.lockRuntime && t.runtime === cur.runtimeId);
  if (locked) {
    let moves = patch.kind !== undefined && patch.kind !== cur.kind;
    if (patch.baseUrl !== undefined) {
      try {
        moves ||= new URL(patch.baseUrl.trim()).origin !== new URL(cur.baseUrl).origin;
      } catch {
        moves = true;
      }
    }
    if (moves) {
      throw new AppError(409, TEAM_POLICY_ERRORS.runtimeLocked,
        `The team "${locked.name}" is locked to "${cur.name}", so its address and kind cannot change (ticket content would go somewhere else). Turn the lock off in Teams first.`);
    }
  }
  let res;
  try { res = await s.update(id, patch); } catch (err) { return mapErr(err, id); }
  const { after, changed: fields } = res;
  if (fields.length) {
    const risky = fields.includes('baseUrl') || (fields.includes('kind') && after.kind === 'remote') || (fields.includes('allowPrivateHttp') && after.allowPrivateHttp);
    ctx.securityLog?.record({
      category: 'connector', action: 'connector.ai_changed', severity: risky ? 'warning' : 'notice',
      summary: `AI connection "${after.name}" was changed (${fields.map((f) => (f === 'apiKey' ? (after.hasApiKey ? 'API key replaced' : 'API key removed') : f)).join(', ')}).`,
      data: { ...describe(after), changed: fields, from: { kind: res.before.kind, host: hostOf(res.before), baseUrl: res.before.baseUrl } },
    });
    ctx.log.info({ connectionId: id, changed: fields }, 'AI connection changed');
  }
  changed(ctx);
  return after;
}

export async function removeAiConnection(ctx: AppContext, id: Id): Promise<void> {
  const s = store(ctx);
  const cur = s.get(id);
  if (!cur) throw notFound('AI connection', id);
  const { agents, teams } = usersOf(ctx, cur);
  if (agents.length || teams.length) {
    const names = [...teams.map((t) => `team ${t.name}`), ...agents.map((a) => a.name)];
    throw new AppError(409, AI_CONNECTION_ERRORS.inUse,
      `"${cur.name}" is still used by ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. Give them another AI first.`);
  }
  try { await s.remove(id); } catch (err) { return mapErr(err, id); }
  ctx.securityLog?.record({
    category: 'connector', action: 'connector.ai_removed', severity: 'notice',
    summary: `AI connection "${cur.name}" was removed (its API key was deleted).`,
    data: describe(cur),
  });
  ctx.log.info({ connectionId: id }, 'AI connection removed');
  changed(ctx);
}

export async function testAiConnection(ctx: AppContext, id: Id): Promise<AiConnectionTestResult> {
  try { return await store(ctx).test(id); } catch (err) { return mapErr(err, id); }
}
