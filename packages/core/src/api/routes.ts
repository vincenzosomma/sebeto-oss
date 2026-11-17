/** /api/v1 routes. Handlers stay thin: validate, call a service, return JSON. */
import type { FastifyInstance } from 'fastify';
import type { ApplyTemplateBody, HealthResponse, RouteTicketResponse, StartTicketResponse, TeamTemplate } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import * as svc from '../services/index.js';
import * as s from './schemas.js';
import { openApiSpec } from './openapi.js';
import { registerTriggerRoutes } from '../triggers/routes.js';
import { registerSecurityRoutes } from './security-routes.js';
import { registerMemoryRoutes } from './memory-routes.js';
import { registerCostRoutes } from './cost-routes.js';
import { registerAiConnectionRoutes } from './ai-connection-routes.js';
import { registerBackupRoutes } from './backup-routes.js';
import { listClaudeConnectors } from '../runtimes/claude-cli.js';
import { AppError } from '../services/errors.js';

export function registerApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async (): Promise<HealthResponse> => ({ ok: true, version: ctx.config.version, workspace: ctx.config.workspaceDir }));

  app.get('/openapi.json', async () => openApiSpec(ctx.config.version));

  // ---- tickets
  app.get('/tickets', async (req) => svc.listTickets(ctx, s.listTicketsQuery.parse(req.query)));

  // "Deleted tickets": delete (restorable), restore, delete forever.
  app.delete('/tickets/:id', async (req) => svc.deleteTicket(ctx, s.idParams.parse(req.params).id));
  app.post('/tickets/:id/restore', async (req) => svc.restoreTicket(ctx, s.idParams.parse(req.params).id));
  app.delete('/tickets/:id/permanent', async (req, reply) => {
    await svc.purgeTicket(ctx, s.idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  app.post('/tickets', async (req, reply) => {
    const ticket = await svc.createTicket(ctx, s.createTicketBody.parse(req.body));
    return reply.code(201).send(ticket);
  });

  app.get('/tickets/:id', async (req) => svc.getTicketDetail(ctx, s.idParams.parse(req.params).id));

  app.patch('/tickets/:id', async (req) => svc.updateTicket(ctx, s.idParams.parse(req.params).id, s.updateTicketBody.parse(req.body ?? {})));

  app.post('/tickets/:id/move', async (req) => {
    const body = s.moveTicketBody.parse(req.body);
    return svc.moveTicket(ctx, s.idParams.parse(req.params).id, body.status, body.note);
  });

  app.post('/tickets/:id/messages', async (req, reply) => {
    const { text, attachments } = s.postMessageBody.parse(req.body);
    const id = s.idParams.parse(req.params).id;
    const names = svc.checkAttachmentNames(ctx, id, attachments);
    const full = `${text || 'See the attached file(s).'}${svc.attachmentNote(names)}`;
    const { message } = svc.postMessage(ctx, id, full);
    return reply.code(201).send(message);
  });

  // Chat attachments: saved in the ticket folder (attachments/), served back for previews.
  app.post('/tickets/:id/attachments', { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
    const { name, data } = s.attachmentBody.parse(req.body);
    return reply.code(201).send(svc.saveAttachment(ctx, s.idParams.parse(req.params).id, name, data));
  });

  app.get('/tickets/:id/attachments/:name', async (req, reply) => {
    const { id } = s.idParams.parse(req.params);
    const a = svc.readAttachment(ctx, id, String((req.params as { name?: unknown }).name ?? ''));
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)/.test(a.type);
    return reply
      .header('Content-Type', a.type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${a.name}"`)
      .send(a.data);
  });

  app.post('/tickets/:id/start', async (req, reply) => {
    const job = svc.startTicket(ctx, s.idParams.parse(req.params).id);
    const body: StartTicketResponse = job ? { ok: true, jobId: job.id, deferred: false } : { ok: true, jobId: null, deferred: true };
    return reply.code(202).send(body);
  });

  app.post('/tickets/:id/cancel', async (req) => {
    const cancelled = svc.cancelTicket(ctx, s.idParams.parse(req.params).id);
    return { ok: true, cancelled };
  });

  // v0.4 G: the owner's written scope (refused while the agent is running)
  app.put('/tickets/:id/scope', async (req) => svc.setTicketScope(ctx, s.idParams.parse(req.params).id, s.setTicketScopeBody.parse(req.body)));
  app.delete('/tickets/:id/scope', async (req) => svc.clearTicketScope(ctx, s.idParams.parse(req.params).id));

  app.post('/tickets/:id/route', async (req): Promise<RouteTicketResponse> => svc.routeTicket(ctx, s.idParams.parse(req.params).id));

  app.post('/tickets/:id/undo', async (req) => {
    const { runId } = s.undoBody.parse(req.body);
    const { snapshot } = await svc.undoRun(ctx, s.idParams.parse(req.params).id, runId);
    return { ok: true, snapshot };
  });

  // ---- permissions
  app.post('/permissions/:id/decide', async (req) => {
    const { decision } = s.decidePermissionBody.parse(req.body);
    return svc.decidePermission(ctx, s.idParams.parse(req.params).id, decision);
  });

  // ---- trusted commands ("Always allow this command")
  app.get('/trusted-commands', async () => svc.listTrustedCommands(ctx));

  app.delete('/trusted-commands/:id', async (req, reply) => {
    svc.removeTrustedCommand(ctx, s.idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  // ---- workspace settings
  app.get('/settings', async () => svc.getSettings(ctx));
  app.patch('/settings', async (req) => svc.updateSettings(ctx, s.updateSettingsBody.parse(req.body ?? {})));

  // ---- intake chat with the Chief of Staff
  app.post('/intake', async (req) => svc.intakeTurn(ctx, s.intakeTurnBody.parse(req.body)));

  app.post('/intake/accept', async (req, reply) => {
    const tickets = await svc.acceptIntake(ctx, s.intakeAcceptBody.parse(req.body));
    return reply.code(201).send({ tickets });
  });

  // ---- sign-in apps (Microsoft / Google); the browser comes back to GET /oauth/callback (server.ts)
  app.get('/connectors/oauth', async () => svc.oauthApps(ctx));
  app.put('/connectors/oauth/:provider', async (req) => svc.setOAuthApp(ctx, s.oauthProviderParams.parse(req.params).provider, s.setOAuthAppBody.parse(req.body)));
  app.post('/connectors/oauth/:provider/start', async (req) => svc.startOAuth(ctx, s.oauthProviderParams.parse(req.params).provider));

  // ---- connectors catalog + custom MCP servers (/connectors/mail below is the Gmail connector)
  app.get('/connectors', async () => svc.listConnectors(ctx));
  app.post('/connectors', async (req, reply) => reply.code(201).send(await svc.addConnector(ctx, s.addConnectorBody.parse(req.body))));
  app.patch('/connectors/:id', async (req) => svc.updateConnector(ctx, s.idParams.parse(req.params).id, s.updateConnectorBody.parse(req.body ?? {})));
  app.put('/connectors/:id/secrets/:name', async (req) => {
    const { id } = s.idParams.parse(req.params);
    const { name } = s.secretNameParams.parse(req.params);
    return svc.setConnectorSecret(ctx, id, name, s.secretValueBody.parse(req.body ?? {}).value);
  });
  app.post('/connectors/:id/refresh', async (req) => svc.refreshConnector(ctx, s.idParams.parse(req.params).id));
  app.delete('/connectors/:id', async (req, reply) => {
    await svc.removeConnector(ctx, s.idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  // ---- connectors (mail). The password goes in, never out.
  app.get('/connectors/mail', async () => svc.mailStatus(ctx));

  app.put('/connectors/mail', async (req) => svc.connectMail(ctx, s.connectMailBody.parse(req.body)));

  app.delete('/connectors/mail', async () => svc.disconnectMail(ctx));

  // ---- projects and tags
  app.get('/projects', async () => svc.listProjects(ctx));
  app.post('/projects', async (req, reply) => reply.code(201).send(svc.createProject(ctx, s.createProjectBody.parse(req.body))));
  app.patch('/projects/:id', async (req) => svc.updateProject(ctx, s.idParams.parse(req.params).id, s.updateProjectBody.parse(req.body ?? {})));
  app.delete('/projects/:id', async (req, reply) => {
    svc.deleteProject(ctx, s.idParams.parse(req.params).id);
    return reply.code(204).send();
  });
  app.get('/tags', async () => svc.listTags(ctx));

  // ---- session library (v0.4 §A): Sebeto + Claude Code sessions, agent memory
  app.get('/sessions', async (req) => svc.listSessions(ctx, s.listSessionsQuery.parse(req.query ?? {})));
  app.get('/sessions/categories', async () => svc.sessionCategories(ctx));
  app.post('/sessions/scan', async () => svc.scanSessions(ctx));
  // v0.5 K: auto-categorise (preview by default; apply what the owner kept)
  app.post('/sessions/suggest-categories', async (req) => svc.suggestSessionCategories(ctx, s.suggestCategoriesBody.parse(req.body ?? {})));
  app.post('/sessions/apply-categories', async (req) => svc.applySessionCategories(ctx, s.applyCategoriesBody.parse(req.body)));
  app.get('/sessions/:id', async (req) => svc.getSession(ctx, s.idParams.parse(req.params).id));
  app.get('/sessions/:id/transcript', async (req) =>
    svc.sessionTranscript(ctx, s.idParams.parse(req.params).id, s.transcriptQuery.parse(req.query ?? {}).limit));
  app.patch('/sessions/:id', async (req) => svc.updateSession(ctx, s.idParams.parse(req.params).id, s.updateSessionBody.parse(req.body ?? {})));
  app.post('/sessions/:id/open', async (req, reply) =>
    reply.code(201).send(await svc.openSession(ctx, s.idParams.parse(req.params).id, s.openSessionBody.parse(req.body ?? {}))));
  app.delete('/sessions/:id', async (req, reply) => {
    svc.deleteSession(ctx, s.idParams.parse(req.params).id);
    return reply.code(204).send();
  });
  // ---- v0.4 teams and routing
  app.get('/teams', async () => svc.listTeams(ctx));
  app.post('/teams', async (req, reply) => reply.code(201).send(await svc.createTeamChecked(ctx, s.createTeamBody.parse(req.body))));
  app.patch('/teams/:id', async (req) => svc.updateTeamChecked(ctx, s.idParams.parse(req.params).id, s.updateTeamBody.parse(req.body ?? {})));
  app.delete('/teams/:id', async (req, reply) => {
    svc.deleteTeam(ctx, s.idParams.parse(req.params).id);
    return reply.code(204).send();
  });
  app.post('/routing/preview', async (req) => svc.previewRoute(ctx, s.routePreviewBody.parse(req.body)));

  // ---- skills (SKILL.md library) and assignment to agents
  app.get('/skills', async () => svc.listSkills(ctx));
  app.post('/skills', async (req, reply) => reply.code(201).send(svc.createSkill(ctx, s.skillBody.parse(req.body))));
  app.put('/skills/:slug', async (req) => svc.updateSkill(ctx, s.slugParams.parse(req.params).slug, s.skillBody.parse(req.body)));
  app.delete('/skills/:slug', async (req, reply) => {
    svc.deleteSkill(ctx, s.slugParams.parse(req.params).slug);
    return reply.code(204).send();
  });
  app.put('/agents/:id/skills', async (req) => svc.assignSkills(ctx, s.idParams.parse(req.params).id, s.assignSkillsBody.parse(req.body).skills));

  // ---- team templates (built-in + saved; apply / export a whole team)
  app.get('/templates', async () => svc.listTemplates(ctx));
  app.post('/templates', async (req, reply) => reply.code(201).send(svc.saveTemplate(ctx, s.teamTemplateBody.parse(req.body) as TeamTemplate)));
  app.delete('/templates/:id', async (req, reply) => {
    svc.deleteTemplate(ctx, s.templateIdParams.parse(req.params).id);
    return reply.code(204).send();
  });
  app.post('/templates/apply', async (req, reply) => {
    const body = s.applyTemplateBody.parse(req.body) as ApplyTemplateBody;
    return reply.code(201).send(await svc.applyTemplate(ctx, body));
  });
  app.get('/templates/export', async (req) => svc.exportTemplate(ctx, s.exportTemplateQuery.parse(req.query ?? {}).agentIds));

  // ---- agents
  app.get('/agents', async () => svc.listAgents(ctx));

  app.post('/agents', async (req, reply) => reply.code(201).send(svc.createAgent(ctx, s.createAgentBody.parse(req.body))));

  app.patch('/agents/:id', async (req) => svc.updateAgent(ctx, s.idParams.parse(req.params).id, s.updateAgentBody.parse(req.body ?? {})));

  app.delete('/agents/:id', async (req) => svc.deleteAgent(ctx, s.idParams.parse(req.params).id));

  // ---- runtimes
  app.get('/runtimes', async () => svc.listRuntimes(ctx));
  // The owner's Claude connectors (claude.ai + local MCP servers) agents on Claude Code may be given.
  app.get('/runtimes/claude-cli/connectors', async () => {
    try { return await listClaudeConnectors(); } catch (err) { throw new AppError(502, 'claude_unavailable', (err as Error).message); }
  });

  // ---- diagnostics: a redacted report for bug reports (?download=1 makes it a file)
  app.get('/diagnostics', async (req, reply) => {
    const report = await svc.buildDiagnostics(ctx);
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    if (q.download === '1' || q.download === 'true') {
      reply.header('content-disposition', `attachment; filename="${svc.diagnosticsFileName(new Date(report.app.generatedAt))}"`);
    }
    reply.header('cache-control', 'no-store');
    return report;
  });

  // ---- v0.4 §D triggers (webhook / mail / schedule); POST /hooks/:id is registered in server.ts
  registerTriggerRoutes(app, ctx);
  // ---- v0.4 security log, integrity check, export, emergency stop (api/security-routes.ts)
  registerSecurityRoutes(app, ctx);
  // ---- v0.4 §E memory graph (api/memory-routes.ts)
  registerMemoryRoutes(app, ctx);
  // ---- v0.5 §L cost dashboard (api/cost-routes.ts)
  registerCostRoutes(app, ctx);
  // ---- v0.7 R OpenAI-compatible AI connections (api/ai-connection-routes.ts)
  registerAiConnectionRoutes(app, ctx);
  // ---- v0.7 Q workspace backups (api/backup-routes.ts)
  registerBackupRoutes(app, ctx);

  // ---- events (WebSocket). Auth: ?token= (checked by the security hook).
  app.get('/events', { websocket: true }, (socket) => {
    const unsubscribe = ctx.bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    // Clients don't send anything meaningful; ignore input but keep the socket alive.
    socket.on('message', () => undefined);
  });
}
