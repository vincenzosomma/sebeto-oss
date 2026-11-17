import type { WsEvent } from '@sebeto/shared';
import type { SubscribeOptions } from './types';

/** Exponential backoff with jitter: 0.5–1.0 × min(max, base·2^attempt). */
export function backoffDelay(attempt: number, base = 500, max = 15_000, rand: () => number = Math.random): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(raw * (0.5 + rand() * 0.5));
}

/** Pure: build the WebSocket URL for the events endpoint. */
export function eventsUrl(origin: string, token: string): string {
  const u = new URL('/api/v1/events', origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('token', token);
  return u.toString();
}

/** Close codes the server may use to reject a bad token. */
const UNAUTHORIZED_CODES = new Set([4401, 4001, 1008]);

export function isWsEvent(value: unknown): value is WsEvent {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Connects to /api/v1/events with auto-reconnect; returns a function that stops it. */
export function connectEvents(
  origin: string,
  getToken: () => string | null,
  listener: (event: WsEvent) => void,
  options: SubscribeOptions = {},
): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connectedOnce = false;

  const schedule = () => {
    if (stopped) return;
    options.onStatus?.('closed');
    const delay = backoffDelay(attempt++);
    timer = setTimeout(open, delay);
  };

  function open() {
    if (stopped) return;
    const token = getToken();
    if (!token) {
      options.onStatus?.('closed');
      return;
    }
    options.onStatus?.('connecting');
    try {
      ws = new WebSocket(eventsUrl(origin, token));
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      options.onStatus?.('open');
      if (connectedOnce) options.onReconnect?.();
      connectedOnce = true;
    };
    ws.onmessage = (msg) => {
      try {
        const data: unknown = JSON.parse(String(msg.data));
        if (isWsEvent(data)) listener(data);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (ev) => {
      ws = null;
      if (stopped) return;
      if (UNAUTHORIZED_CODES.has(ev.code)) {
        options.onStatus?.('closed');
        options.onUnauthorized?.();
        return;
      }
      schedule();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close(1000);
    ws = null;
  };
}
