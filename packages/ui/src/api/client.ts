import {
  API_PREFIX,
  type Agent, type ApiError, type ClaudeConnectorInfo, type CreateAgentBody, type CreateTicketBody, type DecidePermissionBody,
  type HealthResponse, type Id, type ListTicketsQuery, type Message, type MoveTicketBody, type PermissionRequest,
  type PostMessageBody, type RuntimeInfo, type TicketAttachment, type Ticket, type TicketDetail, type TicketPage, type UpdateAgentBody,
  type UpdateTicketBody, type WsEvent, type TrustedCommand, type ConnectMailBody, type MailConnectorStatus,
  type IntakeTurnBody, type IntakeTurnResponse, type IntakeAcceptBody, type IntakeAcceptResponse, type AppSettings,
  type ConnectorsResponse, type ConnectorInfo, type AddConnectorBody, type UpdateConnectorBody,
  type OAuthAppStatus, type OAuthProviderId, type SetOAuthAppBody, type StartOAuthResponse, type DisconnectMailResponse,
  type Project, type ProjectSummary, type CreateProjectBody, type UpdateProjectBody, type TagCount,
  type Skill, type SkillBody, type AssignSkillsBody, type DiagnosticsReport, type DeleteAgentResponse,
  type TeamTemplate, type ApplyTemplateBody, type ApplyTemplateResponse,
  type Team, type CreateTeamBody, type UpdateTeamBody, type RoutePreviewBody, type RouteDecision, type RouteTicketResponse, type SetTicketScopeBody,
  type Page, type SessionEntry, type SessionCategoryCount, type SessionScanResult, type SessionTranscript, type UpdateSessionEntryBody,
  type OpenSessionBody, type OpenSessionResponse, type SuggestCategoriesBody, type SuggestCategoriesResult, type ApplyCategoriesBody, type ApplyCategoriesResult,
  type Trigger, type CreateTriggerBody, type CreateTriggerResponse, type UpdateTriggerBody, type RotateSecretResponse,
  type TriggerTestBody, type TriggerTestResult, type TriggerFire,
} from '@sebeto/shared';
import type {
  SecurityEvent, SecurityEventsQuery, SecuritySummary, SecurityLockdownStatus, SecurityVerifyResult,
  EmergencyStopBody, EmergencyStopResult, SecuritySettings,
} from '@sebeto/shared';
import { connectEvents } from './events';
import { ApiHttpError, type MemoryGraphQuery, type MemoryListQuery, type SebetoApi, type SessionListQuery, type SubscribeOptions } from './types';
import type {
  CostsQuery, CostsReport,
  MemoryBackfillBody, MemoryBackfillResult, MemoryGraph, MemoryInfo, MemoryNote, MemoryNoteDetail, MemoryReindexResult, MemoryRelated, SaveMemoryNoteBody,
} from '@sebeto/shared';
import type { AiConnection, AiConnectionTestResult, CreateAiConnectionBody, UpdateAiConnectionBody } from '@sebeto/shared';
import type {
  BackupEstimate, BackupInfo, BackupListResponse, BackupSettings, BackupVerifyResult, CreateBackupBody, VerifyBackupBody,
} from '@sebeto/shared';
import { getToken } from './token';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Pure: `/tickets` + query object → `/tickets?status=…&q=…` (skips empty values). */
export function buildQuery(query: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export interface HttpClientOptions {
  /** Origin of the core server; default: the page's origin. */
  origin?: string;
  token?: () => string | null;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export class HttpClient implements SebetoApi {
  readonly mode = 'real' as const;
  private readonly origin: string;
  private readonly token: () => string | null;
  private readonly onUnauthorized?: () => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpClientOptions = {}) {
    this.origin = opts.origin || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:7600');
    this.token = opts.token ?? (() => getToken());
    this.onUnauthorized = opts.onUnauthorized;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiHttpError(0, 'network', err instanceof Error ? err.message : 'Network error');
    }
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new ApiHttpError(401, 'unauthorized', 'Access token missing or invalid');
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const e = (data as ApiError | null)?.error;
      throw new ApiHttpError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed (${res.status})`);
    }
    return data as T;
  }

  health() { return this.request<HealthResponse>('GET', '/health'); }
  listTickets(q: ListTicketsQuery = {}) {
    return this.request<TicketPage>('GET', `/tickets${buildQuery({ status: q.status, q: q.q, cursor: q.cursor, limit: q.limit, projectId: q.projectId, tag: q.tag, teamId: q.teamId, deleted: q.deleted ? 'true' : undefined })}`);
  }
  deleteTicket(id: Id) { return this.request<Ticket>('DELETE', `/tickets/${encodeURIComponent(id)}`); }
  restoreTicket(id: Id) { return this.request<Ticket>('POST', `/tickets/${encodeURIComponent(id)}/restore`, {}); }
  async purgeTicket(id: Id) { await this.request<unknown>('DELETE', `/tickets/${encodeURIComponent(id)}/permanent`); }
  createTicket(body: CreateTicketBody) { return this.request<Ticket>('POST', '/tickets', body); }
  getTicket(id: Id) { return this.request<TicketDetail>('GET', `/tickets/${encodeURIComponent(id)}`); }
  updateTicket(id: Id, body: UpdateTicketBody) { return this.request<Ticket>('PATCH', `/tickets/${encodeURIComponent(id)}`, body); }
  moveTicket(id: Id, body: MoveTicketBody) { return this.request<Ticket>('POST', `/tickets/${encodeURIComponent(id)}/move`, body); }
  postMessage(id: Id, body: PostMessageBody) { return this.request<Message>('POST', `/tickets/${encodeURIComponent(id)}/messages`, body); }
  uploadAttachment(id: Id, name: string, data: string) { return this.request<TicketAttachment>('POST', `/tickets/${encodeURIComponent(id)}/attachments`, { name, data }); }
  async getAttachment(id: Id, name: string): Promise<Blob> {
    const headers: Record<string, string> = {};
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await this.fetchImpl(`${this.origin}${API_PREFIX}/tickets/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`, { headers });
    if (res.status === 401) { this.onUnauthorized?.(); throw new ApiHttpError(401, 'unauthorized', 'Access token missing or invalid'); }
    if (!res.ok) throw new ApiHttpError(res.status, 'http_error', `Could not load ${name} (${res.status})`);
    return res.blob();
  }
  async startTicket(id: Id) { await this.request<unknown>('POST', `/tickets/${encodeURIComponent(id)}/start`, {}); }
  async cancelTicket(id: Id) { await this.request<unknown>('POST', `/tickets/${encodeURIComponent(id)}/cancel`, {}); }
  async undoRun(ticketId: Id, runId: Id) {
    await this.request<unknown>('POST', `/tickets/${encodeURIComponent(ticketId)}/undo`, { runId });
  }
  decidePermission(id: Id, body: DecidePermissionBody) {
    return this.request<PermissionRequest>('POST', `/permissions/${encodeURIComponent(id)}/decide`, body);
  }
  listTrustedCommands() { return this.request<TrustedCommand[]>('GET', '/trusted-commands'); }
  async removeTrustedCommand(id: Id) {
    await this.request<unknown>('DELETE', `/trusted-commands/${encodeURIComponent(id)}`);
  }
  oauthApps() { return this.request<OAuthAppStatus[]>('GET', '/connectors/oauth'); }
  setOAuthApp(provider: OAuthProviderId, body: SetOAuthAppBody) { return this.request<OAuthAppStatus>('PUT', `/connectors/oauth/${provider}`, body); }
  startOAuth(provider: OAuthProviderId) { return this.request<StartOAuthResponse>('POST', `/connectors/oauth/${provider}/start`, {}); }
  listConnectors() { return this.request<ConnectorsResponse>('GET', '/connectors'); }
  addConnector(body: AddConnectorBody) { return this.request<ConnectorInfo>('POST', '/connectors', body); }
  updateConnector(id: Id, patch: UpdateConnectorBody) { return this.request<ConnectorInfo>('PATCH', `/connectors/${encodeURIComponent(id)}`, patch); }
  refreshConnector(id: Id) { return this.request<ConnectorInfo>('POST', `/connectors/${encodeURIComponent(id)}/refresh`, {}); }
  async removeConnector(id: Id) { await this.request<unknown>('DELETE', `/connectors/${encodeURIComponent(id)}`); }
  listAiConnections() { return this.request<AiConnection[]>('GET', '/ai-connections'); }
  addAiConnection(body: CreateAiConnectionBody) { return this.request<AiConnection>('POST', '/ai-connections', body); }
  updateAiConnection(id: Id, patch: UpdateAiConnectionBody) { return this.request<AiConnection>('PATCH', `/ai-connections/${encodeURIComponent(id)}`, patch); }
  async removeAiConnection(id: Id) { await this.request<unknown>('DELETE', `/ai-connections/${encodeURIComponent(id)}`); }
  testAiConnection(id: Id) { return this.request<AiConnectionTestResult>('POST', `/ai-connections/${encodeURIComponent(id)}/test`, {}); }
  getSettings() { return this.request<AppSettings>('GET', '/settings'); }
  updateSettings(patch: Partial<AppSettings>) { return this.request<AppSettings>('PATCH', '/settings', patch); }
  intakeTurn(body: IntakeTurnBody) { return this.request<IntakeTurnResponse>('POST', '/intake', body); }
  acceptIntake(body: IntakeAcceptBody) { return this.request<IntakeAcceptResponse>('POST', '/intake/accept', body); }
  mailStatus() { return this.request<MailConnectorStatus>('GET', '/connectors/mail'); }
  connectMail(body: ConnectMailBody) { return this.request<MailConnectorStatus>('PUT', '/connectors/mail', body); }
  disconnectMail() { return this.request<DisconnectMailResponse>('DELETE', '/connectors/mail'); }
  listProjects() { return this.request<ProjectSummary[]>('GET', '/projects'); }
  createProject(body: CreateProjectBody) { return this.request<Project>('POST', '/projects', body); }
  updateProject(id: Id, body: UpdateProjectBody) { return this.request<Project>('PATCH', `/projects/${encodeURIComponent(id)}`, body); }
  async deleteProject(id: Id) { await this.request<unknown>('DELETE', `/projects/${encodeURIComponent(id)}`); }
  listTags() { return this.request<TagCount[]>('GET', '/tags'); }
  listAgents() { return this.request<Agent[]>('GET', '/agents'); }
  createAgent(body: CreateAgentBody) { return this.request<Agent>('POST', '/agents', body); }
  updateAgent(id: Id, body: UpdateAgentBody) { return this.request<Agent>('PATCH', `/agents/${encodeURIComponent(id)}`, body); }
  deleteAgent(id: Id) { return this.request<DeleteAgentResponse>('DELETE', `/agents/${encodeURIComponent(id)}`); }
  listRuntimes() { return this.request<RuntimeInfo[]>('GET', '/runtimes'); }
  /** The owner's Claude connectors (slow: Claude Code checks each one). */
  listClaudeConnectors() { return this.request<ClaudeConnectorInfo[]>('GET', '/runtimes/claude-cli/connectors'); }
  getDiagnostics() { return this.request<DiagnosticsReport>('GET', '/diagnostics'); }
  listSessions(q: SessionListQuery = {}) {
    return this.request<Page<SessionEntry>>('GET', `/sessions${buildQuery({ q: q.q, category: q.category, source: q.source, cursor: q.cursor, limit: q.limit })}`);
  }
  sessionCategories() { return this.request<SessionCategoryCount[]>('GET', '/sessions/categories'); }
  scanSessions() { return this.request<SessionScanResult>('POST', '/sessions/scan', {}); }
  sessionTranscript(id: Id, limit?: number) {
    return this.request<SessionTranscript>('GET', `/sessions/${encodeURIComponent(id)}/transcript${buildQuery({ limit })}`);
  }
  updateSession(id: Id, body: UpdateSessionEntryBody) { return this.request<SessionEntry>('PATCH', `/sessions/${encodeURIComponent(id)}`, body); }
  openSession(id: Id, body: OpenSessionBody = {}) { return this.request<OpenSessionResponse>('POST', `/sessions/${encodeURIComponent(id)}/open`, body); }
  async deleteSession(id: Id) { await this.request<unknown>('DELETE', `/sessions/${encodeURIComponent(id)}`); }
  suggestSessionCategories(body: SuggestCategoriesBody) { return this.request<SuggestCategoriesResult>('POST', '/sessions/suggest-categories', body); }
  applySessionCategories(body: ApplyCategoriesBody) { return this.request<ApplyCategoriesResult>('POST', '/sessions/apply-categories', body); }
  listTeams() { return this.request<Team[]>('GET', '/teams'); }
  createTeam(body: CreateTeamBody) { return this.request<Team>('POST', '/teams', body); }
  updateTeam(id: Id, body: UpdateTeamBody) { return this.request<Team>('PATCH', `/teams/${encodeURIComponent(id)}`, body); }
  async deleteTeam(id: Id) { await this.request<unknown>('DELETE', `/teams/${encodeURIComponent(id)}`); }
  previewRoute(body: RoutePreviewBody) { return this.request<RouteDecision>('POST', '/routing/preview', body); }
  routeTicket(id: Id) { return this.request<RouteTicketResponse>('POST', `/tickets/${encodeURIComponent(id)}/route`, {}); }
  setTicketScope(id: Id, body: SetTicketScopeBody) { return this.request<Ticket>('PUT', `/tickets/${encodeURIComponent(id)}/scope`, body); }
  clearTicketScope(id: Id) { return this.request<Ticket>('DELETE', `/tickets/${encodeURIComponent(id)}/scope`); }
  listSkills() { return this.request<Skill[]>('GET', '/skills'); }
  createSkill(body: SkillBody) { return this.request<Skill>('POST', '/skills', body); }
  updateSkill(slug: string, body: SkillBody) { return this.request<Skill>('PUT', `/skills/${encodeURIComponent(slug)}`, body); }
  async deleteSkill(slug: string) { await this.request<unknown>('DELETE', `/skills/${encodeURIComponent(slug)}`); }
  assignSkills(agentId: Id, slugs: string[]) {
    const body: AssignSkillsBody = { skills: slugs };
    return this.request<Agent>('PUT', `/agents/${encodeURIComponent(agentId)}/skills`, body);
  }
  listTemplates() { return this.request<TeamTemplate[]>('GET', '/templates'); }
  saveTemplate(template: TeamTemplate) { return this.request<TeamTemplate>('POST', '/templates', template); }
  async deleteTemplate(id: string) { await this.request<unknown>('DELETE', `/templates/${encodeURIComponent(id)}`); }
  applyTemplate(body: ApplyTemplateBody) { return this.request<ApplyTemplateResponse>('POST', '/templates/apply', body); }
  /** Goes through request(): the token travels in the Authorization header, never in the URL. */
  exportTemplate(agentIds: Id[] = []) {
    return this.request<TeamTemplate>('GET', `/templates/export${buildQuery({ agentIds: agentIds.join(',') })}`);
  }

  listTriggers() { return this.request<Trigger[]>('GET', '/triggers'); }
  createTrigger(body: CreateTriggerBody) { return this.request<CreateTriggerResponse>('POST', '/triggers', body); }
  updateTrigger(id: Id, body: UpdateTriggerBody) { return this.request<Trigger>('PATCH', `/triggers/${encodeURIComponent(id)}`, body); }
  async deleteTrigger(id: Id) { await this.request<unknown>('DELETE', `/triggers/${encodeURIComponent(id)}`); }
  rotateTriggerSecret(id: Id) { return this.request<RotateSecretResponse>('POST', `/triggers/${encodeURIComponent(id)}/rotate-secret`, {}); }
  testTrigger(id: Id, body: TriggerTestBody) { return this.request<TriggerTestResult>('POST', `/triggers/${encodeURIComponent(id)}/test`, body); }
  listTriggerFires(id: Id, limit = 20) { return this.request<TriggerFire[]>('GET', `/triggers/${encodeURIComponent(id)}/fires${buildQuery({ limit })}`); }
  // ---- v0.4 B: security log
  listSecurityEvents(q: SecurityEventsQuery = {}) {
    return this.request<Page<SecurityEvent>>('GET', `/security/events${buildQuery({ ...q })}`);
  }
  securitySummary(hours = 24) { return this.request<SecuritySummary>('GET', `/security/summary${buildQuery({ hours })}`); }
  securityStatus() { return this.request<SecurityLockdownStatus>('GET', '/security/status'); }
  verifySecurityLog() { return this.request<SecurityVerifyResult>('GET', '/security/verify'); }
  async exportSecurityLog(format: 'jsonl' | 'csv') {
    const headers: Record<string, string> = {};
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${API_PREFIX}/security/export${buildQuery({ format })}`, { method: 'GET', headers });
    } catch (err) {
      throw new ApiHttpError(0, 'network', err instanceof Error ? err.message : 'Network error');
    }
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new ApiHttpError(401, 'unauthorized', 'Access token missing or invalid');
    }
    if (!res.ok) throw new ApiHttpError(res.status, 'http_error', `Request failed (${res.status})`);
    const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
    return { fileName: m?.[1] ?? `sebeto-security.${format}`, blob: await res.blob() };
  }
  emergencyStop(body: EmergencyStopBody) { return this.request<EmergencyStopResult>('POST', '/security/emergency-stop', body); }
  async releaseLockdown() { await this.request<unknown>('POST', '/security/emergency-stop/release', {}); }
  getSecuritySettings() { return this.request<SecuritySettings>('GET', '/security/settings'); }
  updateSecuritySettings(patch: Partial<SecuritySettings>) { return this.request<SecuritySettings>('PUT', '/security/settings', patch); }

  // ---- v0.4 E: memory graph
  listMemoryNotes(q: MemoryListQuery = {}) {
    return this.request<MemoryNote[]>('GET', `/memory/notes${buildQuery({ q: q.q, kind: q.kind, team: q.team, status: q.status, limit: q.limit })}`);
  }
  getMemoryNote(id: Id) { return this.request<MemoryNoteDetail>('GET', `/memory/notes/${encodeURIComponent(id)}`); }
  createMemoryNote(body: SaveMemoryNoteBody) { return this.request<MemoryNoteDetail>('POST', '/memory/notes', body); }
  updateMemoryNote(id: Id, body: SaveMemoryNoteBody) { return this.request<MemoryNoteDetail>('PUT', `/memory/notes/${encodeURIComponent(id)}`, body); }
  async deleteMemoryNote(id: Id) { await this.request<unknown>('DELETE', `/memory/notes/${encodeURIComponent(id)}`); }
  approveMemoryNote(id: Id) { return this.request<MemoryNoteDetail>('POST', `/memory/notes/${encodeURIComponent(id)}/approve`, {}); }
  memoryGraph(q: MemoryGraphQuery = {}) {
    return this.request<MemoryGraph>('GET', `/memory/graph${buildQuery({ team: q.team, kind: q.kind, center: q.center, depth: q.depth, limit: q.limit, proposed: q.proposed ? '1' : undefined, q: q.q })}`);
  }
  memoryRelated(name: string, depth?: 1 | 2) { return this.request<MemoryRelated>('GET', `/memory/related${buildQuery({ name, depth })}`); }
  reindexMemory() { return this.request<MemoryReindexResult>('POST', '/memory/reindex', {}); }
  backfillMemory(body: MemoryBackfillBody = {}) { return this.request<MemoryBackfillResult>('POST', '/memory/backfill', body); }
  memoryInfo() { return this.request<MemoryInfo>('GET', '/memory/info'); }

  // ---- v0.5 L: cost dashboard
  costs(q: CostsQuery = {}) {
    const groupBy = Array.isArray(q.groupBy) ? q.groupBy.join(',') : q.groupBy;
    return this.request<CostsReport>('GET', `/costs${buildQuery({ from: q.from, to: q.to, groupBy, projectId: q.projectId, teamId: q.teamId, top: q.top })}`);
  }

  // ---- v0.7 Q: workspace backups
  listBackups() { return this.request<BackupListResponse>('GET', '/backups'); }
  backupEstimate() { return this.request<BackupEstimate>('GET', '/backups/estimate'); }
  createBackup(body: CreateBackupBody) { return this.request<BackupInfo>('POST', '/backups', body); }
  async downloadBackup(name: string) {
    const headers: Record<string, string> = {};
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${API_PREFIX}/backups/${encodeURIComponent(name)}/download`, { method: 'GET', headers });
    } catch (err) {
      throw new ApiHttpError(0, 'network', err instanceof Error ? err.message : 'Network error');
    }
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new ApiHttpError(401, 'unauthorized', 'Access token missing or invalid');
    }
    if (!res.ok) throw new ApiHttpError(res.status, 'http_error', `Request failed (${res.status})`);
    return { fileName: name, blob: await res.blob() };
  }
  verifyBackup(name: string, body: VerifyBackupBody = {}) { return this.request<BackupVerifyResult>('POST', `/backups/${encodeURIComponent(name)}/verify`, body); }
  async deleteBackup(name: string) { await this.request<unknown>('DELETE', `/backups/${encodeURIComponent(name)}`); }
  updateBackupSettings(patch: Partial<BackupSettings>) { return this.request<BackupSettings>('PUT', '/backups/settings', patch); }

  subscribe(listener: (event: WsEvent) => void, options: SubscribeOptions = {}) {
    return connectEvents(this.origin, this.token, listener, {
      ...options,
      onUnauthorized: () => {
        options.onUnauthorized?.();
        this.onUnauthorized?.();
      },
    });
  }
}
