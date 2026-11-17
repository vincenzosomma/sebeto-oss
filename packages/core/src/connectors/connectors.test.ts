import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMailConnector, GMAIL_SERVERS, MAIL_SECRET, MailError, type MailAccount, type MailClient } from './mail.js';
import { createSecretStore, dpapiProtector, plainFileProtector, type Protector } from './secrets.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-conn-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Reversible fake "encryption" so tests can check that plaintext never hits the disk. */
const xorProtector: Protector = {
  kind: 'dpapi',
  protect: async (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
  unprotect: async (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
};

describe('secret store', () => {
  it('stores protected bytes, reads back, caches, deletes', async () => {
    const store = createSecretStore(dir, xorProtector);
    expect(await store.get('mail-password')).toBeNull();
    await store.set('mail-password', 'abcdefghijklmnop');
    const onDisk = fs.readFileSync(path.join(dir, 'secrets', 'mail-password.secret'));
    expect(onDisk.toString('utf8')).not.toContain('abcdefghijklmnop');
    expect(await createSecretStore(dir, xorProtector).get('mail-password')).toBe('abcdefghijklmnop');
    await store.delete('mail-password');
    expect(await store.get('mail-password')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'secrets', 'mail-password.secret'))).toBe(false);
  });

  it('rejects unsafe names', async () => {
    const store = createSecretStore(dir, plainFileProtector());
    await expect(store.set('../x', 'v')).rejects.toThrow(/Invalid secret name/);
  });

  it.runIf(process.platform === 'win32')('DPAPI round trip on Windows', async () => {
    const p = dpapiProtector();
    const enc = await p.protect(Buffer.from('s3cret app pässword', 'utf8'));
    expect(enc.toString('utf8')).not.toContain('s3cret');
    expect((await p.unprotect(enc)).toString('utf8')).toBe('s3cret app pässword');
  }, 30_000);
});

describe('mail connector', () => {
  function setup(verify: () => Promise<void> = async () => undefined) {
    const accounts: MailAccount[] = [];
    const factory = (a: MailAccount): MailClient => {
      accounts.push(a);
      return { verify, search: async () => [], read: async () => null, send: async () => ({ messageId: 'x' }) };
    };
    const secrets = createSecretStore(dir, xorProtector);
    return { accounts, secrets, connector: createMailConnector({ workspaceDir: dir, secrets, factory }) };
  }

  it('verifies before saving; gmail strips spaces and uses Gmail servers; status never has the password', async () => {
    const { connector, accounts, secrets } = setup();
    expect(connector.status()).toEqual({ connected: false });
    const status = await connector.connect({ provider: 'gmail', address: ' Me@Gmail.com ', password: 'abcd efgh ijkl mnop' });
    expect(status).toMatchObject({ connected: true, provider: 'gmail', address: 'me@gmail.com', servers: GMAIL_SERVERS });
    expect(JSON.stringify(status)).not.toContain('abcd');
    expect(accounts[0]!.password).toBe('abcdefghijklmnop');
    expect(await secrets.get(MAIL_SECRET)).toBe('abcdefghijklmnop');
    const cfg = fs.readFileSync(path.join(dir, 'connectors', 'mail.json'), 'utf8');
    expect(cfg).not.toContain('abcdefghijklmnop');

    // A new connector instance (app restart) reads the saved settings.
    const again = createMailConnector({ workspaceDir: dir, secrets: createSecretStore(dir, xorProtector), factory: () => ({}) as MailClient });
    expect(again.status()).toMatchObject({ connected: true, address: 'me@gmail.com' });
    expect((await again.open())?.address).toBe('me@gmail.com');
  });

  it('does not save anything when the login fails', async () => {
    const { connector, secrets } = setup(async () => { throw new MailError('Gmail refused the login.', 'auth'); });
    await expect(connector.connect({ provider: 'gmail', address: 'me@gmail.com', password: 'wrong' })).rejects.toThrow(/refused/);
    expect(connector.status()).toEqual({ connected: false });
    expect(await secrets.get(MAIL_SECRET)).toBeNull();
    expect(await connector.open()).toBeNull();
  });

  it('validates input', async () => {
    const { connector } = setup();
    await expect(connector.connect({ provider: 'gmail', address: 'not-an-email', password: 'x' })).rejects.toThrow(/valid email/);
    await expect(connector.connect({ provider: 'gmail', address: 'a@b.co', password: '   ' })).rejects.toThrow(/app password/);
    await expect(connector.connect({ provider: 'imap', address: 'a@b.co', password: 'x', servers: { imapHost: 'bad host!' } })).rejects.toThrow(/server names/);
  });

  it('disconnect removes settings and the password', async () => {
    const { connector, secrets } = setup();
    await connector.connect({ provider: 'gmail', address: 'me@gmail.com', password: 'abcdefghijklmnop' });
    await connector.disconnect();
    expect(connector.status()).toEqual({ connected: false });
    expect(await secrets.get(MAIL_SECRET)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'connectors', 'mail.json'))).toBe(false);
  });
});
