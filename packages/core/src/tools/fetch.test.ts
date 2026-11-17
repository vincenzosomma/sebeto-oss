import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, fetchText, isPrivateIp, pinnedLookup, validateUrl, type Resolver } from './fetch.js';

describe('isPrivateIp', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', '[::1]', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:a9fe:a9fe]', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::a00:1',
    '0:0:0:0:0:0:0:1',
  ])('blocks %s', (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each([
    '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '169.255.0.1', '93.184.216.34',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808',
    'example.com',
  ])('allows %s', (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe('validateUrl', () => {
  it('refuses schemes, credentials, localhost and private literals', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(FetchError);
    expect(() => validateUrl('http://user:pw@example.com/')).toThrow(/credentials/);
    expect(() => validateUrl('http://localhost:7600/')).toThrow(/private/);
    expect(() => validateUrl('http://[::ffff:127.0.0.1]/')).toThrow(/private/); // normalised to ::ffff:7f00:1
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data')).toThrow(/private/);
    expect(validateUrl('http://localhost/', { allowPrivate: true }).hostname).toBe('localhost');
  });
});

describe('pinnedLookup', () => {
  it('answers with the vetted address in both callback shapes', () => {
    const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 }) as unknown as (
      h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void;
    lookup('example.com', {}, (err, address, family) => expect([err, address, family]).toEqual([null, '93.184.216.34', 4]));
    lookup('example.com', { all: true }, (err, list) => expect([err, list]).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]));
  });
});

describe('fetchText: resolve-then-connect', () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ host: string | undefined; path: string | undefined }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url });
      if (req.url === '/to-internal') {
        res.writeHead(302, { location: `http://internal.test:${port}/secret` });
        res.end();
      } else if (req.url === '/to-good') {
        res.writeHead(301, { location: '/hello' });
        res.end();
      } else if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync('compressed hello'));
      } else if (req.url === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('x');
      } else {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`hello from ${req.url}`);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  /** In tests 127.0.0.1 plays a "public" server; 10.0.0.0/8 and the usual suspects stay blocked. */
  const isBlockedAddress = (ip: string) => ip !== '127.0.0.1' && isPrivateIp(ip);

  function resolverOf(table: Record<string, string[]>): Resolver & { calls: string[] } {
    const calls: string[] = [];
    const fn = async (host: string) => {
      calls.push(host);
      const list = table[host];
      if (!list) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };
    return Object.assign(fn, { calls });
  }

  it('blocks a hostname that resolves to a private address (real policy)', async () => {
    const resolve = resolverOf({ 'rebind.test': ['127.0.0.1'] });
    await expect(fetchText(`http://rebind.test:${port}/`, { resolve })).rejects.toThrow(/private network/);
    expect(seen.some((s) => s.host?.startsWith('rebind.test'))).toBe(false); // never connected
  });

  it('blocks when ANY address is private (mixed answers)', async () => {
    const resolve = resolverOf({ 'mixed.test': ['93.184.216.34', '10.0.0.5'] });
    await expect(fetchText('http://mixed.test/', { resolve })).rejects.toThrow(/private network/);
    const v6 = resolverOf({ 'v6.test': ['2606:4700::1', '::ffff:169.254.169.254'] });
    await expect(fetchText('http://v6.test/', { resolve: v6 })).rejects.toThrow(/private network/);
  });

  it('reports unknown hosts', async () => {
    await expect(fetchText('http://nowhere.test/', { resolve: resolverOf({}) })).rejects.toThrow(/Could not find nowhere\.test/);
  });

  it('connects to the vetted address and keeps the Host header; resolves once per hop', async () => {
    const resolve = resolverOf({ 'site.test': ['127.0.0.1'] });
    const r = await fetchText(`http://site.test:${port}/page`, { resolve, isBlockedAddress });
    expect(r.status).toBe(200);
    expect(r.text).toBe('hello from /page');
    expect(seen.at(-1)).toEqual({ host: `site.test:${port}`, path: '/page' });
    // The connection did not trigger a second (possibly rebinding) resolution.
    expect(resolve.calls).toEqual(['site.test']);
  });

  it('re-vets every redirect hop', async () => {
    const resolve = resolverOf({ 'site.test': ['127.0.0.1'], 'internal.test': ['10.0.0.5'] });
    await expect(fetchText(`http://site.test:${port}/to-internal`, { resolve, isBlockedAddress })).rejects.toThrow(/private network/);
    expect(resolve.calls).toEqual(['site.test', 'internal.test']);
    expect(seen.some((s) => s.path === '/secret')).toBe(false);

    const ok = resolverOf({ 'site.test': ['127.0.0.1'] });
    const r = await fetchText(`http://site.test:${port}/to-good`, { resolve: ok, isBlockedAddress });
    expect(r.text).toBe('hello from /hello');
    expect(r.url.pathname).toBe('/hello');
    expect(ok.calls).toEqual(['site.test', 'site.test']);
  });

  it('decompresses gzip and refuses non-text content', async () => {
    const resolve = resolverOf({ 'site.test': ['127.0.0.1'] });
    expect((await fetchText(`http://site.test:${port}/gzip`, { resolve, isBlockedAddress })).text).toBe('compressed hello');
    await expect(fetchText(`http://site.test:${port}/image`, { resolve, isBlockedAddress })).rejects.toThrow(/not text/);
  });

  it('allowPrivate keeps working for local servers (tests, containers)', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/local`, { allowPrivate: true });
    expect(r.text).toBe('hello from /local');
  });
});
