/**
 * /api/v1/costs (v0.5 §L, contract packages/shared/src/costs.ts): the read-only cost dashboard.
 * Kept in its own file (zod schema + OpenAPI fragments) like security-routes.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COST_GROUP_BYS, MAX_COST_TOP_TICKETS, PLANNING_PURPOSES, type CostGroupBy } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { costsReport } from '../services/costs.js';

const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date').transform((s) => new Date(s).toISOString());
const idOrNone = z.string().min(1).max(100);
const groupBy = z.string().max(200).transform((s, c) => {
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (!COST_GROUP_BYS.includes(p as CostGroupBy)) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: `unknown groupBy "${p}"` });
      return z.NEVER;
    }
  }
  return parts as CostGroupBy[];
});

export const costsQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  groupBy: groupBy.optional(),
  projectId: idOrNone.optional(),
  teamId: idOrNone.optional(),
  top: z.coerce.number().int().min(1).max(MAX_COST_TOP_TICKETS).optional(),
}).strict();

export function registerCostRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/costs', async (req) => costsReport(ctx, costsQuery.parse(req.query ?? {})));
}

// ---------------------------------------------------------------- OpenAPI fragments (merged in openapi.ts)
const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const int = { type: 'integer' } as const;
const num = { type: 'number' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (items: object) => ({ type: 'array', items });
const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required });
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const q = (name: string, schema: object, description?: string) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const amounts = { costUsd: num, runs: int, tokensIn: int, tokensOut: int };
const numMap = { type: 'object', additionalProperties: num };

export const costOpenApiPaths = {
  '/costs': {
    get: {
      summary: 'Cost dashboard: totals, a daily series (UTC days), breakdowns, top tickets, the Chief of Staff by purpose, paid vs local split and this month\'s agent budgets. Counts agent runs and every Chief of Staff planning call (routing, intake chat, memory notes, session categories).',
      parameters: [
        q('from', date, 'Inclusive (default: 30 UTC days before "to")'),
        q('to', date, 'Exclusive (default: next UTC midnight)'),
        q('groupBy', str, `Comma-separated: ${COST_GROUP_BYS.join(', ')} (default: project, team, agent, runtime, model)`),
        q('projectId', str, 'A project id, or "none" for tickets without a project'),
        q('teamId', str, 'A team id, or "none" for tickets without a team'),
        q('top', { type: 'integer', minimum: 1, maximum: MAX_COST_TOP_TICKETS }, 'How many top tickets (default 10)'),
      ],
      responses: {
        '200': { description: 'OK', ...json(ref('CostsReport')) },
        '400': { description: 'Invalid request', ...json(ref('ApiError')) },
        '401': { description: 'Missing or invalid token', ...json(ref('ApiError')) },
        '403': { description: 'Host or Origin not allowed', ...json(ref('ApiError')) },
      },
    },
  },
};

export const costOpenApiSchemas = {
  CostGroup: obj({ key: nstr, label: nstr, ...amounts, paidUsd: num }),
  CostDay: obj({ day: str, ...amounts, byRuntime: numMap, byProject: numMap }),
  CostTicket: obj({
    ticketId: str, number: int, title: str, status: str, projectId: nstr, teamId: nstr, costUsd: num, planningUsd: num, runs: int,
  }),
  CostPlanningGroup: obj({
    purpose: { type: 'string', enum: [...PLANNING_PURPOSES] }, costUsd: num, paidUsd: num, calls: int, failed: int, tokensIn: int, tokensOut: int,
  }),
  CostsReport: obj({
    from: date, to: date, timezone: { const: 'UTC' },
    filters: obj({ projectId: nstr, teamId: nstr }),
    totals: obj({ ...amounts, tickets: int, planningUsd: num, planningCalls: int }),
    split: obj({ paid: obj(amounts), free: obj(amounts) }),
    days: arr(ref('CostDay')),
    groups: { type: 'object', properties: Object.fromEntries(COST_GROUP_BYS.map((g) => [g, arr(ref('CostGroup'))])), required: [] },
    topTickets: arr(ref('CostTicket')),
    planning: arr(ref('CostPlanningGroup')),
    budget: obj({
      month: str, limitUsd: num, spentUsd: num,
      agents: arr(obj({ agentId: str, name: str, monthlyBudgetUsd: num, spentUsd: num })),
    }),
    notCounted: arr(str),
  }),
};
