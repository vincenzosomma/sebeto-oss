/**
 * /api/v1/backups (v0.7 Q, contract packages/shared/src/backups.ts). Names are checked against
 * BACKUP_NAME_RE before any file is touched; the passphrase is only passed through (never stored,
 * logged or echoed). Kept in its own file with its zod schemas and OpenAPI fragments.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BACKUP_TIME_RE, MAX_BACKUP_KEEP, MAX_BACKUP_PASSPHRASE } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import type { BackupService } from '../backup/service.js';
import { unavailable } from '../services/errors.js';

const passphrase = z.string().min(1).max(MAX_BACKUP_PASSPHRASE);
export const createBackupBody = z.object({ includeTickets: z.boolean().optional(), passphrase: passphrase.optional() }).strict();
export const verifyBackupBody = z.object({ passphrase: passphrase.optional() }).strict();
export const backupSettingsBody = z.object({
  autoEnabled: z.boolean().optional(),
  autoTime: z.string().regex(BACKUP_TIME_RE, 'must be HH:MM').optional(),
  keep: z.number().int().min(1).max(MAX_BACKUP_KEEP).optional(),
  dir: z.string().min(1).max(1024).nullable().optional(),
}).strict();
const nameParam = z.object({ name: z.string().min(1).max(64) }).strict();

function svc(ctx: AppContext): BackupService {
  if (!ctx.backups) throw unavailable('Backups are not available in this build');
  return ctx.backups;
}

export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/backups', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return svc(ctx).list();
  });
  app.get('/backups/estimate', async () => svc(ctx).estimate());
  app.get('/backups/settings', async () => svc(ctx).settings());
  app.put('/backups/settings', async (req) => svc(ctx).updateSettings(backupSettingsBody.parse(req.body ?? {})));
  app.post('/backups', async (req, reply) => {
    const body = createBackupBody.parse(req.body ?? {});
    const info = await svc(ctx).create(body, 'manual');
    return reply.code(201).send(info);
  });
  app.get('/backups/:name/download', async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const file = svc(ctx).filePath(name);
    const size = fs.statSync(file).size;
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', String(size))
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(fs.createReadStream(file));
  });
  app.post('/backups/:name/verify', async (req) => {
    const { name } = nameParam.parse(req.params);
    return svc(ctx).verify(name, verifyBackupBody.parse(req.body ?? {}));
  });
  app.delete('/backups/:name', async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    svc(ctx).remove(name);
    return reply.code(204).send();
  });
}

// ---------------------------------------------------------------- OpenAPI fragments (merged in openapi.ts)
const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (items: object) => ({ type: 'array', items });
const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required });
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const nameP = { name: 'name', in: 'path', required: true, schema: { type: 'string', pattern: '^sebeto-backup-\\d{8}-\\d{6}(-auto)?(-\\d{1,3})?\\.zip$' } };
const errs = {
  '400': { description: 'Invalid request', ...json(ref('ApiError')) },
  '401': { description: 'Missing or invalid token', ...json(ref('ApiError')) },
};
const nf = { '404': { description: 'No such backup', ...json(ref('ApiError')) } };

export const backupOpenApiPaths = {
  '/backups': {
    get: { summary: 'Backups in the backup folder (newest first), the settings and the last automatic run.', responses: { '200': { description: 'OK', ...json(ref('BackupListResponse')) }, ...errs } },
    post: {
      summary: 'Back up now: database (online copy), memory, settings, templates, skills; ticket folders optional; secrets only encrypted with a passphrase (AES-256-GCM, scrypt key). The passphrase is never stored or logged.',
      requestBody: json(obj({ includeTickets: bool, passphrase: { type: 'string', minLength: 12 } }, [])),
      responses: { '201': { description: 'Created', ...json(ref('BackupInfo')) }, ...errs, '409': { description: 'A backup is already running', ...json(ref('ApiError')) } },
    },
  },
  '/backups/estimate': { get: { summary: 'Sizes before a backup (ticket folders can be big).', responses: { '200': { description: 'OK', ...json(ref('BackupEstimate')) }, ...errs } } },
  '/backups/settings': {
    get: { summary: 'Automatic backup settings.', responses: { '200': { description: 'OK', ...json(ref('BackupSettings')) }, ...errs } },
    put: { summary: 'Change the automatic backup settings or the backup folder (absolute, never inside a ticket folder).', requestBody: json(obj({ autoEnabled: bool, autoTime: str, keep: int, dir: nstr }, [])), responses: { '200': { description: 'OK', ...json(ref('BackupSettings')) }, ...errs } },
  },
  '/backups/{name}/download': { get: { summary: 'Download a backup file.', parameters: [nameP], responses: { '200': { description: 'The .zip file', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } }, ...errs, ...nf } } },
  '/backups/{name}/verify': {
    post: { summary: 'Check a backup without restoring it: manifest, every sha256, schema version, paths, and the hash recorded in the security log.', parameters: [nameP], requestBody: json(obj({ passphrase: str }, [])), responses: { '200': { description: 'OK', ...json(ref('BackupVerifyResult')) }, ...errs, ...nf } },
  },
  '/backups/{name}': { delete: { summary: 'Delete a backup file.', parameters: [nameP], responses: { '204': { description: 'Deleted' }, ...errs, ...nf } } },
};

export const backupOpenApiSchemas = {
  BackupInfo: obj({ name: str, kind: { type: 'string', enum: ['manual', 'auto'] }, sizeBytes: int, createdAt: date, secretsSkipped: int }, ['name', 'kind', 'sizeBytes', 'createdAt']),
  BackupSettings: obj({ autoEnabled: bool, autoTime: str, keep: int, dir: nstr }),
  BackupListResponse: obj({
    items: arr(ref('BackupInfo')), dir: str, settings: ref('BackupSettings'), running: bool,
    lastAuto: { type: ['object', 'null'], properties: { at: date, ok: bool, message: nstr } },
  }),
  BackupEstimate: obj({ baseBytes: int, ticketsBytes: int, ticketFolders: int, secrets: int }),
  BackupVerifyResult: obj({
    ok: bool, name: str, files: int, bytes: int, schemaVersion: { type: ['integer', 'null'] }, supportedSchemaVersion: int,
    createdAt: nstr, appVersion: nstr, includesTickets: bool, includesSecrets: bool,
    secretsOpened: { type: ['boolean', 'null'] }, matchesRecordedHash: { type: ['boolean', 'null'] }, problems: arr(str),
  }),
};
