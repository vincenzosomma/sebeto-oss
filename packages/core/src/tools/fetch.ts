/**
 * Bounded HTTP(S) GET for the `fetch_url` tool.
 *
 * Threats handled:
 *  - SSRF: an agent (or a page it read) points us at the local Sebeto API, the router admin page or
 *    a cloud metadata endpoint. We refuse non-http(s) schemes, `localhost`, and loopback / private /
 *    link-local / unique-local / CGNAT / multicast / unspecified addresses (IPv4 and IPv6, including
 *    IPv4-mapped IPv6), and re-check every redirect hop ourselves.
 *  - DNS rebinding: a public-looking hostname that resolves to a private address, or that answers
 *    differently when the connection is made. Each hop resolves the hostname ONCE (all addresses),
 *    refuses it if any address is blocked, and then connects with a `lookup` that returns only the
 *    vetted address, so the check and the connection use the same IP. TLS SNI, certificate checks
 *    and the Host header still use the hostname.
 *  - Resource exhaustion: time limit, byte limit (after decompression), redirect limit.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface ResolvedAddress { address: string; family: number }
/** Resolves a hostname to all of its addresses (like `dns.lookup(host, { all: true })`). */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface FetchOptions {
  /** Skip the private-address checks (tests, container setups). */
  allowPrivate?: boolean;
  /** Injected resolver (tests). Default: the OS resolver via dns.lookup. */
  resolve?: Resolver;
  /** TEST-ONLY override of the address policy, e.g. to treat 127.0.0.1 as "public" in a test. */
  isBlockedAddress?: (ip: string) => boolean;
}

const systemResolver: Resolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

function isBlockedIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  return a === 0 // "this network", incl. 0.0.0.0 (unspecified)
    || a === 10 // private
    || a === 127 // loopback
    || (a === 169 && b === 254) // link-local (cloud metadata lives here)
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 192 && b === 0 && ip.split('.')[2] === '0') // IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224; // multicast (224/4) and reserved/broadcast (240/4)
}

/** Expand an IPv6 address to 8 16-bit groups; undefined when it can't be parsed. */
function ipv6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    if (!net.isIPv4(v4[1]!)) return undefined;
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function isBlockedIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable: refuse rather than guess
  const embeddedV4 = () => `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedIPv4(embeddedV4()); // ::ffff:a.b.c.d (mapped)
  if (g.slice(0, 6).every((x) => x === 0)) return isBlockedIPv4(embeddedV4()); // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(embeddedV4()); // NAT64
  const first = g[0]!;
  return (first & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (first & 0xffc0) === 0xfec0 // site-local (deprecated) fec0::/10
    || (first & 0xfe00) === 0xfc00 // unique-local fc00::/7
    || (first & 0xff00) === 0xff00; // multicast ff00::/8
}

/** Whether an IP address (v4 or v6, brackets allowed) is local/private/special and must not be fetched. */
export function isPrivateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(h)) return isBlockedIPv4(h);
  if (net.isIPv6(h)) return isBlockedIPv6(h);
  return false;
}

const LOCAL_NETWORK = 'Local and private network addresses cannot be fetched.';

/** Validate a URL for fetching; throws FetchError with an agent-friendly message. */
export function validateUrl(raw: string, opts: { allowPrivate?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('Only http:// and https:// URLs can be fetched.');
  if (url.username || url.password) throw new FetchError('URLs with embedded credentials are not allowed.');
  const host = url.hostname.toLowerCase();
  if (!opts.allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || isPrivateIp(host))) {
    throw new FetchError(LOCAL_NETWORK);
  }
  return url;
}

/**
 * Resolve the URL's host once and vet every address. Returns the address to connect to, or null
 * when no pinning is needed (allowPrivate: the OS resolver is used as usual).
 */
async function vetHost(url: URL, opts: FetchOptions): Promise<ResolvedAddress | null> {
  if (opts.allowPrivate) return null;
  const blocked = opts.isBlockedAddress ?? isPrivateIp;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await (opts.resolve ?? systemResolver)(host);
    } catch (err) {
      throw new FetchError(`Could not find ${host}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.`);
    }
  }
  addresses = addresses.filter((a) => net.isIP(a.address));
  if (!addresses.length) throw new FetchError(`Could not find ${host}.`);
  // ANY blocked address refuses the host: a name with one public and one private answer is a
  // classic rebinding setup.
  if (addresses.some((a) => blocked(a.address))) throw new FetchError(LOCAL_NETWORK);
  const first = addresses[0]!;
  return { address: first.address, family: net.isIP(first.address) };
}

/** A `lookup` for http(s).request that always answers with the vetted address. */
export function pinnedLookup(pinned: ResolvedAddress): net.LookupFunction {
  return ((_hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as unknown as net.LookupFunction;
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: http.IncomingMessage }

function request(url: URL, pinned: ResolvedAddress | null, signal: AbortSignal): Promise<RawResponse> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isHttps = url.protocol === 'https:';
  const options: https.RequestOptions = {
    method: 'GET',
    hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    signal,
    agent: false, // a fresh connection per hop: no pooled socket from another lookup is reused
    headers: {
      'user-agent': 'Sebeto/0.1 (+fetch_url)',
      accept: 'text/*, application/json, application/xml;q=0.9, */*;q=0.1',
      'accept-encoding': 'gzip, deflate, br',
    },
  };
  if (pinned) options.lookup = pinnedLookup(pinned);
  // SNI and certificate checks use the hostname, never the pinned IP (SNI is not sent for IPs).
  if (isHttps && !net.isIP(hostname)) options.servername = hostname;
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(options, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res });
    });
    req.on('error', reject);
    req.end();
  });
}

function decoded(res: RawResponse): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.body.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.body.pipe(zlib.createInflate());
  if (enc === 'br') return res.body.pipe(zlib.createBrotliDecompress());
  return res.body;
}

export interface FetchResult { url: URL; status: number; contentType: string; text: string; truncated: boolean }

export async function fetchText(raw: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = validateUrl(raw, opts);
  for (let hop = 0; ; hop++) {
    const pinned = await vetHost(url, opts);
    let res: RawResponse;
    try {
      res = await request(url, pinned, signal);
    } catch (err) {
      const msg = signal.aborted ? 'the request timed out' : (err as Error).message;
      throw new FetchError(`Could not fetch ${url.host}: ${msg}.`);
    }
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      res.body.destroy();
      if (hop >= MAX_REDIRECTS) throw new FetchError('Too many redirects.');
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new FetchError('The page redirected to an invalid URL.');
      }
      url = validateUrl(next, opts);
      continue;
    }
    const contentType = String(res.headers['content-type'] ?? '');
    if (contentType && !/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json))/i.test(contentType)) {
      res.body.destroy();
      throw new FetchError(`The page is not text (${contentType.split(';')[0]}); only text content can be fetched.`);
    }
    // Stream with a hard byte cap (after decompression) instead of trusting Content-Length.
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const body = decoded(res);
    try {
      for await (const chunk of body) {
        const value = chunk as Buffer;
        const room = FETCH_MAX_BYTES - size;
        if (value.byteLength > room) {
          chunks.push(value.subarray(0, room));
          truncated = true;
          break;
        }
        chunks.push(value);
        size += value.byteLength;
      }
    } catch (err) {
      const msg = signal.aborted ? 'the request timed out' : (err as Error).message;
      throw new FetchError(`Could not fetch ${url.host}: ${msg}.`);
    } finally {
      body.destroy();
      res.body.destroy();
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
    return { url, status: res.status, contentType, text, truncated };
  }
}
