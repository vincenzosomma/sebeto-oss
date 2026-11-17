/** Sign-in apps and the browser sign-in flow for the Microsoft / Google connectors. */
import type { MailConnectorStatus, OAuthAppStatus, OAuthProviderId, SetOAuthAppBody } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { MailError } from '../connectors/mail.js';
import { AppError, badRequest, unavailable } from './errors.js';

function manager(ctx: AppContext) {
  if (!ctx.oauth) throw unavailable('Sign-in connectors are not available in this build');
  return ctx.oauth;
}

function mapErr(err: unknown): never {
  if (err instanceof MailError) {
    throw err.code === 'network' ? new AppError(502, 'oauth_unreachable', err.message) : badRequest(err.message, `oauth_${err.code}`);
  }
  throw err;
}

export async function oauthApps(ctx: AppContext): Promise<OAuthAppStatus[]> {
  return ctx.oauth ? ctx.oauth.apps() : [];
}

export async function setOAuthApp(ctx: AppContext, provider: OAuthProviderId, body: SetOAuthAppBody): Promise<OAuthAppStatus> {
  try {
    const s = await manager(ctx).setCustomApp(provider, body);
    ctx.bus.publish({ type: 'connectors.changed' });
    return s;
  } catch (err) { return mapErr(err); }
}

export async function startOAuth(ctx: AppContext, provider: OAuthProviderId): Promise<{ authUrl: string }> {
  try {
    return { authUrl: await manager(ctx).start(provider) };
  } catch (err) { return mapErr(err); }
}

/**
 * The browser redirect: exchange the code, then make that account the connected mailbox.
 * Returns the outcome for the small HTML page; never throws.
 */
export async function finishOAuth(ctx: AppContext, q: Record<string, string | undefined>): Promise<{ ok: true; status: MailConnectorStatus } | { ok: false; message: string }> {
  try {
    const { provider, email } = await manager(ctx).callback(q);
    if (!ctx.mail) throw new MailError('The mail connector is not available in this build.', 'other');
    const status = await ctx.mail.completeSignIn(provider, email);
    ctx.log.info({ provider }, 'signed in');
    ctx.bus.publish({ type: 'connectors.changed' });
    return { ok: true, status };
  } catch (err) {
    const message = err instanceof MailError || err instanceof AppError ? err.message : 'Something went wrong while signing in.';
    ctx.log.warn({ err: { message: (err as Error).message } }, 'sign-in failed');
    return { ok: false, message };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal, self-contained page shown in the browser after sign-in (no scripts). */
export function oauthResultPage(r: Awaited<ReturnType<typeof finishOAuth>>): string {
  const title = r.ok ? 'Signed in' : 'Sign-in did not work';
  const body = r.ok && r.status.connected
    ? `<p>Sebeto is now connected to <strong>${esc(r.status.address)}</strong>.</p><p>You can close this tab and go back to Sebeto.</p>`
    : `<p>${esc(r.ok ? 'Sign-in finished, but no mailbox is connected.' : r.message)}</p><p>Close this tab and try again from Sebeto (Settings → Connectors).</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sebeto: ${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#F6F6F3;color:#1C1C1A;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{background:#fff;border:1px solid #E4E4DF;border-radius:14px;padding:28px 32px;max-width:440px;box-shadow:0 8px 24px rgba(10,68,104,.08)}
h1{font-size:20px;color:${r.ok ? '#0A4468' : '#9B1C1C'};margin:0 0 12px}p{margin:8px 0;line-height:1.5}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;
}
