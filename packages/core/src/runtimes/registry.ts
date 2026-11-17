import type { RuntimeAdapter, RuntimeId } from '@sebeto/shared';
import type { RuntimeRegistry } from '../contracts.js';

/**
 * Simple id → adapter lookup. Later adapters win when ids collide.
 * `dynamic` adds adapters that change while the core runs (v0.7 R: one per AI connection,
 * `openai:<id>`); it is asked on every lookup, and never overrides a built-in id.
 */
export function createRuntimeRegistry(adapters: RuntimeAdapter[], dynamic?: () => RuntimeAdapter[]): RuntimeRegistry {
  const byId = new Map<RuntimeId, RuntimeAdapter>();
  for (const a of adapters) byId.set(a.id, a);
  const extra = () => (dynamic?.() ?? []).filter((a) => !byId.has(a.id));
  return {
    get: (id) => byId.get(id) ?? extra().find((a) => a.id === id),
    list: () => [...byId.values(), ...extra()],
  };
}
