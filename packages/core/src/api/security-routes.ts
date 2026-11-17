/**
 * /api/v1/security routes (v0.4 §B, contract packages/shared/src/security.ts): the security log,
 * integrity check, export, settings and the emergency stop. Kept in its own file (with its zod
 * schemas and OpenAPI paths) so parallel work on routes.ts / schemas.ts / openapi.ts stays small.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SECURITY_CATEGORIES, SECURITY_SEVERITIES, type SecurityCategory, type SecuritySeverity } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import * as sec from '../security/service.js';

const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date').transform((s) => new Date(s).toISOString());
const csvEnum = <T extends string>(values: readonly T[]) =>
  z.string().max(400).transform((s, c) => {
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      if (!values.includes(p as T)) {
        c.addIssue({ code: 'custom', message: `unknown value "${p}"` });
        return z.NEVER;
      }
    }
    return parts as T[];
  });
const id = z.string().min(1).max(100);

export const securityEventsQuery = z.object({
  since: isoDate.optional(),
  until: isoDate.optional(),
  category: csvEnum<SecurityCategory>(SECURITY_CATEGORIES).optional(),
  severity: csvEnum<SecuritySeverity>(SECURITY_SEVERITIES).optional(),
  agentId: id.optional(),
  ticketId: id.optional(),
  ticketNumber: z.coerce.number().int().min(1).max(1e9).optional(),
  sessionId: id.optional(),
  runId: id.optional(),
  action: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

export const securitySummaryQuery = z.object({ hours: z.coerce.number().int().min(1).max(24 * 366).optional() }).strict();

export const securityExportQuery = z.object({
  format: z.enum(['jsonl', 'csv']).default('jsonl'),
  since: isoDate.optional(),
  until: isoDate.optional(),
}).strict();

export const emergencyStopBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const securitySettingsBody = z.object({
  retentionDays: z.number().int().min(0).max(36_500).optional(),
  jsonlMirror: z.boolean().optional(),
}).strict();

export function registerSecurityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/security/events', async (req) => {
    const q = securityEventsQuery.parse(req.query ?? {});
    return sec.listSecurityEvents(ctx, q);
  });
  app.get('/security/summary', async (req) => sec.securitySummary(ctx, securitySummaryQuery.parse(req.query ?? {}).hours ?? 24));
  app.get('/security/status', async () => sec.lockdownStatus(ctx));
  app.get('/security/verify', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return sec.verifySecurityLog(ctx);
  });
  app.get('/security/export', async (req, reply) => {
    const q = securityExportQuery.parse(req.query ?? {});
    const file = sec.exportSecurityLog(ctx, q);
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('cache-control', 'no-store')
      .send(file.stream);
  });
  app.post('/security/emergency-stop', async (req) => sec.emergencyStop(ctx, emergencyStopBody.parse(req.body).reason));
  app.post('/security/emergency-stop/release', async () => sec.releaseLockdown(ctx));
  app.get('/security/settings', async () => sec.getSecuritySettings(ctx));
  app.put('/security/settings', async (req) => sec.updateSecuritySettings(ctx, securitySettingsBody.parse(req.body ?? {})));
}

// ---------------------------------------------------------------- OpenAPI fragments (merged in openapi.ts)
const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const int = { type: 'integer' } as const;
const nint = { type: ['integer', 'null'] } as const;
const bool = { type: 'boolean' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required });
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const errors = {
  '400': { description: 'Invalid request', ...json(ref('ApiError')) },
  '401': { description: 'Missing or invalid token', ...json(ref('ApiError')) },
  '403': { description: 'Host or Origin not allowed', ...json(ref('ApiError')) },
};
const op = (summary: string, responses: object, extra: object = {}) => ({ summary, ...extra, responses: { ...responses, ...errors } });
const okJson = (schema: object) => ({ '200': { description: 'OK', ...json(schema) } });
const q = (name: string, schema: object, description?: string) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const severity = { type: 'string', enum: [...SECURITY_SEVERITIES] };
const category = { type: 'string', enum: [...SECURITY_CATEGORIES] };

export const securityOpenApiPaths = {
  '/security/events': {
    get: op('Security log events, newest first (cursor paginated)', okJson(obj({ items: { type: 'array', items: ref('SecurityEvent') }, nextCursor: nstr })), {
      parameters: [
        q('since', date), q('until', date),
        q('category', str, 'Comma-separated categories'), q('severity', str, 'Comma-separated severities'),
        q('agentId', str), q('ticketId', str), q('ticketNumber', int), q('sessionId', str), q('runId', str), q('action', str),
        q('q', str, 'Text search in summary, action, actor and data'), q('cursor', str), q('limit', { type: 'integer', minimum: 1, maximum: 200 }),
      ],
    }),
  },
  '/security/summary': { get: op('Counts for the last N hours (default 24)', okJson(ref('SecuritySummary')), { parameters: [q('hours', int)] }) },
  '/security/status': { get: op('Emergency stop (lockdown) state', okJson(obj({ active: bool, since: nstr, reason: nstr }))) },
  '/security/verify': { get: op('Check the hash chain of the whole log', okJson(ref('SecurityVerifyResult'))) },
  '/security/export': {
    get: op('Download the log as JSONL or CSV (CSV cells are formula-injection safe)', {
      '200': { description: 'File', content: { 'application/x-ndjson': { schema: str }, 'text/csv': { schema: str } } },
    }, { parameters: [q('format', { type: 'string', enum: ['jsonl', 'csv'] }), q('since', date), q('until', date)] }),
  },
  '/security/emergency-stop': {
    post: op('Emergency stop: stop every run, pause every agent, turn off every trigger, lock down', okJson(obj({ ok: { const: true }, cancelledRuns: int, pausedAgents: int, disabledTriggers: int })), {
      requestBody: { required: true, ...json(obj({ reason: str })) },
    }),
  },
  '/security/emergency-stop/release': { post: op('End the lockdown (agents stay paused)', okJson(obj({ ok: { const: true } }))) },
  '/security/settings': {
    get: op('Security log settings', okJson(ref('SecuritySettings'))),
    put: op('Change security log settings', okJson(ref('SecuritySettings')), { requestBody: { required: true, ...json(obj({ retentionDays: int, jsonlMirror: bool }, [])) } }),
  },
};

export const securityOpenApiSchemas = {
  SecurityEvent: obj({
    id: str, seq: int, at: date, category, action: str, severity,
    actor: obj({ type: { type: 'string', enum: ['user', 'agent', 'system', 'trigger'] }, id: nstr, name: str }),
    ticketId: nstr, ticketNumber: nint, agentId: nstr, sessionId: nstr, runId: nstr, summary: str,
    data: { type: ['object', 'null'] }, prevHash: str, hash: str,
  }),
  SecuritySummary: obj({
    hours: int, total: int, bySeverity: { type: 'object', additionalProperties: int }, byCategory: { type: 'object', additionalProperties: int },
    deniedPermissions: int, untrustedReads: int, rejectedTriggers: int,
    activeAgents: { type: 'array', items: obj({ agentId: str, name: str, events: int }) }, lockdown: bool,
  }),
  SecurityVerifyResult: obj({ ok: bool, checked: int, firstSeq: nint, lastSeq: nint, brokenAtSeq: nint, problem: nstr }),
  SecuritySettings: obj({ retentionDays: int, jsonlMirror: bool }),
};
