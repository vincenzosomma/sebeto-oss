/** /api/v1/triggers routes (token-protected like the rest of the API). The webhook itself is in webhook.ts. */
import type { FastifyInstance } from 'fastify';
import type { CreateTriggerBody, UpdateTriggerBody } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { idParams } from '../api/schemas.js';
import * as svc from './service.js';
import * as s from './schemas.js';

export function registerTriggerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/triggers', async () => svc.listTriggers(ctx));
  app.post('/triggers', async (req, reply) => {
    const res = await svc.createTrigger(ctx, s.createTriggerBody.parse(req.body) as CreateTriggerBody);
    return reply.code(201).header('cache-control', 'no-store').send(res);
  });
  app.get('/triggers/:id', async (req) => svc.getTrigger(ctx, idParams.parse(req.params).id));
  app.patch('/triggers/:id', async (req) => svc.updateTrigger(ctx, idParams.parse(req.params).id, s.updateTriggerBody.parse(req.body ?? {}) as UpdateTriggerBody));
  app.delete('/triggers/:id', async (req, reply) => {
    await svc.deleteTrigger(ctx, idParams.parse(req.params).id);
    return reply.code(204).send();
  });
  app.post('/triggers/:id/rotate-secret', async (req, reply) => {
    const res = await svc.rotateSecret(ctx, idParams.parse(req.params).id);
    return reply.header('cache-control', 'no-store').send(res);
  });
  app.post('/triggers/:id/test', async (req) => svc.testTrigger(ctx, idParams.parse(req.params).id, s.testTriggerBody.parse(req.body ?? {}).payload));
  app.get('/triggers/:id/fires', async (req) => svc.listFires(ctx, idParams.parse(req.params).id, s.firesQuery.parse(req.query ?? {}).limit));
}
