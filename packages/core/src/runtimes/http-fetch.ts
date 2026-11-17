/**
 * A minimal fetch for local services (Ollama) built on node:http(s).
 *
 * Node's global fetch (undici) gives up when response headers take longer than 300 s. A large local
 * model on a small GPU can take longer than that to answer one /api/chat call with stream:false, so
 * the run failed with "fetch failed" while Ollama was still working. node:http has no such limit;
 * the caller's AbortSignal (Sebeto's own, configurable timeout and the run's cancel) stays in charge.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export async function httpFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const mod = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
  const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : String(init.body);
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');

  return await new Promise<Response>((resolve, reject) => {
    const req = mod.request(url, { method: init.method ?? 'GET', headers }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => h.append(k, x)); else if (v !== undefined) h.set(k, String(v));
      }
      const status = res.statusCode ?? 0;
      const nullBody = status === 204 || status === 304 || (init.method ?? 'GET') === 'HEAD';
      if (nullBody) res.resume();
      resolve(new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => { signal?.removeEventListener('abort', onAbort); reject(err); });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
