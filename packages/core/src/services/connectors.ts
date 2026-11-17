/** Connector settings (mail). Thin wrappers that turn connector errors into API errors. */
import type { AddConnectorBody, ConnectMailBody, DisconnectMailResponse, ConnectorInfo, ConnectorsResponse, Id, MailConnectorStatus, UpdateConnectorBody } from '@sebeto/shared';
import { CATALOG } from '../connectors/catalog.js';
import { ConnectorError } from '../connectors/mcp-hub.js';
import type { AppContext } from '../contracts.js';
import { MailError } from '../connectors/mail.js';
import { AppError, badRequest, notFound, unavailable } from './errors.js';

function requireMail(ctx: AppContext) {
  if (!ctx.mail) throw unavailable('The mail connector is not available in this build');
  return ctx.mail;
}

export function mailStatus(ctx: AppContext): MailConnectorStatus {
  return ctx.mail ? ctx.mail.status() : { connected: false };
}

export async function connectMail(ctx: AppContext, body: ConnectMailBody): Promise<MailConnectorStatus> {
  try {
    const status = await requireMail(ctx).connect(body);
    if (status.connected) ctx.log.info({ provider: status.provider }, 'mail connector connected');
    return status;
  } catch (err) {
    if (err instanceof MailError) {
      // 400 for wrong input/credentials, 502 when the mail server could not be reached.
      throw err.code === 'network' ? new AppError(502, 'mail_unreachable', err.message) : badRequest(err.message, `mail_${err.code}`);
    }
    throw err;
  }
}

/** Where the owner can remove Sebeto's access completely (security page of the account). */
export const ACCOUNT_PAGES: Record<string, string> = {
  microsoft: 'https://account.microsoft.com/privacy/app-access',
  google: 'https://myaccount.google.com/connections',
  gmail: 'https://myaccount.google.com/apppasswords',
};

export async function disconnectMail(ctx: AppContext): Promise<DisconnectMailResponse> {
  const r = await requireMail(ctx).disconnect();
  ctx.log.info({ provider: r.provider, revoked: r.revokedAtProvider }, 'mail connector signed out');
  ctx.bus.publish({ type: 'connectors.changed' });
  return { ok: true, provider: r.provider, revokedAtProvider: r.revokedAtProvider, accountUrl: r.provider ? ACCOUNT_PAGES[r.provider] ?? null : null };
}

// ---- connectors catalog + custom MCP servers
function hub(ctx: AppContext) {
  if (!ctx.connectors) throw unavailable('Connectors are not available in this build');
  return ctx.connectors;
}

function mapErr(err: unknown, id?: Id): never {
  if (err instanceof ConnectorError) {
    if (err.code === 'not_found') throw notFound('Connector', id ?? '');
    throw err.code === 'unavailable' ? new AppError(502, 'connector_unavailable', err.message) : badRequest(err.message, 'connector_invalid');
  }
  throw err;
}

export function listConnectors(ctx: AppContext): ConnectorsResponse {
  return { catalog: CATALOG, installed: ctx.connectors?.list() ?? [] };
}

export async function addConnector(ctx: AppContext, body: AddConnectorBody): Promise<ConnectorInfo> {
  try {
    const c = await hub(ctx).add(body);
    ctx.log.info({ connector: c.id, catalogId: c.catalogId, tools: c.tools.length }, 'connector added');
    return c;
  } catch (err) { return mapErr(err); }
}

export function updateConnector(ctx: AppContext, id: Id, patch: UpdateConnectorBody): ConnectorInfo {
  for (const a of patch.allowedAgents ?? []) if (!ctx.repos.agents.get(a)) throw badRequest(`Agent ${a} does not exist`, 'unknown_agent');
  try { return hub(ctx).update(id, patch); } catch (err) { return mapErr(err, id); }
}

/** PUT /connectors/:id/secrets/:name: set (or with '' remove) an extra secret of a preset connector. */
export async function setConnectorSecret(ctx: AppContext, id: Id, name: string, value: string): Promise<{ ok: true }> {
  try { await hub(ctx).setSecretSetting(id, name, value); } catch (err) { return mapErr(err, id); }
  ctx.securityLog?.record({ category: 'connector', action: 'connector.secret_set', actor: { type: 'user', id: null, name: 'You' }, summary: `Connector setting ${name} ${value ? 'set' : 'removed'}`, data: { connectorId: id, name } });
  return { ok: true };
}

export async function refreshConnector(ctx: AppContext, id: Id): Promise<ConnectorInfo> {
  try { return await hub(ctx).refresh(id); } catch (err) { return mapErr(err, id); }
}

export async function removeConnector(ctx: AppContext, id: Id): Promise<void> {
  try { await hub(ctx).remove(id); } catch (err) { mapErr(err, id); }
}
