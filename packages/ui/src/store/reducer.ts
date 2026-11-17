import {
  TICKET_STATUSES,
  type Agent, type AuditEvent, type Id, type Message, type PermissionRequest, type Run, type Ticket, type TicketDetail,
  type MailConnectorStatus, type Project, type Team, type TicketPage, type TicketStatus, type TrustedCommand, type WsEvent,
} from '@sebeto/shared';
import type { ConnectionState } from '../api/types';

export type View = 'all' | 'needs_you' | 'blocked';
/** Which main page is shown: the ticket board or the Agents & skills page. */
export type Page = 'board' | 'agents' | 'sessions' | 'memory' | 'security' | 'costs' | 'deleted';

/** Latest activity shown on a card: the newest audit event summary and its time. */
export type Activity = NonNullable<Ticket['lastActivity']>;

export interface ColumnState {
  ids: Id[];
  cursor: string | null;
  loading: boolean;
}

export interface AppState {
  tickets: Record<Id, Ticket>;
  columns: Record<TicketStatus, ColumnState>;
  agents: Record<Id, Agent>;
  /** ticketId → latest audit summary and time ("latest activity" on cards). */
  activity: Record<Id, Activity>;
  /** pending permission request id → ticket id. */
  pendingPerms: Record<Id, Id>;
  /** Commands the owner always allows; null until loaded. */
  trusted: TrustedCommand[] | null;
  /** Mail connector status; null until loaded. */
  mail: MailConnectorStatus | null;
  /** Bumped on connectors.changed so open connector screens reload. */
  connectorsVersion: number;
  /** Bumped on skills.changed so open skill screens reload. */
  skillsVersion: number;
  /** Bumped on templates.changed so open template screens reload. */
  templatesVersion: number;
  /** v0.4: bumped by 'sessions.changed', 'teams.changed', 'triggers.changed', 'trigger.fired', 'security.event' (key = event type). */
  versions: Record<string, number>;
  /** v0.4: emergency stop (lockdown) is active. */
  lockdown: boolean;
  /** Projects by id (null until loaded). */
  projects: Record<Id, Project> | null;
  /** Board filters: a project id, 'none' (no project) or null (all); a tag or null. */
  projectFilter: Id | 'none' | null;
  tagFilter: string | null;
  /** v0.4 teams by id (null until loaded) and the board's team filter: a team id, 'none' or null (all). */
  teams: Record<Id, Team> | null;
  teamFilter: Id | 'none' | null;
  page: Page;
  selectedId: Id | null;
  detail: TicketDetail | null;
  query: string;
  view: View;
  connection: ConnectionState;
  error: string | null;
}

export type Action =
  | { type: 'columnLoading'; status: TicketStatus }
  | { type: 'columnLoaded'; status: TicketStatus; page: TicketPage; append: boolean }
  | { type: 'columnFailed'; status: TicketStatus }
  | { type: 'ticketUpserted'; ticket: Ticket }
  | { type: 'ticketRemoved'; id: Id }
  | { type: 'agentsLoaded'; agents: Agent[] }
  | { type: 'agentUpserted'; agent: Agent }
  | { type: 'select'; id: Id | null }
  | { type: 'detailLoaded'; detail: TicketDetail }
  | { type: 'messageAdded'; message: Message }
  | { type: 'eventAdded'; event: AuditEvent }
  | { type: 'permissionUpserted'; request: PermissionRequest }
  | { type: 'runUpserted'; run: Run }
  | { type: 'trustedLoaded'; commands: TrustedCommand[] }
  | { type: 'mailLoaded'; status: MailConnectorStatus }
  | { type: 'connectorsChanged' }
  | { type: 'skillsChanged' }
  | { type: 'templatesChanged' }
  | { type: 'bump'; key: string }
  | { type: 'setLockdown'; active: boolean }
  | { type: 'projectsLoaded'; projects: Project[] }
  | { type: 'projectUpserted'; project: Project }
  | { type: 'projectRemoved'; id: Id }
  | { type: 'setProjectFilter'; projectId: Id | 'none' | null }
  | { type: 'setTagFilter'; tag: string | null }
  | { type: 'teamsLoaded'; teams: Team[] }
  | { type: 'setTeamFilter'; teamId: Id | 'none' | null }
  | { type: 'agentRemoved'; id: Id }
  | { type: 'setPage'; page: Page }
  | { type: 'setQuery'; query: string }
  | { type: 'setView'; view: View }
  | { type: 'setConnection'; connection: ConnectionState }
  | { type: 'setError'; error: string | null }
  | { type: 'ws'; event: WsEvent };

function emptyColumns(): Record<TicketStatus, ColumnState> {
  const out = {} as Record<TicketStatus, ColumnState>;
  for (const s of TICKET_STATUSES) out[s] = { ids: [], cursor: null, loading: false };
  return out;
}

export function initialState(partial: Partial<AppState> = {}): AppState {
  return {
    tickets: {},
    columns: emptyColumns(),
    agents: {},
    activity: {},
    pendingPerms: {},
    trusted: null,
    mail: null,
    connectorsVersion: 0,
    skillsVersion: 0,
    templatesVersion: 0,
    versions: {},
    lockdown: false,
    projects: null,
    projectFilter: null,
    tagFilter: null,
    teams: null,
    teamFilter: null,
    page: 'board',
    selectedId: null,
    detail: null,
    query: '',
    view: 'all',
    connection: 'connecting',
    error: null,
    ...partial,
  };
}

/** Upsert by id, keeping order; appends if new. */
function upsertById<T extends { id: Id }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Place a ticket in the column for its status (front if new there) and remove it from every other column. */
function placeTicket(columns: AppState['columns'], ticket: Ticket): AppState['columns'] {
  const next = { ...columns };
  for (const s of TICKET_STATUSES) {
    const col = columns[s];
    const has = col.ids.includes(ticket.id);
    if (s === ticket.status) {
      if (!has) next[s] = { ...col, ids: [ticket.id, ...col.ids] };
    } else if (has) {
      next[s] = { ...col, ids: col.ids.filter((id) => id !== ticket.id) };
    }
  }
  return next;
}

/**
 * Record an activity unless we already know a newer one. Tickets may arrive without lastActivity
 * (some ticket.updated payloads) or with an older one than a live event: both keep what we have.
 */
function noteActivity(activity: AppState['activity'], ticketId: Id, next: Activity | null | undefined): AppState['activity'] {
  if (!next) return activity;
  const cur = activity[ticketId];
  if (cur && cur.at > next.at) return activity;
  if (cur && cur.at === next.at && cur.summary === next.summary) return activity;
  return { ...activity, [ticketId]: next };
}

function withDetail(state: AppState, ticketId: Id, fn: (d: TicketDetail) => TicketDetail): TicketDetail | null {
  if (!state.detail || state.detail.ticket.id !== ticketId) return state.detail;
  return fn(state.detail);
}

function trackPermission(pending: Record<Id, Id>, req: PermissionRequest): Record<Id, Id> {
  const has = pending[req.id] !== undefined;
  if (req.state === 'pending' && !has) return { ...pending, [req.id]: req.ticketId };
  if (req.state !== 'pending' && has) {
    const next = { ...pending };
    delete next[req.id];
    return next;
  }
  return pending;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'columnLoading':
      return { ...state, columns: { ...state.columns, [action.status]: { ...state.columns[action.status], loading: true } } };
    case 'columnFailed':
      return { ...state, columns: { ...state.columns, [action.status]: { ...state.columns[action.status], loading: false } } };
    case 'columnLoaded': {
      const tickets = { ...state.tickets };
      let columns = state.columns;
      let activity = state.activity;
      for (const t of action.page.items) {
        tickets[t.id] = t;
        activity = noteActivity(activity, t.id, t.lastActivity);
        // A ticket can only live in one column.
        columns = placeTicket(columns, t);
      }
      const pageIds = action.page.items.filter((t) => t.status === action.status).map((t) => t.id);
      const prev = columns[action.status].ids;
      const ids = action.append ? [...prev.filter((id) => !pageIds.includes(id)), ...pageIds] : pageIds;
      return {
        ...state,
        tickets,
        activity,
        columns: { ...columns, [action.status]: { ids, cursor: action.page.nextCursor, loading: false } },
      };
    }
    case 'ticketUpserted': {
      const t = action.ticket;
      // A ticket in "Deleted tickets" never sits on the board.
      if (t.deletedAt) return reducer(state, { type: 'ticketRemoved', id: t.id });
      return {
        ...state,
        tickets: { ...state.tickets, [t.id]: t },
        columns: placeTicket(state.columns, t),
        activity: noteActivity(state.activity, t.id, t.lastActivity),
        detail: withDetail(state, t.id, (d) => ({ ...d, ticket: t })),
      };
    }
    case 'ticketRemoved': {
      const tickets = { ...state.tickets };
      delete tickets[action.id];
      const columns = { ...state.columns };
      for (const s of TICKET_STATUSES) {
        if (columns[s].ids.includes(action.id)) columns[s] = { ...columns[s], ids: columns[s].ids.filter((id) => id !== action.id) };
      }
      const selected = state.selectedId === action.id;
      return {
        ...state,
        tickets,
        columns,
        selectedId: selected ? null : state.selectedId,
        detail: selected ? null : state.detail,
      };
    }
    case 'agentsLoaded': {
      const agents: Record<Id, Agent> = {};
      for (const a of action.agents) agents[a.id] = a;
      return { ...state, agents };
    }
    case 'agentUpserted':
      return { ...state, agents: { ...state.agents, [action.agent.id]: action.agent } };
    case 'select':
      if (action.id === state.selectedId) return state;
      return { ...state, selectedId: action.id, detail: null };
    case 'detailLoaded': {
      const d = action.detail;
      if (d.ticket.id !== state.selectedId) return state; // stale response
      let pendingPerms = state.pendingPerms;
      for (const p of d.permissions) pendingPerms = trackPermission(pendingPerms, p);
      const last = d.events[d.events.length - 1];
      return {
        ...state,
        detail: d,
        tickets: { ...state.tickets, [d.ticket.id]: d.ticket },
        columns: placeTicket(state.columns, d.ticket),
        activity: noteActivity(
          noteActivity(state.activity, d.ticket.id, d.ticket.lastActivity),
          d.ticket.id,
          last ? { summary: last.summary, at: last.createdAt } : null,
        ),
        pendingPerms,
      };
    }
    case 'messageAdded': {
      const m = action.message;
      return { ...state, detail: withDetail(state, m.ticketId, (d) => ({ ...d, messages: upsertById(d.messages, m) })) };
    }
    case 'eventAdded': {
      const e = action.event;
      return {
        ...state,
        activity: noteActivity(state.activity, e.ticketId, { summary: e.summary, at: e.createdAt }),
        detail: withDetail(state, e.ticketId, (d) => ({ ...d, events: upsertById(d.events, e) })),
      };
    }
    case 'permissionUpserted': {
      const p = action.request;
      return {
        ...state,
        pendingPerms: trackPermission(state.pendingPerms, p),
        detail: withDetail(state, p.ticketId, (d) => ({ ...d, permissions: upsertById(d.permissions, p) })),
      };
    }
    case 'runUpserted': {
      const r = action.run;
      return {
        ...state,
        detail: withDetail(state, r.ticketId, (d) => {
          const exists = d.runs.some((x) => x.id === r.id);
          return { ...d, runs: exists ? d.runs.map((x) => (x.id === r.id ? r : x)) : [r, ...d.runs] };
        }),
      };
    }
    case 'projectsLoaded':
      return { ...state, projects: Object.fromEntries(action.projects.map((p) => [p.id, p])) };
    case 'projectUpserted':
      return { ...state, projects: { ...(state.projects ?? {}), [action.project.id]: action.project } };
    case 'projectRemoved': {
      const projects = { ...(state.projects ?? {}) };
      delete projects[action.id];
      return { ...state, projects, projectFilter: state.projectFilter === action.id ? null : state.projectFilter };
    }
    case 'setProjectFilter':
      return { ...state, projectFilter: action.projectId };
    case 'setTagFilter':
      return { ...state, tagFilter: action.tag };
    case 'teamsLoaded': {
      const teams = Object.fromEntries(action.teams.map((t) => [t.id, t]));
      // A deleted team cannot stay the board filter.
      const teamFilter = state.teamFilter && state.teamFilter !== 'none' && !teams[state.teamFilter] ? null : state.teamFilter;
      return { ...state, teams, teamFilter };
    }
    case 'setTeamFilter':
      return { ...state, teamFilter: action.teamId };
    case 'bump':
      return { ...state, versions: { ...state.versions, [action.key]: (state.versions[action.key] ?? 0) + 1 } };
    case 'setLockdown':
      return state.lockdown === action.active ? state : { ...state, lockdown: action.active };
    case 'templatesChanged':
      return { ...state, templatesVersion: state.templatesVersion + 1 };
    case 'agentRemoved': {
      const agents = { ...state.agents };
      delete agents[action.id];
      return { ...state, agents };
    }
    case 'skillsChanged':
      return { ...state, skillsVersion: state.skillsVersion + 1 };
    case 'setPage':
      // Leaving the board closes the ticket panel.
      return state.page === action.page ? state : { ...state, page: action.page, selectedId: action.page === 'board' ? state.selectedId : null, detail: action.page === 'board' ? state.detail : null };
    case 'connectorsChanged':
      return { ...state, connectorsVersion: state.connectorsVersion + 1 };
    case 'mailLoaded':
      return { ...state, mail: action.status };
    case 'trustedLoaded':
      return { ...state, trusted: action.commands };
    case 'setQuery':
      return { ...state, query: action.query };
    case 'setView':
      return { ...state, view: action.view };
    case 'setConnection':
      return state.connection === action.connection ? state : { ...state, connection: action.connection };
    case 'setError':
      return { ...state, error: action.error };
    case 'ws':
      return reducer(state, wsToAction(action.event));
  }
}

export function wsToAction(e: WsEvent): Action {
  switch (e.type) {
    case 'ticket.updated': return { type: 'ticketUpserted', ticket: e.ticket };
    case 'ticket.deleted': return { type: 'ticketRemoved', id: e.ticketId };
    case 'message.created': return { type: 'messageAdded', message: e.message };
    case 'event.created': return { type: 'eventAdded', event: e.event };
    case 'permission.created':
    case 'permission.updated': return { type: 'permissionUpserted', request: e.request };
    case 'run.updated': return { type: 'runUpserted', run: e.run };
    case 'agent.updated': return { type: 'agentUpserted', agent: e.agent };
    case 'trusted.changed': return { type: 'trustedLoaded', commands: e.commands };
    case 'connectors.changed': return { type: 'connectorsChanged' };
    case 'skills.changed': return { type: 'skillsChanged' };
    case 'templates.changed': return { type: 'templatesChanged' };
    case 'project.updated': return { type: 'projectUpserted', project: e.project };
    case 'project.deleted': return { type: 'projectRemoved', id: e.projectId };
    case 'agent.deleted': return { type: 'agentRemoved', id: e.agentId };
    case 'sessions.changed':
    case 'teams.changed':
    case 'triggers.changed':
    case 'trigger.fired':
    case 'memory.changed':
    case 'security.event': return { type: 'bump', key: e.type };
    case 'security.lockdown': return { type: 'setLockdown', active: e.active };
  }
}

// ---------- selectors (pure)

export function columnCount(state: AppState, status: TicketStatus): number {
  return state.columns[status].ids.length;
}

export function ticketsIn(state: AppState, status: TicketStatus): Ticket[] {
  return state.columns[status].ids.map((id) => state.tickets[id]).filter((t): t is Ticket => !!t);
}

export function pendingPermissionCount(state: AppState, ticketId: Id): number {
  return Object.values(state.pendingPerms).filter((t) => t === ticketId).length;
}

export function isRunActive(run: Run): boolean {
  return run.status === 'queued' || run.status === 'running';
}

/** The latest finished run that has a snapshot to restore. Runs may arrive in any order. */
export function undoableRun(runs: Run[]): Run | null {
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sorted.find((r) => !isRunActive(r) && !!r.snapshotBefore) ?? null;
}

export function hasActiveRun(detail: TicketDetail | null): boolean {
  return !!detail && detail.runs.some(isRunActive);
}
