/** zod validators for request bodies/queries; shapes mirror packages/shared/src/api.ts. */
import { z } from 'zod';
import { teamTemplateSchema } from '../templates/schema.js';
import { MAX_SCOPE_CHARS, PERMISSION_KEYS, SUGGEST_MAX_COST_USD, SUGGEST_MAX_LIMIT, TICKET_STATUSES, type PermissionKey, type TicketStatus } from '@sebeto/shared';

const id = z.string().min(1).max(100);
const statusEnum = z.enum(TICKET_STATUSES as unknown as [TicketStatus, ...TicketStatus[]]);
const permKeyEnum = z.enum(PERMISSION_KEYS as unknown as [PermissionKey, ...PermissionKey[]]);
const runtimeId = z.string().min(1).max(64);
const money = z.number().finite().min(0).max(1_000_000);
/** v0.4: a team id, 'auto' (route it) or null (no team). */
const teamChoice = id.nullable().optional();

export const createTicketBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().max(20_000),
    agentId: id.nullable().optional(),
    runtime: runtimeId.nullable().optional(),
    model: z.string().max(200).nullable().optional(),
    costCapUsd: money.optional(),
    dependsOn: z.array(id).max(100).optional(),
    parentId: id.nullable().optional(),
    projectId: id.nullable().optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
    teamId: teamChoice,
    start: z.boolean().optional(),
  })
  .strict();

export const updateTicketBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    goal: z.string().max(20_000).optional(),
    agentId: id.nullable().optional(),
    costCapUsd: money.optional(),
    projectId: id.nullable().optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
    teamId: teamChoice,
  })
  .strict();

export const moveTicketBody = z.object({ status: statusEnum, note: z.string().max(2000).optional() }).strict();
export const postMessageBody = z.object({
  text: z.string().trim().max(50_000).default(''),
  attachments: z.array(z.string().min(1).max(200)).max(10).default([]),
}).strict().refine((b) => b.text.length > 0 || b.attachments.length > 0, { message: 'Write a message or attach a file', path: ['text'] });
export const attachmentBody = z.object({
  name: z.string().trim().min(1).max(200),
  /** The file, base64. */
  data: z.string().min(1).max(28 * 1024 * 1024),
}).strict();
export const undoBody = z.object({ runId: id }).strict();
export const decidePermissionBody = z.object({ decision: z.enum(['allow', 'deny', 'always', 'task', 'team']) }).strict();

export const listTicketsQuery = z.object({
  status: statusEnum.optional(),
  q: z.string().max(500).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  projectId: z.string().min(1).max(100).optional(),
  tag: z.string().min(1).max(64).optional(),
  teamId: z.string().min(1).max(100).optional(),
  deleted: z.enum(['true', 'false', '1', '0']).optional().transform((v) => v === 'true' || v === '1'),
});

const permissionsMap = z.partialRecord(permKeyEnum, z.enum(['allow', 'ask', 'never'])).optional();

const agentFields = {
  name: z.string().trim().min(1).max(100),
  role: z.string().max(200).optional(),
  job: z.string().max(20_000).optional(),
  runtime: runtimeId.optional(),
  model: z.string().max(200).nullable().optional(),
  reportsTo: id.nullable().optional(),
  heartbeatMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
  monthlyBudgetUsd: money.optional(),
  permissions: permissionsMap,
  teamId: id.nullable().optional(),
  claudeConnectors: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
};

export const createAgentBody = z.object(agentFields).strict();
export const updateAgentBody = z
  .object({ ...agentFields, name: agentFields.name.optional(), paused: z.boolean().optional() })
  .strict();

export const idParams = z.object({ id });

const intakeMessage = z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20_000) }).strict();
export const intakeTurnBody = z
  .object({ messages: z.array(intakeMessage).min(1).max(60), model: z.string().max(200).nullable().optional() })
  .strict();
const proposedTicket = z.object({
  key: z.string().trim().min(1).max(20),
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(20_000),
  agentId: id.nullable(),
  costCapUsd: money,
  dependsOn: z.array(z.string().max(20)).max(20),
  why: z.string().max(500).optional(),
  teamId: id.nullable().optional(),
}).strict();
export const intakeAcceptBody = z.object({ proposals: z.array(proposedTicket).min(1).max(20), start: z.boolean().optional(), projectId: id.nullable().optional() }).strict();

export const updateSettingsBody = z
  .object({
    intakeModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/).nullable().optional(),
    setupCompleted: z.boolean().optional(),
    newTicketTeam: z.enum(['manual', 'auto']).optional(),
    autoTags: z.boolean().optional(),
    budgetBlocks: z.boolean().optional(),
    claudeConnectorsAllAgents: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
    claudeLookupTools: z.array(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/)).max(100).optional(),
  })
  .strict();

// ---- v0.4 teams and routing (packages/shared/src/teams.ts)
const teamColor = z.string().max(9).optional();
/** v0.4 F/G: the team's AI and policies (TeamAiFields). */
const teamAiFields = {
  runtime: runtimeId.nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  lockRuntime: z.boolean().optional(),
  requireScope: z.boolean().optional(),
};
export const createTeamBody = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().max(63).optional(),
  description: z.string().max(2_000).optional(),
  color: teamColor,
  leadAgentId: id.nullable().optional(),
  routingHints: z.string().max(2_000).optional(),
  ...teamAiFields,
  claudeConnectors: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
}).strict();
export const updateTeamBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(2_000).optional(),
  color: teamColor,
  leadAgentId: id.nullable().optional(),
  routingHints: z.string().max(2_000).optional(),
  ...teamAiFields,
  claudeConnectors: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  applyToMembers: z.boolean().optional(),
}).strict();
// ---- v0.4 G written scope (packages/shared/src/types.ts TicketScope)
export const setTicketScopeBody = z.object({
  text: z.string().min(1).max(MAX_SCOPE_CHARS),
  fileName: z.string().max(200).nullable().optional(),
  confirm: z.literal(true, { error: 'Tick "I confirm this scope is written and authorised"' }),
}).strict();
export const routePreviewBody = z.object({
  title: z.string().max(200),
  goal: z.string().max(20_000),
  tags: z.array(z.string().max(64)).max(20).optional(),
  projectId: id.nullable().optional(),
  rulesOnly: z.boolean().optional(),
}).strict();

const connectorTransport = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1).max(500), args: z.array(z.string().max(2000)).max(50) }).strict(),
  z.object({ type: z.literal('http'), url: z.string().min(8).max(2000) }).strict(),
]);
const connectorSetting = z.object({ name: z.string().min(1).max(64), secret: z.boolean(), value: z.string().max(10_000).optional() }).strict();
export const addConnectorBody = z.object({
  name: z.string().trim().min(1).max(60),
  catalogId: z.string().min(1).max(40),
  values: z.record(z.string().max(40), z.string().max(2000)).optional(),
  transport: connectorTransport.optional(),
  settings: z.array(connectorSetting).max(30).optional(),
  allowedAgents: z.array(id).max(200).nullable().optional(),
}).strict();
export const secretNameParams = z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) });
export const secretValueBody = z.object({ value: z.string().max(2000) }).strict();
export const updateConnectorBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  allowedAgents: z.array(id).max(200).nullable().optional(),
  tools: z.array(z.object({ name: z.string().min(1).max(200), level: z.enum(['read', 'change', 'production', 'off']) }).strict()).max(500).optional(),
}).strict();

export const skillBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  instructions: z.string().min(1).max(20_000),
  needs: z.array(permKeyEnum).max(20).optional(),
  connectors: z.array(z.string().max(60)).max(20).optional(),
}).strict();
export const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) });
export const assignSkillsBody = z.object({ skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)).max(50) }).strict();

export const oauthProviderParams = z.object({ provider: z.enum(['microsoft', 'google']) });
export const setOAuthAppBody = z.object({
  clientId: z.string().max(200),
  tenant: z.string().max(100).optional(),
  clientSecret: z.string().max(500).optional(),
}).strict();

export const createProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(5_000).optional(),
  color: z.string().max(9).optional(),
}).strict();
export const updateProjectBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(5_000).optional(),
  color: z.string().max(9).optional(),
  archived: z.boolean().optional(),
}).strict();

export const connectMailBody = z
  .object({
    provider: z.enum(['gmail', 'imap']),
    address: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(500),
    servers: z.object({
      imapHost: z.string().max(253).optional(), imapPort: z.number().int().min(1).max(65535).optional(),
      smtpHost: z.string().max(253).optional(), smtpPort: z.number().int().min(1).max(65535).optional(),
    }).strict().optional(),
  })
  .strict();

// ---- team templates (packages/shared/src/templates.ts); the template itself is validated in templates/schema.ts
export { teamTemplateSchema as teamTemplateBody } from '../templates/schema.js';
export const applyTemplateBody = z.object({
  templateId: z.string().min(1).max(100).optional(),
  template: teamTemplateSchema.optional(),
  reportsTo: id.nullable().optional(),
  runtime: runtimeId.nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  lockRuntime: z.boolean().optional(),
}).strict().refine((b) => (b.templateId === undefined) !== (b.template === undefined), { message: 'Send either templateId or template' });
export const templateIdParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) });
export const exportTemplateQuery = z.object({
  agentIds: z.string().max(20_000).optional()
    .transform((v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(id).max(200)),
}).strict();

// ---- session library (v0.4 §A, packages/shared/src/sessions.ts)
export const listSessionsQuery = z.object({
  q: z.string().max(500).optional(),
  category: z.string().max(64).optional(),
  source: z.enum(['sebeto', 'claude-code']).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const transcriptQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });
export const updateSessionBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().max(2_000).optional(),
  category: z.string().max(64).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  pinned: z.boolean().optional(),
}).strict();
export const openSessionBody = z.object({
  agentId: id.nullable().optional(),
  teamId: id.nullable().optional(),
  projectId: id.nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
}).strict();
// v0.5 K auto-categorise
export const suggestCategoriesBody = z.object({
  mode: z.enum(['ai', 'rules']).optional(),
  dryRun: z.boolean().optional(),
  maxCostUsd: z.number().min(0).max(SUGGEST_MAX_COST_USD).optional(),
  limit: z.number().int().min(1).max(SUGGEST_MAX_LIMIT).optional(),
  ids: z.array(id).max(SUGGEST_MAX_LIMIT).optional(),
}).strict();
export const applyCategoriesBody = z.object({
  items: z.array(z.object({ id, category: z.string().trim().min(1).max(64), source: z.enum(['auto', 'rules']) }).strict()).max(SUGGEST_MAX_LIMIT),
}).strict();
