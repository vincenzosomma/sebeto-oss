import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import {
  LOCKDOWN_MESSAGE, TICKET_STATUSES,
  type CreateTicketBody, type Id, type PermissionDecision, type TeamChoice, type Ticket, type TicketStatus,
} from '@sebeto/shared';
import type { SebetoApi } from '../api/types';
import { ApiHttpError } from '../api/types';
import { errorMessage } from '../lib/format';
import { isLockdownError } from '../lib/security';
import { initialState, reducer, type Action, type AppState, type View } from './reducer';

export const PAGE_SIZE = 50;

export interface Actions {
  loadBoard(query?: string): Promise<void>;
  loadMore(status: TicketStatus): Promise<void>;
  select(id: Id | null): void;
  refreshDetail(): Promise<void>;
  move(id: Id, status: TicketStatus): Promise<void>;
  assign(id: Id, agentId: Id): Promise<void>;
  /** Change project, tags and/or team (optimistic; 'auto' routes it). */
  updateTicket(id: Id, body: { projectId?: Id | null; tags?: string[]; teamId?: TeamChoice; costCapUsd?: number }): Promise<void>;
  /** v0.4: route the ticket automatically (team, and agent while no session started). */
  routeTicket(id: Id): Promise<void>;
  loadTeams(): Promise<void>;
  setTeamFilter(teamId: Id | 'none' | null): void;
  create(body: CreateTicketBody): Promise<Ticket | null>;
  /** attachments = names from api.uploadAttachment. */
  send(text: string, attachments?: string[]): Promise<boolean>;
  start(id: Id): Promise<void>;
  cancel(id: Id): Promise<void>;
  undo(ticketId: Id, runId: Id): Promise<void>;
  decide(permissionId: Id, decision: PermissionDecision): Promise<void>;
  loadTrusted(): Promise<void>;
  removeTrusted(id: Id): Promise<void>;
  setQuery(q: string): void;
  setView(v: View): void;
  setProjectFilter(projectId: Id | 'none' | null): void;
  setTagFilter(tag: string | null): void;
  dismissError(): void;
}

interface Store {
  state: AppState;
  dispatch: (a: Action) => void;
  actions: Actions;
  api: SebetoApi;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ api, children, onUnauthorized }: { api: SebetoApi; children: ReactNode; onUnauthorized: () => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState());
  const stateRef = useRef(state);
  stateRef.current = state;

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiHttpError && err.status === 401) {
        onUnauthorized();
        return;
      }
      // v0.5 I: the emergency stop refusal always carries the same plain message (Shell translates it).
      dispatch({ type: 'setError', error: isLockdownError(err) ? LOCKDOWN_MESSAGE : errorMessage(err) });
    },
    [onUnauthorized],
  );

  const actions = useMemo<Actions>(() => {
    const loadColumn = async (status: TicketStatus, q: string, cursor?: string) => {
      dispatch({ type: 'columnLoading', status });
      try {
        const { projectFilter, tagFilter, teamFilter } = stateRef.current;
        const page = await api.listTickets({
          status, q: q || undefined, cursor, limit: PAGE_SIZE,
          ...(projectFilter ? { projectId: projectFilter } : {}), ...(tagFilter ? { tag: tagFilter } : {}),
          ...(teamFilter ? { teamId: teamFilter } : {}),
        });
        dispatch({ type: 'columnLoaded', status, page, append: !!cursor });
      } catch (err) {
        dispatch({ type: 'columnFailed', status });
        throw err;
      }
    };

    const refreshDetail = async () => {
      const id = stateRef.current.selectedId;
      if (!id) return;
      try {
        const detail = await api.getTicket(id);
        dispatch({ type: 'detailLoaded', detail });
      } catch (err) {
        fail(err);
      }
    };

    return {
      async loadBoard(query) {
        const q = query ?? stateRef.current.query;
        try {
          await Promise.all(TICKET_STATUSES.map((s) => loadColumn(s, q)));
        } catch (err) {
          fail(err);
        }
      },
      async loadMore(status) {
        const col = stateRef.current.columns[status];
        if (!col.cursor || col.loading) return;
        try {
          await loadColumn(status, stateRef.current.query, col.cursor);
        } catch (err) {
          fail(err);
        }
      },
      select(id) {
        dispatch({ type: 'select', id });
        if (id) {
          api.getTicket(id).then((detail) => dispatch({ type: 'detailLoaded', detail }), fail);
        }
      },
      refreshDetail,
      async move(id, status) {
        const prev = stateRef.current.tickets[id];
        if (!prev || prev.status === status) return;
        dispatch({ type: 'ticketUpserted', ticket: { ...prev, status } }); // optimistic
        try {
          const t = await api.moveTicket(id, { status });
          dispatch({ type: 'ticketUpserted', ticket: t });
        } catch (err) {
          dispatch({ type: 'ticketUpserted', ticket: prev });
          fail(err);
        }
      },
      async updateTicket(id, body) {
        const prev = stateRef.current.tickets[id] ?? stateRef.current.detail?.ticket;
        if (!prev) return;
        const { teamId, ...known } = body;
        // 'auto' is decided by the core: no optimistic team for it.
        dispatch({ type: 'ticketUpserted', ticket: { ...prev, ...known, ...(teamId !== undefined && teamId !== 'auto' ? { teamId } : {}) } });
        try {
          dispatch({ type: 'ticketUpserted', ticket: await api.updateTicket(id, body) });
        } catch (err) {
          dispatch({ type: 'ticketUpserted', ticket: prev });
          fail(err);
        }
      },
      async routeTicket(id) {
        try {
          const { ticket } = await api.routeTicket(id);
          dispatch({ type: 'ticketUpserted', ticket });
          if (api.mode === 'real') await refreshDetail();
        } catch (err) {
          fail(err);
        }
      },
      async loadTeams() {
        try {
          dispatch({ type: 'teamsLoaded', teams: await api.listTeams() });
        } catch (err) {
          fail(err);
        }
      },
      setTeamFilter(teamId) {
        dispatch({ type: 'setTeamFilter', teamId });
        stateRef.current = { ...stateRef.current, teamFilter: teamId };
        dispatch({ type: 'setPage', page: 'board' });
        void this.loadBoard();
      },
      async assign(id, agentId) {
        const prev = stateRef.current.tickets[id] ?? stateRef.current.detail?.ticket;
        if (!prev || prev.agentId === agentId) return;
        dispatch({ type: 'ticketUpserted', ticket: { ...prev, agentId } }); // optimistic
        try {
          const t = await api.updateTicket(id, { agentId });
          dispatch({ type: 'ticketUpserted', ticket: t });
        } catch (err) {
          dispatch({ type: 'ticketUpserted', ticket: prev });
          fail(err);
        }
      },
      async create(body) {
        try {
          const t = await api.createTicket(body);
          dispatch({ type: 'ticketUpserted', ticket: t });
          return t;
        } catch (err) {
          fail(err);
          return null;
        }
      },
      async send(text, attachments) {
        const id = stateRef.current.selectedId;
        if (!id) return false;
        try {
          const m = await api.postMessage(id, attachments?.length ? { text, attachments } : { text });
          dispatch({ type: 'messageAdded', message: m });
          return true;
        } catch (err) {
          fail(err);
          return false;
        }
      },
      async start(id) {
        try {
          await api.startTicket(id);
          if (api.mode === 'real') await refreshDetail();
        } catch (err) {
          fail(err);
        }
      },
      async cancel(id) {
        try {
          await api.cancelTicket(id);
          if (api.mode === 'real') await refreshDetail();
        } catch (err) {
          fail(err);
        }
      },
      async undo(ticketId, runId) {
        try {
          await api.undoRun(ticketId, runId);
          if (api.mode === 'real') await refreshDetail();
        } catch (err) {
          fail(err);
        }
      },
      async decide(permissionId, decision) {
        try {
          const p = await api.decidePermission(permissionId, { decision });
          dispatch({ type: 'permissionUpserted', request: p });
        } catch (err) {
          fail(err);
        }
      },
      async loadTrusted() {
        try {
          dispatch({ type: 'trustedLoaded', commands: await api.listTrustedCommands() });
        } catch (err) {
          fail(err);
        }
      },
      async removeTrusted(id) {
        try {
          await api.removeTrustedCommand(id);
          dispatch({ type: 'trustedLoaded', commands: await api.listTrustedCommands() });
        } catch (err) {
          fail(err);
        }
      },
      setQuery(q) {
        dispatch({ type: 'setQuery', query: q });
      },
      setView(v) {
        dispatch({ type: 'setView', view: v });
      },
      setProjectFilter(projectId) {
        dispatch({ type: 'setProjectFilter', projectId });
        stateRef.current = { ...stateRef.current, projectFilter: projectId };
        dispatch({ type: 'setPage', page: 'board' });
        void this.loadBoard();
      },
      setTagFilter(tag) {
        dispatch({ type: 'setTagFilter', tag });
        stateRef.current = { ...stateRef.current, tagFilter: tag };
        dispatch({ type: 'setPage', page: 'board' });
        void this.loadBoard();
      },
      dismissError() {
        dispatch({ type: 'setError', error: null });
      },
    };
  }, [api, fail]);

  // Initial load + agents + live events.
  useEffect(() => {
    void actions.loadBoard('');
    // Deep link from a Slack DM: /?ticket=<id> opens that ticket.
    try {
      const url = new URL(window.location.href);
      const linked = url.searchParams.get('ticket');
      if (linked) {
        actions.select(linked);
        url.searchParams.delete('ticket');
        window.history.replaceState(null, '', url.toString());
      }
    } catch { /* no window (tests) */ }
    api.listAgents().then((agents) => dispatch({ type: 'agentsLoaded', agents }), fail);
    api.listTrustedCommands().then((commands) => dispatch({ type: 'trustedLoaded', commands }), fail);
    api.listProjects().then((projects) => dispatch({ type: 'projectsLoaded', projects }), fail);
    api.mailStatus().then((status) => dispatch({ type: 'mailLoaded', status }), fail);
    const stop = api.subscribe((event) => dispatch({ type: 'ws', event }), {
      onStatus: (connection) => dispatch({ type: 'setConnection', connection }),
      onReconnect: () => {
        // We may have missed events while offline: resync.
        void actions.loadBoard();
        void actions.refreshDetail();
      },
      onUnauthorized,
    });
    return stop;
  }, [api, actions, fail, onUnauthorized]);

  // v0.4: teams load at start and again on every teams.changed event.
  const teamsVersion = state.versions['teams.changed'] ?? 0;
  useEffect(() => { void actions.loadTeams(); }, [actions, teamsVersion]);

  const value = useMemo<Store>(() => ({ state, dispatch, actions, api }), [state, actions, api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}
