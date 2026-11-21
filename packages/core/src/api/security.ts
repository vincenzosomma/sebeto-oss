/**
 * API security (docs/15 Architecture Review.md, item 5):
 *  - bearer token on every /api request (WebSocket: ?token=), constant-time compare
 *  - Host header allow-list (DNS-rebinding defence)
 *  - cross-origin Origin headers rejected
 * The /mcp endpoint is NOT covered by the API token: the tool server checks its own per-session tokens.
 * `publicPaths` (v0.4: only POST /api/v1/hooks/:id) skip the token check too: the webhook route
 * checks its own per-trigger secret. Host and Origin checks still apply to them.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isLoopbackHost } from '../config.js';

export interface SecurityOptions {
  apiToken: string;
  /** Configured bind host. Wildcard binds (0.0.0.0 / ::) accept any Host name. */
  bindHost: string;
  /** Extra Host names to accept. */
  allowedHosts?: string[];
  /** Extra exact origins to accept (e.g. a Vite dev server). */
  allowedOrigins?: string[];
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);

/** Domain label, so these digests are never equal to a plain SHA-256 of the token used elsewhere. */
const TOKEN_DIGEST_LABEL = 'tkc:htzw.6yebxr';

function sha256(s: string): Buffer {
  return createHash('sha256').update(TOKEN_DIGEST_LABEL).update(s, 'utf8').digest();
}

/** Constant-time token comparison (hashing first equalises lengths). */
export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  return timingSafeEqual(sha256(expected), sha256(given));
}

/** Hostname from a Host header ("example.com:7600", "[::1]:7600"), lowercased, without port. */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

export function createHostCheck(opts: SecurityOptions): (hostHeader: string | undefined) => boolean {
  const bind = opts.bindHost.trim().toLowerCase();
  const anyHost = WILDCARD_HOSTS.has(bind);
  const allowed = new Set<string>([bind, ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase())]);
  return (hostHeader) => {
    if (!hostHeader) return false;
    const name = hostnameOf(hostHeader);
    if (isLoopbackHost(name) || allowed.has(name)) return true;
    return anyHost;
  };
}

export function createOriginCheck(opts: SecurityOptions): (origin: string | undefined, hostHeader: string | undefined) => boolean {
  const extra = new Set((opts.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  return (origin, hostHeader) => {
    if (origin === undefined) return true; // non-browser clients, same-origin GETs
    const o = origin.toLowerCase();
    if (extra.has(o)) return true;
    if (o === 'null') return false;
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Same origin as the request.
    if (hostHeader && url.host === hostHeader.trim().toLowerCase()) return true;
    // A loopback page talking to a loopback core (e.g. the Vite dev server in development).
    return isLoopbackHost(url.hostname) && !!hostHeader && isLoopbackHost(hostnameOf(hostHeader));
  };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).header('content-type', 'application/json; charset=utf-8').send({ error: { code, message } });
}

export function bearerFrom(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  // No regex here: this runs before the token is checked, on any header (CodeQL polynomial-redos).
  const s = h.trim();
  if (s.length < 8 || s.slice(0, 6).toLowerCase() !== 'bearer' || !/\s/.test(s[6]!)) return undefined;
  return s.slice(7).trim() || undefined;
}

function queryToken(req: FastifyRequest): string | undefined {
  const q = req.query as Record<string, unknown> | undefined;
  const t = q?.token;
  return typeof t === 'string' ? t : undefined;
}

export interface SecurityHookOptions extends SecurityOptions {
  /** Paths (exact, without query) where ?token= is accepted in place of the Authorization header. */
  queryTokenPaths: string[];
  apiPrefix: string;
  /** Route patterns (as registered, e.g. '/api/v1/hooks/:id') that authenticate themselves. */
  publicPaths?: string[];
  /** v0.4: called for every refused request (the security log rate-limits what it records). Must not throw. */
  onRefused?: (r: RefusedRequest) => void;
}

export interface RefusedRequest {
  reason: 'forbidden_host' | 'forbidden_origin' | 'missing_token' | 'bad_token';
  ip: string; method: string; path: string; host?: string; origin?: string;
}

/** Fastify onRequest hook. */
export function createSecurityHook(opts: SecurityHookOptions) {
  const hostOk = createHostCheck(opts);
  const originOk = createOriginCheck(opts);
  const queryPaths = new Set(opts.queryTokenPaths);
  const publicPaths = new Set(opts.publicPaths ?? []);
  const refused = (req: FastifyRequest, reason: RefusedRequest['reason'], extra: Partial<RefusedRequest> = {}) => {
    if (!opts.onRefused) return;
    try {
      opts.onRefused({ reason, ip: req.ip ?? 'unknown', method: req.method, path: (req.url.split('?')[0] ?? '').slice(0, 200), ...extra });
    } catch { /* never break the request */ }
  };
  return async function securityHook(req: FastifyRequest, reply: FastifyReply) {
    const host = req.headers.host;
    if (!hostOk(host)) {
      refused(req, 'forbidden_host', { host: host ?? '' });
      return sendError(reply, 403, 'forbidden_host', 'Host not allowed');
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originOk(origin, host)) {
      refused(req, 'forbidden_origin', { origin: origin ?? '' });
      return sendError(reply, 403, 'forbidden_origin', 'Cross-origin request not allowed');
    }

    // Use the matched route pattern (robust against encoded/odd paths); fall back to the raw path.
    const path = req.routeOptions?.url ?? req.url.split('?')[0] ?? '';
    if (path !== opts.apiPrefix && !path.startsWith(`${opts.apiPrefix}/`)) return; // static UI, /mcp
    // Only a MATCHED route pattern can be public (routeOptions.url), never a raw path.
    if (req.routeOptions?.url && publicPaths.has(req.routeOptions.url)) return;
    let token = bearerFrom(req);
    if (token === undefined && queryPaths.has(path)) token = queryToken(req);
    if (!tokenMatches(opts.apiToken, token)) {
      refused(req, token ? 'bad_token' : 'missing_token');
      return sendError(reply, 401, 'unauthorized', 'Missing or invalid token');
    }
  };
}
