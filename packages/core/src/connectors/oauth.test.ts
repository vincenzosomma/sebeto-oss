import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtinApps, createOAuthManager, emailFromIdToken, pkcePair, STATE_TTL_MS } from './oauth.js';
import { createSecretStore, type Protector } from './secrets.js';
import { createMailConnector, MailError } from './mail.js';
import type { CalendarClient, MailClient, ProviderClientFactory, TokenSource } from './clients.js';

const xor: Protector = { kind: 'dpapi', protect: async (b) => Buffer.from(b.map((x) => x ^ 0x2a)), unprotect: async (b) => Buffer.from(b.map((x) => x ^ 0x2a)) };
const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-oauth-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Fake token endpoint: records form posts, answers per grant type. */
function fakeTokenEndpoint() {
  const posts: Array<{ url: string; form: Record<string, string> }> = [];
  let n = 0;
  let failRefresh = false;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
    posts.push({ url: String(url), form });
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/revoke')) return new Response('', { status: 200 });
    if (form.grant_type === 'authorization_code') {
      return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, id_token: idToken({ preferred_username: 'Mario.Rossi@Contoso.it' }) });
    }
    if (form.grant_type === 'refresh_token') {
      if (failRefresh) return json({ error: 'invalid_grant', error_description: 'AADSTS70000: token revoked' }, 400);
      n += 1;
      return json({ access_token: `at-r${n}`, refresh_token: `rt-r${n}`, expires_in: 3600 });
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }) as typeof fetch;
  return { fetchImpl, posts, setFailRefresh: (v: boolean) => { failRefresh = v; } };
}

function manager(extra: Partial<Parameters<typeof createOAuthManager>[0]> = {}) {
  const t = fakeTokenEndpoint();
  let clock = 1_000_000;
  const secrets = createSecretStore(dir, xor);
  const m = createOAuthManager({
    workspaceDir: dir, secrets, port: () => 7600, fetchImpl: t.fetchImpl, now: () => clock,
    builtin: { microsoft: { clientId: 'builtin-ms-client-id', tenant: 'common' } }, ...extra,
  });
  return { m, t, secrets, tick: (ms: number) => { clock += ms; } };
}

describe('oauth helpers', () => {
  it('PKCE challenge is the S256 of the verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('reads the email from an ID token', () => {
    expect(emailFromIdToken(idToken({ email: 'Me@Gmail.com' }))).toBe('me@gmail.com');
    expect(emailFromIdToken(idToken({ preferred_username: 'x@contoso.it' }))).toBe('x@contoso.it');
    expect(emailFromIdToken(idToken({ name: 'no mail' }))).toBeNull();
    expect(emailFromIdToken('garbage')).toBeNull();
  });

  it('built-in apps come from the environment or a file', () => {
    expect(builtinApps({ SEBETO_MS_CLIENT_ID: '11111111-2222-3333-4444-555555555555' })).toEqual({ microsoft: { clientId: '11111111-2222-3333-4444-555555555555', tenant: 'common' } });
    const f = path.join(dir, 'oauth-apps.json');
    fs.writeFileSync(f, JSON.stringify({ google: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' } }));
    expect(builtinApps({}, f)).toEqual({ google: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' } });
    expect(builtinApps({ SEBETO_MS_CLIENT_ID: 'bad id!' })).toEqual({});
  });
});

describe('oauth manager', () => {
  it('builds the sign-in URL (PKCE, state, loopback redirect, scopes)', async () => {
    const { m } = manager();
    const u = new URL(await m.start('microsoft'));
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('client_id')).toBe('builtin-ms-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:7600/oauth/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('offline_access');
    expect(u.searchParams.get('scope')).toContain('Calendars.Read');
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await expect(m.start('google')).rejects.toThrow(/No Google sign-in app/);
  });

  it('exchanges the code once, stores the refresh token encrypted, refreshes when expired', async () => {
    const { m, t, secrets, tick } = manager();
    const state = new URL(await m.start('microsoft')).searchParams.get('state')!;
    expect(await m.callback({ code: 'c0de', state })).toEqual({ provider: 'microsoft', email: 'mario.rossi@contoso.it' });
    const ex = t.posts[0]!;
    expect(ex.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(ex.form).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', client_id: 'builtin-ms-client-id', redirect_uri: 'http://localhost:7600/oauth/callback' });
    expect(ex.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(ex.form.client_secret).toBeUndefined();
    // Encrypted at rest, not in plain text.
    const raw = fs.readFileSync(path.join(dir, 'secrets', 'oauth-microsoft-refresh.secret'), 'utf8');
    expect(raw).not.toContain('rt-1');
    expect(await secrets.get('oauth-microsoft-refresh')).toBe('rt-1');

    // Single use.
    await expect(m.callback({ code: 'c0de', state })).rejects.toThrow(/expired or was already used/);

    const ts = (await m.tokens('microsoft'))!;
    expect(await ts.getAccessToken()).toBe('at-1');
    tick(3600_000);
    const [a, b] = await Promise.all([ts.getAccessToken(), ts.getAccessToken()]);
    expect([a, b]).toEqual(['at-r1', 'at-r1']); // one refresh for concurrent callers
    expect(t.posts.filter((p) => p.form.grant_type === 'refresh_token')).toHaveLength(1);
    expect(await secrets.get('oauth-microsoft-refresh')).toBe('rt-r1'); // rotated
    ts.invalidate();
    expect(await ts.getAccessToken()).toBe('at-r2');

    t.setFailRefresh(true);
    ts.invalidate();
    await expect(ts.getAccessToken()).rejects.toMatchObject({ code: 'auth' });
    await m.signOut('microsoft');
    expect(await m.tokens('microsoft')).toBeNull();
  });

  it('rejects expired, unknown or denied sign-ins', async () => {
    const { m, tick } = manager();
    await expect(m.callback({ code: 'x', state: 'nope' })).rejects.toThrow(/expired/);
    const s1 = new URL(await m.start('microsoft')).searchParams.get('state')!;
    tick(STATE_TTL_MS + 1);
    await expect(m.callback({ code: 'x', state: s1 })).rejects.toThrow(/expired/);
    const s2 = new URL(await m.start('microsoft')).searchParams.get('state')!;
    await expect(m.callback({ error: 'access_denied', error_description: 'The user said no', state: s2 })).rejects.toThrow(/not completed: The user said no/);
  });

  it("your organization's app wins over the built-in one; Google sends its client secret", async () => {
    const { m, t } = manager();
    expect((await m.apps()).map((a) => [a.provider, a.source])).toEqual([['microsoft', 'builtin'], ['google', 'none']]);
    await m.setCustomApp('microsoft', { clientId: 'org-app-1234', tenant: 'contoso.onmicrosoft.com' });
    await m.setCustomApp('google', { clientId: '42-x.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
    const apps = await m.apps();
    expect(apps[0]).toMatchObject({ source: 'custom', clientId: 'org-app-1234', tenant: 'contoso.onmicrosoft.com' });
    expect(apps[1]).toMatchObject({ source: 'custom', hasSecret: true });
    expect(JSON.stringify(apps)).not.toContain('GOCSPX-secret');
    expect(fs.readFileSync(path.join(dir, 'connectors', 'oauth-apps.json'), 'utf8')).not.toContain('GOCSPX-secret');
    expect(new URL(await m.start('microsoft')).pathname).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    const g = new URL(await m.start('google'));
    expect(g.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:7600/oauth/callback');
    expect(g.searchParams.get('access_type')).toBe('offline');
    await m.callback({ code: 'gc', state: g.searchParams.get('state')! });
    expect(t.posts.at(-1)!.form).toMatchObject({ client_secret: 'GOCSPX-secret', client_id: '42-x.apps.googleusercontent.com' });
    // Sign out: Google revokes the refresh token at the provider; Microsoft has no per-app revocation.
    const revokeCalls = t.posts.length;
    expect(await m.signOut('google')).toEqual({ revokedAtProvider: true });
    expect(t.posts[revokeCalls]).toMatchObject({ url: 'https://oauth2.googleapis.com/revoke', form: { token: 'rt-1' } });
    expect(await m.tokens('google')).toBeNull();
    expect(await m.signOut('google')).toEqual({ revokedAtProvider: false }); // nothing left to revoke
    await expect(m.setCustomApp('microsoft', { clientId: 'bad id!' })).rejects.toThrow(/client/);
    await m.setCustomApp('microsoft', { clientId: '' });
    expect((await m.apps())[0]!.source).toBe('builtin');
  });
});

describe('mail connector with sign-in providers', () => {
  function fakeProvider() {
    const seenTokens: string[] = [];
    const factory: ProviderClientFactory = (tokens: TokenSource) => {
      const mail: MailClient = {
        verify: async () => { seenTokens.push(await tokens.getAccessToken()); },
        search: async () => [], read: async () => null, send: async () => ({ messageId: 'm' }),
      };
      const calendar: CalendarClient = { listEvents: async () => [] };
      return { mail, calendar };
    };
    return { factory, seenTokens };
  }

  it('sign-in connects the mailbox and calendar, replacing an app-password mailbox', async () => {
    const { m, secrets } = manager();
    const p = fakeProvider();
    const mail = createMailConnector({
      workspaceDir: dir, secrets, oauth: m, providers: { microsoft: p.factory },
      factory: () => ({ verify: async () => undefined, search: async () => [], read: async () => null, send: async () => ({ messageId: 'x' }) }),
    });
    await mail.connect({ provider: 'gmail', address: 'me@gmail.com', password: 'abcdefghijklmnop' });
    expect(await secrets.get('mail-password')).toBe('abcdefghijklmnop');
    await expect(mail.connect({ provider: 'microsoft', address: 'a@b.it', password: 'x' })).rejects.toBeInstanceOf(MailError);

    const state = new URL(await m.start('microsoft')).searchParams.get('state')!;
    const { email } = await m.callback({ code: 'c', state });
    const status = await mail.completeSignIn('microsoft', email);
    expect(status).toMatchObject({ connected: true, provider: 'microsoft', address: 'mario.rossi@contoso.it', servers: null, calendar: true });
    expect(p.seenTokens).toEqual(['at-1']);
    expect(await secrets.get('mail-password')).toBeNull(); // the old password is gone
    expect((await mail.open())?.address).toBe('mario.rossi@contoso.it');
    expect(await mail.openCalendar()).not.toBeNull();

    // Restart: still connected through the stored refresh token.
    const again = createMailConnector({ workspaceDir: dir, secrets: createSecretStore(dir, xor), oauth: m, providers: { microsoft: p.factory } });
    expect(again.status()).toMatchObject({ connected: true, provider: 'microsoft' });

    expect(await mail.disconnect()).toEqual({ provider: 'microsoft', revokedAtProvider: false });
    expect(mail.status()).toEqual({ connected: false });
    expect(await m.tokens('microsoft')).toBeNull();
    expect(await mail.openCalendar()).toBeNull();
  });
});
