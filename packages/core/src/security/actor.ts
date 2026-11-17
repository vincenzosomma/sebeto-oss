/**
 * Who is acting right now, for the security log. The API server runs every /api request inside
 * `runWithActor(USER_ACTOR, …)`, so repo changes made while serving it are attributed to the owner.
 * Code outside a request (executor, scheduler, triggers) is the system, unless it says otherwise.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SecurityActor } from '@sebeto/shared';

export const SYSTEM_ACTOR: SecurityActor = { type: 'system', id: null, name: 'Sebeto' };
export const USER_ACTOR: SecurityActor = { type: 'user', id: null, name: 'You' };

const als = new AsyncLocalStorage<SecurityActor>();

export function currentActor(): SecurityActor | undefined {
  return als.getStore();
}

export function runWithActor<T>(actor: SecurityActor, fn: () => T): T {
  return als.run(actor, fn);
}
