/**
 * Minimal Slack Socket Mode client (2026-11-16): receives button clicks and modal submissions from
 * Slack over an outgoing WebSocket, so nothing on this computer is exposed to the internet.
 * apps.connections.open (app-level token xapp-…) → wss URL → every envelope is acknowledged at once,
 * then handed to `onInteractive`. Reconnects on `disconnect` messages and closed sockets, with backoff.
 */
import type { FetchLike } from './common.js';

export interface SocketEnvelope { envelope_id?: string; type: string; payload?: Record<string, unknown>; reason?: string }

export interface SlackSocket { close(): void }

interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error' | 'open', fn: () => void): void;
}

export interface SlackSocketOptions {
  appToken: string;
  onInteractive: (payload: Record<string, unknown>) => void | Promise<void>;
  log?: { warn: (o: object, msg: string) => void; info?: (o: object, msg: string) => void };
  fetchImpl?: FetchLike;
  /** For tests. */
  wsFactory?: (url: string) => WsLike;
}

const MAX_BACKOFF_MS = 5 * 60_000;

export function startSlackSocket(opts: SlackSocketOptions): SlackSocket {
  let closed = false;
  let ws: WsLike | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const factory = opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);

  const retry = () => {
    if (closed || timer) return;
    const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(failures, 8));
    failures++;
    timer = setTimeout(() => { timer = null; void connect(); }, wait);
    (timer as { unref?: () => void }).unref?.();
  };

  async function connect(): Promise<void> {
    if (closed) return;
    let url: string | undefined;
    try {
      const res = await fetchImpl('https://slack.com/api/apps.connections.open', {
        method: 'POST', headers: { Authorization: `Bearer ${opts.appToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!body.ok || !body.url) throw new Error(body.error ?? 'no url');
      url = body.url;
    } catch (err) {
      opts.log?.warn({ err: (err as Error).message }, 'slack socket mode: could not open a connection');
      retry();
      return;
    }
    const sock = factory(url);
    ws = sock;
    sock.addEventListener('open', () => { failures = 0; });
    sock.addEventListener('message', (e) => {
      let env: SocketEnvelope;
      try { env = JSON.parse(String(e.data)) as SocketEnvelope; } catch { return; }
      if (env.envelope_id) {
        try { sock.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch { /* socket closing */ }
      }
      if (env.type === 'disconnect') { try { sock.close(); } catch { /* already */ } return; }
      if (env.type === 'interactive' && env.payload) {
        Promise.resolve(opts.onInteractive(env.payload)).catch((err: Error) => opts.log?.warn({ err: err.message }, 'slack socket mode: action failed'));
      }
    });
    const onEnd = () => { if (ws === sock) ws = null; retry(); };
    sock.addEventListener('close', onEnd);
    sock.addEventListener('error', () => { try { sock.close(); } catch { /* already */ } });
  }

  void connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      try { ws?.close(); } catch { /* already */ }
    },
  };
}
