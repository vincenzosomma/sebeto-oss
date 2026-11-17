import { describe, expect, it } from 'vitest';
import { buildQuery, HttpClient } from './client';
import { backoffDelay, eventsUrl, isWsEvent } from './events';
import { MockApi } from './mock';
import { extractToken, getToken, isMockEnabled, setToken, type KeyValueStorage } from './token';
import { ApiHttpError } from './types';

class MemStorage implements KeyValueStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}
class ThrowingStorage implements KeyValueStorage {
  getItem(): string | null { throw new Error('blocked'); }
  setItem() { throw new Error('blocked'); }
  removeItem() { throw new Error('blocked'); }
}

describe('token handling', () => {
  it('extracts the token and strips it from the URL', () => {
    const r = extractToken('http://127.0.0.1:7600/?token=abc123&mock=1#x');
    expect(r.token).toBe('abc123');
    expect(r.cleanUrl).toBe('http://127.0.0.1:7600/?mock=1#x');
  });
  it('leaves URLs without a token untouched', () => {
    expect(extractToken('http://h/app?x=1')).toEqual({ token: null, cleanUrl: 'http://h/app?x=1' });
    expect(extractToken('not a url').token).toBeNull();
  });
  it('treats an empty token as missing', () => {
    expect(extractToken('http://h/?token=').token).toBeNull();
  });
  it('stores and clears the token', () => {
    const s = new MemStorage();
    setToken('t1', s);
    expect(getToken(s)).toBe('t1');
    setToken(null, s);
    expect(getToken(s)).toBeNull();
  });
  it('falls back to memory when storage throws', () => {
    const s = new ThrowingStorage();
    setToken('t2', s);
    expect(getToken(s)).toBe('t2');
    setToken(null, s);
  });
  it('detects mock mode', () => {
    expect(isMockEnabled('http://h/?mock=1', undefined)).toBe(true);
    expect(isMockEnabled('http://h/', '1')).toBe(true);
    expect(isMockEnabled('http://h/', undefined)).toBe(false);
  });
});

describe('events helpers', () => {
  it('backs off exponentially with a cap and jitter', () => {
    expect(backoffDelay(0, 500, 15000, () => 1)).toBe(500);
    expect(backoffDelay(3, 500, 15000, () => 1)).toBe(4000);
    expect(backoffDelay(20, 500, 15000, () => 1)).toBe(15000);
    expect(backoffDelay(3, 500, 15000, () => 0)).toBe(2000);
  });
  it('builds ws/wss URLs with the token', () => {
    expect(eventsUrl('http://127.0.0.1:5173', 'a b')).toBe('ws://127.0.0.1:5173/api/v1/events?token=a+b');
    expect(eventsUrl('https://x.test', 't')).toBe('wss://x.test/api/v1/events?token=t');
  });
  it('validates event frames', () => {
    expect(isWsEvent({ type: 'ticket.deleted', ticketId: 'x' })).toBe(true);
    expect(isWsEvent({ nope: 1 })).toBe(false);
    expect(isWsEvent(null)).toBe(false);
  });
});

describe('HttpClient', () => {
  it('builds query strings without empty values', () => {
    expect(buildQuery({ status: 'done', q: '', cursor: undefined, limit: 50 })).toBe('?status=done&limit=50');
    expect(buildQuery({})).toBe('');
  });

  it('sends bearer auth to /api/v1 and parses JSON', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new HttpClient({ origin: 'http://core', token: () => 'tok', fetchImpl });
    const page = await c.listTickets({ status: 'needs_you', q: 'vpn' });
    expect(page.items).toEqual([]);
    expect(calls[0]?.url).toBe('http://core/api/v1/tickets?status=needs_you&q=vpn');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('posts undo with the run id', async () => {
    let body = '';
    let url = '';
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      body = String(init?.body);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await new HttpClient({ origin: 'http://core', token: () => 't', fetchImpl }).undoRun('t1', 'r1');
    expect(url).toBe('http://core/api/v1/tickets/t1/undo');
    expect(JSON.parse(body)).toEqual({ runId: 'r1' });
  });

  it('reports 401 and API errors', async () => {
    let unauthorized = 0;
    const make = (status: number, payload: unknown) =>
      new HttpClient({
        origin: 'http://core',
        token: () => 't',
        onUnauthorized: () => unauthorized++,
        fetchImpl: (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch,
      });
    await expect(make(401, {}).health()).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toBe(1);
    const err = await make(409, { error: { code: 'already_running', message: 'Already running' } }).startTicket('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(err).toMatchObject({ status: 409, code: 'already_running', message: 'Already running' });
  });
});

describe('MockApi', () => {
  it('serves IT Ops sample data with pagination and search', async () => {
    const api = new MockApi({ speed: 0 });
    const done = await api.listTickets({ status: 'done', limit: 5 });
    expect(done.items).toHaveLength(5);
    expect(done.nextCursor).toBe('5');
    const more = await api.listTickets({ status: 'done', limit: 5, cursor: done.nextCursor ?? undefined });
    expect(more.items[0]?.id).not.toBe(done.items[0]?.id);
    const ssl = await api.listTickets({ q: 'ssl' });
    expect(ssl.items.map((t) => t.number)).toContain(107);
  });

  it('emits live events when a ticket is moved', async () => {
    const api = new MockApi({ speed: 0 });
    const types: string[] = [];
    const stop = api.subscribe((e) => types.push(e.type));
    const [t] = (await api.listTickets({ status: 'backlog' })).items;
    expect(t).toBeDefined();
    const moved = await api.moveTicket(t!.id, { status: 'blocked' });
    expect(moved.status).toBe('blocked');
    expect(types).toContain('ticket.updated');
    stop();
  });
});
