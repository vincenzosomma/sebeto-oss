/**
 * Mail connector: lets agents search and read the owner's mailbox and send real email, through
 * Sebeto tools only (docs/23 Mail Connector.md).
 *
 * - Gmail works with an **app password** over IMAP (read) and SMTP (send). No Google Cloud project,
 *   no Sebeto server: the connection goes straight from this computer to Gmail.
 * - The password is kept in the SecretStore (DPAPI-encrypted on Windows). The API, logs and agents
 *   never see it.
 * - Everything read from a mailbox is untrusted content: the tool server tags it and forces outbound
 *   actions (sending email, commands) to ask afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import type { ConnectMailBody, MailConnectorStatus, MailProvider, MailServerSettings, OAuthProviderId } from '@sebeto/shared';
import type { SecretStore } from './secrets.js';
import type { OAuthManager } from './oauth.js';
import type { CalendarClient, ProviderClientFactory } from './clients.js';

export interface MailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  unread: boolean;
}

export interface MailMessage extends MailSummary {
  cc: string;
  text: string;
  truncated: boolean;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
}

export interface MailAccount {
  provider: MailProvider;
  address: string;
  password: string;
  servers: MailServerSettings;
}

/** What the tools need from a mailbox. One implementation talks IMAP/SMTP; tests use a fake. */
export interface MailClient {
  /** Log in to IMAP and SMTP; throws MailError with a friendly message on failure. */
  verify(): Promise<void>;
  /** Newest first. `query` uses Gmail search syntax on Gmail (e.g. "from:alice newer_than:7d", "in:sent"). */
  search(q: { query?: string; limit: number }): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage | null>;
  send(m: { to: string[]; subject: string; text: string }): Promise<{ messageId: string }>;
}

export type MailClientFactory = (account: MailAccount) => MailClient;

export class MailError extends Error {
  constructor(message: string, readonly code: 'auth' | 'network' | 'invalid' | 'other' = 'other') {
    super(message);
    this.name = 'MailError';
  }
}

export const GMAIL_SERVERS: MailServerSettings = { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 };
/** Max characters of a message body handed to the agent. */
export const MAIL_TEXT_MAX = 30_000;
export const MAIL_SEARCH_MAX = 25;

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;

const addr = (a: AddressObject | AddressObject[] | undefined): string =>
  !a ? '' : (Array.isArray(a) ? a : [a]).map((x) => x.text).join(', ');

type Envelope = { from?: Array<{ name?: string; address?: string }>; to?: Array<{ name?: string; address?: string }>; subject?: string; date?: Date };
const envAddr = (list: Envelope['from']): string =>
  (list ?? []).map((p) => (p.name ? `${p.name} <${p.address ?? ''}>` : p.address ?? '')).join(', ');

function friendly(err: unknown, account: MailAccount): MailError {
  if (err instanceof MailError) return err;
  const e = err as { authenticationFailed?: boolean; responseCode?: number; code?: string; message?: string };
  if (e.authenticationFailed || e.code === 'EAUTH' || e.responseCode === 535) {
    return new MailError(
      account.provider === 'gmail'
        ? 'Gmail refused the login. Check the address and use an app password (16 letters from myaccount.google.com/apppasswords), not your normal password.'
        : 'The mail server refused the login. Check the address and password.',
      'auth',
    );
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(e.code ?? '')) {
    return new MailError('Could not reach the mail server. Check the internet connection and the server names.', 'network');
  }
  return new MailError(`The mail server returned an error: ${e.message ?? String(err)}`);
}

/** Real IMAP (imapflow) + SMTP (nodemailer) client. Opens a short connection per call. */
export const imapMailClient: MailClientFactory = (account) => {
  const imap = () => new ImapFlow({
    host: account.servers.imapHost, port: account.servers.imapPort, secure: account.servers.imapPort === 993,
    auth: { user: account.address, pass: account.password }, logger: false, emitLogs: false,
  });
  const smtp = () => nodemailer.createTransport({
    host: account.servers.smtpHost, port: account.servers.smtpPort, secure: account.servers.smtpPort === 465,
    auth: { user: account.address, pass: account.password },
  });

  async function withMailbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = imap();
    // imapflow emits 'error' on socket problems; without a listener Node would crash the process.
    client.on('error', () => undefined);
    try {
      await client.connect();
      // Gmail: "All Mail" holds every message (inbox, sent, archived) and supports Gmail search.
      let box = 'INBOX';
      if (account.provider === 'gmail') {
        const all = (await client.list()).find((m) => m.specialUse === '\\All');
        if (all) box = all.path;
      }
      const lock = await client.getMailboxLock(box, { readOnly: true });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } catch (err) {
      throw friendly(err, account);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  return {
    async verify() {
      await withMailbox(async () => undefined);
      try {
        await smtp().verify();
      } catch (err) {
        throw friendly(err, account);
      }
    },

    search({ query, limit }) {
      return withMailbox(async (client) => {
        const q = query?.trim();
        const criteria = !q ? { all: true }
          : account.provider === 'gmail' ? { gmraw: q }
          : { or: [{ subject: q }, { from: q }, { body: q }] };
        const uids = (await client.search(criteria, { uid: true })) || [];
        const pick = uids.sort((a, b) => b - a).slice(0, Math.min(Math.max(1, limit), MAIL_SEARCH_MAX));
        if (!pick.length) return [];
        const out: MailSummary[] = [];
        for await (const msg of client.fetch(pick.join(','), { envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const env = (msg.envelope ?? {}) as Envelope;
          const date = env.date ?? (msg.internalDate instanceof Date ? msg.internalDate : null);
          out.push({
            id: String(msg.uid), from: envAddr(env.from), to: envAddr(env.to), subject: env.subject ?? '(no subject)',
            date: date ? date.toISOString() : null, unread: !msg.flags?.has('\\Seen'),
          });
        }
        return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      });
    },

    read(id) {
      if (!/^\d{1,10}$/.test(id)) return Promise.reject(new MailError('Unknown email id. Use an id from search_email.', 'invalid'));
      return withMailbox(async (client) => {
        const msg = await client.fetchOne(id, { source: true, flags: true }, { uid: true });
        if (!msg || !msg.source) return null;
        const parsed = await simpleParser(msg.source);
        const full = (parsed.text ?? '').trim();
        return {
          id, from: addr(parsed.from), to: addr(parsed.to), cc: addr(parsed.cc), subject: parsed.subject ?? '(no subject)',
          date: parsed.date ? parsed.date.toISOString() : null, unread: !msg.flags?.has('\\Seen'),
          text: full.slice(0, MAIL_TEXT_MAX), truncated: full.length > MAIL_TEXT_MAX,
          attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? '(unnamed)', contentType: a.contentType, size: a.size })),
        };
      });
    },

    async send({ to, subject, text }) {
      try {
        const info = await smtp().sendMail({ from: account.address, to, subject, text });
        return { messageId: info.messageId };
      } catch (err) {
        throw friendly(err, account);
      }
    },
  };
};

// ------------------------------------------------------------------ connector (settings + secret)

interface StoredConfig { provider: MailProvider; address: string; connectedAt: string; servers: MailServerSettings | null }

const isSignIn = (p: MailProvider): p is OAuthProviderId => p === 'microsoft' || p === 'google';

export interface MailConnector {
  status(): MailConnectorStatus;
  /** Validates, logs in (IMAP + SMTP) and only then saves. Throws MailError. */
  connect(body: ConnectMailBody): Promise<MailConnectorStatus>;
  /** Sign out / disconnect: always forgets the key or password; revokes at the provider when possible. */
  disconnect(): Promise<{ provider: MailProvider | null; revokedAtProvider: boolean }>;
  /** The connected mailbox, or null when no mailbox is connected. */
  open(): Promise<{ client: MailClient; address: string } | null>;
  /** The connected calendar (sign-in providers only), or null. */
  openCalendar(): Promise<{ client: CalendarClient; address: string } | null>;
  /**
   * After "Sign in with Microsoft/Google" succeeded: make that account the connected mailbox
   * (replacing any other). `email` comes from the sign-in; verify() checks the mailbox answers.
   */
  completeSignIn(provider: OAuthProviderId, email: string | null): Promise<MailConnectorStatus>;
}

export const MAIL_SECRET = 'mail-password';

export function createMailConnector(opts: {
  workspaceDir: string; secrets: SecretStore; factory?: MailClientFactory;
  /** Sign-in providers (Microsoft / Google); absent in builds or tests without them. */
  oauth?: OAuthManager; providers?: Partial<Record<OAuthProviderId, ProviderClientFactory>>;
}): MailConnector {
  const factory = opts.factory ?? imapMailClient;
  const file = path.join(opts.workspaceDir, 'connectors', 'mail.json');
  let config: StoredConfig | null = null;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredConfig;
  } catch {
    config = null;
  }

  const status = (): MailConnectorStatus => (config
    ? { connected: true, provider: config.provider, address: config.address, connectedAt: config.connectedAt, servers: config.servers ?? null, calendar: isSignIn(config.provider) }
    : { connected: false });

  async function signedIn(p: OAuthProviderId) {
    const make = opts.providers?.[p];
    const tokens = make && opts.oauth ? await opts.oauth.tokens(p) : null;
    return make && tokens ? make(tokens) : null;
  }

  async function save(next: StoredConfig | null): Promise<void> {
    const previous = config;
    config = next;
    if (previous && isSignIn(previous.provider) && previous.provider !== next?.provider) await opts.oauth?.signOut(previous.provider);
    if (previous && !isSignIn(previous.provider) && (!next || isSignIn(next.provider))) await opts.secrets.delete(MAIL_SECRET);
    if (next) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
    } else {
      await fs.promises.rm(file, { force: true });
    }
  }

  return {
    status,

    async connect(body) {
      if (isSignIn(body.provider)) throw new MailError('Use "Sign in" for this provider.', 'invalid');
      const address = body.address.trim().toLowerCase();
      if (!EMAIL_RE.test(address)) throw new MailError('Enter a valid email address.', 'invalid');
      // Google shows app passwords as "abcd efgh ijkl mnop"; the spaces are not part of it.
      const password = body.provider === 'gmail' ? body.password.replace(/\s+/g, '') : body.password;
      if (!password) throw new MailError('Enter the app password.', 'invalid');
      const servers: MailServerSettings = body.provider === 'gmail' ? { ...GMAIL_SERVERS } : {
        imapHost: body.servers?.imapHost?.trim() ?? '', imapPort: body.servers?.imapPort ?? 993,
        smtpHost: body.servers?.smtpHost?.trim() ?? '', smtpPort: body.servers?.smtpPort ?? 465,
      };
      if (!HOST_RE.test(servers.imapHost) || !HOST_RE.test(servers.smtpHost)) throw new MailError('Enter the IMAP and SMTP server names.', 'invalid');

      await factory({ provider: body.provider, address, password, servers }).verify();

      await save({ provider: body.provider, address, connectedAt: new Date().toISOString(), servers });
      await opts.secrets.set(MAIL_SECRET, password);
      return status();
    },

    async completeSignIn(provider, email) {
      const clients = await signedIn(provider);
      if (!clients) throw new MailError('Sign-in is not available for this provider.', 'invalid');
      await clients.mail.verify();
      await save({ provider, address: email ?? `${provider} account`, connectedAt: new Date().toISOString(), servers: null });
      return status();
    },

    async disconnect() {
      const p = config?.provider ?? null;
      // Revoke first (needs the stored refresh token), then forget everything locally.
      const revoked = p && isSignIn(p) && opts.oauth ? await opts.oauth.signOut(p) : { revokedAtProvider: false };
      config = null;
      await fs.promises.rm(file, { force: true });
      await opts.secrets.delete(MAIL_SECRET);
      return { provider: p, revokedAtProvider: revoked.revokedAtProvider };
    },

    async openCalendar() {
      if (!config || !isSignIn(config.provider)) return null;
      const c = await signedIn(config.provider);
      return c ? { client: c.calendar, address: config.address } : null;
    },

    async open() {
      if (!config) return null;
      if (isSignIn(config.provider)) {
        const c = await signedIn(config.provider);
        return c ? { client: c.mail, address: config.address } : null;
      }
      if (!config.servers) return null;
      const password = await opts.secrets.get(MAIL_SECRET);
      if (!password) return null;
      return { client: factory({ provider: config.provider, address: config.address, password, servers: config.servers }), address: config.address };
    },
  };
}
