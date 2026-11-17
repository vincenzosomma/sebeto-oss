import { describe, expect, it } from 'vitest';
import { createRedactor, isPrivateIpv4, redactDeep } from './redact.js';

const r = createRedactor({ homeDir: 'C:\\Users\\mario.rossi', userName: 'mario.rossi', secrets: ['the-api-token-0123456789'] });
const unix = createRedactor({ homeDir: '/home/gennaro', userName: 'gennaro' });

describe('redactor', () => {
  it('shortens e-mail addresses but keeps the domain', () => {
    expect(r('Sent to mario.rossi@example.it and ops@contoso.com')).toBe('Sent to m***@example.it and o***@contoso.com');
    expect(r('a@b.it')).toBe('a***@b.it');
  });

  it('replaces the home folder in both slash styles and any case', () => {
    expect(r('C:\\Users\\mario.rossi\\.sebeto\\workspace\\tickets\\T-3')).toBe('<home>\\.sebeto\\workspace\\tickets\\T-3');
    expect(r('c:/users/MARIO.ROSSI/Documents/report.xlsx')).toBe('<home>/Documents/report.xlsx');
    expect(unix('/home/gennaro/.sebeto/workspace')).toBe('<home>/.sebeto/workspace');
  });

  it('replaces other users\' home folders too (Windows, Linux, macOS)', () => {
    expect(r('D:\\Users\\Administrator\\Desktop\\x.ps1')).toBe('<home>\\Desktop\\x.ps1');
    expect(r('cannot open /home/ciro/notes.txt')).toBe('cannot open <home>/notes.txt');
    expect(r('in /Users/anna/Library')).toBe('in <home>/Library');
    // Not a home folder: left alone.
    expect(r('/usr/local/bin/claude')).toBe('/usr/local/bin/claude');
  });

  it('replaces the OS user name on its own', () => {
    expect(unix('Login failed for gennaro on the share')).toBe('Login failed for <user> on the share');
    expect(unix('gennaro2 is someone else')).toBe('gennaro2 is someone else');
  });

  it('removes known secrets, bearer tokens and key=value secrets', () => {
    expect(r('token the-api-token-0123456789 leaked')).toBe('token <secret> leaked');
    expect(r('Authorization: Bearer abc.def-ghi_jkl')).toBe('Authorization: <secret>');
    expect(r('sent Bearer qwertyuiop123 to server')).toBe('sent Bearer <secret> to server');
    expect(r('password=hunter2! next')).toBe('password=<secret> next');
    expect(r('{"refresh_token":"1//0gXyZ","x":1}')).toBe('{"refresh_token":"<secret>","x":1}');
    expect(r('app password: abcd-efgh-ijkl-mnop')).toBe('app password: <secret>');
    expect(r('client_secret = GOCSPX-abc')).toBe('client_secret = <secret>');
  });

  it('removes long hex and base64-like runs, and well-known key prefixes', () => {
    expect(r('commit 3f2a9c4e1b7d8f6a5c3e2d1b0a9f8e7d done')).toBe('commit <secret> done');
    expect(r('key dGhpcyBpcyBhIFNlY3JldCBrZXkgMTIz end')).toBe('key <secret> end');
    expect(r('use sk-ant-api03-abcdefghijklmnop please')).toBe('use <secret> please');
    expect(r('ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe('<secret>');
    expect(r('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlU2VjcmV0MTIzNDU2')).not.toMatch(/eyJ|c2lnbmF0/);
  });

  it('keeps ordinary words, versions, model names and ids', () => {
    for (const s of [
      'The run stopped after 25 steps without finishing.',
      'claude-3-5-haiku-20241022',
      'qwen3-vl:4b',
      'Node v24.11.0 on win32 10.0.26300',
      'T-12 needs you',
      'Tests pass: 5',
      'The token expired, sign in again',
    ]) expect(r(s)).toBe(s);
  });

  it('keeps only scheme and host of URLs (no user, path, query or fragment)', () => {
    expect(r('GET https://user:pw@api.contoso.com:8443/v1/items?key=1#x failed')).toBe('GET https://api.contoso.com:8443 failed');
    expect(r('see http://intranet.local/wiki/Mario_Rossi')).toBe('see http://intranet.local');
    expect(r('file:///C:/Users/mario.rossi/x.txt')).toBe('file://');
  });

  it('keeps private IPv4 addresses and hides public ones', () => {
    expect(r('ping 192.168.1.10 and 10.0.0.1 and 127.0.0.1 and 172.16.4.2')).toBe('ping 192.168.1.10 and 10.0.0.1 and 127.0.0.1 and 172.16.4.2');
    expect(r('connect to 8.8.8.8:53 failed')).toBe('connect to <ip>:53 failed');
    expect(r('https://93.184.216.34/path')).toBe('https://<ip>');
    expect(r('version 1.2.3.4.5 stays')).toBe('version 1.2.3.4.5 stays');
    expect(isPrivateIpv4('172.32.0.1')).toBe(false);
    expect(isPrivateIpv4('169.254.1.1')).toBe(true);
  });

  it('is safe on empty strings and redacts deeply (strings only, keys untouched)', () => {
    expect(r('')).toBe('');
    expect(redactDeep({ 'mario@x.it': ['mario@x.it', 1, true, null, { p: 'C:\\Users\\mario.rossi\\a' }] }, r))
      .toEqual({ 'mario@x.it': ['m***@x.it', 1, true, null, { p: '<home>\\a' }] });
  });
});
