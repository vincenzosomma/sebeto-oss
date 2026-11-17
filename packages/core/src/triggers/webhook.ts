/**
 * POST /api/v1/hooks/:id: alerts and messages from outside (docs/28 v0.4 Plan.md §D).
 *
 * This is the ONLY /api route without the session token (api/security.ts exempts it). Instead the
 * caller proves it knows the trigger's secret:
 *   - `Authorization: Bearer <secret>`: sha256(secret) compared in constant time with secret_hash;
 *   - `X-Sebeto-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`: key from the secret store.
 * Host / Origin checks still apply (see api/security.ts): with the default bind 127.0.0.1 only
 * loopback Host names are accepted; on 0.0.0.0 (Docker) any Host is, plus SEBETO_ALLOWED_HOSTS.
 *
 * Order of checks (each refusal is a trigger_fires row + a security event, rate-limited in floods):
 *   unknown id → 404 (no row) · body > 256 KB → 413 · trigger off → 404 · no / wrong secret → 401 ·
 *   emergency stop → 503 · more than 60 accepted calls a minute → 429 · not JSON → 415 / 400.
 * The rate limit counts authenticated calls only, so someone without the secret cannot use up the
 * budget of a real alert source. Responses never echo the payload.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HOOK_MAX_BYTES, HOOK_RATE_PER_MINUTE, type HookResponse, type Id } from '@sebeto/shared';
import type { AppContext, StoredTrigger } from '../contracts.js';
import { bearerFrom } from '../api/security.js';
import { fire, recordRejected, secretName, sha256Hex, webhookIncoming } from './service.js';

/** Rejected calls written to trigger_fires / the security log per trigger per minute (flood guard). */
export const REJECT_ROWS_PER_MINUTE = 20;

export interface HookRouteOptions {
  /** Clock (ms) for the rate limiter; injectable for tests. */
  now?: () => number;
}

interface Bucket { tokens: number; at: number }
interface RowWindow { start: number; count: number; suppressed: number }

function send(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).header('cache-control', 'no-store').send({ error: { code, message } });
}

/** Constant-time check of a Bearer secret against the stored sha256 hex. */
export function bearerMatches(secretHash: string | null, given: string | undefined): boolean {
  if (!secretHash || !given || !/^[0-9a-f]{64}$/.test(secretHash)) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(given), 'hex'), Buffer.from(secretHash, 'hex'));
}

/** Constant-time check of `sha256=<hex>` against HMAC-SHA256(secret, body). */
export function signatureMatches(secret: string | null, header: string, body: Buffer): boolean {
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!secret || !m) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(m[1]!, 'hex'));
}

function isJsonType(ct: string | undefined): boolean {
  if (!ct) return true; // curl -d without a type, simple scripts: the body must still parse as JSON
  const type = ct.split(';')[0]!.trim().toLowerCase();
  return type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type);
}

export function registerHookRoute(app: FastifyInstance, ctx: AppContext, opts: HookRouteOptions = {}): void {
  const now = opts.now ?? Date.now;
  const buckets = new Map<Id, Bucket>();
  const rows = new Map<Id, RowWindow>();

  /** Token bucket: HOOK_RATE_PER_MINUTE per trigger, refilled continuously. */
  function take(id: Id): boolean {
    const t = now();
    const b = buckets.get(id) ?? { tokens: HOOK_RATE_PER_MINUTE, at: t };
    b.tokens = Math.min(HOOK_RATE_PER_MINUTE, b.tokens + ((t - b.at) / 60_000) * HOOK_RATE_PER_MINUTE);
    b.at = t;
    buckets.set(id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Refusal: a fire row + a security event, at most REJECT_ROWS_PER_MINUTE a minute per trigger. */
  function reject(reply: FastifyReply, t: StoredTrigger, status: number, code: string, reason: string, message: string) {
    const ts = now();
    const w = rows.get(t.id);
    const win = w && ts - w.start < 60_000 ? w : { start: ts, count: 0, suppressed: w && ts - w.start >= 60_000 ? w.suppressed : 0 };
    rows.set(t.id, win);
    if (win.count < REJECT_ROWS_PER_MINUTE) {
      win.count += 1;
      const extra = win.suppressed ? ` (+${win.suppressed} similar calls not logged)` : '';
      win.suppressed = 0;
      try {
        recordRejected(ctx, t, `${reason}${extra}`);
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message }, 'could not record a rejected webhook call');
      }
    } else {
      win.suppressed += 1;
    }
    return send(reply, status, code, message);
  }

  function lookup(id: unknown): StoredTrigger | undefined {
    if (typeof id !== 'string' || id.length > 100) return undefined;
    const t = ctx.repos.triggers?.get(id);
    return t && t.kind === 'webhook' ? t : undefined;
  }

  // Raw body for the HMAC: every content type is read as a Buffer (JSON is parsed in the handler).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HOOK_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const t = lookup((req.params as { id?: unknown } | undefined)?.id);
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
      if (t) return reject(reply, t, 413, 'too_large', 'too large', `The body is larger than ${HOOK_MAX_BYTES / 1024} KB`);
      return send(reply, 413, 'too_large', 'Body too large');
    }
    if (t) return reject(reply, t, err.statusCode && err.statusCode < 500 ? err.statusCode : 400, 'bad_request', 'bad request', 'Bad request');
    return send(reply, 400, 'bad_request', 'Bad request');
  });

  app.post('/hooks/:id', { bodyLimit: HOOK_MAX_BYTES }, async (req, reply) => {
    const t = lookup((req.params as { id?: unknown }).id);
    if (!t) return send(reply, 404, 'not_found', 'Unknown hook');
    if (!t.enabled) return reject(reply, t, 404, 'not_found', 'trigger is off', 'Unknown hook');

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (raw.length > HOOK_MAX_BYTES) return reject(reply, t, 413, 'too_large', 'too large', 'Body too large');

    const bearer = bearerFrom(req);
    const sig = req.headers['x-sebeto-signature'];
    let ok = false;
    let reason = 'missing secret';
    if (bearer !== undefined) {
      ok = bearerMatches(t.secretHash, bearer);
      reason = 'wrong secret';
    } else if (typeof sig === 'string') {
      let secret: string | null = null;
      try {
        secret = (await ctx.secrets?.get(secretName(t.id))) ?? null;
      } catch (err) {
        ctx.log.error({ triggerId: t.id, err: (err as Error).message }, 'could not read the webhook secret');
      }
      // The stored key must still match the current hash (a rotation always rewrites both).
      ok = !!secret && sha256Hex(secret) === t.secretHash && signatureMatches(secret, sig, raw);
      reason = 'bad signature';
    }
    if (!ok) {
      reply.header('www-authenticate', 'Bearer');
      return reject(reply, t, 401, 'unauthorized', reason, 'Missing or invalid secret');
    }

    if (ctx.securityLog?.lockdown()) return reject(reply, t, 503, 'lockdown', 'emergency stop is on', 'Sebeto is in emergency stop; try later');
    if (!take(t.id)) {
      reply.header('retry-after', '60');
      return reject(reply, t, 429, 'rate_limited', 'rate limited', `More than ${HOOK_RATE_PER_MINUTE} calls a minute`);
    }
    if (!isJsonType(req.headers['content-type'])) return reject(reply, t, 415, 'not_json', 'not JSON', 'Send JSON (Content-Type: application/json)');
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reject(reply, t, 400, 'bad_json', 'bad JSON', 'The body is not valid JSON');
    }

    const cfg = t.config.kind === 'webhook' ? t.config : null;
    if (!cfg) return send(reply, 404, 'not_found', 'Unknown hook');
    const result = await fire(ctx, t.id, webhookIncoming(cfg.preset, payload, cfg.dedupeField));
    const body: HookResponse = { outcome: result.outcome, ...(result.ticketNumber !== null ? { ticketNumber: result.ticketNumber } : {}) };
    return reply.code(202).header('cache-control', 'no-store').send(body);
  });
}
