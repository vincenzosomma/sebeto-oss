/**
 * Hand-maintained OpenAPI 3.1 description of /api/v1 (docs/15 Architecture Review.md, item 19).
 * Keep in sync with packages/shared/src/api.ts and api/routes.ts (a test checks every route is listed).
 */
import { securityOpenApiPaths, securityOpenApiSchemas } from './security-routes.js';
import { memoryOpenApiPaths, memoryOpenApiSchemas } from './memory-routes.js';
import { costOpenApiPaths, costOpenApiSchemas } from './cost-routes.js';
import { aiConnectionOpenApiPaths, aiConnectionOpenApiSchemas } from './ai-connection-routes.js';
import { backupOpenApiPaths, backupOpenApiSchemas } from './backup-routes.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const num = { type: 'number' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
/** v0.4 F/G team AI fields (teams.ts TeamAiFields). */
const teamAi = { runtime: { type: ['string', 'null'] }, model: { type: ['string', 'null'] }, lockRuntime: bool, requireScope: bool } as const;
const date = { type: 'string', format: 'date-time' } as const;
const ndate = { type: ['string', 'null'], format: 'date-time' } as const;
const arr = (items: object) => ({ type: 'array', items });
const obj = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});

const ticketStatus = { type: 'string', enum: ['backlog', 'in_progress', 'needs_you', 'blocked', 'done'] };
const permKey = { type: 'string', enum: ['fs.read', 'fs.write', 'web.read', 'email.read', 'email.send', 'tool.read', 'tool.change', 'script.run', 'prod.change', 'memory.read', 'memory.write'] };
const permLevel = { type: 'string', enum: ['allow', 'ask', 'never'] };
const permMap = { type: 'object', additionalProperties: permLevel, propertyNames: permKey };

const teamDefault = { type: 'string', enum: ['manual', 'auto'] };
const teamChoice = { type: ['string', 'null'], description: "A team id, 'auto' (route it) or null (no team)" };
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const ok = (schema: object, description = 'OK') => ({ description, ...json(schema) });
const errors = {
  '400': { description: 'Invalid request', ...json(ref('ApiError')) },
  '401': { description: 'Missing or invalid token', ...json(ref('ApiError')) },
  '403': { description: 'Host or Origin not allowed', ...json(ref('ApiError')) },
  '404': { description: 'Not found', ...json(ref('ApiError')) },
  '409': { description: 'Conflict', ...json(ref('ApiError')) },
};
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const body = (schema: object) => ({ required: true, ...json(schema) });
const op = (summary: string, extra: object) => ({ summary, responses: { ...errors }, ...extra });
const withResponses = (summary: string, responses: object, extra: object = {}) => ({
  summary,
  ...extra,
  responses: { ...responses, ...errors },
});

export function openApiSpec(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Sebeto core API',
      version,
      description:
        'Local API of sebeto-core. Every request needs `Authorization: Bearer <token>`; the WebSocket event stream uses `?token=`.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearer: [] }],
    paths: {
      '/health': { get: withResponses('Health check', { '200': ok(ref('HealthResponse')) }) },
      '/openapi.json': { get: withResponses('This document', { '200': ok({ type: 'object' }) }) },
      '/tickets': {
        get: withResponses('List tickets (newest activity first, cursor paginated)', { '200': ok(ref('TicketPage')) }, {
          parameters: [
            { name: 'status', in: 'query', schema: ticketStatus },
            { name: 'q', in: 'query', schema: str, description: 'Full-text search over title, goal and messages' },
            { name: 'cursor', in: 'query', schema: str },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
            { name: 'teamId', in: 'query', schema: str, description: "A team id, or 'none' for tickets without a team" },
          ],
        }),
        post: withResponses('Create a ticket (optionally start a run; with start, 409 lockdown during the emergency stop)', { '201': ok(ref('Ticket'), 'Created') }, {
          requestBody: body(ref('CreateTicketBody')),
        }),
      },
      '/tickets/{id}': {
        get: withResponses('Ticket with messages, events, permissions and runs', { '200': ok(ref('TicketDetail')) }, { parameters: [idParam] }),
        patch: withResponses('Update ticket fields', { '200': ok(ref('Ticket')) }, {
          parameters: [idParam],
          requestBody: body(ref('UpdateTicketBody')),
        }),
        delete: withResponses('Move the ticket to Deleted tickets (restorable)', { '200': ok(ref('Ticket')) }, { parameters: [idParam] }),
      },
      '/tickets/{id}/move': {
        post: withResponses('Move a ticket to another column (user override)', { '200': ok(ref('Ticket')) }, {
          parameters: [idParam],
          requestBody: body(obj({ status: ticketStatus, note: str }, ['status'])),
        }),
      },
      '/tickets/{id}/messages': {
        post: withResponses('Post a message to the agent (enqueues a reply run; 409 lockdown during the emergency stop)', { '201': ok(ref('Message'), 'Created') }, {
          parameters: [idParam],
          requestBody: body(obj({ text: str, attachments: { type: 'array', items: str } })),
        }),
      },
      '/tickets/{id}/attachments': {
        post: withResponses('Attach a file in the chat (base64, max 20 MB; saved in the ticket folder under attachments/; images, PDF, text, logs, Office)', { '201': ok(obj({ name: str, path: str, size: { type: 'integer' }, type: str }), 'Created') }, {
          parameters: [idParam],
          requestBody: body(obj({ name: str, data: str }, ['name', 'data'])),
        }),
      },
      '/tickets/{id}/attachments/{name}': {
        get: withResponses('One attached file (for previews and downloads)', { '200': { description: 'The file' } }, { parameters: [idParam, { name: 'name', in: 'path', required: true, schema: str }] }),
      },
      '/tickets/{id}/start': {
        post: withResponses('Enqueue a run (409 lockdown during the emergency stop)', { '202': ok(obj({ ok: bool, jobId: str }), 'Accepted') }, { parameters: [idParam] }),
      },
      '/tickets/{id}/cancel': {
        post: withResponses('Cancel the active run', { '200': ok(obj({ ok: bool, cancelled: bool })) }, { parameters: [idParam] }),
      },
      '/tickets/{id}/scope': {
        put: withResponses('Attach the owner\'s written scope (v0.4 G; refused while the agent runs)', { '200': ok(ref('Ticket')) }, {
          parameters: [idParam], requestBody: body(obj({ text: str, fileName: nstr, confirm: bool }, ['text', 'confirm'])),
        }),
        delete: withResponses('Remove the written scope', { '200': ok(ref('Ticket')) }, { parameters: [idParam] }),
      },
      '/tickets/{id}/route': {
        post: withResponses('Route the ticket automatically (rules, then the Chief of Staff); sets the team, and the agent while no session has started', {
          '200': ok(obj({ ticket: ref('Ticket'), decision: ref('RouteDecision') })),
        }, { parameters: [idParam] }),
      },
      '/routing/preview': {
        post: withResponses('Preview the automatic routing of a ticket (no side effects)', { '200': ok(ref('RouteDecision')) }, {
          requestBody: body(obj({ title: str, goal: str, tags: arr(str), projectId: nstr, rulesOnly: bool }, ['title', 'goal'])),
        }),
      },
      '/teams': {
        get: withResponses('Teams with their members', { '200': ok(arr(ref('Team'))) }),
        post: withResponses('Create a team (the lead joins the team)', { '201': ok(ref('Team'), 'Created') }, {
          requestBody: body(obj({ name: str, slug: str, description: str, color: str, leadAgentId: nstr, routingHints: str, ...teamAi, claudeConnectors: arr(str) }, ['name'])),
        }),
      },
      '/teams/{id}': {
        patch: withResponses('Rename, change colour, lead, routing hints or the team AI and its lock (v0.4 F)', { '200': ok(ref('Team')) }, {
          parameters: [idParam], requestBody: body(obj({ name: str, description: str, color: str, leadAgentId: nstr, routingHints: str, ...teamAi, claudeConnectors: arr(str), applyToMembers: bool }, [])),
        }),
        delete: withResponses('Delete a team (agents and tickets stay, without a team)', { '204': { description: 'Deleted' } }, { parameters: [idParam] }),
      },
      '/tickets/{id}/undo': {
        post: withResponses('Restore the ticket folder to the snapshot taken before a run', { '200': ok(obj({ ok: bool, snapshot: str })) }, {
          parameters: [idParam],
          requestBody: body(obj({ runId: str })),
        }),
      },
      '/permissions/{id}/decide': {
        post: withResponses('Allow once, always allow (plain system commands only) or deny a pending permission request (409 lockdown during the emergency stop)', { '200': ok(ref('PermissionRequest')) }, {
          parameters: [idParam],
          requestBody: body(obj({ decision: { type: 'string', enum: ['allow', 'deny', 'always', 'task', 'team'] } })),
        }),
      },
      '/projects': {
        get: withResponses('Projects with ticket counts and cost', { '200': ok(arr(ref('Project'))) }),
        post: withResponses('Create a project', { '201': ok(ref('Project'), 'Created') }, { requestBody: body(obj({ name: str, description: str, color: str }, ['name'])) }),
      },
      '/projects/{id}': {
        patch: withResponses('Rename, change the brief or colour, archive', { '200': ok(ref('Project')) }, { parameters: [idParam], requestBody: body(obj({ name: str, description: str, color: str, archived: bool }, [])) }),
        delete: withResponses('Delete a project (its tickets stay, without a project)', { '204': { description: 'Deleted' } }, { parameters: [idParam] }),
      },
      '/tags': {
        get: withResponses('Tags in use with ticket counts', { '200': ok(arr(obj({ tag: str, count: int }))) }),
      },
      '/sessions': {
        get: withResponses('Session library: Sebeto and Claude Code sessions (latest activity first, cursor paginated)', { '200': ok(ref('SessionEntryPage')) }, {
          parameters: [
            { name: 'q', in: 'query', schema: str },
            { name: 'category', in: 'query', schema: str, description: "Exact category; '-' = not categorised" },
            { name: 'source', in: 'query', schema: { type: 'string', enum: ['sebeto', 'claude-code'] } },
            { name: 'cursor', in: 'query', schema: str },
            { name: 'limit', in: 'query', schema: int },
          ],
        }),
      },
      '/sessions/categories': {
        get: withResponses('Categories in use with entry counts', { '200': ok(arr(obj({ category: str, count: int }))) }),
      },
      '/sessions/scan': {
        post: withResponses('Find Claude Code sessions on this computer (read-only)', { '200': ok(obj({ found: int, added: int, updated: int, skipped: int })) }),
      },
      '/sessions/suggest-categories': {
        post: withResponses('v0.5 K: suggest categories for uncategorised entries (rules = free; ai = Chief of Staff, cost-capped). Preview unless dryRun is false', {
          '200': ok(obj({
            mode: { type: 'string', enum: ['ai', 'rules'] }, dryRun: bool, considered: int, applied: int, modelCalls: int, costUsd: num, maxCostUsd: num,
            choices: arr(str), error: nstr,
            skipped: obj({ locked: int, noMatch: int, invalid: int, budget: int }),
            suggestions: arr(obj({ entryId: str, title: str, current: str, category: str, source: { type: 'string', enum: ['auto', 'rules'] }, reason: str })),
          })),
          '409': { description: 'Emergency stop is on (ai mode)' },
        }, {
          requestBody: { required: false, ...json(obj({
            mode: { type: 'string', enum: ['ai', 'rules'] }, dryRun: bool, maxCostUsd: num, limit: int, ids: arr(str),
          }, [])) },
        }),
      },
      '/sessions/apply-categories': {
        post: withResponses('v0.5 K: apply the suggestions the owner kept (no AI; never over the owner\'s own categories)', {
          '200': ok(obj({ applied: int, skipped: int })),
        }, {
          requestBody: body(obj({ items: arr(obj({ id: str, category: str, source: { type: 'string', enum: ['auto', 'rules'] } })) })),
        }),
      },
      '/sessions/{id}': {
        get: withResponses('One library entry', { '200': ok(ref('SessionEntry')) }, { parameters: [idParam] }),
        patch: withResponses('Edit title, summary, category, tags or pin', { '200': ok(ref('SessionEntry')) }, {
          parameters: [idParam], requestBody: body(obj({ title: str, summary: str, category: str, tags: arr(str), pinned: bool }, [])),
        }),
        delete: withResponses('Remove from the library (never deletes files or tickets)', { '204': { description: 'Removed' } }, { parameters: [idParam] }),
      },
      '/sessions/{id}/transcript': {
        get: withResponses('Read-only preview of the last turns', { '200': ok(obj({
          entryId: str, truncated: bool,
          turns: arr(obj({ role: { type: 'string', enum: ['user', 'agent', 'tool', 'system'] }, text: str, at: ndate })),
        })) }, { parameters: [idParam, { name: 'limit', in: 'query', schema: int }] }),
      },
      '/sessions/{id}/open': {
        post: withResponses('Open: a Claude Code session becomes a new ticket that resumes it; a Completed ticket is reopened', {
          '201': ok(obj({ ticket: ref('Ticket'), action: { type: 'string', enum: ['created', 'reopened', 'existing'] } }), 'Opened'),
        }, { parameters: [idParam], requestBody: { required: false, ...json(obj({ agentId: nstr, teamId: nstr, projectId: nstr, title: str }, [])) } }),
      },
      '/skills': {
        get: withResponses('The skill library (SKILL.md folders)', { '200': ok(arr(ref('Skill'))) }),
        post: withResponses('Create a skill (slug derived from the name)', { '201': ok(ref('Skill'), 'Created') }, { requestBody: body(ref('SkillBody')) }),
      },
      '/skills/{slug}': {
        put: withResponses('Update a skill', { '200': ok(ref('Skill')) }, { parameters: [{ name: 'slug', in: 'path', required: true, schema: str }], requestBody: body(ref('SkillBody')) }),
        delete: withResponses('Delete a skill and unassign it everywhere', { '204': { description: 'Deleted' } }, { parameters: [{ name: 'slug', in: 'path', required: true, schema: str }] }),
      },
      '/agents/{id}/skills': {
        put: withResponses("Replace an agent's skills", { '200': ok(ref('Agent')) }, { parameters: [idParam], requestBody: body(obj({ skills: arr(str) })) }),
      },
      '/templates': {
        get: withResponses('Team templates: built-in first, then saved ones', { '200': ok(arr(ref('TeamTemplate'))) }),
        post: withResponses('Save a team template (id derived from the name; never built in)', { '201': ok(ref('TeamTemplate'), 'Created') }, { requestBody: body(ref('TeamTemplate')) }),
      },
      '/templates/{id}': {
        delete: withResponses('Delete a saved team template (built-in ones: 409)', { '204': { description: 'Deleted' } }, { parameters: [idParam] }),
      },
      '/templates/apply': {
        post: withResponses('Add a team: create its missing skills and its agents (managers first, names made unique)', { '201': ok(ref('ApplyTemplateResponse'), 'Created') }, {
          requestBody: body(obj({ templateId: str, template: ref('TeamTemplate'), reportsTo: nstr }, [])),
        }),
      },
      '/templates/export': {
        get: withResponses('Export the team (or the listed agents and everyone below them) as a team template', { '200': ok(ref('TeamTemplate')) }, {
          parameters: [{ name: 'agentIds', in: 'query', required: false, description: 'Comma-separated agent ids', schema: str }],
        }),
      },
      '/settings': {
        get: withResponses('Workspace settings', { '200': ok(ref('AppSettings')) }),
        patch: withResponses('Change workspace settings', { '200': ok(ref('AppSettings')) }, { requestBody: body(obj({ intakeModel: nstr, setupCompleted: bool, newTicketTeam: teamDefault, autoTags: bool, budgetBlocks: bool, claudeConnectorsAllAgents: arr(str), claudeLookupTools: arr(str) }, [])) }),
      },
      '/intake': {
        post: withResponses('One turn of the intake chat: the Chief of Staff replies and may propose tickets (nothing is created)', { '200': ok(ref('IntakeTurnResponse')) }, {
          requestBody: body(obj({ messages: arr(ref('IntakeMessage')), model: nstr }, ['messages'])),
        }),
      },
      '/intake/accept': {
        post: withResponses('Create the accepted (possibly edited) proposals, in order (with start, 409 lockdown during the emergency stop)', { '201': ok(obj({ tickets: arr(ref('Ticket')) }), 'Created') }, {
          requestBody: body(obj({ proposals: arr(ref('ProposedTicket')), start: bool }, ['proposals'])),
        }),
      },
      '/connectors': {
        get: withResponses('Connectors catalog and installed connectors (no secret values)', { '200': ok(obj({ catalog: arr({ type: 'object' }), installed: arr(ref('ConnectorInfo')) })) }),
        post: withResponses('Add a preset connector or your own MCP server; starts it and lists its tools (all unreviewed)', { '201': ok(ref('ConnectorInfo'), 'Created') }, {
          requestBody: body({ type: 'object' }),
        }),
      },
      '/connectors/{id}': {
        patch: withResponses('Rename, enable/disable, limit to agents, or review tool levels', { '200': ok(ref('ConnectorInfo')) }, { parameters: [idParam], requestBody: body({ type: 'object' }) }),
        delete: withResponses('Remove a connector and its stored secrets', { '204': { description: 'Removed' } }, { parameters: [idParam] }),
      },
      '/connectors/{id}/refresh': {
        post: withResponses('Reconnect and list the tools again (changed tools need a new review)', { '200': ok(ref('ConnectorInfo')) }, { parameters: [idParam] }),
      },
      '/connectors/oauth': {
        get: withResponses('Sign-in apps for Microsoft and Google (built-in, your organization\'s, or none)', { '200': ok(arr({ type: 'object' })) }),
      },
      '/connectors/oauth/{provider}': {
        put: withResponses("Set (or clear with an empty clientId) your organization's sign-in app", { '200': ok({ type: 'object' }) }, {
          parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['microsoft', 'google'] } }], requestBody: body({ type: 'object' }),
        }),
      },
      '/connectors/oauth/{provider}/start': {
        post: withResponses('Start "Sign in with Microsoft/Google": returns the URL to open in the browser', { '200': ok(obj({ authUrl: str })) }, {
          parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['microsoft', 'google'] } }],
        }),
      },
      '/connectors/mail': {
        get: withResponses('Mail connector status (never includes the password)', { '200': ok(ref('MailConnectorStatus')) }),
        put: withResponses('Connect a mailbox: logs in to IMAP and SMTP first, then stores the password encrypted on this computer', { '200': ok(ref('MailConnectorStatus')) }, {
          requestBody: body(ref('ConnectMailBody')),
        }),
        delete: withResponses('Disconnect the mailbox and delete the stored password', { '204': { description: 'Disconnected' } }),
      },
      '/trusted-commands': {
        get: withResponses('List the commands the owner always allows', { '200': ok(arr(ref('TrustedCommand'))) }),
      },
      '/trusted-commands/{id}': {
        delete: withResponses('Stop trusting a command (it will ask again)', { '204': { description: 'Removed' } }, { parameters: [idParam] }),
      },
      '/agents': {
        get: withResponses('List agents', { '200': ok(arr(ref('Agent'))) }),
        post: withResponses('Create an agent', { '201': ok(ref('Agent'), 'Created') }, { requestBody: body(ref('CreateAgentBody')) }),
      },
      '/agents/{id}': {
        patch: withResponses('Update an agent', { '200': ok(ref('Agent')) }, {
          parameters: [idParam],
          requestBody: body(ref('UpdateAgentBody')),
        }),
        delete: withResponses(
          'Delete an agent: open tickets move to the default agent, direct reports move up to its manager, connector access and skills are removed. 409 agent_busy while it is running, 409 last_agent for the only agent.',
          { '200': ok(obj({ ok: { type: 'boolean', const: true }, reassignedTickets: int, movedReports: int })) },
          { parameters: [idParam] },
        ),
      },
      '/tickets/{id}/restore': { post: withResponses('Restore a ticket from Deleted tickets', { '200': ok({ type: 'object' }) }) },
      '/tickets/{id}/permanent': { delete: withResponses('Delete forever a ticket that is in Deleted tickets (with its folder)', { '204': { description: 'Deleted' } }) },
      '/runtimes': { get: withResponses('Enabled runtimes with detection and models', { '200': ok(arr(ref('RuntimeInfo'))) }) },
      '/runtimes/claude-cli/connectors': { get: withResponses("The owner's Claude connectors (claude mcp list) that Claude Code agents may be given", { '200': ok(arr({ type: 'object' })) }) },
      '/diagnostics': {
        get: withResponses('Redacted diagnostics report for bug reports (versions, counts, recent problems; no ticket text, emails shortened, no keys or passwords)', {
          '200': ok({ type: 'object', description: 'DiagnosticsReport (packages/shared/src/api.ts), format "sebeto-diagnostics/1"' }),
        }, {
          parameters: [{ name: 'download', in: 'query', required: false, schema: { type: 'string', enum: ['1'] }, description: 'Send as a file (content-disposition: attachment)' }],
        }),
      },
      '/triggers': {
        get: withResponses('Triggers (webhook / mail rule / schedule); secrets are never returned', { '200': ok(arr(ref('Trigger'))) }),
        post: withResponses('Create a trigger. The webhook secret is in the response ONCE', { '201': ok(obj({ trigger: ref('Trigger'), secret: nstr }), 'Created') }, { requestBody: body(ref('CreateTriggerBody')) }),
      },
      '/triggers/{id}': {
        get: withResponses('One trigger', { '200': ok(ref('Trigger')) }, { parameters: [idParam] }),
        patch: withResponses('Rename, turn on/off, change config, blueprint or dedupe window (the kind cannot change)', { '200': ok(ref('Trigger')) }, { parameters: [idParam], requestBody: body({ type: 'object' }) }),
        delete: withResponses('Delete a trigger (its tickets stay)', { '204': { description: 'Deleted' } }, { parameters: [idParam] }),
      },
      '/triggers/{id}/rotate-secret': {
        post: withResponses('New webhook secret (shown once); the old one stops working', { '200': ok(obj({ secret: str })) }, { parameters: [idParam] }),
      },
      '/triggers/{id}/test': {
        post: withResponses('Dry run: the ticket a payload WOULD create (creates nothing)', { '200': ok(ref('TriggerTestResult')) }, { parameters: [idParam], requestBody: body(obj({ payload: {} }, [])) }),
      },
      '/triggers/{id}/fires': {
        get: withResponses('Recent fires, newest first (accepted and rejected)', { '200': ok(arr(ref('TriggerFire'))) }, {
          parameters: [idParam, { name: 'limit', in: 'query', required: false, schema: int }],
        }),
      },
      '/hooks/{id}': {
        post: {
          summary: 'Webhook: an alert or message from outside. No session token: send the trigger secret as `Authorization: Bearer <secret>` or `X-Sebeto-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`. JSON only, max 256 KB, 60 calls/minute.',
          security: [],
          parameters: [idParam],
          requestBody: body({ type: 'object' }),
          responses: {
            '202': ok(obj({ outcome: { type: 'string', enum: ['created', 'commented', 'ignored', 'error'] }, ticketNumber: int }, ['outcome']), 'Accepted'),
            '401': { description: 'Missing or wrong secret / signature', ...json(ref('ApiError')) },
            '404': { description: 'Unknown or turned-off hook', ...json(ref('ApiError')) },
            '413': { description: 'Body larger than 256 KB', ...json(ref('ApiError')) },
            '415': { description: 'Not JSON', ...json(ref('ApiError')) },
            '429': { description: 'More than 60 calls a minute', ...json(ref('ApiError')) },
            '503': { description: 'Emergency stop is on', ...json(ref('ApiError')) },
          },
        },
      },
      ...securityOpenApiPaths,
      ...memoryOpenApiPaths,
      ...costOpenApiPaths,
      ...aiConnectionOpenApiPaths,
      ...backupOpenApiPaths,
      '/events': {
        get: op('WebSocket stream of WsEvent JSON messages (upgrade required)', {
          parameters: [{ name: 'token', in: 'query', required: true, schema: str }],
          security: [],
        }),
      },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ...securityOpenApiSchemas,
        ...memoryOpenApiSchemas,
        ...costOpenApiSchemas,
        ...aiConnectionOpenApiSchemas,
        ...backupOpenApiSchemas,
        ApiError: obj({ error: obj({ code: str, message: str }) }),
        Trigger: obj({
          id: str, name: str, kind: { type: 'string', enum: ['webhook', 'mail', 'schedule', 'slack', 'jira'] }, enabled: bool, config: { type: 'object' },
          blueprint: ref('TicketBlueprint'), dedupeWindowMinutes: int, hookPath: nstr, hasSecret: bool, lastFiredAt: ndate, fireCount: int,
          createdAt: date, updatedAt: date,
        }),
        TicketBlueprint: obj({
          title: str, goal: str, teamId: { type: ['string', 'null'], description: 'A team id, null, or "auto"' }, agentId: nstr, projectId: nstr,
          tags: arr(str), costCapUsd: { type: ['number', 'null'] }, autoStart: bool,
        }, ['title', 'goal']),
        CreateTriggerBody: obj({
          name: str,
          config: { type: 'object', description: '{kind:"webhook",preset,dedupeField?,ignoreResolved} | {kind:"mail",from,subjectContains,folder,pollMinutes} | {kind:"schedule",cron}' },
          blueprint: ref('TicketBlueprint'), dedupeWindowMinutes: int, enabled: bool,
        }, ['name', 'config', 'blueprint']),
        TriggerFire: obj({
          id: str, triggerId: str, at: date, outcome: { type: 'string', enum: ['created', 'commented', 'ignored', 'rejected', 'error'] },
          ticketId: nstr, ticketNumber: { type: ['integer', 'null'] }, detail: str,
        }),
        TriggerTestResult: obj({
          outcome: str, title: str, goal: str, teamId: nstr, agentId: nstr, tags: arr(str), detail: str,
        }),
        HealthResponse: obj({ ok: { const: true }, version: str, workspace: str }),
        Ticket: obj({
          id: str, number: int, title: str, goal: str, status: ticketStatus, agentId: nstr, runtime: nstr, model: nstr,
          currentSessionId: nstr, folder: str, costCapUsd: num, costUsd: num, parentId: nstr, dependsOn: arr(str),
          projectId: nstr, tags: arr(str), teamId: nstr,
          scope: { oneOf: [obj({ text: str, fileName: nstr, sha256: str, confirmedAt: date }), { type: 'null' }], description: 'Written scope confirmed by the owner (v0.4 G)' },
          createdAt: date, updatedAt: date,
          lastActivity: { oneOf: [obj({ summary: str, at: date }), { type: 'null' }], description: 'Latest audit event of the ticket' },
        }, ['id', 'number', 'title', 'goal', 'status', 'agentId', 'runtime', 'model', 'currentSessionId', 'folder', 'costCapUsd',
          'costUsd', 'parentId', 'dependsOn', 'createdAt', 'updatedAt']),
        TicketPage: obj({ items: arr(ref('Ticket')), nextCursor: nstr }),
        TicketDetail: obj({
          ticket: ref('Ticket'), messages: arr(ref('Message')), events: arr(ref('AuditEvent')),
          permissions: arr(ref('PermissionRequest')), runs: arr(ref('Run')),
          children: arr(ref('Ticket')), parent: ref('Ticket'),
          agentBudget: obj({ agentId: str, name: str, monthlyBudgetUsd: num, spentUsd: num }),
        }, ['ticket', 'messages', 'events', 'permissions', 'runs']),
        CreateTicketBody: obj({
          title: str, goal: str, agentId: nstr, runtime: nstr, model: nstr, costCapUsd: num, dependsOn: arr(str), parentId: nstr,
          projectId: nstr, tags: arr(str), teamId: teamChoice, start: bool,
        }, ['title', 'goal']),
        UpdateTicketBody: obj({ title: str, goal: str, agentId: nstr, costCapUsd: num, projectId: nstr, tags: arr(str), teamId: teamChoice }, []),
        Message: obj({
          id: str, ticketId: str, runId: nstr, role: { type: 'string', enum: ['user', 'agent', 'handoff', 'system'] }, author: str, text: str, createdAt: date,
        }),
        AuditEvent: obj({
          id: str, ticketId: str, runId: nstr,
          kind: { type: 'string', enum: ['tool', 'status', 'permission', 'snapshot', 'error', 'cost', 'info'] },
          summary: str, data: { type: ['object', 'null'] }, createdAt: date,
        }),
        PermissionRequest: obj({
          id: str, ticketId: str, runId: nstr, agentId: nstr, key: permKey, title: str, detail: str, provenance: nstr,
          command: { oneOf: [ref('CommandSpec'), { type: 'null' }] },
          state: { type: 'string', enum: ['pending', 'allowed', 'denied'] }, alwaysAllowed: bool, taskScoped: bool, createdAt: date, decidedAt: ndate,
        }),
        CommandSpec: obj({ shell: str, command: str }),
        IntakeMessage: obj({ role: { type: 'string', enum: ['user', 'assistant'] }, text: str }),
        ProposedTicket: obj({ key: str, title: str, goal: str, agentId: nstr, teamId: nstr, costCapUsd: num, dependsOn: arr(str), why: str }, ['key', 'title', 'goal', 'agentId', 'costCapUsd', 'dependsOn']),
        IntakeTurnResponse: obj({ reply: str, proposals: arr(ref('ProposedTicket')), costUsd: num, model: nstr }),
        Project: obj({ id: str, name: str, description: str, color: str, archived: bool, createdAt: date, updatedAt: date }),
        AppSettings: obj({ intakeModel: nstr, setupCompleted: bool, newTicketTeam: teamDefault, autoTags: bool, budgetBlocks: bool, claudeConnectorsAllAgents: arr(str), claudeLookupTools: arr(str) }, ['intakeModel', 'setupCompleted']),
        Team: obj({
          id: str, slug: str, name: str, description: str, color: str, leadAgentId: nstr, routingHints: str, memberIds: arr(str),
          runtime: nstr, model: nstr, lockRuntime: bool, requireScope: bool, claudeConnectors: arr(str), createdAt: date, updatedAt: date,
        }),
        RouteDecision: obj({
          teamId: nstr, agentId: nstr, reason: str, by: { type: 'string', enum: ['rules', 'chief-of-staff', 'fallback'] }, confidence: num,
        }),
        SessionEntry: obj({
          id: str, source: { type: 'string', enum: ['sebeto', 'claude-code'] }, externalSessionId: nstr, sessionId: nstr, ticketId: nstr,
          ticketNumber: { type: ['integer', 'null'] }, title: str, summary: str, category: str,
          categorySource: { type: ['string', 'null'], enum: ['owner', 'auto', 'rules', null] }, tags: arr(str), cwd: nstr, runtime: nstr, model: nstr,
          messageCount: int, costUsd: num, startedAt: date, lastActivityAt: date, pinned: bool,
        }),
        SessionEntryPage: obj({ items: arr(ref('SessionEntry')), nextCursor: nstr }),
        Skill: obj({ slug: str, name: str, description: str, instructions: str, needs: arr(permKey), connectors: arr(str), files: arr(str), version: int, updatedAt: date, usedBy: arr(str) }),
        SkillBody: obj({ name: str, description: str, instructions: str, needs: arr(permKey), connectors: arr(str) }, ['name', 'description', 'instructions']),
        ConnectorInfo: obj({
          id: str, name: str, catalogId: str, transport: { type: 'object' }, settings: arr({ type: 'object' }), enabled: bool,
          allowedAgents: { type: ['array', 'null'], items: str }, tools: arr({ type: 'object' }),
          status: { type: 'string', enum: ['connected', 'error', 'disabled', 'not_started'] }, error: nstr, createdAt: date,
        }),
        MailServerSettings: obj({ imapHost: str, imapPort: int, smtpHost: str, smtpPort: int }),
        MailConnectorStatus: obj({
          connected: bool, provider: { type: 'string', enum: ['gmail', 'imap'] }, address: str, connectedAt: date, servers: ref('MailServerSettings'),
        }, ['connected']),
        ConnectMailBody: obj({
          provider: { type: 'string', enum: ['gmail', 'imap'] }, address: str, password: { type: 'string', format: 'password' },
          servers: obj({ imapHost: str, imapPort: int, smtpHost: str, smtpPort: int }, []),
        }, ['provider', 'address', 'password']),
        TrustedCommand: obj({ id: str, shell: str, command: str, requestId: nstr, createdAt: date }),
        Run: obj({
          id: str, sessionId: str, ticketId: str, jobId: nstr,
          trigger: { type: 'string', enum: ['start', 'user', 'heartbeat', 'message', 'permission'] },
          status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
          startedAt: date, endedAt: ndate, tokensIn: int, tokensOut: int, costUsd: num, exitReason: nstr, snapshotBefore: nstr, snapshotAfter: nstr,
        }),
        Agent: obj({
          id: str, name: str, role: str, job: str, runtime: str, model: nstr, reportsTo: nstr, heartbeatMinutes: int,
          monthlyBudgetUsd: num, permissions: permMap, paused: bool, createdAt: date, skills: arr(str), teamId: nstr,
        }, ['id', 'name', 'role', 'job', 'runtime', 'model', 'reportsTo', 'heartbeatMinutes', 'monthlyBudgetUsd', 'permissions', 'paused', 'createdAt', 'skills']),
        CreateAgentBody: obj({
          name: str, role: str, job: str, runtime: str, model: nstr, reportsTo: nstr, heartbeatMinutes: int, monthlyBudgetUsd: num, permissions: permMap, teamId: nstr,
        }, ['name']),
        UpdateAgentBody: obj({
          name: str, role: str, job: str, runtime: str, model: nstr, reportsTo: nstr, heartbeatMinutes: int, monthlyBudgetUsd: num, permissions: permMap, paused: bool, teamId: nstr,
        }, []),
        TemplateAgent: obj({
          key: str, name: str, role: str, job: str, reportsTo: nstr, runtime: nstr, model: nstr, heartbeatMinutes: int, monthlyBudgetUsd: num,
          permissions: permMap, skills: arr(str),
        }, ['key', 'name', 'role', 'job', 'reportsTo', 'skills']),
        TemplateSkill: obj({ slug: str, name: str, description: str, instructions: str, needs: arr(permKey), connectors: arr(str) }, ['slug', 'name', 'description', 'instructions']),
        TeamTemplate: obj({
          format: { type: 'string', const: 'sebeto-team/1' }, id: str, name: str, description: str, builtin: bool,
          agents: { ...arr(ref('TemplateAgent')), maxItems: 30 }, skills: { ...arr(ref('TemplateSkill')), maxItems: 50 }, suggestedConnectors: arr(str),
          team: obj({ name: str, slug: str, color: str, routingHints: str }, []),
        }, ['format', 'id', 'name', 'description', 'builtin', 'agents', 'skills']),
        ApplyTemplateResponse: obj({ agents: arr(ref('Agent')), skillsCreated: arr(str), skillsReused: arr(str), team: ref('Team'), warnings: arr(str) }, ['agents', 'skillsCreated', 'skillsReused']),
        RuntimeInfo: obj({
          id: str, displayName: str, models: arr(str),
          detection: obj({ installed: bool, version: str, loggedIn: bool, problem: str }, ['installed']),
        }),
      },
    },
  };
}
