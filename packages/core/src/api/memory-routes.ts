/**
 * /api/v1/memory routes (v0.4 §E, contract packages/shared/src/memory.ts): the memory graph.
 * Kept in its own file (zod schemas + OpenAPI fragments) like security-routes.ts, so parallel work
 * on routes.ts / schemas.ts / openapi.ts stays small.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMORY_KINDS, type MemoryKind } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import * as mem from '../memory/service.js';

const id = z.string().min(1).max(100);
const kind = z.enum(MEMORY_KINDS as unknown as [MemoryKind, ...MemoryKind[]]);
const depth = z.coerce.number().int().min(1).max(2).transform((n) => n as 1 | 2);
const flag = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');

export const listMemoryQuery = z.object({
  q: z.string().max(300).optional(),
  kind: kind.optional(),
  team: z.string().min(1).max(64).optional(),
  status: z.enum(['approved', 'proposed']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

export const saveMemoryNoteBody = z.object({
  title: z.string().trim().min(1).max(120),
  kind,
  body: z.string().max(62 * 1024),
  tags: z.array(z.string().max(64)).max(30).optional(),
  teamSlug: z.string().min(1).max(64).nullable().optional(),
  untrusted: z.boolean().optional(),
}).strict();

export const memoryGraphQuery = z.object({
  team: z.string().min(1).max(64).optional(),
  kind: kind.optional(),
  center: id.optional(),
  depth: depth.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  proposed: flag.optional(),
  q: z.string().max(300).optional(),
}).strict();

export const memoryRelatedQuery = z.object({
  name: z.string().trim().min(1).max(200),
  depth: depth.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

export const memoryBackfillBody = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  dryRun: z.boolean().optional(),
  useModel: z.boolean().optional(),
}).strict();

export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/memory/notes', async (req) => mem.listMemoryNotes(ctx, listMemoryQuery.parse(req.query ?? {})));
  app.get('/memory/notes/:id', async (req) => mem.getMemoryNote(ctx, z.object({ id }).parse(req.params).id));
  app.post('/memory/notes', async (req, reply) => reply.code(201).send(await mem.createMemoryNote(ctx, saveMemoryNoteBody.parse(req.body))));
  app.put('/memory/notes/:id', async (req) => mem.updateMemoryNote(ctx, z.object({ id }).parse(req.params).id, saveMemoryNoteBody.parse(req.body)));
  app.delete('/memory/notes/:id', async (req, reply) => {
    await mem.deleteMemoryNote(ctx, z.object({ id }).parse(req.params).id);
    return reply.code(204).send();
  });
  app.post('/memory/notes/:id/approve', async (req) => mem.approveMemoryNote(ctx, z.object({ id }).parse(req.params).id));
  app.get('/memory/graph', async (req) => {
    const { proposed, ...q } = memoryGraphQuery.parse(req.query ?? {});
    return mem.memoryGraph(ctx, { ...q, includeProposed: proposed === true });
  });
  app.get('/memory/related', async (req) => mem.memoryRelated(ctx, memoryRelatedQuery.parse(req.query ?? {})));
  app.post('/memory/reindex', async () => mem.reindexMemory(ctx));
  app.post('/memory/backfill', async (req) => mem.backfillMemory(ctx, memoryBackfillBody.parse(req.body ?? {})));
  app.get('/memory/info', async () => mem.memoryInfo(ctx));
}

// ---------------------------------------------------------------- OpenAPI fragments (merged in openapi.ts)
const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const int = { type: 'integer' } as const;
const num = { type: 'number' } as const;
const bool = { type: 'boolean' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const ndate = { type: ['string', 'null'], format: 'date-time' } as const;
const arr = (items: object) => ({ type: 'array', items });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required });
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const errors = {
  '400': { description: 'Invalid request', ...json(ref('ApiError')) },
  '401': { description: 'Missing or invalid token', ...json(ref('ApiError')) },
  '403': { description: 'Host or Origin not allowed', ...json(ref('ApiError')) },
  '404': { description: 'Not found', ...json(ref('ApiError')) },
  '409': { description: 'Conflict', ...json(ref('ApiError')) },
};
const op = (summary: string, responses: object, extra: object = {}) => ({ summary, ...extra, responses: { ...responses, ...errors } });
const okJson = (schema: object, code = '200') => ({ [code]: { description: 'OK', ...json(schema) } });
const q = (name: string, schema: object, description?: string) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const kindSchema = { type: 'string', enum: [...MEMORY_KINDS] };
const saveBody = { requestBody: { required: true, ...json(ref('SaveMemoryNoteBody')) } };

export const memoryOpenApiPaths = {
  '/memory/notes': {
    get: op('Memory notes (newest first, or best match for q)', okJson(arr(ref('MemoryNote'))), {
      parameters: [q('q', str), q('kind', kindSchema), q('team', str, "Team slug, or '-' for notes without a team"),
        q('status', { type: 'string', enum: ['approved', 'proposed'] }), q('limit', int)],
    }),
    post: op('Write a new owner note', okJson(ref('MemoryNoteDetail'), '201'), saveBody),
  },
  '/memory/notes/{id}': {
    get: op('One note with body, links and backlinks', okJson(ref('MemoryNoteDetail')), { parameters: [idParam] }),
    put: op('Edit a note (owner)', okJson(ref('MemoryNoteDetail')), { parameters: [idParam], ...saveBody }),
    delete: op('Move a note to memory/.trash/ (never a hard delete)', { '204': { description: 'Moved to the trash' } }, { parameters: [idParam] }),
  },
  '/memory/notes/{id}/approve': {
    post: op('Approve an agent proposal (moves it into its kind folder)', okJson(ref('MemoryNoteDetail')), { parameters: [idParam] }),
  },
  '/memory/graph': {
    get: op('Nodes and links for the graph view (missing link targets are nodes of kind "missing")', okJson(ref('MemoryGraph')), {
      parameters: [q('team', str), q('kind', kindSchema), q('center', str, 'Note id to centre on'), q('depth', int), q('limit', int),
        q('proposed', str, "'1' to include proposals"), q('q', str)],
    }),
  },
  '/memory/related': {
    get: op('A note and its neighbours (approved notes only)', okJson(ref('MemoryRelated')), { parameters: [{ ...q('name', str), required: true }, q('depth', int), q('limit', int)] }),
  },
  '/memory/reindex': { post: op('Rebuild the index from the files', okJson(obj({ notes: int, links: int, ms: int }))) },
  '/memory/backfill': {
    post: op('Notes for already completed tickets (rules only unless useModel)', okJson(ref('MemoryBackfillResult')), {
      requestBody: { required: false, ...json(obj({ limit: int, dryRun: bool, useModel: bool }, [])) },
    }),
  },
  '/memory/info': { get: op('Memory folder and counts', okJson(obj({ folder: str, notes: int, proposed: int, links: int, lastIndexedAt: ndate }))) },
};

const noteProps = {
  id: str, title: str, kind: kindSchema, path: str, provenance: { type: 'string', enum: ['owner', 'chief-of-staff', 'agent'] }, untrusted: bool,
  status: { type: 'string', enum: ['approved', 'proposed'] }, teamSlug: nstr, ticketId: nstr, tags: arr(str), excerpt: str,
  linkCount: int, backlinkCount: int, updatedAt: date,
};

export const memoryOpenApiSchemas = {
  MemoryNote: obj(noteProps),
  MemoryNoteDetail: obj({ ...noteProps, body: str, links: arr(str), backlinks: arr(obj({ id: str, title: str })), obsidianUrl: str }),
  SaveMemoryNoteBody: obj({ title: str, kind: kindSchema, body: str, tags: arr(str), teamSlug: nstr, untrusted: bool }, ['title', 'kind', 'body']),
  MemoryGraph: obj({
    nodes: arr(obj({ id: str, title: str, kind: { type: 'string', enum: [...MEMORY_KINDS, 'missing'] }, untrusted: bool, status: nstr, teamSlug: nstr, degree: int })),
    edges: arr(obj({ from: str, to: str })),
    truncated: bool,
  }),
  MemoryRelated: obj({ note: { oneOf: [ref('MemoryNote'), { type: 'null' }] }, neighbours: arr(obj({ note: ref('MemoryNote'), via: { type: 'string', enum: ['out', 'in', 'hop2'] } })) }),
  MemoryBackfillResult: obj({ considered: int, written: int, skipped: int, modelCalls: int, costUsd: num, dryRun: bool }),
};
