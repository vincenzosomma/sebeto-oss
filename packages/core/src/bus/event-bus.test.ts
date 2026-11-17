import { describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '@sebeto/shared';
import { createEventBus } from './index.js';

const ev: WsEvent = { type: 'ticket.deleted', ticketId: 't1' };

describe('event bus', () => {
  it('delivers to all listeners and supports unsubscribe', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.subscribe(a);
    bus.subscribe(b);
    bus.publish(ev);
    offA();
    bus.publish(ev);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledWith(ev);
  });

  it('isolates listener errors (sync and async)', async () => {
    const onError = vi.fn();
    const bus = createEventBus({ onError });
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((() => Promise.reject(new Error('async boom'))) as unknown as (e: WsEvent) => void);
    bus.subscribe(after);
    bus.publish(ev);
    await new Promise((r) => setTimeout(r, 0));
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('tolerates unsubscribing during publish', () => {
    const bus = createEventBus();
    const second = vi.fn();
    const off = bus.subscribe(() => off());
    bus.subscribe(second);
    bus.publish(ev);
    bus.publish(ev);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
