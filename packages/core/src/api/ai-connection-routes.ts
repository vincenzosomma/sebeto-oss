/**
 * /api/v1/ai-connections (v0.7 R, contract packages/shared/src/ai-connections.ts): the owner's
 * OpenAI-compatible endpoints. The API key goes in, never out. Own file like cost-routes.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_CONNECTION_KINDS, AI_CONNECTION_LIMITS } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import {
  createAiConnection, listAiConnections, removeAiConnection, testAiConnection, updateAiConnection,
} from '../services/ai-connections.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const model = z.string().trim().min(1).max(200);
const price = z.object({
  inputPerM: z.number().finite().min(0).max(AI_CONNECTION_LIMITS.maxPricePerM),
  outputPerM: z.number().finite().min(0).max(AI_CONNECTION_LIMITS.maxPricePerM),
}).strict();
const prices = z.record(model, price).refine((p) => Object.keys(p).length <= AI_CONNECTION_LIMITS.maxPrices, `at most ${AI_CONNECTION_LIMITS.maxPrices} prices`);
const timeout = z.number().int().min(AI_CONNECTION_LIMITS.minReplyTimeoutMin).max(AI_CONNECTION_LIMITS.maxReplyTimeoutMin);
const contextWindow = z.number().int().min(2048).max(2_097_152).nullable();
const kind = z.enum(AI_CONNECTION_KINDS as unknown as ['local', 'remote']);

export const createAiConnectionBody = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().min(1).max(500),
  kind,
  apiKey: z.string().max(4096).optional(),
  defaultModel: model.nullable().optional(),
  allowPrivateHttp: z.boolean().optional(),
  prices: prices.optional(),
  replyTimeoutMin: timeout.optional(),
  contextWindow: contextWindow.optional(),
}).strict();

export const updateAiConnectionBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  kind: kind.optional(),
  apiKey: z.string().max(4096).nullable().optional(),
  defaultModel: model.nullable().optional(),
  allowPrivateHttp: z.boolean().optional(),
  prices: prices.optional(),
  replyTimeoutMin: timeout.optional(),
  contextWindow: contextWindow.optional(),
}).strict();

export function registerAiConnectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ai-connections', async () => listAiConnections(ctx));
  app.post('/ai-connections', async (req, reply) => reply.code(201).send(await createAiConnection(ctx, createAiConnectionBody.parse(req.body))));
  app.patch('/ai-connections/:id', async (req) => updateAiConnection(ctx, idParams.parse(req.params).id, updateAiConnectionBody.parse(req.body ?? {})));
  app.delete('/ai-connections/:id', async (req, reply) => {
    await removeAiConnection(ctx, idParams.parse(req.params).id);
    return reply.code(204).send();
  });
  app.post('/ai-connections/:id/test', async (req) => testAiConnection(ctx, idParams.parse(req.params).id));
}

// ---------------------------------------------------------------- OpenAPI fragments (merged in openapi.ts)
const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const bool = { type: 'boolean' } as const;
const int = { type: 'integer' } as const;
const num = { type: 'number' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const errors = {
  '400': { description: 'Invalid request', ...json(ref('ApiError')) },
  '401': { description: 'Missing or invalid token', ...json(ref('ApiError')) },
  '403': { description: 'Host or Origin not allowed', ...json(ref('ApiError')) },
};
const priceMap = { type: 'object', additionalProperties: { type: 'object', properties: { inputPerM: num, outputPerM: num }, required: ['inputPerM', 'outputPerM'] } };
const bodyProps = {
  name: str, baseUrl: str, kind: { type: 'string', enum: [...AI_CONNECTION_KINDS] }, apiKey: { type: ['string', 'null'], writeOnly: true, description: 'Stored in the secrets store; never returned' },
  defaultModel: nstr, allowPrivateHttp: bool, prices: priceMap, replyTimeoutMin: int, contextWindow: { type: ['integer', 'null'] },
};

export const aiConnectionOpenApiPaths = {
  '/ai-connections': {
    get: { summary: 'OpenAI-compatible AI connections (each is a runtime "openai:<id>"). The API key is never returned.', responses: { '200': { description: 'OK', ...json({ type: 'array', items: ref('AiConnection') }) }, ...errors } },
    post: {
      summary: 'Add an AI connection. Remote endpoints must be https (plain http only to this computer or an allowed private LAN IP).',
      requestBody: { required: true, ...json({ type: 'object', properties: bodyProps, required: ['name', 'baseUrl', 'kind'] }) },
      responses: { '201': { description: 'Created', ...json(ref('AiConnection')) }, ...errors },
    },
  },
  '/ai-connections/{id}': {
    patch: {
      summary: 'Change an AI connection (apiKey: a new key, null to remove, omitted to keep). 409 runtime_locked when a locked team uses it and the address or kind would change.',
      parameters: [idParam], requestBody: { required: true, ...json({ type: 'object', properties: bodyProps }) },
      responses: { '200': { description: 'OK', ...json(ref('AiConnection')) }, '409': { description: 'A locked team uses it', ...json(ref('ApiError')) }, ...errors },
    },
    delete: {
      summary: 'Remove an AI connection and its API key (409 ai_connection_in_use while an agent or team uses it).',
      parameters: [idParam], responses: { '204': { description: 'Removed' }, '409': { description: 'In use', ...json(ref('ApiError')) }, ...errors },
    },
  },
  '/ai-connections/{id}/test': {
    post: {
      summary: 'Test connection: reach the endpoint, check the key, list the models (GET <baseUrl>/models).',
      parameters: [idParam], responses: { '200': { description: 'OK', ...json(ref('AiConnectionTestResult')) }, ...errors },
    },
  },
};

export const aiConnectionOpenApiSchemas = {
  AiConnection: {
    type: 'object',
    properties: {
      id: str, runtimeId: str, name: str, baseUrl: str, kind: { type: 'string', enum: [...AI_CONNECTION_KINDS] }, defaultModel: nstr,
      hasApiKey: bool, allowPrivateHttp: bool, prices: priceMap, replyTimeoutMin: int, contextWindow: { type: ['integer', 'null'] }, createdAt: date, updatedAt: date,
    },
    required: ['id', 'runtimeId', 'name', 'baseUrl', 'kind', 'defaultModel', 'hasApiKey', 'allowPrivateHttp', 'prices', 'replyTimeoutMin', 'contextWindow', 'createdAt', 'updatedAt'],
  },
  AiConnectionTestResult: {
    type: 'object', properties: { ok: bool, models: { type: 'array', items: str }, problem: nstr, latencyMs: int }, required: ['ok', 'models', 'problem', 'latencyMs'],
  },
};
