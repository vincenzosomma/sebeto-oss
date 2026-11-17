import type { AiConnection, AiConnectionTestResult, CreateAiConnectionBody, UpdateAiConnectionBody } from '@sebeto/shared';
import type {
  Agent, CreateAgentBody, CreateTicketBody, DecidePermissionBody, HealthResponse, Id, ListTicketsQuery,
  Message, MoveTicketBody, PermissionRequest, PostMessageBody, RuntimeInfo, TicketAttachment, Ticket, TicketDetail, TicketPage,
  UpdateAgentBody, UpdateTicketBody, WsEvent, TrustedCommand, ConnectMailBody, MailConnectorStatus,
  IntakeTurnBody, IntakeTurnResponse, IntakeAcceptBody, IntakeAcceptResponse, AppSettings,
  ConnectorsResponse, ConnectorInfo, AddConnectorBody, UpdateConnectorBody,
  OAuthAppStatus, OAuthProviderId, SetOAuthAppBody, StartOAuthResponse, DisconnectMailResponse,
  Project, ProjectSummary, CreateProjectBody, UpdateProjectBody, TagCount, Skill, SkillBody,
  DiagnosticsReport, DeleteAgentResponse, TeamTemplate, ApplyTemplateBody, ApplyTemplateResponse,
  Page, SessionEntry, SessionCategoryCount, SessionScanResult, SessionTranscript, UpdateSessionEntryBody, OpenSessionBody, OpenSessionResponse, SessionSource,
  SuggestCategoriesBody, SuggestCategoriesResult, ApplyCategoriesBody, ApplyCategoriesResult,
  Trigger, CreateTriggerBody, CreateTriggerResponse, UpdateTriggerBody, RotateSecretResponse, TriggerTestBody, TriggerTestResult, TriggerFire,
  Team, CreateTeamBody, UpdateTeamBody, RoutePreviewBody, RouteDecision, RouteTicketResponse, SetTicketScopeBody,
} from '@sebeto/shared';
import type {
  SecurityEvent, SecurityEventsQuery, SecuritySummary, SecurityLockdownStatus, SecurityVerifyResult,
  EmergencyStopBody, EmergencyStopResult, SecuritySettings,
} from '@sebeto/shared';
import type {
  MemoryBackfillBody, MemoryBackfillResult, MemoryGraph, MemoryInfo, MemoryKind, MemoryNote, MemoryNoteDetail, MemoryReindexResult,
  MemoryRelated, MemoryStatus, SaveMemoryNoteBody, CostsQuery, CostsReport,
} from '@sebeto/shared';
import type {
  BackupEstimate, BackupInfo, BackupListResponse, BackupSettings, BackupVerifyResult, CreateBackupBody, VerifyBackupBody,
} from '@sebeto/shared';

/** v0.4 §E: GET /memory/notes query. */
export interface MemoryListQuery { q?: string; kind?: MemoryKind; team?: string; status?: MemoryStatus; limit?: number }
/** v0.4 §E: GET /memory/graph query. */
export interface MemoryGraphQuery { team?: string; kind?: MemoryKind; center?: string; depth?: 1 | 2; limit?: number; proposed?: boolean; q?: string }

/** GET /sessions query; category '-' = not categorised. */
export interface SessionListQuery { q?: string; category?: string; source?: SessionSource; cursor?: string | null; limit?: number }

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface SubscribeOptions {
  onStatus?: (state: ConnectionState) => void;
  /** Called after every successful (re)connect except the first, so the caller can resync. */
  onReconnect?: () => void;
  onUnauthorized?: () => void;
}

/** One interface for the real HTTP client and the in-memory mock. */
export interface SebetoApi {
  readonly mode: 'real' | 'mock';
  health(): Promise<HealthResponse>;
  listTickets(query?: ListTicketsQuery): Promise<TicketPage>;
  createTicket(body: CreateTicketBody): Promise<Ticket>;
  getTicket(id: Id): Promise<TicketDetail>;
  updateTicket(id: Id, body: UpdateTicketBody): Promise<Ticket>;
  /** Move to "Deleted tickets" (restorable). */
  deleteTicket(id: Id): Promise<Ticket>;
  restoreTicket(id: Id): Promise<Ticket>;
  /** Delete forever (only tickets already in "Deleted tickets"). */
  purgeTicket(id: Id): Promise<void>;
  moveTicket(id: Id, body: MoveTicketBody): Promise<Ticket>;
  postMessage(id: Id, body: PostMessageBody): Promise<Message>;
  /** A file for the ticket chat (base64); saved in the ticket folder under attachments/. */
  uploadAttachment(id: Id, name: string, dataBase64: string): Promise<TicketAttachment>;
  /** An attached file's bytes (previews, downloads). */
  getAttachment(id: Id, name: string): Promise<Blob>;
  startTicket(id: Id): Promise<void>;
  cancelTicket(id: Id): Promise<void>;
  undoRun(ticketId: Id, runId: Id): Promise<void>;
  decidePermission(id: Id, body: DecidePermissionBody): Promise<PermissionRequest>;
  /** Commands the owner chose to "Always allow". */
  listTrustedCommands(): Promise<TrustedCommand[]>;
  removeTrustedCommand(id: Id): Promise<void>;
  /** Sign-in apps and "Sign in with Microsoft/Google". */
  oauthApps(): Promise<OAuthAppStatus[]>;
  setOAuthApp(provider: OAuthProviderId, body: SetOAuthAppBody): Promise<OAuthAppStatus>;
  startOAuth(provider: OAuthProviderId): Promise<StartOAuthResponse>;
  listConnectors(): Promise<ConnectorsResponse>;
  addConnector(body: AddConnectorBody): Promise<ConnectorInfo>;
  updateConnector(id: Id, patch: UpdateConnectorBody): Promise<ConnectorInfo>;
  refreshConnector(id: Id): Promise<ConnectorInfo>;
  removeConnector(id: Id): Promise<void>;
  /** v0.7 R: OpenAI-compatible AI connections (each is a runtime `openai:<id>`). The API key goes in, never out. */
  listAiConnections(): Promise<AiConnection[]>;
  addAiConnection(body: CreateAiConnectionBody): Promise<AiConnection>;
  updateAiConnection(id: Id, patch: UpdateAiConnectionBody): Promise<AiConnection>;
  removeAiConnection(id: Id): Promise<void>;
  testAiConnection(id: Id): Promise<AiConnectionTestResult>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** One turn of the Chief of Staff intake chat. */
  intakeTurn(body: IntakeTurnBody): Promise<IntakeTurnResponse>;
  acceptIntake(body: IntakeAcceptBody): Promise<IntakeAcceptResponse>;
  mailStatus(): Promise<MailConnectorStatus>;
  connectMail(body: ConnectMailBody): Promise<MailConnectorStatus>;
  /** Sign out of the connected mailbox (revokes at the provider when possible). */
  disconnectMail(): Promise<DisconnectMailResponse>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(body: CreateProjectBody): Promise<Project>;
  updateProject(id: Id, body: UpdateProjectBody): Promise<Project>;
  deleteProject(id: Id): Promise<void>;
  listTags(): Promise<TagCount[]>;
  listAgents(): Promise<Agent[]>;
  createAgent(body: CreateAgentBody): Promise<Agent>;
  updateAgent(id: Id, body: UpdateAgentBody): Promise<Agent>;
  /** Delete an agent: open tickets move to the default agent, reports move up (409 agent_busy / last_agent). */
  deleteAgent(id: Id): Promise<DeleteAgentResponse>;
  listRuntimes(): Promise<RuntimeInfo[]>;
  listClaudeConnectors(): Promise<import('@sebeto/shared').ClaudeConnectorInfo[]>;
  /** Skills v1 (docs/17 Agents & Skills.md). */
  listSkills(): Promise<Skill[]>;
  createSkill(body: SkillBody): Promise<Skill>;
  updateSkill(slug: string, body: SkillBody): Promise<Skill>;
  deleteSkill(slug: string): Promise<void>;
  /** Replaces the agent's skill list. */
  assignSkills(agentId: Id, slugs: string[]): Promise<Agent>;
  /** Team templates (v0.3): built-in first, then saved ones. */
  listTemplates(): Promise<TeamTemplate[]>;
  /** Save an imported template (the core derives the id from the name). */
  saveTemplate(template: TeamTemplate): Promise<TeamTemplate>;
  /** Delete a saved template (built-in ones are refused). */
  deleteTemplate(id: string): Promise<void>;
  /** Add a team: creates its missing skills and its agents. */
  applyTemplate(body: ApplyTemplateBody): Promise<ApplyTemplateResponse>;
  /** The whole team (no ids) or the listed agents and everyone below them, as a template. */
  exportTemplate(agentIds?: Id[]): Promise<TeamTemplate>;
  /** Redacted diagnostics report for bug reports ("Export diagnostics"). */
  getDiagnostics(): Promise<DiagnosticsReport>;
  /** Session library (v0.4 §A): Sebeto and Claude Code sessions. */
  listSessions(query?: SessionListQuery): Promise<Page<SessionEntry>>;
  sessionCategories(): Promise<SessionCategoryCount[]>;
  /** Find Claude Code sessions on this computer (read-only). */
  scanSessions(): Promise<SessionScanResult>;
  sessionTranscript(id: Id, limit?: number): Promise<SessionTranscript>;
  updateSession(id: Id, body: UpdateSessionEntryBody): Promise<SessionEntry>;
  openSession(id: Id, body?: OpenSessionBody): Promise<OpenSessionResponse>;
  /** Remove from the library only (never deletes files or tickets). */
  deleteSession(id: Id): Promise<void>;
  /** v0.5 K: suggest categories for uncategorised entries (rules = free, ai = Chief of Staff with a cost cap); a preview unless dryRun is false. */
  suggestSessionCategories(body: SuggestCategoriesBody): Promise<SuggestCategoriesResult>;
  /** v0.5 K: apply the suggestions the owner kept. */
  applySessionCategories(body: ApplyCategoriesBody): Promise<ApplyCategoriesResult>;
  /** v0.4 §D triggers (Settings → Triggers). A webhook secret is returned only by create / rotate. */
  listTriggers(): Promise<Trigger[]>;
  createTrigger(body: CreateTriggerBody): Promise<CreateTriggerResponse>;
  updateTrigger(id: Id, body: UpdateTriggerBody): Promise<Trigger>;
  deleteTrigger(id: Id): Promise<void>;
  rotateTriggerSecret(id: Id): Promise<RotateSecretResponse>;
  testTrigger(id: Id, body: TriggerTestBody): Promise<TriggerTestResult>;
  listTriggerFires(id: Id, limit?: number): Promise<TriggerFire[]>;
  // ---- v0.4 B: security log, integrity, export, emergency stop (packages/shared/src/security.ts)
  listSecurityEvents(query?: SecurityEventsQuery): Promise<Page<SecurityEvent>>;
  securitySummary(hours?: number): Promise<SecuritySummary>;
  securityStatus(): Promise<SecurityLockdownStatus>;
  verifySecurityLog(): Promise<SecurityVerifyResult>;
  /** Download the log as a file (the token stays in the Authorization header). */
  exportSecurityLog(format: 'jsonl' | 'csv'): Promise<{ fileName: string; blob: Blob }>;
  emergencyStop(body: EmergencyStopBody): Promise<EmergencyStopResult>;
  releaseLockdown(): Promise<void>;
  getSecuritySettings(): Promise<SecuritySettings>;
  updateSecuritySettings(patch: Partial<SecuritySettings>): Promise<SecuritySettings>;
  /** v0.4 teams (packages/shared/src/teams.ts). */
  listTeams(): Promise<Team[]>;
  createTeam(body: CreateTeamBody): Promise<Team>;
  updateTeam(id: Id, body: UpdateTeamBody): Promise<Team>;
  /** Agents and tickets stay, without a team. */
  deleteTeam(id: Id): Promise<void>;
  /** Where would automatic routing send this ticket? No side effects. */
  previewRoute(body: RoutePreviewBody): Promise<RouteDecision>;
  /** Route an existing ticket automatically (sets team, and agent while no session started). */
  routeTicket(id: Id): Promise<RouteTicketResponse>;
  /** v0.4 G: attach / remove the owner's written scope (refused while the agent runs). */
  setTicketScope(id: Id, body: SetTicketScopeBody): Promise<Ticket>;
  clearTicketScope(id: Id): Promise<Ticket>;
  // ---- v0.4 E: memory graph (packages/shared/src/memory.ts)
  listMemoryNotes(query?: MemoryListQuery): Promise<MemoryNote[]>;
  getMemoryNote(id: Id): Promise<MemoryNoteDetail>;
  createMemoryNote(body: SaveMemoryNoteBody): Promise<MemoryNoteDetail>;
  updateMemoryNote(id: Id, body: SaveMemoryNoteBody): Promise<MemoryNoteDetail>;
  /** Moves the file to memory/.trash/. */
  deleteMemoryNote(id: Id): Promise<void>;
  approveMemoryNote(id: Id): Promise<MemoryNoteDetail>;
  memoryGraph(query?: MemoryGraphQuery): Promise<MemoryGraph>;
  memoryRelated(name: string, depth?: 1 | 2): Promise<MemoryRelated>;
  reindexMemory(): Promise<MemoryReindexResult>;
  /** Rules only (no AI) unless useModel. */
  backfillMemory(body?: MemoryBackfillBody): Promise<MemoryBackfillResult>;
  memoryInfo(): Promise<MemoryInfo>;
  // ---- v0.5 L: cost dashboard (packages/shared/src/costs.ts)
  costs(query?: CostsQuery): Promise<CostsReport>;
  // ---- v0.7 Q: workspace backups (packages/shared/src/backups.ts)
  listBackups(): Promise<BackupListResponse>;
  /** Sizes before a backup (ticket folders can be big). */
  backupEstimate(): Promise<BackupEstimate>;
  /** The passphrase (optional) encrypts the secrets; it is never stored. */
  createBackup(body: CreateBackupBody): Promise<BackupInfo>;
  /** Download a backup file (the token stays in the Authorization header). */
  downloadBackup(name: string): Promise<{ fileName: string; blob: Blob }>;
  verifyBackup(name: string, body?: VerifyBackupBody): Promise<BackupVerifyResult>;
  deleteBackup(name: string): Promise<void>;
  updateBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings>;
  /** Live events (WebSocket in real mode). Returns an unsubscribe function. */
  subscribe(listener: (event: WsEvent) => void, options?: SubscribeOptions): () => void;
}

export class ApiHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiHttpError';
  }
}
