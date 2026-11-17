/**
 * HTTP + WebSocket server (Fastify 5). The API only reads state and enqueues jobs; it never runs
 * agents (docs/16 Scalability.md, rule 4).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { API_PREFIX, type ApiError } from '@sebeto/shared';
import type { AppContext, ToolServer } from '../contracts.js';
import { redactUrl } from '../logger.js';
import { AppError } from '../services/errors.js';
import { finishOAuth, oauthResultPage } from '../services/oauth.js';
import { createSecurityHook } from './security.js';
import { registerApiRoutes } from './routes.js';
import { registerHookRoute } from '../triggers/webhook.js';
import { USER_ACTOR, runWithActor } from '../security/actor.js';
import { createAuthRefusalRecorder } from '../security/service.js';

export interface ServerOptions {
  /** Extra Host header names to accept (defaults to config.allowedHosts when present). */
  allowedHosts?: string[];
  /** Extra exact origins allowed to call the API (e.g. http://localhost:5173). */
  allowedOrigins?: string[];
}

/** Tool server as provided by tools/: the contract plus an HTTP handler for the MCP endpoint. */
export type HttpToolServer = ToolServer & {
  handleHttp(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body?: unknown): Promise<void> | void;
};

function hasHttpHandler(tools: ToolServer | undefined): tools is HttpToolServer {
  return !!tools && typeof (tools as Partial<HttpToolServer>).handleHttp === 'function';
}

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

function zodMessage(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function createServer(ctx: AppContext, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const cfg = ctx.config as AppContext['config'] & { allowedHosts?: string[] };
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 2 * 1024 * 1024 });

  // ---- security first: Host / Origin / token
  app.addHook(
    'onRequest',
    createSecurityHook({
      apiToken: ctx.config.apiToken,
      bindHost: ctx.config.host,
      allowedHosts: opts.allowedHosts ?? cfg.allowedHosts ?? [],
      allowedOrigins: opts.allowedOrigins ?? [],
      apiPrefix: API_PREFIX,
      queryTokenPaths: [`${API_PREFIX}/events`],
      // v0.4 §D: webhooks authenticate with their own per-trigger secret (triggers/webhook.ts).
      publicPaths: [`${API_PREFIX}/hooks/:id`],
      onRefused: createAuthRefusalRecorder(ctx),
    }),
  );
  // v0.4 security log: changes made while serving an API request are the owner's (not /mcp: agents).
  app.addHook('onRequest', (req, _reply, done) => {
    if ((req.url.split('?')[0] ?? '').startsWith(API_PREFIX)) runWithActor(USER_ACTOR, done);
    else done();
  });

  // CSP for the web UI. The inline theme script (index.html, runs before paint) is allowed by its
  // sha256 hash, read from the served file at startup so it can never drift. The primary XSS defence
  // is still that the UI renders no raw HTML from untrusted content (components/RichText.tsx); this
  // is defence in depth. The /oauth/callback page sets its own stricter CSP and keeps it.
  const uiCsp = ctx.config.uiDir && existsSync(ctx.config.uiDir) ? buildUiCsp(ctx.config.uiDir) : null;
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer'); // the desktop shell puts the token in the page URL
    if (uiCsp && !reply.getHeader('content-security-policy')) {
      const ct = String(reply.getHeader('content-type') ?? '');
      if (ct.includes('text/html')) reply.header('content-security-policy', uiCsp);
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    ctx.log.debug({ method: req.method, url: redactUrl(req.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) return reply.code(400).send(apiError('invalid_request', zodMessage(err)));
    if (err instanceof AppError) return reply.code(err.statusCode).send(apiError(err.code, err.message));
    // Domain errors from other modules, matched by name to keep the API layer decoupled.
    if (err.name === 'InvalidTransitionError') return reply.code(409).send(apiError('invalid_transition', err.message));
    if (err.name === 'InvalidCursorError') return reply.code(400).send(apiError('invalid_cursor', err.message));
    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send(apiError((err as FastifyError).code ?? 'bad_request', err.message));
    }
    ctx.log.error({ err: { message: err.message, stack: err.stack }, method: req.method, url: redactUrl(req.url) }, 'request failed');
    return reply.code(500).send(apiError('internal', 'Something went wrong. Check the logs for details.'));
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  await app.register(
    async (api) => {
      registerApiRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );

  // ---- v0.4 §D webhooks: own plugin scope (raw-body parser for the HMAC, own error handler).
  await app.register(
    async (hooks) => {
      registerHookRoute(hooks, ctx);
    },
    { prefix: API_PREFIX },
  );

  // ---- Sign-in redirect from the owner's browser (Microsoft / Google). It cannot carry the API
  // token: it is protected by the Host check (loopback names only) and by the single-use, 10-minute
  // `state` + PKCE verifier held in the core. The page has no scripts.
  app.get('/oauth/callback', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const pick = (k: string) => (typeof q[k] === 'string' ? q[k]!.slice(0, 4096) : undefined);
    const result = await finishOAuth(ctx, { code: pick('code'), state: pick('state'), error: pick('error'), error_description: pick('error_description') });
    return reply
      .code(result.ok ? 200 : 400)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(oauthResultPage(result));
  });

  // ---- MCP endpoint (tool server owns its auth: per-session scoped tokens). ctx.tools is looked up per
  // request so main.ts can create the tool server after listen() once the real port is known.
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const tools = ctx.tools;
      if (!hasHttpHandler(tools)) {
        return reply.code(503).send(apiError('unavailable', 'Tool server is not available'));
      }
      reply.hijack();
      try {
        await tools.handleHttp(req.raw, reply.raw, req.body);
      } catch (err) {
        ctx.log.error({ err: { message: (err as Error).message } }, 'mcp request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(JSON.stringify(apiError('internal', 'MCP request failed')));
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    },
  });

  // ---- built UI with SPA fallback
  const uiDir = ctx.config.uiDir;
  const serveUi = !!uiDir && existsSync(uiDir);
  if (uiDir && !serveUi) ctx.log.warn({ uiDir }, 'UI directory not found; not serving the UI');
  if (serveUi) {
    await app.register(fastifyStatic, { root: uiDir!, prefix: '/', index: ['index.html'], wildcard: true });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    const isApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`) || path.startsWith('/api/') || path === '/mcp';
    if (serveUi && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send(apiError('not_found', `Route ${req.method} ${path} not found`));
  });

  return app;
}

/**
 * Content-Security-Policy for the web UI, built from the served index.html so the inline theme
 * script's hash never drifts. Allows: same-origin assets; Google Fonts (styles + fonts); inline
 * styles (React style attributes); same-origin WebSocket for /events; data: images. No raw inline
 * scripts beyond the one hashed here; no plugins, framing, base-tag or form posting.
 */
export function buildUiCsp(uiDir: string): string {
  const hashes: string[] = [];
  try {
    const html = readFileSync(join(uiDir, 'index.html'), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      hashes.push(`'sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}'`);
    }
  } catch {
    /* no index.html: fall back to a script-src with no inline allowance */
  }
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
    "connect-src 'self' ws: wss:",
  ].join('; ');
}
