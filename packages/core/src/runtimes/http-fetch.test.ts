import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpFetch } from './http-fetch.js';
import { OLLAMA_REPLY_TIMEOUT_MIN, ollamaReplyTimeoutMs } from './ollama.js';

let server: http.Server | null = null;
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; });

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('httpFetch (node:http fetch for local models)', () => {
  it('POSTs JSON and reads the JSON answer, status and headers', async () => {
    const base = await serve((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-seen': req.headers['content-type'] ?? '' });
        res.end(JSON.stringify({ method: req.method, url: req.url, got: JSON.parse(body) }));
      });
    });
    const r = await httpFetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-seen')).toBe('application/json');
    expect(await r.json()).toEqual({ method: 'POST', url: '/api/chat', got: { a: 1 } });
  });

  it('passes error statuses through', async () => {
    const base = await serve((_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"model not found"}'); });
    const r = await httpFetch(`${base}/api/chat`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'model not found' });
  });

  it('waits for a slow answer and stops when the signal aborts', async () => {
    const base = await serve(() => { /* never answers */ });
    const ctl = new AbortController();
    const p = httpFetch(`${base}/api/chat`, { method: 'POST', body: '{}', signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    await expect(p).rejects.toThrow();
  });

  it('a refused connection rejects', async () => {
    const base = await serve(() => {});
    await new Promise<void>((r) => server!.close(() => r())); server = null;
    await expect(httpFetch(`${base}/api/tags`)).rejects.toThrow();
  });
});

describe('Ollama reply timeout', () => {
  it('defaults to 30 minutes and accepts 1–240 from SEBETO_OLLAMA_TIMEOUT_MIN', () => {
    expect(OLLAMA_REPLY_TIMEOUT_MIN).toBe(30);
    expect(ollamaReplyTimeoutMs(undefined)).toBe(30 * 60_000);
    expect(ollamaReplyTimeoutMs('90')).toBe(90 * 60_000);
    expect(ollamaReplyTimeoutMs('0')).toBe(30 * 60_000);
    expect(ollamaReplyTimeoutMs('999')).toBe(30 * 60_000);
    expect(ollamaReplyTimeoutMs('abc')).toBe(30 * 60_000);
  });
});
