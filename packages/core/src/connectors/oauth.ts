/**
 * "Sign in with Microsoft / Google" for the mail + calendar connectors
 * (docs/26 Microsoft & Google Connectors.md).
 *
 * - Authorization Code flow with PKCE for a public desktop client (RFC 8252): the owner's browser
 *   opens the provider's sign-in page; the provider redirects back to this computer
 *   (GET /oauth/callback on Sebeto's own loopback server). No Sebeto server is involved.
 * - Works for personal AND work accounts: Microsoft uses the "common" authority unless an
 *   organization sets its tenant; Google accepts any Google account.
 * - Which app: the organization's own app (Settings → Connectors) wins over Sebeto's built-in
 *   shared app (SEBETO_MS_CLIENT_ID / SEBETO_GOOGLE_CLIENT_ID [+ SEBETO_GOOGLE_CLIENT_SECRET] or
 *   <app>/oauth-apps.json). Client ids are public; Google's "secret" for desktop apps is not
 *   confidential by design but is still kept in the secret store when entered by the owner.
 * - Tokens: the refresh token is stored encrypted (SecretStore, DPAPI on Windows); access tokens
 *   live in memory only and are refreshed shortly before they expire.
 * - `state` is random, single use and expires after 10 minutes; the PKCE verifier never leaves
 *   the core.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthAppStatus, OAuthProviderId, SetOAuthAppBody } from '@sebeto/shared';
import { MailError } from './mail.js';
import type { SecretStore } from './secrets.js';
import type { TokenSource } from './clients.js';

export const OAUTH_PROVIDERS: readonly OAuthProviderId[] = ['microsoft', 'google'] as const;
export const STATE_TTL_MS = 10 * 60_000;
const EXPIRY_SKEW_MS = 60_000;

interface ProviderSpec {
  authorize: (tenant: string) => string;
  token: (tenant: string) => string;
  scopes: string[];
  /** Token revocation endpoint (RFC 7009), if the provider offers one for this kind of app. */
  revoke?: string;
  /** Loopback host registered with the provider (port is free for loopback redirects). */
  redirectHost: 'localhost' | '127.0.0.1';
  extraAuthParams: Record<string, string>;
}

export const PROVIDER_SPECS: Record<OAuthProviderId, ProviderSpec> = {
  microsoft: {
    authorize: (t) => `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/authorize`,
    token: (t) => `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/token`,
    scopes: ['openid', 'offline_access', 'email', 'User.Read', 'Mail.Read', 'Mail.Send', 'Calendars.Read'],
    // Entra matches http://localhost/oauth/callback for any port (desktop public clients).
    redirectHost: 'localhost',
    extraAuthParams: { prompt: 'select_account', response_mode: 'query' },
  },
  google: {
    authorize: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    revoke: 'https://oauth2.googleapis.com/revoke',
    token: () => 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.readonly'],
    redirectHost: '127.0.0.1',
    // offline + consent: Google only returns a refresh token on consent.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
};

export interface OAuthApp { clientId: string; tenant?: string; clientSecret?: string }

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,200}$/;
const TENANT_RE = /^[A-Za-z0-9.-]{2,100}$/;

/** Built-in shared apps: environment first, then oauth-apps.json next to the app. Exported for tests. */
export function builtinApps(env: NodeJS.ProcessEnv = process.env, file?: string): Partial<Record<OAuthProviderId, OAuthApp>> {
  let fromFile: Partial<Record<OAuthProviderId, OAuthApp>> = {};
  if (file) {
    try { fromFile = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof fromFile; } catch { /* none */ }
  }
  const out: Partial<Record<OAuthProviderId, OAuthApp>> = {};
  const ms = env.SEBETO_MS_CLIENT_ID?.trim() || fromFile.microsoft?.clientId;
  if (ms && CLIENT_ID_RE.test(ms)) out.microsoft = { clientId: ms, tenant: 'common' };
  const g = env.SEBETO_GOOGLE_CLIENT_ID?.trim() || fromFile.google?.clientId;
  if (g && CLIENT_ID_RE.test(g)) out.google = { clientId: g, clientSecret: env.SEBETO_GOOGLE_CLIENT_SECRET?.trim() || fromFile.google?.clientSecret };
  return out;
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

interface Pending { provider: OAuthProviderId; verifier: string; redirectUri: string; createdAt: number; app: OAuthApp }
interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string }

/**
 * The signed-in address from the ID token. The token comes straight from the provider's token
 * endpoint over TLS in this same request (OIDC code flow), so its claims are read without a
 * signature check. Exported for tests.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const v = [payload.email, payload.preferred_username, payload.upn].find((x) => typeof x === 'string' && x.includes('@')) as string | undefined;
    return v ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface OAuthManager {
  apps(): Promise<OAuthAppStatus[]>;
  setCustomApp(provider: OAuthProviderId, body: SetOAuthAppBody): Promise<OAuthAppStatus>;
  /** Begin sign-in: returns the URL to open in the owner's browser. */
  start(provider: OAuthProviderId): Promise<string>;
  /** Finish sign-in from the browser redirect: stores the tokens, returns the provider and signed-in address. */
  callback(q: { code?: string; state?: string; error?: string; error_description?: string }): Promise<{ provider: OAuthProviderId; email: string | null }>;
  /** Token source for API clients, or null when not signed in. */
  tokens(provider: OAuthProviderId): Promise<TokenSource | null>;
  /**
   * Forget the tokens; where the provider supports it (Google) also revoke them there.
   * Never throws: local sign-out always happens.
   */
  signOut(provider: OAuthProviderId): Promise<{ revokedAtProvider: boolean }>;
}

export function createOAuthManager(opts: {
  workspaceDir: string;
  secrets: SecretStore;
  /** Port Sebeto listens on (known after listen()). */
  port: () => number;
  builtin?: Partial<Record<OAuthProviderId, OAuthApp>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests: replace provider endpoints. */
  specs?: Partial<Record<OAuthProviderId, ProviderSpec>>;
}): OAuthManager {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const specs = { ...PROVIDER_SPECS, ...opts.specs };
  const builtin = opts.builtin ?? {};
  const file = path.join(opts.workspaceDir, 'connectors', 'oauth-apps.json');
  const pending = new Map<string, Pending>();
  const access = new Map<OAuthProviderId, { token: string; expiresAt: number }>();
  const refreshing = new Map<OAuthProviderId, Promise<string>>();
  const refreshSecret = (p: OAuthProviderId) => `oauth-${p}-refresh`;
  const appSecret = (p: OAuthProviderId) => `oauth-${p}-client-secret`;

  type CustomFile = Partial<Record<OAuthProviderId, { clientId: string; tenant?: string; hasSecret?: boolean }>>;
  const readCustom = (): CustomFile => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as CustomFile; } catch { return {}; }
  };

  /** The app used for a provider: the organization's own first, then the built-in one. */
  async function appFor(p: OAuthProviderId): Promise<{ app: OAuthApp; source: 'custom' | 'builtin' } | null> {
    const c = readCustom()[p];
    if (c?.clientId) {
      const clientSecret = c.hasSecret ? (await opts.secrets.get(appSecret(p))) ?? undefined : undefined;
      return { app: { clientId: c.clientId, tenant: c.tenant, clientSecret }, source: 'custom' };
    }
    const b = builtin[p];
    return b ? { app: b, source: 'builtin' } : null;
  }

  async function statusOf(p: OAuthProviderId): Promise<OAuthAppStatus> {
    const a = await appFor(p);
    return {
      provider: p, source: a?.source ?? 'none', clientId: a?.app.clientId ?? null,
      tenant: p === 'microsoft' ? a?.app.tenant ?? 'common' : null, hasSecret: !!a?.app.clientSecret,
    };
  }

  function prune(): void {
    for (const [k, v] of pending) if (now() - v.createdAt > STATE_TTL_MS) pending.delete(k);
  }

  async function postToken(p: OAuthProviderId, app: OAuthApp, form: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({ client_id: app.clientId, ...form, ...(app.clientSecret ? { client_secret: app.clientSecret } : {}) });
    let res: Response;
    try {
      res = await doFetch(specs[p].token(app.tenant ?? 'common'), {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body,
      });
    } catch {
      throw new MailError(`Could not reach ${p === 'microsoft' ? 'Microsoft' : 'Google'}. Check the internet connection.`, 'network');
    }
    const data = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || data.error) {
      const why = (data.error_description ?? data.error ?? `HTTP ${res.status}`).split(/\r?\n/)[0]!.slice(0, 300);
      throw new MailError(`${p === 'microsoft' ? 'Microsoft' : 'Google'} sign-in failed: ${why}`, data.error === 'invalid_grant' ? 'auth' : 'other');
    }
    return data;
  }

  async function refresh(p: OAuthProviderId): Promise<string> {
    const rt = await opts.secrets.get(refreshSecret(p));
    const a = await appFor(p);
    if (!rt || !a) throw new MailError('Sign in again in Settings → Connectors.', 'auth');
    const data = await postToken(p, a.app, { grant_type: 'refresh_token', refresh_token: rt, scope: specs[p].scopes.join(' ') });
    if (!data.access_token) throw new MailError('The sign-in service returned no access token.', 'auth');
    // Providers may rotate refresh tokens: keep the newest.
    if (data.refresh_token && data.refresh_token !== rt) await opts.secrets.set(refreshSecret(p), data.refresh_token);
    access.set(p, { token: data.access_token, expiresAt: now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
  }

  return {
    apps: () => Promise.all(OAUTH_PROVIDERS.map(statusOf)),

    async setCustomApp(p, body) {
      const custom = readCustom();
      const clientId = body.clientId.trim();
      if (!clientId) {
        delete custom[p];
        await opts.secrets.delete(appSecret(p));
      } else {
        if (!CLIENT_ID_RE.test(clientId)) throw new MailError('That does not look like a client (application) ID.', 'invalid');
        const tenant = body.tenant?.trim() || undefined;
        if (tenant && !TENANT_RE.test(tenant)) throw new MailError('That does not look like a tenant ID or domain.', 'invalid');
        const secret = body.clientSecret?.trim();
        if (secret) await opts.secrets.set(appSecret(p), secret);
        custom[p] = { clientId, ...(p === 'microsoft' ? { tenant: tenant ?? 'common' } : {}), hasSecret: !!secret || !!custom[p]?.hasSecret };
      }
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(custom, null, 2), 'utf8');
      access.delete(p);
      return statusOf(p);
    },

    async start(p) {
      const a = await appFor(p);
      if (!a) throw new MailError(`No ${p === 'microsoft' ? 'Microsoft' : 'Google'} sign-in app is set up. Enter your organization's app in Settings → Connectors.`, 'invalid');
      prune();
      const state = b64url(randomBytes(24));
      const { verifier, challenge } = pkcePair();
      const spec = specs[p];
      const redirectUri = `http://${spec.redirectHost}:${opts.port()}/oauth/callback`;
      pending.set(state, { provider: p, verifier, redirectUri, createdAt: now(), app: a.app });
      const q = new URLSearchParams({
        client_id: a.app.clientId, response_type: 'code', redirect_uri: redirectUri, scope: spec.scopes.join(' '),
        state, code_challenge: challenge, code_challenge_method: 'S256', ...spec.extraAuthParams,
      });
      return `${spec.authorize(a.app.tenant ?? 'common')}?${q.toString()}`;
    },

    async callback(q) {
      prune();
      const flow = q.state ? pending.get(q.state) : undefined;
      if (q.state) pending.delete(q.state); // single use, whatever happens next
      if (!flow) throw new MailError('This sign-in link has expired or was already used. Start again from Sebeto.', 'invalid');
      if (q.error) throw new MailError(`Sign-in was not completed: ${(q.error_description ?? q.error).slice(0, 300)}`, q.error === 'access_denied' ? 'auth' : 'other');
      if (!q.code) throw new MailError('The sign-in page returned no code.', 'invalid');
      const data = await postToken(flow.provider, flow.app, {
        grant_type: 'authorization_code', code: q.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier,
      });
      if (!data.access_token) throw new MailError('The sign-in service returned no access token.', 'auth');
      if (!data.refresh_token) throw new MailError('The sign-in service returned no refresh token, so Sebeto could not stay signed in. Try again.', 'auth');
      await opts.secrets.set(refreshSecret(flow.provider), data.refresh_token);
      access.set(flow.provider, { token: data.access_token, expiresAt: now() + (data.expires_in ?? 3600) * 1000 });
      return { provider: flow.provider, email: emailFromIdToken(data.id_token) };
    },

    async tokens(p) {
      if (!(await opts.secrets.get(refreshSecret(p)))) return null;
      return {
        async getAccessToken() {
          const cur = access.get(p);
          if (cur && cur.expiresAt - EXPIRY_SKEW_MS > now()) return cur.token;
          // One refresh at a time per provider.
          let r = refreshing.get(p);
          if (!r) {
            r = refresh(p).finally(() => refreshing.delete(p));
            refreshing.set(p, r);
          }
          return r;
        },
        invalidate() { access.delete(p); },
      };
    },

    async signOut(p) {
      const rt = await opts.secrets.get(refreshSecret(p)).catch(() => null);
      access.delete(p);
      await opts.secrets.delete(refreshSecret(p));
      const url = specs[p].revoke;
      if (!rt || !url) return { revokedAtProvider: false };
      try {
        const res = await doFetch(url, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }),
        });
        // 400 invalid_token = already revoked/expired: the key is gone either way.
        return { revokedAtProvider: res.ok || res.status === 400 };
      } catch {
        return { revokedAtProvider: false };
      }
    },
  };
}
