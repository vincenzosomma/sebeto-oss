/**
 * In-process event bus (docs/16 Scalability.md rule 5). A Postgres LISTEN/NOTIFY or Redis
 * implementation can replace it later behind the same EventBus interface.
 */
import type { WsEvent } from '@sebeto/shared';
import type { EventBus } from '../contracts.js';

type Listener = (event: WsEvent) => void;

export interface EventBusOptions {
  /** Called when a listener throws (or its returned promise rejects). Defaults to console.error. */
  onError?: (err: unknown, event: WsEvent) => void;
}

export function createEventBus(opts: EventBusOptions = {}): EventBus {
  const listeners = new Set<Listener>();
  const onError = opts.onError ?? ((err: unknown, event: WsEvent) => console.error(`[bus] listener failed on ${event.type}`, err));

  return {
    publish(event) {
      // Iterate over a snapshot so (un)subscribing during publish is safe.
      for (const listener of [...listeners]) {
        try {
          const result: unknown = listener(event);
          // Listeners are typed sync, but guard against async ones rejecting unobserved.
          if (result instanceof Promise) result.catch((err: unknown) => onError(err, event));
        } catch (err) {
          onError(err, event);
        }
      }
    },
    subscribe(listener) {
      // Wrap so the same function subscribed twice gets two independent subscriptions.
      const entry: Listener = (e) => listener(e);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  };
}
